See what every agent chat is doing from bb's sidebar, including the ones
running outside bb.

## What you get

- On each thread row: the project in its own color, a live turn clock while
  the agent works, and what it is blocked on while it waits for you. Other
  rows show how long ago the chat last ran, with recent ones in green.
- A **Chats outside bb** item in the sidebar footer that lists the chats
  running in VS Code or a terminal. Click one to jump to it.

## What it needs

The Chat Status menu bar app and its hook, which write
one status file per chat to `~/.claude/chat-status/`. This plugin only reads
those files. Without them the rows still show the project name.

Row metadata is off in bb by default. Turn it on once:

    bb settings experiment threadRowMetadata true
    bb thread-list prefs set showRowMetadata true
