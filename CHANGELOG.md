# Changelog

Versions follow semver 0.x — the JSON hook contract and UI are still evolving.
The app shows its version (from `build.sh`'s Info.plist) in the panel footer.

## 0.12.0 — 2026-11-18

Chat Status inside bb, and answering bb from the pop-out.

- **Cards name the repos a chat is working in.** A chat opened on a workspace
  folder of many repos used to show only that folder. The card now shows the
  repo its latest tool calls touched, with a count of any others
  (`measure-web +2`); hover a gallery card for the full list. A turn with no
  tool calls keeps the previous repos. Clicks still open the folder the chat
  started in. With several repos, the one with the most activity leads. A repo shows once the chat has edited a file in it or touched
  it twice in the turn, so a single `ls` of a neighbouring repo does not put
  it on the card.
- **Claude chats run by bb carry a Claude spark** beside the bb icon. bb runs
  both agents, so an unmarked card no longer has to mean Claude. Chats in
  VS Code and terminals stay unmarked.
- **bb chats use bb's own title.** bb names each thread with its AI service,
  from the whole conversation. A bb card now shows that title instead of the
  on-device summary of one prompt, and shows it even with summaries off. A
  label you set by hand still wins.
- **bb sidebar plugin** (`bb-plugin-chat-status/`). It replaces bb's
  thread list with *Today*: a card for each thread that ran today, is busy
  or waiting now, or is pinned. A card shows the project in its color, a
  live turn clock while the agent works, what it is blocked on while it
  waits, or how long ago it ran. Cards that need you come first. Older
  threads fold under *Earlier*, and the list resets overnight. The project
  named is a short tag per repo (`contributor`, `msr-web`; up to three,
  then a count), for the repo the thread worked in, read from
  bb's own record of its tool calls, so it works for every bb thread. A *Chats outside bb* item
  in the sidebar footer lists the chats running in VS Code or a terminal;
  click one to jump to it. Install steps are in the plugin's README.
- **Cards from bb's own events.** The plugin now listens to bb's thread
  events. A bb thread whose agent has no hook gets a full card: working,
  needs you, failed, finished. For Claude and Codex threads, which the hook
  already covers, it fills two gaps: a question or form bb is waiting on, and
  a turn bb reports as failed. Turn it off with
  `bb plugin config chat-status set feed false`.
- **Allow or deny a bb permission from the pop-out.** Hover a bb card that is
  waiting on a permission and its foot shows *Deny* and *Allow*. They answer
  the prompt through bb, so you stay in the app you are in. If bb has nothing
  to approve (the chat was asking a question, or you already answered), the
  click opens the thread instead.

## 0.11.0 — 2026-11-18

Codex chats, exact-thread clicks for bb, and cards you can tell apart at a
glance.

- **Project colors.** Every repo gets its own color, shown on the repo name in
  the dropdown and as a pill on gallery cards. A repo keeps its color for
  good, and repos on screen together get different ones.
- **Source icons.** The host app (VS Code, bb, a terminal) shows as its app
  icon instead of a text tag, with a second icon for Codex chats. Gallery
  cards now lead with the project, then a two-line title.

- **Codex support.** `install.sh` now also registers the hook in
  `~/.codex/hooks.json` when Codex is installed, so Codex chats get cards
  wherever they run: the CLI, the VS Code extension, or bb. Cards are tagged
  *Codex*. Codex runs a new hook only after you trust it — run `/hooks` in
  Codex once after installing.
- Codex has no error or notification hooks, so its cards show working, needs
  permission, finished and idle (after you interrupt a turn), but not errored.
  Clicking a Codex card in VS Code focuses the repo window; there is no deep
  link to the conversation.
- Codex chats inside bb open their exact thread too. bb shares one Codex
  process across threads, so the hook finds the thread in bb's database.
- **Clicking a bb chat opens that thread.** bb exports its thread id to the
  agents it runs; the hook records it as `bb_thread`, and a click runs
  `bb thread open <id>` before raising the app. Before, a click only brought
  bb to the front. Applies from a chat's next prompt.

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
