See what every agent chat is doing from bb's sidebar, including the ones
running outside bb.

## What you get

- A **Today** thread list: one card for each thread you ran today, with the
  repo it worked in (in its own color), a live turn clock while the agent
  works, and what it is blocked on while it waits for you. Threads that need
  you come first. Older threads fold under **Earlier**, and the list resets
  overnight. Pin a thread to keep its card. Repos show as short tags
  (`contributor`, `msr-web`), one per repo the thread worked in.
- A **Chats outside bb** item in the sidebar footer that lists the chats
  running in VS Code or a terminal. Click one to jump to it.

## What it needs

The Chat Status menu bar app and its hook, which write
one status file per chat to `~/.claude/chat-status/`. This plugin only reads
those files. Without them the cards still show the repo and when the
thread last ran.

To return to bb's own thread list, choose it under Settings → Appearance →
Sidebar.
