#!/usr/bin/env python3
"""Claude Code hook: maintains per-session status files for the ChatStatus menu bar app.

Registered in ~/.claude/settings.json for these hook events:
    SessionStart      -> live
    UserPromptSubmit  -> working
    PostToolUse       -> working (clears needs_input once an approved tool runs)
    Notification      -> notify (mapped to needs_input for permission prompts)
    Stop              -> done
    SessionEnd        -> ended (removes the status file)

Reads the hook payload JSON from stdin. Writes one JSON file per session to
~/.claude/chat-status/<session_id>.json. Always exits 0 so it never blocks Claude.
"""
import json
import os
import subprocess
import sys
import time

STATUS_DIR = os.path.expanduser("~/.claude/chat-status")


def main():
    status = sys.argv[1] if len(sys.argv) > 1 else "live"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
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

    if status == "notify":
        # Claude Code's Notification hook fires only to get your attention:
        # permission prompts, and idle waits (~60s sitting on a question/input).
        # Both mean "needs you", so any notification flips the chat to needs_input.
        status = "needs_input"

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

    entry.update({
        "session_id": sid,
        "status": status,
        "updated_at": int(time.time()),
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
