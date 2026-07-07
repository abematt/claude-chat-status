# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS menu bar app showing live status of every Claude Code chat across repos. Two components connected by JSON files on disk:

1. **`update_status.py`** — a Claude Code hook script. Each lifecycle event (SessionStart, UserPromptSubmit, Stop, …) runs it with a positional arg naming the event; it merges state into `~/.claude/chat-status/<session_id>.json`.
2. **`ChatStatusBar.swift`** — the entire app (single file, AppKit, no Xcode project). Polls that directory every 2s, renders menu bar counts + card dropdown, fires notifications on transitions to *needs you* / *errored* / *finished*.

`install.sh` wires them together by patching hooks into `~/.claude/settings.json` via jq.

## Commands

```bash
./build.sh        # swiftc-compiles ChatStatusBar.swift into build/ChatStatus.app (ad-hoc signed)
./install.sh      # build + register hooks + (re)launch — idempotent
./install.sh --uninstall   # strip hooks + login item
./build/ChatStatus.app/Contents/MacOS/ChatStatus --dump   # print parsed state without the GUI
touch ~/.claude/chat-status/.debug   # log every raw hook payload to ~/.claude/chat-status/_debug.jsonl
```

There are no tests. To verify changes end-to-end: `./install.sh`, then drive a Claude Code session and watch the JSON files / app. `--dump` and `.debug` are the debugging tools.

## Architecture and invariants

**Data flow:** hook event → `update_status.py <arg>` (payload on stdin) → status JSON file → app poll. The contract between the two sides is the JSON schema (`status`, `waiting_on`, `waiting_kind`, `waiting_rich`, `error_type`, `fail_streak`, `turn_started_at`, `updated_at`, `repo`/`branch`/`cwd`, `title`, `last_prompt`, `pid`/`pid_started_at`, `background`, `last_message`) and the status vocabulary: `live`, `working`, `needs_input`, `error`, `done`. Changing either side means changing both — plus `install.sh`, whose event→arg mapping must match the dispatch in `update_status.py`'s `main()`.

**`update_status.py` must never print to stdout.** Hook stdout is interpreted by Claude Code — PermissionRequest output can auto-approve/deny, PreToolUse output can rewrite tool calls. It must also always exit 0 (never block Claude), which is why everything is wrapped in bare try/except.

**State semantics encoded across both files:**
- `repo`/`branch`/`cwd` are pinned on the session's first write and never overwritten — the card stays attached to the window it opened in even if the chat `cd`s elsewhere. Click routing opens `cwd` in VS Code, then deep-links `vscode://anthropic.claude-code/open?session=…`.
- `turn_started_at` is stamped only by UserPromptSubmit; tool events refresh `updated_at` but not the turn clock. The app ages *working* cards from `turn_started_at` and everything else from `updated_at` (see `Chat.activityDate`).
- `waiting_rich` marks precise blocked-on text (from PermissionRequest / AskUserQuestion) so the generic Notification message that follows doesn't clobber it.
- Status writes are atomic via a PID-unique tmp file + `os.replace` — hooks fire concurrently for one session.
- `error` comes from StopFailure because `Stop` never fires on API errors; without it a dead turn looks *working* forever.
- `pid`/`pid_started_at` (the Claude process, found by walking the hook's ancestors; re-pinned on SessionStart and each prompt) let the app reap sessions that died without a SessionEnd. The start time defends against PID reuse; the ancestor walk must skip the hook's own chain, whose command line contains "claude" via the repo path.
- A `Stop` with any `background_tasks`/`session_crons` entry `status == "running"` is not *done*: the entry stays `working` with `background: true` (no finished ping), and `idle_prompt` notifications are ignored while it's set. `last_message` (Claude's closing message, payload field or transcript tail-parse) is only written on a true finish.
- Notifications are keyed `chat-<session_id>` — one live banner per chat; `poll()` withdraws delivered banners when a chat returns to `working`/`live` or its file disappears.

**Swift file layout** (top to bottom): `Chat` struct + file loading/pruning → `FMEngine` (Apple on-device Foundation Models, macOS 26+, availability-gated so its types never leak elsewhere) → `ChatCardView` (card rendering + inline rename) → `AppDelegate` (status item, panel, polling, notifications, Carbon global hotkey ⌃⌥C). Persistent app state (AI-summary cache, user labels, toggles, hotkey binding) lives in `UserDefaults` under `com.measure.chatstatus`.

**Do not change the bundle identifier** `com.measure.chatstatus` — the previous id has poisoned status-item state in the window server (see comment in `build.sh`).

**Hooks in settings.json are guarded** by a file-existence check on the script path, so a moved/deleted clone no-ops instead of breaking Claude; `install.sh` strips any prior chat-status hooks before adding, so re-running never duplicates.
