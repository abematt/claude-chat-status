# bb-plugin-chat-status

A [bb](https://getbb.app) plugin that puts Chat Status in bb's sidebar. It
reads the status files the hook in this repo writes
(`~/.claude/chat-status/<session_id>.json`) and never writes them.

- **Thread rows** get a metadata item: the project in its color, then the turn
  clock while the chat works, or what it is blocked on while it waits.
- **Sidebar footer** gets a *Chats outside bb* item listing the chats running
  in VS Code or a terminal. A click routes to the chat the way a card does.

Project colors come from the menu bar app's `projectColors` preference, so a
repo has the same color here as on its card.

## Install

```bash
cd bb-plugin-chat-status
npm install
bb plugin install . --yes
bb settings experiment threadRowMetadata true   # row metadata is off by default
bb thread-list prefs set showRowMetadata true
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
