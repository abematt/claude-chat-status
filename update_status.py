#!/usr/bin/env python3
"""Claude Code hook: maintains per-session status files for the ChatStatus menu bar app.

Registered in ~/.claude/settings.json for these hook events:
    SessionStart                -> live
    UserPromptSubmit            -> working  (starts the turn clock; clears waiting/error)
    PostToolUse                 -> tool     (back to working; turn clock keeps running)
    PostToolUseFailure          -> toolfail (still working; bumps fail_streak)
    PermissionRequest           -> permission (needs_input + the exact tool/command)
    PreToolUse[AskUserQuestion] -> question (needs_input + the question text)
    Notification                -> notify   (needs_input, labeled by notification_type)
    StopFailure                 -> error    (turn died on an API error; Stop won't fire)
    Stop                        -> done
    SessionEnd                  -> ended    (removes the status file)

Reads the hook payload JSON from stdin. Writes one JSON file per session to
~/.claude/chat-status/<session_id>.json. Always exits 0 so it never blocks Claude.

IMPORTANT: this script must never print to stdout. Hook stdout is interpreted by
Claude Code — a PermissionRequest hook that emits JSON can auto-approve or deny
the request, and PreToolUse output can rewrite tool calls.

Debugging: `touch ~/.claude/chat-status/.debug` to append every raw payload to
~/.claude/chat-status/_debug.jsonl; remove the file to stop.
"""
import json
import os
import subprocess
import sys
import time

STATUS_DIR = os.path.expanduser("~/.claude/chat-status")

# needs_input sub-kinds, so the app can label cards precisely.
NOTIFY_KIND = {
    "permission_prompt": "permission",
    "idle_prompt": "reply",
    "agent_needs_input": "reply",
    "elicitation_dialog": "mcp",
}
# Informational notifications that don't mean "needs you".
NOTIFY_IGNORE = ("auth_success", "agent_completed")


def clear_waiting(entry):
    for k in ("waiting_on", "waiting_kind", "waiting_rich"):
        entry.pop(k, None)


def describe_tool(payload):
    """One-line human summary of the tool call awaiting permission."""
    tool = payload.get("tool_name") or "a tool"
    ti = payload.get("tool_input") or {}
    detail = ""
    if isinstance(ti, dict):
        detail = ti.get("command") or ti.get("file_path") or ti.get("url") or ""
        detail = " ".join(str(detail).split())
    return f"{tool}: {detail}" if detail else tool


def question_text(payload):
    """The question AskUserQuestion is showing (field shape is docs-derived,
    so try both singular and list forms)."""
    ti = payload.get("tool_input") or {}
    if not isinstance(ti, dict):
        return ""
    q = ti.get("question")
    if not q:
        qs = ti.get("questions")
        if isinstance(qs, list) and qs and isinstance(qs[0], dict):
            q = qs[0].get("question")
    return " ".join(str(q or "").split())


def main():
    status = sys.argv[1] if len(sys.argv) > 1 else "live"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    if os.path.exists(os.path.join(STATUS_DIR, ".debug")):
        try:
            with open(os.path.join(STATUS_DIR, "_debug.jsonl"), "a") as f:
                json.dump({"arg": status, "payload": payload}, f)
                f.write("\n")
        except Exception:
            pass

    sid = payload.get("session_id")
    if not sid:
        return

    os.makedirs(STATUS_DIR, exist_ok=True)
    path = os.path.join(STATUS_DIR, f"{sid}.json")

    if status == "ended":
        try:
            os.remove(path)
        except OSError:
            pass
        return

    # Merge with the existing entry so fields like title survive status-only updates.
    entry = {}
    try:
        with open(path) as f:
            entry = json.load(f)
    except Exception:
        pass

    # repo/branch/cwd are captured once, on the session's first update, and
    # never overwritten: the card stays attached to the window the chat was
    # opened in (click-routing opens cwd) even if the session later cd's into
    # another repo mid-conversation.
    if not entry.get("cwd"):
        cwd = payload.get("cwd") or os.getcwd()
        branch = ""
        repo = ""
        try:
            r = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel"],
                capture_output=True, text=True, timeout=2,
            )
            lines = r.stdout.strip().splitlines()
            if len(lines) == 2:
                branch = lines[0]
                # Name by git root, not cwd — the chat may live in a subdirectory.
                repo = os.path.basename(lines[1])
        except Exception:
            pass
        entry["repo"] = repo or os.path.basename(cwd.rstrip("/")) or cwd
        entry["branch"] = branch
        entry["cwd"] = cwd

    now = int(time.time())

    if status == "working":
        # A fresh user prompt starts a new turn; the app measures "working" age
        # against this, not updated_at (which tool events keep refreshing).
        entry["turn_started_at"] = now
        clear_waiting(entry)
        entry.pop("error_type", None)
        entry.pop("fail_streak", None)
    elif status == "tool":
        # Tool activity flips an answered permission prompt / question back to
        # working without restarting the turn clock; a success ends any streak.
        status = "working"
        clear_waiting(entry)
        entry.pop("fail_streak", None)
        entry.pop("error_type", None)
    elif status == "toolfail":
        # Still working, but count consecutive failures so the app can flag a
        # struggling chat. Reset by any successful tool / prompt / turn end.
        status = "working"
        entry["fail_streak"] = entry.get("fail_streak", 0) + 1
    elif status == "permission":
        # PermissionRequest carries the exact tool + input — better text than
        # the generic Notification message that follows it.
        status = "needs_input"
        entry["waiting_kind"] = "permission"
        entry["waiting_on"] = describe_tool(payload)[:160]
        entry["waiting_rich"] = True
    elif status == "question":
        # PreToolUse on AskUserQuestion: Claude is asking you to choose.
        status = "needs_input"
        entry["waiting_kind"] = "question"
        q = question_text(payload)
        if q:
            entry["waiting_on"] = q[:160]
        entry["waiting_rich"] = True
    elif status == "notify":
        # Claude Code's Notification hook fires to get your attention; the
        # structured notification_type says why. Unknown/missing types fall
        # back to the old behavior (generic needs_input) on older versions.
        ntype = payload.get("notification_type") or ""
        if ntype in NOTIFY_IGNORE:
            return
        status = "needs_input"
        entry["waiting_kind"] = NOTIFY_KIND.get(ntype, entry.get("waiting_kind") or "")
        msg = " ".join((payload.get("message") or "").split())
        # PermissionRequest/AskUserQuestion already set exact text; don't
        # clobber it with the generic notification message.
        if msg and not entry.get("waiting_rich"):
            entry["waiting_on"] = msg[:160]
    elif status == "error":
        # StopFailure: the turn died on an API error and Stop will not fire —
        # without this the chat would show "working" forever.
        entry["error_type"] = payload.get("error_type") or ""
        clear_waiting(entry)
    elif status == "done":
        clear_waiting(entry)
        entry.pop("fail_streak", None)
        entry.pop("error_type", None)

    entry.update({
        "session_id": sid,
        "status": status,
        "updated_at": now,
    })

    # UserPromptSubmit payloads carry the prompt text: first prompt names the
    # chat, latest prompt shows what it's currently doing.
    prompt = " ".join((payload.get("prompt") or "").split())
    if prompt:
        entry["last_prompt"] = prompt[:120]
        if not entry.get("title"):
            entry["title"] = prompt[:80]

    # PID-unique tmp name: hook events can fire concurrently for one session,
    # and two writers sharing a tmp path could replace with mixed content.
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(entry, f)
    os.replace(tmp, path)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
