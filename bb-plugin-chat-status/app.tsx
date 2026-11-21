// bb-plugin-chat-status — frontend entry.
//
// Two sidebar surfaces, both fed by the Chat Status hook's status files
// (served by server.ts) and bb's own thread state:
//   - the thread list itself, replaced by "Today": a card for each thread
//     that ran today (status, repo, turn clock or what it is blocked on),
//     with everything older folded away under "Earlier";
//   - a footer item that lists the chats running outside bb (VS Code, a
//     terminal), so they are visible without leaving bb.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadTitle,
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { Chat, WorklogState, rpcContract } from "./server";
import {
  ANIMS,
  CAMERA,
  CLOSEUPS,
  FRAME_H,
  FRAME_W,
  SHOT_H,
  SHOT_W,
} from "./sprites";

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
  return (
    REPO_SHORT[key] ??
    (key.startsWith("measure-") ? repo.slice("measure-".length) : repo)
  );
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
const EMPTY: ChatsState = {
  chats: [],
  colorSlots: {},
  byThread: {},
  loaded: false,
};

/** Every chat with a status file, kept current by the server's change signal. */
function useChats(): ChatsState & {
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
} {
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
function lastRanAt(
  thread: PluginSidebarThread,
  chat: Chat | undefined,
): number {
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
  if (chat !== undefined && chat.reposTouched.length > 0)
    return chat.reposTouched;
  const fromHistory = threadRepos[thread.id];
  if (fromHistory !== undefined && fromHistory.length > 0) return fromHistory;
  const fromChat = chat === undefined ? [] : chatProjects(chat);
  if (fromChat.length > 0) return fromChat;
  if (personalProjectIds.has(thread.projectId)) return [];
  const folder = (thread.environment?.path ?? "")
    .split("/")
    .filter(Boolean)
    .pop();
  return folder === undefined ? [] : [folder];
}

// ---- For me: the private tracker (via server.ts and the worklog CLI) ----

/** The tracker's state, refreshed when the store changes and once a minute. */
function useWorklog(): WorklogState | null {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WorklogState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("worklog_state").then(setState, () => undefined);
  }, [rpc]);
  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, 60_000);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime("worklog-changed", refetch);
  return state;
}

/**
 * The For me buddy is Abraham's own pixel sprite (sprites.ts), standing on a
 * little stage. Motion stops under prefers-reduced-motion.
 *   sleep    wide, idling     nothing new; next check-in is later
 *   work     wide, hand at chin  the collector is running
 *   brief    close, notepad   a morning or midday check-in is waiting, unread
 *   wrap     close, thumbs up the evening wrap-up is waiting, unread
 *   ask      close, hand up   questions or proposals wait for you (with a badge)
 *   done     close, smile     everything set for today is done
 */
type Mood = "sleep" | "work" | "brief" | "wrap" | "ask" | "done";
type CloseMood = keyof typeof CLOSEUPS;
const isCloseMood = (mood: Mood): mood is CloseMood => mood in CLOSEUPS;

/** Push-in frame times (ms), slowing as the camera comes to a stop. */
const CAMERA_MS = [70, 80, 90, 110];
/** Close-up frames 0 and 1: arriving, then the gesture coming in. */
const ENTER_MS = [120, 120];
/** The held pose: close-up frames 2–5, looped. */
const HOLD_FRAMES = [2, 3, 4, 5];
const HOLD_MS = 420;
/** "done" is a moment, not a state: the camera pulls back out after this long. */
const DONE_HOLD_MS = 6000;

/**
 * The shot on stage: null for the wide shot (the idle sprite), otherwise one
 * image. Moving between moods always pulls out to wide and pushes back in, so
 * two close-ups never cut into each other. A mood change mid-move is picked up
 * when the move finishes.
 */
function useCamera(target: CloseMood | null, reduced: boolean): string | null {
  const [shot, setShot] = useState<string | null>(null);
  const [held, setHeld] = useState<CloseMood | null>(null);
  const at = useRef<CloseMood | null>(null);
  const want = useRef(target);
  want.current = target;
  const moving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (reduced) {
      at.current = target;
      setHeld(target);
      setShot(target ? CLOSEUPS[target][HOLD_FRAMES[0]!]! : null);
      return;
    }
    if (moving.current) return;
    moving.current = true;
    const wait = (ms: number) =>
      new Promise<void>((done) => window.setTimeout(done, ms));
    const show = (src: string | null) => {
      if (mounted.current) setShot(src);
    };
    void (async () => {
      try {
        while (mounted.current && at.current !== want.current) {
          setHeld(null);
          const from = at.current;
          if (from) {
            const frames = CLOSEUPS[from];
            show(frames[1]!);
            await wait(ENTER_MS[1]!);
            show(frames[0]!);
            await wait(ENTER_MS[0]!);
            for (let i = CAMERA.length - 1; i >= 0; i--) {
              show(CAMERA[i]!);
              await wait(CAMERA_MS[i]!);
            }
            at.current = null;
            show(null);
          } else {
            const to = want.current!;
            for (let i = 0; i < CAMERA.length; i++) {
              show(CAMERA[i]!);
              await wait(CAMERA_MS[i]!);
            }
            const frames = CLOSEUPS[to];
            show(frames[0]!);
            await wait(ENTER_MS[0]!);
            show(frames[1]!);
            await wait(ENTER_MS[1]!);
            at.current = to;
            show(frames[HOLD_FRAMES[0]!]!);
          }
        }
        if (mounted.current) setHeld(at.current);
      } finally {
        moving.current = false;
      }
    })();
  }, [target, reduced]);
  // Settled on a close-up: loop its held pose.
  useEffect(() => {
    if (!held || reduced) return;
    let i = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      i = (i + 1) % HOLD_FRAMES.length;
      setShot(CLOSEUPS[held][HOLD_FRAMES[i]!]!);
    }, HOLD_MS);
    return () => clearInterval(timer);
  }, [held, reduced]);
  return shot;
}

/** Idles to pick from, with weights; the impatient ones get likelier late in a day with work open. */
const IDLES: ReadonlyArray<readonly [string, number, boolean]> = [
  ["stretch", 2, false],
  ["think", 2, false],
  ["watch", 1, true],
  ["wave", 1, true],
];
/**
 * Frame order per animation; a repeated frame holds that pose for one more
 * tick. Frame 0 and the last frame are the base pose, so every special
 * starts and ends where the idle is. "pondering" is think's chin hold, looped
 * while the collector runs.
 */
const SEQUENCES: Record<string, readonly number[]> = {
  idle: [0, 0, 1, 2, 3, 3, 4, 5, 5, 5, 6, 7, 7],
  stretch: [0, 1, 2, 3, 3, 3, 4, 4, 4, 4, 4, 3, 5, 6, 7],
  think: [0, 1, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 7],
  pondering: [3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 4, 4, 4, 4],
  watch: [0, 1, 2, 3, 3, 4, 4, 4, 4, 4, 5, 5, 6, 7],
  wave: [0, 1, 2, 3, 4, 5, 4, 5, 4, 5, 5, 6, 7],
};
/** Animations that reuse another one's strip. */
const STRIP_OF: Record<string, string> = { pondering: "think" };
const stripOf = (name: string) =>
  ANIMS[STRIP_OF[name] ?? name] ?? ANIMS.idle!;
const sequenceOf = (name: string): readonly number[] =>
  SEQUENCES[name] ?? Array.from({ length: stripOf(name).frames }, (_, i) => i);
/** Idles that read well looped a couple of times; the rest play once. */
const LOOPABLE = new Set(["idle"]);
const FRAME_MS = 180;
/** Base-idle breaths (~2.3s each) between two special idles: 4–6, so ~9–14s of calm. */
const restLoops = () => 4 + Math.floor(Math.random() * 3);
function pickIdle(restless: boolean): string {
  const pool = IDLES.map(
    ([name, weight, impatient]) =>
      [name, impatient && restless ? weight * 3 : weight] as const,
  );
  let roll = Math.random() * pool.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of pool) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return "stretch";
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia(REDUCED_MOTION).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(REDUCED_MOTION);
    const change = () => setReduced(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return reduced;
}

/**
 * Abraham, standing on a little stage. With nothing to do he idles, switching at
 * random between his idle loops (fidgeting more late in a day with work still
 * open). While the collector runs he thinks. When something needs him the
 * camera pushes in (a drawn frame per step, not a CSS zoom) to a medium
 * close-up of the mood's gesture, with letterbox bars; it pulls back out when
 * the moment passes.
 */
function Stage({ mood, restless }: { mood: Mood; restless: boolean }) {
  const reduced = useReducedMotion();
  const [doneShown, setDoneShown] = useState(false);
  useEffect(() => {
    if (mood !== "done") {
      setDoneShown(false);
      return;
    }
    const timer = window.setTimeout(() => setDoneShown(true), DONE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [mood]);
  const camTarget =
    isCloseMood(mood) && !(mood === "done" && doneShown) ? mood : null;
  const closeUp = camTarget !== null;
  const shot = useCamera(camTarget, reduced);
  const [anim, setAnim] = useState("idle");
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (closeUp) return; // hold still in close-up
    let current = mood === "work" ? "think" : "idle";
    let f = 0;
    let loops = 0;
    let target = current === "idle" ? restLoops() : 1;
    setAnim(current);
    setFrame(0);
    if (reduced) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      f += 1;
      if (f >= sequenceOf(current).length) {
        f = 0;
        loops += 1;
        if (mood === "work") {
          // Raise the hand once, then hold it at the chin while collecting.
          if (current === "think") {
            current = "pondering";
            setAnim(current);
          }
        } else if (loops >= target) {
          current = current === "idle" ? pickIdle(restless) : "idle";
          loops = 0;
          target =
            current === "idle"
              ? restLoops()
              : LOOPABLE.has(current)
                ? 2
                : 1;
          setAnim(current);
        }
      }
      setFrame(sequenceOf(current)[f] ?? 0);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [closeUp, mood, restless, reduced]);
  const strip = stripOf(anim);
  return (
    <div
      className="fm-stage"
      data-close={shot !== null}
      data-reduced={reduced}
      aria-hidden="true"
    >
      <div className="fm-floor" />
      <div
        className="fm-cam"
        hidden={shot !== null}
        style={{ width: FRAME_W, height: FRAME_H, marginLeft: -FRAME_W / 2 }}
      >
        <div
          className="fm-body"
          style={{
            width: FRAME_W,
            height: FRAME_H,
            backgroundImage: `url(${strip.src})`,
            backgroundSize: `${strip.frames * FRAME_W}px ${FRAME_H}px`,
            backgroundPosition: `${-(frame % strip.frames) * FRAME_W}px 0`,
          }}
        />
      </div>
      {shot !== null ? (
        <img
          className="fm-shot"
          src={shot}
          alt=""
          draggable={false}
          style={{ width: SHOT_W, height: SHOT_H, marginLeft: -SHOT_W / 2 }}
        />
      ) : null}
      <div className="fm-bar fm-bar-top" />
      <div className="fm-bar fm-bar-bottom" />
    </div>
  );
}

const STAGE_CSS = `
.fm-stage { position: relative; height: 140px; overflow: hidden; background-color: #1f1b25;
  background-image: radial-gradient(120% 95% at 50% 100%, #3b3242 0%, #1f1b25 72%); }
.fm-floor { position: absolute; left: 0; right: 0; bottom: 0; height: 14px;
  background: linear-gradient(#2c2633, #221d29); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
  transition: transform 0.25s ease; }
.fm-cam { position: absolute; left: 50%; bottom: 5px; }
.fm-cam[hidden] { display: none; }
.fm-body { image-rendering: pixelated; }
.fm-shot { position: absolute; left: 50%; top: 0; }
.fm-bar { position: absolute; left: 0; right: 0; height: 0; background: #0b0a0d; transition: height 0.35s ease; z-index: 2; }
.fm-bar-top { top: 0; }
.fm-bar-bottom { bottom: 0; }
.fm-stage[data-close="true"] .fm-floor { transform: translateY(14px); }
.fm-stage[data-close="true"] .fm-bar { height: 11px; }
.fm-stage[data-reduced="true"] * { transition: none !important; }
`;

function nextCheckin(now: Date): string {
  const day = now.getDay();
  if (day === 0 || day === 6) return "Weekend · next check-in Monday 9:00";
  const hour = now.getHours();
  if (hour < 9) return "Morning check-in at 9:00";
  if (hour < 13) return "All quiet · midday check-in at 13:00";
  if (hour < 18) return "All quiet · evening check-in at 18:00";
  return "All quiet for today";
}

function forMeStatus(
  worklog: WorklogState,
  today: PluginSidebarThread | undefined,
  todayChat: Chat | undefined,
  collector: PluginSidebarThread | undefined,
): { mood: Mood; line: string; badge: number } {
  const questions = worklog.toConfirm.length + worklog.proposals;
  if (
    questions > 0 ||
    (today !== undefined && attentionRank(today, todayChat) === 0)
  ) {
    return {
      mood: "ask",
      line:
        questions > 0
          ? `${questions} question${questions === 1 ? "" : "s"} for you`
          : "Needs you",
      badge: questions,
    };
  }
  if (today?.isUnread) {
    const kind = worklog.latestCheckin?.kind ?? "";
    if (kind === "evening")
      return { mood: "wrap", line: "Evening wrap-up ready", badge: 0 };
    const label = kind ? kind[0]!.toUpperCase() + kind.slice(1) : "";
    return {
      mood: "brief",
      line: label ? `${label} check-in ready` : "Check-in ready",
      badge: 0,
    };
  }
  if (collector !== undefined && collector.status !== "idle") {
    return {
      mood: "work",
      line: "Collecting Slack, meetings, ClickUp…",
      badge: 0,
    };
  }
  const total = worklog.counts.today_total ?? 0;
  if (total > 0 && (worklog.counts.today_done ?? 0) >= total) {
    return { mood: "done", line: "Everything for today is done", badge: 0 };
  }
  return { mood: "sleep", line: nextCheckin(new Date()), badge: 0 };
}

/** Pinned at the top of the sidebar: today's For me chat, drawn as the robot. */
function ForMeCard({
  worklog,
  threads,
  byThread,
  worklogProjectId,
  active,
  onNavigate,
}: {
  worklog: WorklogState;
  threads: readonly PluginSidebarThread[];
  byThread: Record<string, Chat>;
  /** The bb project the tracker's chats run in; any new chat there is the assistant. */
  worklogProjectId: string | null;
  active: boolean;
  onNavigate: () => void;
}) {
  const nav = useBbNavigate();
  // Ask: always a fresh chat in the Worklog project, whatever the day. The
  // folder's CLAUDE.md makes it the assistant; the check-in thread is untouched.
  const ask = () => {
    if (!worklogProjectId) return;
    nav.toCompose({ projectId: worklogProjectId, focusPrompt: true });
    onNavigate();
  };
  const today = threads.find((thread) => thread.id === worklog.todayThread);
  const collector = threads.find(
    (thread) => thread.id === worklog.collectorThread,
  );
  const { mood, line, badge } = forMeStatus(
    worklog,
    today,
    today ? byThread[today.id] : undefined,
    collector,
  );
  const done = worklog.counts.today_done ?? 0;
  const total = worklog.counts.today_total ?? 0;
  const open = () => {
    if (today) {
      nav.toThread(today.id);
      onNavigate();
    } else {
      if (worklog.hubUrl) window.open(worklog.hubUrl, "_blank", "noopener");
    }
  };
  const restless = new Date().getHours() >= 16 && total > done;
  return (
    <div className="flex flex-col gap-1 pt-2">
      <style>{STAGE_CSS}</style>
      <button
        type="button"
        onClick={open}
        aria-current={active ? "page" : undefined}
        aria-label={`${today ? today.displayTitle : "For me"}: ${line}`}
        className={cn(
          "relative flex w-full flex-col overflow-hidden rounded-xl border text-left text-muted-foreground transition-[border-color,box-shadow] hover:border-foreground/30 focus-visible:outline-none",
          active && "border-foreground/40",
        )}
        style={
          mood === "ask"
            ? {
                borderColor: "#D97757",
                boxShadow: "0 0 0 3px rgb(217 119 87 / 0.18)",
              }
            : mood === "brief" || mood === "wrap"
              ? { borderColor: "currentColor" }
              : undefined
        }
      >
        <Stage mood={mood} restless={restless} />
        <span className="flex min-w-0 flex-col px-3 py-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {today ? today.displayTitle : "For me"}
          </span>
          <span className="truncate text-xs">{line}</span>
        </span>
        {badge > 0 ? (
          <span
            className="absolute right-2 top-2 z-10 rounded-full px-1.5 text-[11px] font-semibold tabular-nums text-white shadow"
            style={{ background: "#D97757" }}
          >
            {badge}
          </span>
        ) : null}
      </button>
      <div className="flex items-center gap-1.5">
        {worklogProjectId ? (
          <button type="button" onClick={ask} className={FM_BUTTON}>
            <Icon name="MessageSquarePlus" className="size-3.5" />
            Ask
          </button>
        ) : null}
        {worklog.hubUrl ? (
          <a href={worklog.hubUrl} target="_blank" rel="noopener" className={FM_BUTTON}>
            <Icon name="ListTodo" className="size-3.5" />
            Hub
          </a>
        ) : null}
      </div>
      <div className="px-1 text-[11px] tabular-nums text-muted-foreground">
        {total > 0 ? `${done}/${total} today` : `${worklog.counts.week ?? 0} this week`}
        {worklog.mode === "shadow" ? " · shadow mode" : ""}
      </div>
    </div>
  );
}

/** Ask / Hub under the card: real buttons, with a raised edge and a press. */
const FM_BUTTON =
  "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition-[background-color,transform,box-shadow] duration-100 hover:bg-accent active:translate-y-px active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
    <span
      className="inline-flex min-w-0 items-center gap-1 text-foreground"
      title={repo}
    >
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
        ? {
            text: `failed ${formatAge(age)}`,
            hue: STATUS_HUE.error,
            numeric: true,
          }
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
function attentionRank(
  thread: PluginSidebarThread,
  chat: Chat | undefined,
): number {
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
  const provider = providers.find(
    (candidate) => candidate.id === thread.providerId,
  );
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const status = resolveThreadStatus({
    thread,
    hiddenThreads: [],
    hasUnsubmittedDraft,
    rowStatus,
  });
  // bb marks a finished, unopened thread with a grey dot, which reads as idle
  // and clashes with the green age beside it. Draw that dot in the finished
  // green instead; once the thread is opened it shows the agent's logo.
  const unreadDone =
    status.indicator === "unread-success" && status.rowStatus === null;
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      title={status.label ?? undefined}
    >
      {unreadDone ? (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: STATUS_HUE.done }}
          aria-label={status.label ?? undefined}
        />
      ) : status.indicator === "none" && status.rowStatus === null ? (
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
  const working =
    chat !== undefined && isWorking(chat) && chat.turnStartedAt > 0;
  const now = useNow(working);
  const projects = threadProjects(
    thread,
    chat,
    data.personalProjectIds,
    data.threadRepos,
  );
  const rank = attentionRank(thread, chat);
  const detail: RowDetail | null =
    rowDetail(thread, chat, working ? now : data.coarseNow) ??
    (rank === 0
      ? { text: "Needs you", hue: STATUS_HUE.needs_input, numeric: false }
      : rank === 2
        ? { text: "Working", hue: STATUS_HUE.working, numeric: false }
        : null);
  // Three tiers, told apart by shape before colour: a card that wants you has a
  // tinted edge and fill, a card still in flight a plain edge, and a finished
  // or idle card none (it shows as a box only on hover or when selected). The
  // border is always 1px, transparent when hidden, so nothing shifts.
  const edge =
    rank === 0
      ? STATUS_HUE.needs_input
      : rank === 1
        ? STATUS_HUE.error
        : undefined;
  const inFlight = edge === undefined && rank === 2;
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
            "flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-left no-underline",
            inFlight ? "border-border" : "border-transparent",
            "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
            // Selected also gets a firmer edge, so it differs from hover.
            active && "border-foreground/30 bg-accent",
          )}
          style={
            edge !== undefined
              ? {
                  borderColor: `color-mix(in srgb, ${edge} 55%, transparent)`,
                  backgroundImage: `linear-gradient(color-mix(in srgb, ${edge} 9%, transparent), color-mix(in srgb, ${edge} 9%, transparent))`,
                }
              : undefined
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
                    more={
                      index === TAGS_MAX - 1 ? projects.length - TAGS_MAX : 0
                    }
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
  const worklog = useWorklog();
  const forMeThread = worklog?.todayThread ?? "";
  // The tracker's chats (Ask, check-ins, collector) live in the "Worklog" project
  // and are reached from the For me card, so the list leaves them out.
  const worklogProjectId = useMemo(
    () => projects.find((project) => project.name === "Worklog")?.id ?? null,
    [projects],
  );
  const personalProjectIds = useMemo(
    () =>
      new Set(
        projects
          .filter((project) => project.isPersonal)
          .map((project) => project.id),
      ),
    [projects],
  );
  const coarseNow = useNow(true, 30_000);
  const midnight = new Date(coarseNow * 1000).setHours(0, 0, 0, 0) / 1000;

  const { today, earlier } = useMemo(() => {
    const today: PluginSidebarThread[] = [];
    const earlier: PluginSidebarThread[] = [];
    for (const thread of threads) {
      if (
        thread.isHidden ||
        thread.isArchived ||
        thread.id === forMeThread ||
        (worklogProjectId !== null && thread.projectId === worklogProjectId)
      )
        continue;
      (isToday(thread, state.byThread[thread.id], midnight)
        ? today
        : earlier
      ).push(thread);
    }
    const recency = (a: PluginSidebarThread, b: PluginSidebarThread) =>
      lastRanAt(b, state.byThread[b.id]) - lastRanAt(a, state.byThread[a.id]);
    today.sort(
      (a, b) =>
        attentionRank(a, state.byThread[a.id]) -
          attentionRank(b, state.byThread[b.id]) || recency(a, b),
    );
    earlier.sort(recency);
    return { today, earlier };
  }, [threads, state.byThread, midnight, forMeThread, worklogProjectId]);

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
  const data: ListData = {
    ...state,
    personalProjectIds,
    threadRepos,
    coarseNow,
  };

  return (
    <nav aria-label="Threads" className="flex flex-col gap-1 px-2 pb-2">
      {worklog?.available ? (
        <ForMeCard
          worklog={worklog}
          threads={threads}
          byThread={state.byThread}
          worklogProjectId={worklogProjectId}
          active={forMeThread !== "" && forMeThread === activeThreadId}
          onNavigate={onNavigate}
        />
      ) : null}
      <h2 className="px-1 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">
        Today
      </h2>
      {today.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          {status === "loading" ? "Loading threads…" : "Nothing started today."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
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
            className="mt-3 flex items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:hover:text-muted-foreground"
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3 transition-transform",
                showEarlier && "rotate-90",
              )}
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
                    onClick={() =>
                      setEarlierShown((shown) => shown + EARLIER_PAGE)
                    }
                    className="w-full rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
                  >
                    Show {Math.min(EARLIER_PAGE, earlier.length - earlierShown)}{" "}
                    more
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
        <span className="truncate text-sm text-foreground">
          {chat.title || "Untitled chat"}
        </span>
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
  const now = useNow(
    others.some((chat) => isWorking(chat) && chat.turnStartedAt > 0),
  );
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
    description:
      "Cards for the threads you ran today; everything older folded under Earlier.",
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
