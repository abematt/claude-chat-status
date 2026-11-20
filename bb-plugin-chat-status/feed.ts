// The bb events feed: turns bb's own thread events into Chat Status status
// files, so a bb thread gets a card without any agent hook.
//
// Two cases, decided per thread on every event:
//
//   - The hook already writes a file for the thread (Claude Code, a trusted
//     Codex). That file stays the hook's. The feed only fills two gaps the
//     hook cannot see, and only after giving the hook time to speak first: a
//     question or form bb is waiting on, and a turn bb reports as failed.
//
//   - No hook file. The feed owns `bb-<threadId>.json` and writes the whole
//     card: working, needs you, failed, finished.
//
// Like the hook, only a turn starting creates a card; a card removed by hand
// stays gone until the thread's next turn.
import { execFile } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Json = Record<string, unknown>;

/** How long the hook gets to write first before the feed acts. */
const HOOK_GRACE_MS = 3000;
/** Providers whose agents can run the Chat Status hook. */
const HOOKED_PROVIDERS = new Set(["claude-code", "codex"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function obj(value: unknown): Json {
  return value !== null && typeof value === "object" ? (value as Json) : {};
}
function oneLine(text: string, max: number): string {
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, max);
}
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** bb's title, unless it still carries mention tokens only bb can resolve. */
function threadTitle(thread: Json): string {
  const title = oneLine(str(thread.title), 120);
  return /@(thread|project|section):/.test(title) ? "" : title;
}

function hasBackgroundWork(thread: Json): boolean {
  return Object.values(obj(thread.activity)).some(
    (count) => typeof count === "number" && count > 0,
  );
}

/** What a pending interaction is waiting on, in the hook's vocabulary. */
function describeInteraction(interaction: Json): { kind: string; text: string } {
  const payload = obj(interaction.payload ?? interaction);
  const kind = str(payload.kind);
  const title = str(payload.title);
  if (kind === "approval" || kind === "permission_grant") {
    const subject = obj(payload.subject);
    const detail = str(subject.command) || str(subject.path) || str(subject.kind);
    return { kind: "permission", text: oneLine(detail || title || "Needs approval", 160) };
  }
  if (kind === "user_question") {
    const first = obj((Array.isArray(payload.questions) ? payload.questions : [])[0]);
    return { kind: "question", text: oneLine(str(first.prompt) || title, 160) };
  }
  // Plugin forms and provider requests (an MCP elicitation, a secrets form).
  return { kind: "mcp", text: oneLine(title || str(obj(payload.data).message), 160) };
}

/** The GUI app this server runs under: the topmost ancestor below launchd. */
function hostAppPid(): Promise<number> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-Ax", "-o", "pid=,ppid="], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(0);
      const parent = new Map<number, number>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid !== undefined && ppid !== undefined) parent.set(pid, ppid);
      }
      let current = process.pid;
      for (let depth = 0; depth < 25; depth += 1) {
        const up = parent.get(current);
        if (up === undefined || up <= 1) break;
        current = up;
      }
      resolve(current === process.pid ? 0 : current);
    });
  });
}

export function startFeed(bb: BbPluginApi, statusDir: () => string): void {
  const hostPid = hostAppPid();
  const timers = new Set<NodeJS.Timeout>();
  bb.onDispose(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  function later(ms: number, work: () => Promise<void>): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      work().catch((error) => bb.log.warn(`feed: ${String(error)}`));
    }, ms);
    timers.add(timer);
  }

  const ownPath = (threadId: string) => join(statusDir(), `bb-${threadId}.json`);

  async function read(path: string): Promise<Json | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return parsed !== null && typeof parsed === "object" ? (parsed as Json) : null;
    } catch {
      return null;
    }
  }
  // Same atomic write as the hook: a tmp file, then a rename.
  async function write(path: string, entry: Json): Promise<void> {
    const tmp = `${path}.${process.pid}.feed.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, path);
  }

  /** The hook's file for a thread, if the hook is covering it. */
  async function hookFile(thread: Json): Promise<{ path: string; entry: Json } | null> {
    const threadId = str(thread.id);
    let names: string[];
    try {
      names = await readdir(statusDir());
    } catch {
      return null;
    }
    const cwd = str(thread.environmentPath);
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith("bb-") || name.startsWith("_")) continue;
      const path = join(statusDir(), name);
      const entry = await read(path);
      if (entry === null) continue;
      if (str(entry.bb_thread) === threadId) return { path, entry };
      // A Codex chat learns its bb thread a few events late; until then,
      // match it by where it runs and how recently it wrote.
      if (
        str(entry.bb_thread) === "" &&
        str(entry.host_app) === "bb" &&
        cwd !== "" &&
        str(entry.cwd) === cwd &&
        typeof entry.updated_at === "number" &&
        nowSeconds() - entry.updated_at < 15
      ) {
        return { path, entry };
      }
    }
    return null;
  }

  /**
   * Apply a change to the feed's own card for a thread. Steps aside (and
   * removes its card) when the hook covers the thread. `create` is set only
   * for a turn starting.
   */
  async function updateOwn(
    thread: Json,
    change: (entry: Json) => void,
    options: { create?: boolean } = {},
  ): Promise<void> {
    const threadId = str(thread.id);
    if (!/^thr_[A-Za-z0-9]+$/.test(threadId)) return;
    const path = ownPath(threadId);
    if ((await hookFile(thread)) !== null) {
      await rm(path, { force: true });
      return;
    }
    let entry = await read(path);
    if (entry === null) {
      if (options.create !== true) return;
      const cwd = str(thread.environmentPath);
      const folder = cwd.split("/").filter(Boolean).pop() ?? "";
      entry = {
        session_id: `bb-${threadId}`,
        // A personal thread's folder is its thread id; "bb" reads better.
        repo: folder === "" || folder.startsWith("thr_") ? "bb" : folder,
        branch: str(thread.environmentBranchName),
        cwd,
        host: "terminal",
        host_app: "bb",
        host_pid: await hostPid,
        bb_thread: threadId,
        feed: true,
      };
      if (str(thread.providerId) === "codex") entry.agent = "codex";
    }
    const title = threadTitle(thread);
    if (title !== "") entry.bb_title = title;
    const name = title || oneLine(str(thread.titleFallback), 80);
    if (name !== "") entry.title = name;
    change(entry);
    entry.updated_at = nowSeconds();
    await write(path, entry);
  }

  function clearWaiting(entry: Json): void {
    delete entry.waiting_on;
    delete entry.waiting_kind;
    delete entry.waiting_rich;
    delete entry.feed_waiting;
  }

  bb.events.on("thread.active", ({ thread }) => {
    const t = obj(thread);
    bb.log.info(`feed: active ${str(t.id)} (${str(t.providerId)})`);
    // An agent with the hook writes its own card on the same prompt; wait
    // for it rather than race it into two cards.
    const grace = HOOKED_PROVIDERS.has(str(t.providerId)) ? HOOK_GRACE_MS : 0;
    const startedAt = nowSeconds();
    later(grace, () =>
      updateOwn(
        t,
        (entry) => {
          // bb re-enters `active` after an answered prompt too; only a turn
          // that starts from rest restarts the clock.
          if (entry.status !== "working" && entry.status !== "needs_input") {
            entry.turn_started_at = startedAt;
            delete entry.last_message;
          }
          entry.status = "working";
          clearWaiting(entry);
          delete entry.error_type;
          delete entry.background;
        },
        { create: true },
      ),
    );
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const t = obj(thread);
    bb.log.info(`feed: idle ${str(t.id)}`);
    void updateOwn(t, (entry) => {
      clearWaiting(entry);
      delete entry.error_type;
      if (hasBackgroundWork(t)) {
        entry.status = "working";
        entry.background = true;
        return;
      }
      entry.status = "done";
      delete entry.background;
      const message = oneLine(lastAssistantText ?? "", 200);
      if (message !== "") entry.last_message = message;
    }).catch((error) => bb.log.warn(`feed: ${String(error)}`));
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const t = obj(thread);
    const reason = oneLine(error ?? "", 80);
    bb.log.info(`feed: failed ${str(t.id)}: ${reason}`);
    later(HOOK_GRACE_MS, async () => {
      const hook = await hookFile(t);
      if (hook !== null) {
        // The hook has no error event for Codex, and none at all when bb
        // fails a turn before the agent runs: still "working" means it
        // missed this.
        const entry = await read(hook.path);
        if (entry !== null && entry.status === "working") {
          entry.status = "error";
          entry.error_type = reason;
          entry.updated_at = nowSeconds();
          await write(hook.path, entry);
        }
      }
      await updateOwn(t, (entry) => {
        entry.status = "error";
        entry.error_type = reason;
        clearWaiting(entry);
      });
    });
  });

  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    const t = obj(thread);
    const waiting = describeInteraction(obj(interaction));
    bb.log.info(`feed: pending ${str(t.id)} ${waiting.kind}: ${waiting.text}`);
    const flag = (entry: Json) => {
      entry.status = "needs_input";
      entry.waiting_kind = waiting.kind;
      if (waiting.text !== "") entry.waiting_on = waiting.text;
      entry.waiting_rich = true;
      entry.feed_waiting = true;
    };
    later(HOOK_GRACE_MS, async () => {
      const hook = await hookFile(t);
      if (hook !== null) {
        // The hook reports permissions itself; a question or a form that it
        // has no event for leaves its card on "working".
        const entry = await read(hook.path);
        if (entry !== null && entry.status === "working") {
          flag(entry);
          entry.updated_at = nowSeconds();
          await write(hook.path, entry);
        }
      }
      await updateOwn(t, flag);
    });
  });

  // No event says a prompt was answered. This one fires (at most once a
  // second) whenever the thread moves, with its current state: a thread that
  // no longer has a pending interaction is working again.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    const t = obj(thread);
    if (t.hasPendingInteraction === true || str(t.status) !== "active") return;
    const resume = (entry: Json): boolean => {
      if (entry.status !== "needs_input" || entry.feed_waiting !== true) return false;
      entry.status = "working";
      clearWaiting(entry);
      entry.updated_at = nowSeconds();
      return true;
    };
    void (async () => {
      const hook = await hookFile(t);
      if (hook !== null) {
        if (resume(hook.entry)) await write(hook.path, hook.entry);
        return;
      }
      const path = ownPath(str(t.id));
      const entry = await read(path);
      if (entry !== null && resume(entry)) await write(path, entry);
    })().catch((error) => bb.log.warn(`feed: ${String(error)}`));
  });

  const remove = ({ thread }: { thread: unknown }) => {
    void rm(ownPath(str(obj(thread).id)), { force: true }).catch(() => undefined);
  };
  bb.events.on("thread.archived", remove);
  bb.events.on("thread.deleted", remove);

  // Events are not replayed for the time the plugin was unloaded: settle the
  // feed's own cards against what bb says now.
  later(0, async () => {
    let names: string[];
    try {
      names = await readdir(statusDir());
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^bb-(thr_[A-Za-z0-9]+)\.json$/.exec(name);
      if (match === null) continue;
      const path = join(statusDir(), name);
      let thread: Json;
      try {
        thread = obj(await bb.sdk.threads.get({ threadId: match[1]! }));
      } catch {
        await rm(path, { force: true }); // the thread is gone
        continue;
      }
      if (thread.archivedAt != null || thread.deletedAt != null) {
        await rm(path, { force: true });
        continue;
      }
      const entry = await read(path);
      if (entry === null) continue;
      const busy = entry.status === "working" || entry.status === "needs_input";
      if (busy && str(thread.status) === "idle" && thread.hasPendingInteraction !== true) {
        entry.status = "done";
        clearWaiting(entry);
        entry.updated_at = nowSeconds();
        await write(path, entry);
      }
    }
  });
}
