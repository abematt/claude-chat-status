// bb-plugin-chat-status — frontend entry.
//
// Two sidebar surfaces, both fed by the Chat Status hook's status files
// (served by server.ts) and bb's own thread state:
//   - the thread list itself, replaced by "Today": a card for each thread
//     that ran today (status, repo, turn clock or what it is blocked on),
//     with everything older folded away under "Earlier";
//   - a footer item that lists the chats running outside bb (VS Code, a
//     terminal), so they are visible without leaving bb.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ThreadTitle,
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginThreadListProps,
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

// ---- short repo names ----

/**
 * The names the team says out loud (and the docker service names), where
 * dropping the "measure-" prefix is not enough. Keys are lowercase. The
 * menu bar app has a copy (`Chat.repoShort` in ChatStatusBar.swift).
 */
const REPO_SHORT: Record<string, string> = {
  "measure-contributor-web": "contributor",
  "measure-web": "msr-web",
  "measure-predict-api": "predict-api",
  "measure-audience-tools": "assembly",
  "claude-chat-status": "chat-status",
};

/** A repo's tag: its established short name, else the name without "measure-". */
function shortRepo(repo: string): string {
  const key = repo.toLowerCase();
  return REPO_SHORT[key] ?? (key.startsWith("measure-") ? repo.slice("measure-".length) : repo);
}

/** Tags a card draws before folding the rest into a count. */
const TAGS_MAX = 3;

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

/** How long ago, as the menu bar app writes it: "now", "4m ago", "2h ago", "3d ago". */
function formatAge(seconds: number): string {
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A chat that stopped this recently still reads as current work. */
const RECENT_SECONDS = 15 * 60;
/** Epoch seconds, re-rendering every `intervalMs` while `ticking`. */
function useNow(ticking: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(timer);
  }, [ticking, intervalMs]);
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

/** When a thread last did anything, in epoch seconds. */
function lastRanAt(thread: PluginSidebarThread, chat: Chat | undefined): number {
  return Math.max(chat?.updatedAt ?? 0, thread.latestAttentionAt / 1000);
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
  threadRepos: Record<string, string[]>,
): string[] {
  // The hook's live list first (it follows a turn as it runs), then bb's
  // record of the thread's tool calls, then the folder it was opened on.
  if (chat !== undefined && chat.reposTouched.length > 0) return chat.reposTouched;
  const fromHistory = threadRepos[thread.id];
  if (fromHistory !== undefined && fromHistory.length > 0) return fromHistory;
  const fromChat = chat === undefined ? [] : chatProjects(chat);
  if (fromChat.length > 0) return fromChat;
  if (personalProjectIds.has(thread.projectId)) return [];
  const folder = (thread.environment?.path ?? "").split("/").filter(Boolean).pop();
  return folder === undefined ? [] : [folder];
}

// ---- the Today list ----

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
    <span className="inline-flex min-w-0 items-center gap-1 text-foreground" title={repo}>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: hue }}
      />
      {/* Mixed with the text color so it stays readable in both themes. */}
      <span
        className="min-w-0 max-w-[9rem] truncate"
        style={{ color: `color-mix(in srgb, ${hue} 72%, currentColor)` }}
      >
        {shortRepo(repo)}
      </span>
      {more > 0 ? <span className="text-muted-foreground">+{more}</span> : null}
    </span>
  );
}

interface RowDetail {
  text: string;
  /** A status color, or undefined for quiet text. */
  hue: string | undefined;
  numeric: boolean;
}

/**
 * What a card says beside its project. A working chat shows its turn clock
 * and a waiting one what it waits on. Everything else shows how long ago it
 * last ran: in color while that is recent, quiet after.
 */
function rowDetail(
  thread: PluginSidebarThread,
  chat: Chat | undefined,
  now: number,
): RowDetail | null {
  if (chat !== undefined) {
    if (isWorking(chat) && chat.turnStartedAt > 0) {
      return {
        text: formatClock(now - chat.turnStartedAt),
        hue: STATUS_HUE.working,
        numeric: true,
      };
    }
    if (chat.status === "needs_input") {
      return chat.waitingOn === ""
        ? null // bb's own glyph already says it is waiting
        : { text: chat.waitingOn, hue: STATUS_HUE.needs_input, numeric: false };
    }
    if (chat.status === "working") return null; // background work: no clock to show
    if (chat.updatedAt > 0) {
      const age = Math.max(0, now - chat.updatedAt);
      const recent = age < RECENT_SECONDS;
      return chat.status === "error"
        ? { text: `failed ${formatAge(age)}`, hue: STATUS_HUE.error, numeric: true }
        : {
            text: formatAge(age),
            hue: recent && chat.status === "done" ? STATUS_HUE.done : undefined,
            numeric: true,
          };
    }
    return null;
  }
  // No status file (an older thread, or a provider without the hook): bb's
  // own record of when the thread last finished or asked for attention.
  if (thread.status !== "idle" || thread.latestAttentionAt <= 0) return null;
  return {
    text: formatAge(Math.max(0, now - thread.latestAttentionAt / 1000)),
    hue: undefined,
    numeric: true,
  };
}

/** Needs you, failed, working, then the rest: the menu bar app's order. */
function attentionRank(thread: PluginSidebarThread, chat: Chat | undefined): number {
  if (thread.hasPendingInteraction || chat?.status === "needs_input") return 0;
  if (chat?.status === "error" || thread.indicator === "unread-error") return 1;
  if (thread.status !== "idle" || chat?.status === "working") return 2;
  return 3;
}

/**
 * Today's work: a thread that ran since local midnight, is busy or waiting
 * right now, or is pinned (the way to keep one in view past midnight).
 */
function isToday(
  thread: PluginSidebarThread,
  chat: Chat | undefined,
  midnight: number,
): boolean {
  if (thread.isPinned || attentionRank(thread, chat) < 3) return true;
  return lastRanAt(thread, chat) >= midnight;
}

/** What bb's own menu needs to act on a thread. */
function actionTarget(thread: PluginSidebarThread) {
  const environment = thread.environment;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment === null || environment.id === null
        ? null
        : { id: environment.id, path: environment.path },
  };
}

/** bb's status glyph when the thread has something to say, else its agent's icon. */
function ThreadGlyph({ thread }: { thread: PluginSidebarThread }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find((candidate) => candidate.id === thread.providerId);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const status = resolveThreadStatus({
    thread,
    hiddenThreads: [],
    hasUnsubmittedDraft,
    rowStatus,
  });
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      title={status.label ?? undefined}
    >
      {status.indicator === "none" && status.rowStatus === null ? (
        <ProviderIcon
          providerKind="agent"
          provider={provider ?? { id: thread.providerId }}
          className="size-4 text-muted-foreground"
          aria-hidden
        />
      ) : (
        <ThreadStatusGlyph
          indicator={status.indicator}
          rowStatus={status.rowStatus}
          size="compact"
        />
      )}
    </span>
  );
}

interface ListData extends ChatsState {
  personalProjectIds: ReadonlySet<string>;
  threadRepos: Record<string, string[]>;
  /** Epoch seconds, refreshed twice a minute: one clock for every age. */
  coarseNow: number;
}

function TodayCard({
  thread,
  data,
  active,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  data: ListData;
  active: boolean;
  onNavigate: () => void;
}) {
  const chat = data.byThread[thread.id];
  const working = chat !== undefined && isWorking(chat) && chat.turnStartedAt > 0;
  const now = useNow(working);
  const projects = threadProjects(thread, chat, data.personalProjectIds, data.threadRepos);
  const rank = attentionRank(thread, chat);
  const detail: RowDetail | null =
    rowDetail(thread, chat, working ? now : data.coarseNow) ??
    (rank === 0
      ? { text: "Needs you", hue: STATUS_HUE.needs_input, numeric: false }
      : rank === 2
        ? { text: "Working", hue: STATUS_HUE.working, numeric: false }
        : null);
  // Only a card that wants something from you is tinted; the rest stay quiet.
  const edge = rank === 0 ? STATUS_HUE.needs_input : rank === 1 ? STATUS_HUE.error : undefined;
  return (
    <li>
      <ThreadActionsContextMenu thread={actionTarget(thread)}>
        <a
          href={thread.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          title={[thread.displayTitle, projects.join(", "), detail?.text]
            .filter(Boolean)
            .join(" · ")}
          className={cn(
            "flex min-w-0 flex-col gap-1 rounded-lg border border-border px-2.5 py-2 text-left no-underline",
            "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
            active && "bg-accent",
          )}
          style={
            edge === undefined
              ? undefined
              : {
                  borderColor: `color-mix(in srgb, ${edge} 55%, transparent)`,
                  backgroundImage: `linear-gradient(color-mix(in srgb, ${edge} 9%, transparent), color-mix(in srgb, ${edge} 9%, transparent))`,
                }
          }
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="pt-0.5">
              <ThreadGlyph thread={thread} />
            </span>
            <span
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-foreground",
                thread.isUnread && "font-medium",
              )}
            >
              {thread.displayTitle}
            </span>
          </span>
          {projects.length === 0 && detail === null ? null : (
            <span className="flex min-w-0 items-start gap-1.5 pl-6 text-xs">
              {/* One tag per repo the turn worked in, busiest first. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                {projects.slice(0, TAGS_MAX).map((repo, index) => (
                  <ProjectName
                    key={repo}
                    repo={repo}
                    hue={projectHue(repo, data.colorSlots)}
                    more={index === TAGS_MAX - 1 ? projects.length - TAGS_MAX : 0}
                  />
                ))}
              </span>
              {detail === null ? null : (
                <span
                  className={cn(
                    detail.numeric ? "shrink-0" : "min-w-0 truncate",
                    detail.numeric && "tabular-nums",
                    detail.hue === undefined && "text-muted-foreground",
                  )}
                  style={{ color: detail.hue }}
                >
                  {detail.text}
                </span>
              )}
            </span>
          )}
        </a>
      </ThreadActionsContextMenu>
    </li>
  );
}

/** One line for a thread that is not today's work: glyph, title, age. */
function EarlierRow({
  thread,
  chat,
  now,
  active,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  chat: Chat | undefined;
  now: number;
  active: boolean;
  onNavigate: () => void;
}) {
  const ran = lastRanAt(thread, chat);
  return (
    <li>
      <ThreadActionsContextMenu thread={actionTarget(thread)}>
        <a
          href={thread.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          title={thread.displayTitle}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground no-underline",
            "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
            active && "bg-accent text-foreground",
          )}
        >
          <ThreadGlyph thread={thread} />
          <span className="min-w-0 flex-1 truncate">
            <ThreadTitle threadId={thread.id} />
          </span>
          {ran > 0 ? (
            <span className="shrink-0 text-xs tabular-nums">
              {formatAge(Math.max(0, now - ran)).replace(" ago", "")}
            </span>
          ) : null}
        </a>
      </ThreadActionsContextMenu>
    </li>
  );
}

const EARLIER_OPEN_KEY = "chat-status.earlier-open";
/** Earlier rows drawn before "Show more". */
const EARLIER_PAGE = 30;

function readEarlierOpen(): boolean {
  try {
    return localStorage.getItem(EARLIER_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function TodayList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const { rpc, ...state } = useChats();
  const { threads, projects, status } = experimental_useSidebarThreads();
  const personalProjectIds = useMemo(
    () => new Set(projects.filter((project) => project.isPersonal).map((project) => project.id)),
    [projects],
  );
  const coarseNow = useNow(true, 30_000);
  const midnight = new Date(coarseNow * 1000).setHours(0, 0, 0, 0) / 1000;

  const { today, earlier } = useMemo(() => {
    const today: PluginSidebarThread[] = [];
    const earlier: PluginSidebarThread[] = [];
    for (const thread of threads) {
      if (thread.isHidden || thread.isArchived) continue;
      (isToday(thread, state.byThread[thread.id], midnight) ? today : earlier).push(thread);
    }
    const recency = (a: PluginSidebarThread, b: PluginSidebarThread) =>
      lastRanAt(b, state.byThread[b.id]) - lastRanAt(a, state.byThread[a.id]);
    today.sort(
      (a, b) =>
        attentionRank(a, state.byThread[a.id]) - attentionRank(b, state.byThread[b.id]) ||
        recency(a, b),
    );
    earlier.sort(recency);
    return { today, earlier };
  }, [threads, state.byThread, midnight]);

  // Repos only for the cards; `state.chats` changes whenever a thread ran.
  const wanted = today
    .slice(0, 60)
    .map((thread) => ({ id: thread.id, path: thread.environment?.path ?? "" }));
  const wantedKey = wanted.map((thread) => thread.id).join(",");
  const [threadRepos, setThreadRepos] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (wanted.length === 0) return;
    let current = true;
    rpc.call("thread_repos", { threads: wanted }).then(
      ({ repos }) => {
        if (current) setThreadRepos(repos);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, wantedKey, state.chats]);

  const [earlierOpen, setEarlierOpen] = useState(readEarlierOpen);
  const [earlierShown, setEarlierShown] = useState(EARLIER_PAGE);
  const toggleEarlier = () => {
    setEarlierOpen((open) => {
      try {
        localStorage.setItem(EARLIER_OPEN_KEY, open ? "0" : "1");
      } catch {
        // private mode: the choice lasts until reload
      }
      return !open;
    });
  };
  // With nothing today, the older threads are the list: never a blank sidebar.
  const showEarlier = earlierOpen || today.length === 0;
  const data: ListData = { ...state, personalProjectIds, threadRepos, coarseNow };

  return (
    <nav aria-label="Threads" className="flex flex-col gap-1 px-2 pb-2">
      <h2 className="px-1 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">Today</h2>
      {today.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          {status === "loading" ? "Loading threads…" : "Nothing started today."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {today.map((thread) => (
            <TodayCard
              key={thread.id}
              thread={thread}
              data={data}
              active={thread.id === activeThreadId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {earlier.length === 0 ? null : (
        <>
          <button
            type="button"
            onClick={toggleEarlier}
            aria-expanded={showEarlier}
            disabled={today.length === 0}
            className="mt-2 flex items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:hover:text-muted-foreground"
          >
            <Icon
              name="ChevronRight"
              className={cn("size-3 transition-transform", showEarlier && "rotate-90")}
            />
            Earlier
            <span className="tabular-nums opacity-70">{earlier.length}</span>
          </button>
          {showEarlier ? (
            <ul className="flex flex-col">
              {earlier.slice(0, earlierShown).map((thread) => (
                <EarlierRow
                  key={thread.id}
                  thread={thread}
                  chat={state.byThread[thread.id]}
                  now={coarseNow}
                  active={thread.id === activeThreadId}
                  onNavigate={onNavigate}
                />
              ))}
              {earlier.length > earlierShown ? (
                <li>
                  <button
                    type="button"
                    onClick={() => setEarlierShown((shown) => shown + EARLIER_PAGE)}
                    className="w-full rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
                  >
                    Show {Math.min(EARLIER_PAGE, earlier.length - earlierShown)} more
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      )}
    </nav>
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
  app.slots.experimental_threadList({
    id: "today",
    title: "Today",
    description: "Cards for the threads you ran today; everything older folded under Earlier.",
    component: TodayList,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "other-chats",
    label: "Chats outside bb",
    icon: "MessageSquare",
    component: OtherChats,
  });
});
