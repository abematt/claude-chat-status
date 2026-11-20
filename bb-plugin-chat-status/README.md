# bb-plugin-chat-status

A [bb](https://getbb.app) plugin that puts Chat Status in bb's sidebar. It
reads the status files the hook in this repo writes
(`~/.claude/chat-status/<session_id>.json`). Its events feed (below) also
writes them for bb threads.

- **The thread list becomes "Today".** It replaces bb's list (the
  `experimental_threadList` slot) with a card for each thread that ran since
  local midnight, is busy or waiting now, or is pinned. A card shows the
  title, the project in its color, and the turn clock while the chat works,
  what it is blocked on while it waits, or how long ago it ran. Cards that
  need you come first and are tinted. Everything older folds under
  **Earlier**, which opens by itself when nothing ran today. Nothing is
  stored, so the list resets overnight. Right-click is bb's own thread menu.
  To go back to bb's list, pin it under Settings → Appearance → Sidebar.
- **Repos are short tags.** A card shows one tag per repo the thread worked
  in, busiest first, up to three and then a count. `shortRepo()` in
  `app.tsx` drops a `measure-` prefix (`measure-sampler` → `sampler`);
  `REPO_SHORT` lists the names that rule gets wrong (`measure-contributor-web`
  → `contributor`, `measure-web` → `msr-web`). Add a line there for a new
  one. Hover a tag for the full name.
- **Not carried over from bb's list:** drag-to-reorder, sections, and
  sub-thread nesting (a sub-thread is its own card).
- **The project is the repo the thread worked in**, not the folder it was
  opened on. `repos.ts` reads the thread's tool calls from bb
  (`threads.events.list`) and applies the hook's rules: an edit, or two
  touches in a turn, shows a repo, and the busiest repo leads.
- **Sidebar footer** gets a *Chats outside bb* item listing the chats running
  in VS Code or a terminal. A click routes to the chat the way a card does.

Project colors come from the menu bar app's `projectColors` preference, so a
repo has the same color here as on its card.

## Cards from bb's events

`feed.ts` listens to bb's thread events and writes status files itself, so
the menu bar app and the pop-out show bb threads the hook does not reach.

- No hook file for the thread: the feed owns `bb-<threadId>.json` and writes
  the whole card.
- The hook covers the thread: the feed leaves that file to the hook and only
  marks a question or form the hook cannot see, or a turn bb reports failed.
  It waits three seconds first, so the hook always speaks first.

Turn it off with `bb plugin config chat-status set feed false`, then
`bb plugin reload chat-status`. `bb plugin logs chat-status` shows each event
it handled.

## Install

```bash
cd bb-plugin-chat-status
npm install
bb plugin install . --yes
```

## Develop

```bash
bb plugin dev            # rebuild and reload on every save
npx tsc -p .             # typecheck
bb plugin rpc call chat-status chats_list --json   # what the UI receives
bb plugin logs chat-status
```

`server.ts` is the backend (reads the files, watches the directory, opens
chats). `app.tsx` is the sidebar UI. The palette in `app.tsx` (`PROJECT_HUES`,
`STATUS_HUE`) is a copy of `ProjectStyle.hues` and `Palette` in
`ChatStatusBar.swift`; keep them in step.

The sidebar slots it uses are all `experimental_` in bb's plugin SDK, so a bb
update can change them. `bb plugin types` repins the SDK.
