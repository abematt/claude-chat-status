// Which repos a bb thread worked in, read from bb's own record of its tool
// calls. The same rules as the hook's `touched_repos` / `repo_of` in
// update_status.py (keep the two in step), so a row and a card agree. The
// hook only knows chats it ran in; this covers every bb thread, old ones
// included.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Json = Record<string, unknown>;

const REPOS_MAX = 6;
/** Evidence a repo needs in one turn before it is shown: an edit, or two touches. */
const REPO_SHOWN_AT = 2;
/** bb serves at most 100 events a request; look back this many requests. */
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function obj(value: unknown): Json {
  return value !== null && typeof value === "object" ? (value as Json) : {};
}

function kindOf(path: string): "dir" | "file" | null {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/**
 * Name of the git repo that holds `path`, or "". A linked worktree is named
 * after the repo it belongs to. Stops below the home directory.
 */
function repoOf(path: string): string {
  const home = homedir();
  let dir = kindOf(path) === "dir" ? path : dirname(path);
  for (let depth = 0; depth < 14; depth += 1) {
    if (dir === "" || dir === home || dir === dirname(dir)) break;
    const git = join(dir, ".git");
    const kind = kindOf(git);
    if (kind === "dir") return basename(dir);
    if (kind === "file") {
      try {
        const match = /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(
          readFileSync(git, "utf8").slice(0, 1024),
        );
        if (match?.[1] !== undefined) return basename(match[1]);
      } catch {
        // unreadable: fall through to the folder's own name
      }
      return basename(dir);
    }
    dir = dirname(dir);
  }
  return "";
}

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** The repos one tool call worked in, and what that is worth as evidence. */
function touched(item: Json, base: string): { names: string[]; worth: number } {
  const kind = str(item.type);
  const paths: string[] = [];
  const named = (value: unknown) => {
    const path = expand(str(value));
    if (path === "") return;
    if (isAbsolute(path)) paths.push(path);
    else if (base !== "") paths.push(join(base, path));
  };
  let worth = 1;
  if (kind === "fileChange") {
    worth = REPO_SHOWN_AT;
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      named(obj(change).path);
    }
  } else if (kind === "fileRead") {
    named(item.path);
  } else if (kind === "toolCall") {
    const args = obj(item.arguments);
    if (EDIT_TOOLS.has(str(item.tool))) worth = REPO_SHOWN_AT;
    named(args.file_path);
    named(args.path);
    named(args.notebook_path);
  } else if (kind === "commandExecution") {
    const cwd = str(item.cwd) || base;
    for (const word of str(item.command).split(/[\s;|&()<>="'`]+/).slice(0, 120)) {
      if (word === "" || word.startsWith("-") || word.includes("://") || word.length > 400) {
        continue;
      }
      const expanded = expand(word);
      const path = isAbsolute(expanded) ? expanded : cwd === "" ? "" : join(cwd, expanded);
      // Most words are not paths; only one that exists counts.
      if (path !== "" && kindOf(path) !== null) paths.push(path);
    }
    if (cwd !== "") paths.push(cwd);
  }
  const names: string[] = [];
  for (const path of paths) {
    const name = repoOf(normalize(path));
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return { names, worth };
}

/**
 * The repos of the thread's latest turn that worked in any, most recent
 * first. Empty when no recent turn did.
 */
export async function threadRepos(
  bb: BbPluginApi,
  threadId: string,
  base: string,
): Promise<string[]> {
  // Newest first. Evidence adds up within a turn; the first turn (walking
  // back) with a repo over the line is the answer.
  let turn: string | null = null;
  let hits = new Map<string, number>();
  // Most evidence first, so the repo the turn really worked in leads and one
  // it only read a few files from trails. The sort is stable: ties keep
  // their most-recent-first order.
  const shown = () =>
    [...hits]
      .filter(([, count]) => count >= REPO_SHOWN_AT)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  let beforeSeq: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: unknown = await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: String(PAGE_SIZE),
      types: ["item/started"],
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    const events: unknown[] = Array.isArray(result)
      ? result
      : Array.isArray(obj(result).events)
        ? (obj(result).events as unknown[])
        : [];
    for (const raw of events) {
      const event = obj(raw);
      const turnId = str(event.turnId) || str(event.turn_id);
      if (turn !== null && turnId !== turn) {
        const found = shown();
        if (found.length > 0) return found.slice(0, REPOS_MAX);
        hits = new Map();
      }
      turn = turnId;
      const item = obj(obj(event.data).item ?? event.item);
      const { names, worth } = touched(item, base);
      // Walking backward, so a repo first met here was touched later than
      // any met after it: insertion order is already most recent first.
      for (const name of names) hits.set(name, (hits.get(name) ?? 0) + worth);
    }
    const last = obj(events[events.length - 1]);
    const sequence = last.sequence ?? last.seq;
    if (events.length < PAGE_SIZE || (typeof sequence !== "number" && typeof sequence !== "string")) {
      break;
    }
    beforeSeq = String(sequence);
  }
  return shown().slice(0, REPOS_MAX);
}
