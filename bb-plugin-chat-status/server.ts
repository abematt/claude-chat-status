// bb-plugin-chat-status — backend entry.
//
// Reads the status files the Chat Status hook writes
// (~/.claude/chat-status/<session_id>.json) and serves them to the sidebar UI
// in app.tsx. It never writes them: the hook owns the files and the menu bar
// app prunes them. Project colors come from the menu bar app's own
// preferences, so a repo has the same color here as on its card.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** The private tracker (~/.worklog, via the `worklog` CLI) for the For me card. */
  worklog_state: {
    input: z.null(),
    output: worklogStateSchema(),
  },
});

function worklogStateSchema() {
  const item = z.object({
    id: z.number(),
    title: z.string(),
    status: z.string(),
    project: z.string(),
    stream: z.string(),
    why: z.string(),
  });
  return z.object({
    available: z.boolean(),
    mode: z.string(),
    counts: z.record(z.string(), z.number()),
    today: z.array(item),
    week: z.array(item),
    dontForget: z.array(item),
    toConfirm: z.array(item),
    proposals: z.number(),
    latestCheckin: z.object({ kind: z.string(), text: z.string(), at: z.string() }).nullable(),
    /** Today's For me thread, when the morning check-in has made one. */
    todayThread: z.string(),
    collectorThread: z.string(),
  });
}
export type WorklogState = z.infer<ReturnType<typeof worklogStateSchema>>;

/** Realtime channel app.tsx listens on; published when a status file changes. */
const CHATS_CHANGED = "chats-changed";
/** Published when the tracker changes (a tick in the hub, or the store file moved). */
const WORKLOG_CHANGED = "worklog-changed";
const PREFS_DOMAIN = "com.measure.chatstatus";
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function statusDir(): string {
  return process.env.CHAT_STATUS_DIR || join(homedir(), ".claude", "chat-status");
}

function run(command: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
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

// ---- the private tracker ----

const WORKLOG_HOME = join(homedir(), ".worklog");
const WORKLOG_CLI = join(homedir(), ".local", "bin", "worklog");
const THREAD_ID = /^thr_[A-Za-z0-9]+$/;
/** The hub web page (worklog/hub/server.py), bound to this Mac only. */
export const HUB_URL = "http://127.0.0.1:7377/";

async function hubUp(): Promise<boolean> {
  try {
    const response = await fetch(`${HUB_URL}healthz`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the hub next to the worklog CLI unless one is already serving. */
async function startHub(log: (message: string) => void): Promise<ChildProcess | null> {
  if (await hubUp()) return null;
  let script: string;
  try {
    script = join(dirname(await realpath(WORKLOG_CLI)), "hub", "server.py");
  } catch {
    return null; // no tracker on this machine
  }
  const child = spawn("/usr/bin/env", ["python3", script, "--port", "7377"], { stdio: "ignore" });
  child.on("error", (error) => log(`hub: ${String(error)}`));
  return child;
}

async function worklogJson(args: string[]): Promise<unknown> {
  const out = await run(WORKLOG_CLI, args, 10_000);
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function readThreadId(file: string): Promise<string> {
  try {
    const id = (await readFile(join(WORKLOG_HOME, file), "utf8")).trim();
    return THREAD_ID.test(id) ? id : "";
  } catch {
    return "";
  }
}

function toItem(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: num(r.id),
    title: str(r.title),
    status: str(r.status),
    project: str(r.project),
    stream: str(r.stream),
    why: str(r.why) || (r.carried_over === true ? "carried over" : ""),
  };
}

async function readWorklog(): Promise<WorklogState> {
  const [board, todayThread, collectorThread] = await Promise.all([
    worklogJson(["board", "--json"]),
    readThreadId("today-thread.txt"),
    readThreadId("collector-thread.txt"),
  ]);
  const b = (board ?? {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(b[key]) ? (b[key] as unknown[]).map(toItem) : []);
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries((b.counts ?? {}) as Record<string, unknown>)) {
    if (typeof value === "number") counts[key] = value;
  }
  const checkin = b.latest_checkin as Record<string, unknown> | null | undefined;
  return {
    available: board !== null,
    mode: str(b.mode) || "live",
    counts,
    today: list("today"),
    week: list("week"),
    dontForget: list("dont_forget").slice(0, 8),
    toConfirm: list("to_confirm"),
    proposals: counts.proposals ?? 0,
    latestCheckin: checkin
      ? { kind: str(checkin.kind), text: str(checkin.text), at: str(checkin.created_at) }
      : null,
    todayThread,
    collectorThread,
  };
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
    worklog_state: async () => readWorklog(),
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

  // The tracker: watch ~/.worklog so the card and hub follow the collector and
  // check-ins without polling hard. SQLite in WAL mode writes the -wal file.
  let worklogWatcher: FSWatcher | null = null;
  let worklogPending: NodeJS.Timeout | null = null;
  try {
    worklogWatcher = watch(WORKLOG_HOME, () => {
      if (worklogPending !== null) return;
      worklogPending = setTimeout(() => {
        worklogPending = null;
        bb.realtime.publish(WORKLOG_CHANGED, {});
      }, 1000);
    });
    worklogWatcher.on("error", () => undefined);
  } catch {
    // No tracker on this machine: the card shows nothing.
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

  const hub = await startHub((message) => bb.log.warn(message));

  bb.onDispose(() => {
    watcher?.close();
    if (pending !== null) clearTimeout(pending);
    worklogWatcher?.close();
    hub?.kill();
    if (worklogPending !== null) clearTimeout(worklogPending);
  });
}
