# Changelog

Versions follow semver 0.x — the JSON hook contract and UI are still evolving.
The app shows its version (from `build.sh`'s Info.plist) in the panel footer.

## 0.10.1 — 2026-11-18

- **Opening a chat no longer creates a card.** A card now appears with the
  first prompt you send. Before, every chat tab an editor opened or restored
  showed up as an idle card. A chat that already has a card still goes *idle*
  when its session restarts.
- Removing a card mid-turn now sticks until that chat's next prompt, instead of
  the next tool event bringing it back.
- `CHAT_STATUS_DIR` points the app at another directory of status files, and
  `CHAT_STATUS_APPEARANCE=light|dark` pins the appearance — for demo
  screenshots and testing without live chats.

## 0.10.0 — 2026-11-18

A pop-out gallery that stays on screen while you work.

- **Pop-out gallery**: a floating, draggable grid of small square cards, one
  per chat. Each card takes a soft wash of its status colour — clay while
  working (with the animated spark and a live turn clock), green when finished,
  orange or red with a matching edge when a chat needs you or errored. Click a
  card to jump to the chat. Toggle with **⌃⌥⇧C**, the "Pop-out gallery" OPTIONS
  switch, or the right-click menu; open state and position persist across
  launches.
- Hover a tile for a ✕ that removes it from the list — handy for hosts with no
  way to close a session. Rename and reorder stay in the dropdown, and the
  gallery follows the dropdown's order.
- `defaults write com.measure.chatstatus galleryColumns -int <n>` sets the
  column count (default 3); `galleryHotkeyKeyCode` / `galleryHotkeyModifiers`
  rebind the shortcut.

## 0.9.0 — 2026-07-13

Card ordering you control, plus a discoverable toggle shortcut.

- Card order is now a choice: an **"Auto order"** toggle (in OPTIONS and the
  right-click menu), on by default — the status sort where needs-input floats to
  the top, unchanged from before.
- Turn **Auto order off** for drag-to-reorder: drag a card to place it and the
  arrangement persists (in `cardOrder`). New sessions drop in at the top by
  recency; ended sessions fall out. Going manual keeps whatever order you're
  looking at, so nothing jumps.
- The panel header now shows the global toggle shortcut (default ⌃⌥C) as a
  keycap, so it's discoverable; it reflects a rebound hotkey.

## 0.8.0 — 2026-07-09

Pixel-mark redesign (design handoff 4e/4g) — new icon, glyph, and a
hairline-row dropdown that adapts to light/dark.

- App icon is now the "4e Cream" mark: a 2×2 grid of 8-bit window panes on a
  cream squircle, the tracked (top-right) pane lit in clay with a pixel sunburst
  on its corner — all drawn procedurally in `make-icon.swift`.
- Menu-bar item leads with the panes mark (a template glyph, no lit pane), shown
  only when everything is idle and hidden the moment there are counts to display.
  Working chats keep the animated Claude spark (the CLI thinking glyphs cycled in
  clay).
- Dropdown reskinned from floating grey cards to a hairline-row panel (384 pt,
  rounded, hairline border): SESSIONS/OPTIONS eyebrows, hairline-divided rows,
  repo · branch + status meta on one line, the title below, and a blocker /
  error / closing-message detail line.
- Neutral scheme is black/white and follows the system light/dark; only the
  status colors (clay working, orange needs-you, red error, green done, amber
  clock) carry hue. Custom monochrome toggles replace NSSwitch so their on-color
  doesn't pull in the system accent.

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
