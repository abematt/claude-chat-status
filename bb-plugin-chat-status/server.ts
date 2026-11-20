// bb-plugin-chat-status — backend entry.
//
// Reads the status files the Chat Status hook writes
// (~/.claude/chat-status/<session_id>.json) and serves them to the sidebar UI
// in app.tsx. It never writes them: the hook owns the files and the menu bar
// app prunes them. Project colors come from the menu bar app's own
// preferences, so a repo has the same color here as on its card.
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { startFeed } from "./feed";
import { threadRepos } from "./repos";

const chatSchema = z.object({
  sessionId: z.string(),
  /** live | working | needs_input | error | done */
  status: z.string(),
  repo: z.string(),
  /** Repos its latest tool calls worked in, most recent first; may be empty. */
  reposTouched: z.array(z.string()),
  branch: z.string(),
  title: z.string(),
  /** What the chat is blocked on, when status is needs_input. */
  waitingOn: z.string(),
  errorType: z.string(),
  /** A finished turn that still has background work running. */
  background: z.boolean(),
  /** Epoch seconds; 0 when unknown. */
  turnStartedAt: z.number(),
  updatedAt: z.number(),
  /** vscode | terminal */
  host: z.string(),
  hostApp: z.string(),
  agent: z.string(),
  /** The bb thread running this chat, or "" for a chat outside bb. */
  bbThread: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const rpcContract = defineRpcContract({
  chats_list: {
    input: z.null(),
    output: z.object({
      chats: z.array(chatSchema),
      /** Lowercased repo name -> palette slot, as the menu bar app assigned. */
      colorSlots: z.record(z.string(), z.number()),
    }),
  },
  /** Repos each thread's latest working turn touched, from bb's tool-call history. */
  thread_repos: {
    input: z.object({
      threads: z
        .array(z.object({ id: z.string().regex(/^thr_[A-Za-z0-9]+$/), path: z.string() }))
        .max(60),
    }),
    output: z.object({ repos: z.record(z.string(), z.array(z.string())) }),
  },
  chats_open: {
    input: z.object({ sessionId: z.string() }),
    output: z.object({ opened: z.boolean() }),
  },
});

/** Realtime channel app.tsx listens on; published when a status file changes. */
const CHATS_CHANGED = "chats-changed";
const PREFS_DOMAIN = "com.measure.chatstatus";
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function statusDir(): string {
  return process.env.CHAT_STATUS_DIR || join(homedir(), ".claude", "chat-status");
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type RawChat = Chat & { cwd: string; hostPid: number };

async function readChats(): Promise<RawChat[]> {
  let names: string[];
  try {
    names = await readdir(statusDir());
  } catch {
    return [];
  }
  const chats: RawChat[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith("_") || name.startsWith(".")) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(statusDir(), name), "utf8"));
      if (parsed === null || typeof parsed !== "object") continue;
      raw = parsed as Record<string, unknown>;
    } catch {
      continue; // mid-write or not ours
    }
    const sessionId = str(raw.session_id) || name.slice(0, -".json".length);
    // A session that died without a SessionEnd leaves its file behind until
    // the menu bar app reaps it; do not show it meanwhile.
    const pid = num(raw.pid);
    if (pid > 0 && !processAlive(pid)) continue;
    chats.push({
      sessionId,
      status: str(raw.status) || "live",
      repo: str(raw.repo),
      reposTouched: Array.isArray(raw.repos_touched)
        ? raw.repos_touched.filter(
            (name): name is string => typeof name === "string" && name !== "",
          )
        : [],
      branch: str(raw.branch),
      title: str(raw.bb_title) || str(raw.title) || str(raw.last_prompt),
      waitingOn: str(raw.waiting_on),
      errorType: str(raw.error_type),
      background: raw.background === true,
      turnStartedAt: num(raw.turn_started_at),
      updatedAt: num(raw.updated_at),
      host: str(raw.host) || "vscode",
      hostApp: str(raw.host_app),
      agent: str(raw.agent),
      bbThread: str(raw.bb_thread),
      cwd: str(raw.cwd),
      hostPid: num(raw.host_pid),
    });
  }
  return chats;
}

/** One dictionary from the menu bar app's preferences, as JSON. */
async function readPrefsDictionary(key: string): Promise<Record<string, unknown>> {
  const json = await run("/bin/sh", [
    "-c",
    `/usr/bin/defaults export ${PREFS_DOMAIN} - | /usr/bin/plutil -extract ${key} json -o - -`,
  ]);
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export default async function plugin(bb: BbPluginApi) {
  // Preferences change rarely (a new repo, a rename); read them at most every
  // ten seconds rather than on each status-file write.
  let prefs: {
    at: number;
    colorSlots: Record<string, number>;
    labels: Record<string, string>;
  } | null = null;
  async function readPrefs() {
    if (prefs !== null && Date.now() - prefs.at < 10_000) return prefs;
    const [slots, labels] = await Promise.all([
      readPrefsDictionary("projectColors"),
      readPrefsDictionary("labels"),
    ]);
    const colorSlots: Record<string, number> = {};
    for (const [repo, slot] of Object.entries(slots)) {
      if (typeof slot === "number") colorSlots[repo.toLowerCase()] = slot;
    }
    const names: Record<string, string> = {};
    for (const [sessionId, label] of Object.entries(labels)) {
      if (typeof label === "string" && label !== "") names[sessionId] = label;
    }
    prefs = { at: Date.now(), colorSlots, labels: names };
    return prefs;
  }

  // A thread's repos change only when it runs, so remember the answer until
  // bb says the thread moved.
  const repoCache = new Map<string, string[]>();
  const threadMoved = ({ thread }: { thread: { id: string } }) => {
    repoCache.delete(thread.id);
    bb.realtime.publish(CHATS_CHANGED, {});
  };
  bb.events.on("thread.active", threadMoved);
  bb.events.on("thread.idle", threadMoved);

  bb.rpc.register(rpcContract, {
    thread_repos: async ({ threads }) => {
      const repos: Record<string, string[]> = {};
      for (const { id, path } of threads) {
        let found = repoCache.get(id);
        if (found === undefined) {
          try {
            found = await threadRepos(bb, id, path);
            repoCache.set(id, found);
          } catch (error) {
            // Not cached: the next request tries again.
            bb.log.warn(`repos for ${id}: ${String(error)}`);
            found = [];
          }
        }
        repos[id] = found;
      }
      return { repos };
    },
    chats_list: async () => {
      const [chats, { colorSlots, labels }] = await Promise.all([readChats(), readPrefs()]);
      return {
        chats: chats.map(({ cwd: _cwd, hostPid: _hostPid, ...chat }) => ({
          ...chat,
          title: labels[chat.sessionId] ?? chat.title,
        })),
        colorSlots,
      };
    },
    // Same routing as a click on the menu bar app's card, for chats outside bb.
    chats_open: async ({ sessionId }) => {
      if (!SESSION_ID.test(sessionId)) return { opened: false };
      const chat = (await readChats()).find((candidate) => candidate.sessionId === sessionId);
      if (chat === undefined) return { opened: false };
      if (chat.host === "terminal") {
        if (chat.hostPid <= 0) return { opened: false };
        await run("/usr/bin/osascript", [
          "-e",
          `tell application "System Events" to set frontmost of (first process whose unix id is ${Math.trunc(chat.hostPid)}) to true`,
        ]);
        return { opened: true };
      }
      if (chat.cwd !== "") {
        await run("/usr/bin/open", ["-b", "com.microsoft.VSCode", chat.cwd]);
      }
      if (chat.agent !== "codex") {
        // The deep link belongs to the Claude Code extension; give the window
        // a moment to come forward first.
        setTimeout(
          () => {
            void run("/usr/bin/open", [
              "-b",
              "com.microsoft.VSCode",
              `vscode://anthropic.claude-code/open?session=${sessionId}`,
            ]);
          },
          chat.cwd === "" ? 0 : 800,
        );
      }
      return { opened: true };
    },
  });

  // Tell open windows when a status file changes. Hooks write through a tmp
  // file and a rename, several times a second during a turn, so coalesce.
  let watcher: FSWatcher | null = null;
  let pending: NodeJS.Timeout | null = null;
  try {
    watcher = watch(statusDir(), () => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        bb.realtime.publish(CHATS_CHANGED, {});
      }, 200);
    });
    watcher.on("error", (error) => bb.log.warn(`status watcher: ${String(error)}`));
  } catch (error) {
    // No status directory yet: the UI still polls.
    bb.log.warn(`not watching ${statusDir()}: ${String(error)}`);
  }

  // Cards for bb threads from bb's own events (feed.ts). On by default;
  // `bb plugin config chat-status set feed false` turns it off.
  const settings = bb.settings.define({
    feed: {
      type: "boolean",
      label: "Make cards from bb's thread events",
      default: true,
    },
  });
  if ((await settings.get()).feed) startFeed(bb, statusDir);

  bb.onDispose(() => {
    watcher?.close();
    if (pending !== null) clearTimeout(pending);
  });
}
