// bb-plugin-chat-status — frontend entry.
//
// Two sidebar surfaces, both fed by the Chat Status hook's status files
// (served by server.ts):
//   - a metadata item on every thread row: the project in its color, then the
//     turn clock while the chat works or what it is blocked on while it waits;
//   - a footer item that lists the chats running outside bb (VS Code, a
//     terminal), so they are visible without leaving bb.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  type ExperimentalThreadRowMetadataProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Chat, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// ---- project colors: the menu bar app's palette (ProjectStyle.hues) ----

const PROJECT_HUES = [
  "#3F8CF5", // blue
  "#E0609F", // pink
  "#1FAE9E", // teal
  "#B061E0", // violet
  "#8A93A6", // slate
  "#2FA3D6", // cyan
  "#7A6BF2", // indigo
];

/** FNV-1a over UTF-8, the app's stableHash: its fallback for an unseen repo. */
function stableHash(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

function projectHue(repo: string, slots: Record<string, number>): string {
  const key = repo.toLowerCase();
  const slot = slots[key];
  const index =
    slot !== undefined && slot >= 0 && slot < PROJECT_HUES.length
      ? slot
      : Number(stableHash(key) % BigInt(PROJECT_HUES.length));
  return PROJECT_HUES[index] ?? PROJECT_HUES[0]!;
}

// ---- status vocabulary: the menu bar app's signal colors (Palette) ----

const STATUS_HUE: Record<string, string> = {
  working: "#D97757",
  needs_input: "#E8912F",
  error: "#FF6257",
  done: "#3BD17A",
};
const STATUS_ORDER = ["needs_input", "error", "working", "done", "live"];

function isWorking(chat: Chat): boolean {
  return chat.status === "working" && !chat.background;
}

function statusText(chat: Chat, now: number): string {
  switch (chat.status) {
    case "working":
      return chat.background
        ? "Background work"
        : chat.turnStartedAt > 0
          ? formatClock(now - chat.turnStartedAt)
          : "Working";
    case "needs_input":
      return chat.waitingOn || "Needs you";
    case "error":
      return chat.errorType || "Errored";
    case "done":
      return "Finished";
    default:
      return "Idle";
  }
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

/** Epoch seconds, re-rendering every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// ---- data ----

interface ChatsState {
  chats: Chat[];
  colorSlots: Record<string, number>;
  /** The newest chat of each bb thread. */
  byThread: Record<string, Chat>;
  loaded: boolean;
}
const EMPTY: ChatsState = { chats: [], colorSlots: {}, byThread: {}, loaded: false };

/** Every chat with a status file, kept current by the server's change signal. */
function useChats(): ChatsState & { rpc: ReturnType<typeof useRpc<typeof rpcContract>> } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ChatsState>(EMPTY);
  const refetch = useCallback(() => {
    rpc.call("chats_list").then(
      ({ chats, colorSlots }) => {
        const byThread: Record<string, Chat> = {};
        for (const chat of chats) {
          if (chat.bbThread === "") continue;
          const current = byThread[chat.bbThread];
          if (current === undefined || chat.updatedAt > current.updatedAt) {
            byThread[chat.bbThread] = chat;
          }
        }
        setState({ chats, colorSlots, byThread, loaded: true });
      },
      () => setState((current) => ({ ...current, loaded: true })),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    // The change signal does the work; this covers a missed one, and a
    // session that died without writing anything.
    const timer = setInterval(refetch, 20_000);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime("chats-changed", refetch);
  return { ...state, rpc };
}

/** What the row metadata item draws from: the chats, and bb's project list. */
interface RowData extends ChatsState {
  /** Projects with no repository of their own; their folders are thread ids. */
  personalProjectIds: ReadonlySet<string>;
}

/**
 * The repos a chat is working in, current one first: the ones its latest tool
 * calls touched, else the folder it was opened on.
 */
function chatProjects(chat: Chat): string[] {
  if (chat.reposTouched.length > 0) return chat.reposTouched;
  return chat.repo === "" ? [] : [chat.repo];
}

function threadProjects(
  thread: PluginSidebarThread,
  chat: Chat | undefined,
  personalProjectIds: ReadonlySet<string>,
): string[] {
  const fromChat = chat === undefined ? [] : chatProjects(chat);
  if (fromChat.length > 0) return fromChat;
  if (personalProjectIds.has(thread.projectId)) return [];
  const folder = (thread.environment?.path ?? "").split("/").filter(Boolean).pop();
  return folder === undefined ? [] : [folder];
}

// ---- thread row metadata ----

/** The current repo in its color, with a count of the others touched. */
function ProjectName({
  repo,
  hue,
  more = 0,
}: {
  repo: string;
  hue: string;
  more?: number;
}) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-foreground">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: hue }}
      />
      {/* Mixed with the text color so it stays readable in both themes. */}
      <span
        className="max-w-[9rem] truncate"
        style={{ color: `color-mix(in srgb, ${hue} 72%, currentColor)` }}
      >
        {repo}
      </span>
      {more > 0 ? <span className="text-muted-foreground">+{more}</span> : null}
    </span>
  );
}

function ThreadRowStatus({
  thread,
  data,
}: ExperimentalThreadRowMetadataProps<RowData>) {
  const chat = data.byThread[thread.id];
  const working = chat !== undefined && isWorking(chat);
  const now = useNow(working && chat.turnStartedAt > 0);
  const projects = threadProjects(thread, chat, data.personalProjectIds);
  const repo = projects[0] ?? "";
  // Only the two states that carry more than bb's own status glyph does.
  const detail =
    chat === undefined
      ? null
      : working && chat.turnStartedAt > 0
        ? { text: formatClock(now - chat.turnStartedAt), hue: STATUS_HUE.working, numeric: true }
        : chat.status === "needs_input" && chat.waitingOn !== ""
          ? { text: chat.waitingOn, hue: STATUS_HUE.needs_input, numeric: false }
          : null;
  if (repo === "" && detail === null) return null;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-xs"
      title={[projects.join(", "), detail?.text].filter(Boolean).join(" · ")}
    >
      {repo === "" ? null : (
        <ProjectName
          repo={repo}
          hue={projectHue(repo, data.colorSlots)}
          more={projects.length - 1}
        />
      )}
      {detail === null ? null : (
        <span
          className={cn("min-w-0 truncate", detail.numeric && "tabular-nums")}
          style={{ color: detail.hue }}
        >
          {detail.text}
        </span>
      )}
    </span>
  );
}

// ---- chats outside bb ----

function OtherChatRow({
  chat,
  colorSlots,
  now,
  onOpen,
}: {
  chat: Chat;
  colorSlots: Record<string, number>;
  now: number;
  onOpen: () => void;
}) {
  const source = chat.host === "terminal" ? chat.hostApp || "CLI" : "VS Code";
  const text = statusText(chat, now);
  const projects = chatProjects(chat);
  const repo = projects[0] ?? "No project";
  return (
    <li title={projects.length > 1 ? projects.join(", ") : undefined}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <ProjectName
            repo={repo}
            hue={projectHue(repo, colorSlots)}
            more={projects.length - 1}
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {source}
            {chat.agent === "codex" ? " · Codex" : ""}
          </span>
          <span
            className={cn(
              "max-w-[55%] shrink-0 truncate",
              isWorking(chat) && "tabular-nums",
              STATUS_HUE[chat.status] === undefined && "text-muted-foreground",
            )}
            style={{ color: STATUS_HUE[chat.status] }}
            title={text}
          >
            {text}
          </span>
        </span>
        <span className="truncate text-sm text-foreground">
          {chat.title || "Untitled chat"}
        </span>
      </button>
    </li>
  );
}

function OtherChats() {
  const { chats, colorSlots, loaded, rpc } = useChats();
  const others = useMemo(
    () =>
      chats
        .filter((chat) => chat.bbThread === "" && chat.hostApp !== "bb")
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
            b.updatedAt - a.updatedAt,
        ),
    [chats],
  );
  const now = useNow(others.some((chat) => isWorking(chat) && chat.turnStartedAt > 0));
  return (
    <section aria-label="Chats outside bb" className="px-1 pb-1">
      <h2 className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        Chats outside bb
      </h2>
      {others.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          {loaded ? "No chats are running outside bb." : "Loading chats…"}
        </p>
      ) : (
        <ul className="max-h-80 overflow-y-auto">
          {others.map((chat) => (
            <OtherChatRow
              key={chat.sessionId}
              chat={chat}
              colorSlots={colorSlots}
              now={now}
              onOpen={() => {
                void rpc.call("chats_open", { sessionId: chat.sessionId });
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadRowMetadata<RowData>({
    id: "status",
    order: 5,
    useData: () => {
      const { rpc: _rpc, ...state } = useChats();
      const { projects } = experimental_useSidebarThreads();
      const personalProjectIds = useMemo(
        () =>
          new Set(
            projects.filter((project) => project.isPersonal).map((project) => project.id),
          ),
        [projects],
      );
      return { ...state, personalProjectIds };
    },
    component: ThreadRowStatus,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "other-chats",
    label: "Chats outside bb",
    icon: "MessageSquare",
    component: OtherChats,
  });
});
