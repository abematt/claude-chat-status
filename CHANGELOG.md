# Changelog

Versions follow semver 0.x — the JSON hook contract and UI are still evolving.
The app shows its version (from `build.sh`'s Info.plist) in the panel footer.

## 0.7.0 — 2026-07-07

Host-aware click routing — CLI chats stop opening VS Code.

- The hook records where each session lives (`host`/`host_app`/`host_pid`) from its
  process ancestry: VS Code, or a terminal app (iTerm, Terminal, Ghostty, tmux…).
- Clicking a terminal-hosted card (or its notification) focuses that terminal app
  instead of wrongly opening VS Code. App-level focus only — no tab/pane targeting,
  and tmux-server sessions can't be focused (not a GUI app).
- Terminal-hosted cards show their host app name next to repo · branch.
- README redesign: centered hero + badges, glyph status table, mermaid data-flow
  diagram, collapsible hook reference, fresh 0.6.0 screenshot.

## 0.6.0 — 2026-07-07

Menu-style visual redesign and summary hardening.

- Working chats show the animated Claude spark (the CLI's thinking glyphs, Claude
  orange) in the menu bar and on cards, with a live monospaced turn clock
  ("2m 52s"). The animation timer only runs while a foreground turn is working.
- Finished chats get a green ✓ in both the bar and cards — no longer lumped with
  idle sessions as a grey dot.
- Sectioned panel: dim Sessions/Options headers, real NSSwitch toggles for
  Notifications and AI summaries, version + Quit (⌘Q works) footer, thinner
  translucent card fills, native selection-vibrancy hover.
- AI summaries no longer answer the prompt instead of labeling it: the message is
  framed as untrusted data, answer-shaped outputs (dialogue openers, questions,
  sentence length) are rejected in favor of raw text, and rejections are cached so
  they don't retry every poll. Summary cache key bumped to flush old poisoned labels.

## 0.5.0 — 2026-07-07

Session lifecycle correctness (cmux-inspired).

- Dead sessions are reaped by PID + process start time, so a closed window or crash
  no longer leaves a "working" card until the 24h prune.
- A Stop with background tasks/crons still running keeps the card working
  (`background: true`) instead of announcing a finish.
- Claude's closing message is captured on a true finish and shown on the card and
  in the finished notification.
- Notifications are keyed per chat and withdrawn when the state they announced is
  no longer true.

## 0.4.0 — 2026-07-06

User labels.

- Inline card rename via hover ✎, evolved into user labels: the label replaces
  repo · branch as the card's name and is used in notifications. Kept app-side in
  UserDefaults so hook writes can never clobber them.

## 0.3.0 — 2026-07-06

Richer states from the full hook surface.

- `error` status from StopFailure with typed reasons (rate limit, auth, overloaded…) —
  a dead turn no longer looks working forever.
- Typed waits: permission / question / reply / MCP, with the exact blocked-on text
  from PermissionRequest and AskUserQuestion.
- Tool-failure streak surfacing, true turn durations (aged from UserPromptSubmit),
  a 5-minute "still waiting" nag, and the ⌃⌥C global hotkey.

## 0.2.0 — 2026-07-06

UX + correctness round.

- PostToolUse hook keeps working cards fresh; per-card delete; Esc and outside
  clicks dismiss the panel; right-click context menu; AI summaries persisted
  across relaunches.

## 0.1.0 — 2026-07-06

Initial release.

- `update_status.py` hook script + single-file AppKit menu bar app connected by
  JSON files in `~/.claude/chat-status/`.
- Menu bar counts per status, card dropdown, on-device AI summaries (macOS 26+),
  click-to-focus VS Code with session deep link, notifications on needs-you /
  errored / finished transitions, `install.sh` hook wiring.
