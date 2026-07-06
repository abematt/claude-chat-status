# claude-chat-status

A macOS menu bar app that shows the live status of every Claude Code chat across
all your repos, with click-to-jump routing and notification pings when a chat
finishes or needs your input.

```
menu bar:  ● 1  ● 2  ● 1     (orange = needs you, green = working, gray = idle/done)
dropdown:  ┌──────────────────────────────────────────────┐
           │  Claude Chats              ✨  🔔  🗑  ⏻       │
           ├──────────────────────────────────────────────┤
           │  ● measure-web                 needs you · now │
           │    Fixing the checkout redirect loop           │
           │  ● measure-backend               working · 2m  │
           │    Refactoring sprint completion flow          │
           └──────────────────────────────────────────────┘
```

Each chat is a card: repo, status + age, and a one-line description of what the
chat is doing. The dropdown is a custom frosted panel (not a native menu), with
a header row of controls.

## How it works

1. **Hooks** in `~/.claude/settings.json` run `update_status.py` on Claude Code
   lifecycle events (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`,
   `SessionEnd`). Each writes/updates one JSON file per session in
   `~/.claude/chat-status/` (repo, branch, cwd, status, title, latest prompt).
   `repo`/`branch`/`cwd` are pinned on first sight so a chat stays attached to
   the window it was opened in even if it later `cd`s elsewhere.
2. **ChatStatus.app** (Swift, `ChatStatusBar.swift`) polls that directory every
   2 seconds, shows per-status counts in the menu bar, renders the dropdown, and
   fires a macOS notification when a chat transitions to *needs you* or *finished*.

Statuses: orange `needs_input` (permission prompt) · green `working` (prompt
submitted) · gray `done` (turn finished) / `live` (session open, idle).

## AI summaries (optional, macOS 26+)

When Apple's on-device Foundation Models framework is available (macOS 26+ with
Apple Intelligence enabled), each card's description is a ~6-word summary of the
chat's latest prompt, generated locally — free, private, ~0.5s per summary after
a one-time model prewarm. Toggle it with the ✨ button in the header. On older
systems or when the model is unavailable, cards show the raw prompt and the
button is hidden.

## Install

```bash
./install.sh            # build, register hooks, launch
./install.sh --login    # also add a macOS login item (auto-start)
./install.sh --uninstall # remove hooks + login item
```

`install.sh` is idempotent and uses its own directory as the source of truth, so
it works wherever you clone the repo. It patches `~/.claude/settings.json`,
adding hooks guarded by a file-existence check (a missing script no-ops rather
than blocking Claude).

## Usage

- **Click a card** to jump to that conversation: it focuses the VS Code window
  with that repo open, then deep-links the session
  (`vscode://anthropic.claude-code/open?session=<id>`). Clicking a notification
  does the same.
- **✨** toggles AI summaries · **🔔** toggles notification pings ·
  **🗑** clears idle/finished entries · **⏻** quits.
- Entries not updated for 24h are pruned automatically (sessions killed without
  a clean exit).

Debug without the GUI:

```bash
./build/ChatStatus.app/Contents/MacOS/ChatStatus --dump
```

## Requirements

- macOS (Apple Silicon recommended; AI summaries need macOS 26+ / Apple Intelligence)
- VS Code with the Claude Code extension (for click-to-jump)
- `jq` for `install.sh` (`brew install jq`)

## Notes

- Hooks are read at session start, so chats opened *before* the hooks were
  registered won't report until their next session.
- Claude Code's own notification setting (`inputNeededNotifEnabled`) is
  independent; disable one or the other to avoid double pings.
- The app is ad-hoc signed. If notifications don't appear, enable them for
  ChatStatus in System Settings → Notifications.
