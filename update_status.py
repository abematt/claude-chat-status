#!/usr/bin/env python3
"""Claude Code hook: maintains per-session status files for the ChatStatus menu bar app.

Registered in ~/.claude/settings.json for these hook events:
    SessionStart                -> live     (only for a chat that already has a card)
    UserPromptSubmit            -> working  (starts the turn clock; clears waiting/error)
    PostToolUse                 -> tool     (back to working; turn clock keeps running)
    PostToolUseFailure          -> toolfail (still working; bumps fail_streak)
    PermissionRequest           -> permission (needs_input + the exact tool/command)
    PreToolUse[AskUserQuestion] -> question (needs_input + the question text)
    Notification                -> notify   (needs_input, labeled by notification_type)
    StopFailure                 -> error    (turn died on an API error; Stop won't fire)
    Stop                        -> done
    SessionEnd                  -> ended    (removes the status file)

Codex runs the same script from ~/.codex/hooks.json with a second argument,
`codex` (e.g. `update_status.py working codex`). Its hook payloads share
Claude's field names. It has no Notification / StopFailure events, and adds
    Interrupt                   -> interrupt (you stopped the turn: back to idle)

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
import re
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


def process_info(agent="claude"):
    """One walk up the hook's ancestry for two facts.

    claude: (pid, start_epoch) of the nearest ancestor that looks like the
    agent process (`claude`, or `codex` for Codex sessions) — lets the app reap sessions whose process died without a
    clean SessionEnd (window closed, crash) instead of showing them working
    for the 24h prune; the start time guards against PID reuse.

    host: the topmost ancestor below launchd is the GUI app hosting the
    session. VS Code-hosted chats can be deep-linked on click; anything else
    (a terminal, a tmux server) is recorded as ("terminal", app name, pid)
    so the app focuses that instead of wrongly opening VS Code."""
    claude = None
    host = None
    try:
        r = subprocess.run(
            ["ps", "-Axww", "-o", "pid=,ppid=,lstart=,command="],
            capture_output=True, text=True, timeout=2,
        )
        procs = {}
        for line in r.stdout.splitlines():
            # pid, ppid, then lstart's 5 tokens ("Mon Jul  7 21:04:32 2026").
            parts = line.split(None, 7)
            if len(parts) == 8:
                procs[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]), parts[7])
        cur = os.getppid()
        top = None
        for _ in range(25):
            if cur <= 1 or cur not in procs:
                break
            ppid, lstart, cmd = procs[cur]
            # Our own hook chain (sh/python running this script) mentions
            # "claude" via the repo path — skip it, not match it.
            if claude is None and agent in cmd.lower() and "update_status.py" not in cmd:
                started = int(time.mktime(time.strptime(lstart, "%a %b %d %H:%M:%S %Y")))
                claude = (cur, started)
            top = (cur, cmd)
            cur = ppid
        if top:
            pid, cmd = top
            low = cmd.lower()
            if "visual studio code" in low or "code helper" in low:
                host = ("vscode", "", 0)
            elif ".app/" in cmd:
                # App name from the bundle path: ".../iTerm.app/..." -> iTerm.
                name = cmd.split(".app/")[0].rsplit("/", 1)[-1]
                host = ("terminal", name, pid)
            else:
                # Bare binary (tmux server, sshd, ...) — first token's basename.
                host = ("terminal", os.path.basename(cmd.split()[0]), pid)
    except Exception:
        pass
    return claude, host


def bb_thread_for(session_id):
    """bb thread that owns a Codex session, or "".

    bb drives every Codex thread through one shared `codex app-server`, so
    there is no per-thread BB_THREAD_ID to inherit. bb's own database links
    the two: each event row carries the provider's thread id (the Codex
    session id) beside bb's thread id. Read-only, newest rows first, and any
    failure (no bb, schema change, locked file) just means no deep link."""
    try:
        import sqlite3
        db = os.path.expanduser("~/.bb/bb.db")
        if not os.path.exists(db):
            return ""
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=0.5)
        try:
            row = con.execute(
                "select thread_id from events where provider_thread_id = ? "
                "order by rowid desc limit 1", (session_id,),
            ).fetchone()
        finally:
            con.close()
        if row and re.fullmatch(r"thr_[A-Za-z0-9]+", row[0] or ""):
            return row[0]
    except Exception:
        pass
    return ""


REPOS_MAX = 6  # repos shown per chat, most recent first
# A repo is shown once the turn has this much evidence for it. A read or a
# shell mention is worth 1, so a single `ls` of a neighbouring repo does not
# put it on the card; an edit is worth the full amount, so real work shows at
# once.
REPO_SHOWN_AT = 2
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch")


def repo_of(path):
    """Name of the git repo that holds `path`, or "".

    Stat-only walk up the tree, so it is cheap enough for every tool event.
    A linked worktree (`.git` is a file) is named after the repo it belongs
    to, not its own folder: `measure-web.fix-login` is still `measure-web`.
    Stops below the home directory, so a dotfiles repo in ~ does not claim
    every path under it."""
    home = os.path.expanduser("~")
    d = path if os.path.isdir(path) else os.path.dirname(path)
    for _ in range(14):
        if not d or d == home or d == os.path.dirname(d):
            break
        git = os.path.join(d, ".git")
        if os.path.isdir(git):
            return os.path.basename(d)
        if os.path.isfile(git):
            try:
                with open(git) as f:
                    m = re.search(r"gitdir:\s*(.+?)/\.git/worktrees/", f.read(1024))
                if m:
                    return os.path.basename(m.group(1))
            except Exception:
                pass
            return os.path.basename(d)
        d = os.path.dirname(d)
    return ""


def touched_repos(payload):
    """Repos a tool call worked in, in the order they appear.

    A chat opened on a workspace folder (many repos side by side) is pinned
    to that folder; this is how its card says which repos it is really in.
    File tools name their path outright. A shell command is scanned for
    words that are existing paths, plus the directory it ran in."""
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        return []
    base = payload.get("cwd") or ""
    named = [ti.get(k) for k in ("file_path", "path", "notebook_path")]
    if payload.get("tool_name") == "Glob" and isinstance(ti.get("pattern"), str):
        # The literal directory before the first wildcard.
        named.append(re.split(r"[*?\[{]", ti["pattern"], maxsplit=1)[0])
    paths = []
    for value in named:
        if isinstance(value, str) and value:
            p = os.path.expanduser(value)
            if os.path.isabs(p) or base:
                paths.append(p if os.path.isabs(p) else os.path.join(base, p))
    cmd = ti.get("command")
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    if isinstance(cmd, str) and cmd:
        for word in re.split(r"""[\s;|&()<>="'`]+""", cmd)[:120]:
            if not word or word.startswith("-") or "://" in word or len(word) > 400:
                continue
            p = os.path.expanduser(word)
            if not os.path.isabs(p):
                if not base:
                    continue
                p = os.path.join(base, p)
            # Most words are not paths; only one that exists counts.
            if os.path.exists(p):
                paths.append(p)
        if base:
            paths.append(base)
    names = []
    for p in paths:
        name = repo_of(os.path.normpath(p))
        if name and name not in names:
            names.append(name)
    return names


def bb_title_for(thread):
    """The title bb gave a thread, or "".

    bb names each thread with its own AI service, from the first task and the
    latest messages, which reads better than a clipped first prompt. Read-only
    from bb's database, like bb_thread_for. A title that still carries bb's
    @thread: / @project: mention tokens is skipped: only bb can resolve them."""
    try:
        import sqlite3
        db = os.path.expanduser("~/.bb/bb.db")
        if not os.path.exists(db):
            return ""
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=0.5)
        try:
            row = con.execute(
                "select title from threads where id = ?", (thread,)).fetchone()
        finally:
            con.close()
        title = " ".join(str((row or [""])[0] or "").split())
        if title and not re.search(r"@(thread|project|section):", title):
            return title[:120]
    except Exception:
        pass
    return ""


def has_background_work(payload):
    """Stop payloads (claude >= 2.1.145) list live background tasks/crons; a
    turn that ends with any still running isn't finished."""
    for key in ("background_tasks", "session_crons"):
        for t in payload.get(key) or []:
            if isinstance(t, dict) and t.get("status") == "running":
                return True
    return False


def last_assistant_message(payload):
    """Claude's closing message, for the finished notification/card: from the
    Stop payload when present, else tail-parsed from the transcript JSONL."""
    msg = payload.get("last_assistant_message")
    if msg:
        return " ".join(str(msg).split())
    path = payload.get("transcript_path")
    if not path:
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 262144))
            lines = f.read().decode("utf-8", "replace").splitlines()
        for line in reversed(lines):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "assistant":
                continue
            content = (obj.get("message") or {}).get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(b.get("text", "") for b in content
                                if isinstance(b, dict) and b.get("type") == "text")
            else:
                continue
            text = " ".join(text.split())
            if text:
                return text
    except Exception:
        pass
    return ""


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
    agent = "codex" if len(sys.argv) > 2 and sys.argv[2] == "codex" else "claude"
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

    # Only a prompt creates a card. Merely opening a chat (SessionStart), or
    # any stray event for a session with no file, must not: an editor that
    # opens or restores chat tabs would otherwise litter the board with idle
    # cards nobody typed into. It also makes a manual remove stick until the
    # next prompt instead of being undone by the turn's next tool event.
    if not entry and status != "working":
        return

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

    # Session (re)starts and prompts re-pin the Claude PID and host app:
    # cheap, and a resumed session gets a fresh process (and possibly a new
    # host) the old values would misrepresent.
    if status in ("live", "working"):
        info, host = process_info(agent)
        if info:
            entry["pid"], entry["pid_started_at"] = info
        if host:
            entry["host"] = host[0]
            if host[0] == "terminal":
                entry["host_app"], entry["host_pid"] = host[1], host[2]
            else:
                entry.pop("host_app", None)
                entry.pop("host_pid", None)
        # bb exports its thread id to the agents it runs; with it the app can
        # ask bb to open the exact thread on click, not just raise the window.
        bb_thread = os.environ.get("BB_THREAD_ID") or ""
        if re.fullmatch(r"thr_[A-Za-z0-9]+", bb_thread):
            entry["bb_thread"] = bb_thread
        elif agent != "codex":
            entry.pop("bb_thread", None)

    # Which agent owns the chat: the app labels Codex cards and must not send
    # a Codex session id to the Claude Code deep link.
    if agent == "codex":
        entry["agent"] = "codex"

    # A Codex chat inside bb learns its bb thread from bb's database. Retried
    # on every event until found: bb may not have written the first event row
    # when the first prompt's hook runs.
    if (agent == "codex" and entry.get("host_app") == "bb"
            and not entry.get("bb_thread")):
        t = bb_thread_for(sid)
        if t:
            entry["bb_thread"] = t

    # bb writes a thread's title a moment after its first prompt and can
    # change it later, so ask on every event rather than once.
    if entry.get("bb_thread"):
        t = bb_title_for(entry["bb_thread"])
        if t:
            entry["bb_title"] = t
    else:
        entry.pop("bb_title", None)

    # Which repos the chat is working in, from its tool calls. The list covers
    # the latest turn that touched any: a new prompt only marks it stale, and
    # the next touch starts it over, so a turn with no tool calls (a question)
    # keeps showing where the work was.
    if status in ("tool", "toolfail", "permission"):
        try:
            names = touched_repos(payload)
        except Exception:
            names = []
        if names:
            if entry.pop("repos_stale", None):
                entry.pop("repo_hits", None)
                entry.pop("repos_touched", None)
            # repo_hits: [[name, evidence], ...], most recent first. It holds
            # every repo seen this turn; repos_touched is the part of it with
            # enough evidence to show.
            old = {h[0]: h[1] for h in entry.get("repo_hits") or []
                   if isinstance(h, list) and len(h) == 2}
            worth = REPO_SHOWN_AT if payload.get("tool_name") in EDIT_TOOLS else 1
            hits = [[n, old.get(n, 0) + worth] for n in names]
            hits += [[n, c] for n, c in old.items() if n not in names]
            entry["repo_hits"] = hits[:REPOS_MAX * 2]
            shown = [n for n, c in hits if c >= REPO_SHOWN_AT][:REPOS_MAX]
            if shown:
                entry["repos_touched"] = shown
            else:
                entry.pop("repos_touched", None)
    elif status == "working" and entry.get("repo_hits"):
        entry["repos_stale"] = True

    if status == "working":
        # A fresh user prompt starts a new turn; the app measures "working" age
        # against this, not updated_at (which tool events keep refreshing).
        entry["turn_started_at"] = now
        clear_waiting(entry)
        entry.pop("error_type", None)
        entry.pop("fail_streak", None)
        entry.pop("background", None)
        entry.pop("last_message", None)
    elif status == "tool":
        # Tool activity flips an answered permission prompt / question back to
        # working without restarting the turn clock; a success ends any streak.
        # It also means the main loop is live again after a background-only
        # stop, so the next Stop should re-evaluate background work fresh.
        status = "working"
        clear_waiting(entry)
        entry.pop("fail_streak", None)
        entry.pop("error_type", None)
        entry.pop("background", None)
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
        # Claude's ~60s idle nag fires while background work is running; that
        # isn't "waiting on you", so don't flip a background card orange.
        if ntype == "idle_prompt" and entry.get("background"):
            return
        status = "needs_input"
        entry["waiting_kind"] = NOTIFY_KIND.get(ntype, entry.get("waiting_kind") or "")
        msg = " ".join((payload.get("message") or "").split())
        # PermissionRequest/AskUserQuestion already set exact text; don't
        # clobber it with the generic notification message.
        if msg and not entry.get("waiting_rich"):
            entry["waiting_on"] = msg[:160]
    elif status == "interrupt":
        # Codex Interrupt: you stopped the turn, and no Stop will follow.
        status = "live"
        clear_waiting(entry)
        entry.pop("fail_streak", None)
        entry.pop("background", None)
    elif status == "error":
        # StopFailure: the turn died on an API error and Stop will not fire —
        # without this the chat would show "working" forever.
        entry["error_type"] = payload.get("error_type") or ""
        clear_waiting(entry)
    elif status == "done":
        clear_waiting(entry)
        entry.pop("fail_streak", None)
        entry.pop("error_type", None)
        if has_background_work(payload):
            # The turn ended but background tasks/crons are still running:
            # not finished. Stay working (no "finished" ping); a later Stop
            # with nothing running completes the card for real.
            status = "working"
            entry["background"] = True
        else:
            entry.pop("background", None)
            msg = last_assistant_message(payload)
            if msg:
                entry["last_message"] = msg[:200]

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
