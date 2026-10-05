// 代办的任务（#1565，ADR-0364）：好友私聊页不再把车道逐条铺在主对话里，而是**一次请求 = 一条任务**——
// 人点起的一句话、或一通打给智能体的电话开一条，之后智能体的回话、管理员的下发、下一棒的回话都归到它名下，
// 直到下一条人点起的开始。主页每条任务画一张卡，点开抽屉看过程。纯投影：全部从车道日志推导，不另落事实。
import type { SessionEvent } from "../session/events.js";
import { openTurns } from "./turnLedger.js";
import type { LaneItem } from "./pairChat.js";
import { stripEmotionTags } from "./voiceProsody.js";

/** 任务里的一行：车道的一行，再多一格「这是管理员下发的」（接力开场白：谁 @ 了谁） */
export interface LaneTaskItem extends LaneItem {
  /** 下发（接力）：这句是 `fromAgentId` 在回复里 @ 出去的、由系统替它落给 `toAgentIds` 的开场白 */
  handoff?: { toAgentIds: string[] };
}

export interface LaneTask {
  key: string;
  ts: number;
  /** 谁点起的：我 / 朋友 / 智能体自己（没有人话在前面的回话，比如打完电话的总结） */
  startedBy: "me" | "friend" | "agent";
  kind: "message" | "call";
  /** 卡上那一行：请求的第一行（截短），电话 = 「打给 X 的电话」 */
  title: string;
  items: LaneTaskItem[];
  /** 牵涉到的智能体（出现顺序） */
  agentIds: string[];
  lastTs: number;
}

export const LANE_TASK_TITLE_MAX = 40;

function titleOf(text: string): string {
  const first = text.split(/\r?\n/u).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const chars = [...first];
  return chars.length > LANE_TASK_TITLE_MAX ? `${chars.slice(0, LANE_TASK_TITLE_MAX - 1).join("")}…` : first;
}

/** 同一个人在这么久以内接着说的话归到他上一条任务里（真机 2026-10-05：「他不在线，你去给他打电话」「你可以给他打电话的」各自成了一条卡）。
    换一个人说、或隔久了、或上一条是智能体自己起的，才开新的一条。电话也算他的上一条（#1613：打给对面管理员的电话与
    电话里说的那句成了两张卡）；通话中的人话一律归到电话那条，不看是谁 */
export const LANE_TASK_GAP_MS = 30 * 60_000;

/** 把一条车道的日志折成任务。`selfUid` 判「我 / 朋友」；`nameOf` 给电话那条任务起标题（参与的智能体叫什么） */
export function laneTasksOf(events: readonly SessionEvent[], selfUid: string | undefined, nameOf: (agentId: string) => string = (id) => id): LaneTask[] {
  const tasks: LaneTask[] = [];
  let inCall = false;
  const who = (uid: string | undefined): "me" | "friend" => (selfUid !== undefined && uid !== selfUid ? "friend" : "me");
  const start = (t: Omit<LaneTask, "items" | "agentIds" | "lastTs">): LaneTask => {
    const task: LaneTask = { ...t, items: [], agentIds: [], lastTs: t.ts };
    tasks.push(task);
    return task;
  };
  const attach = (item: LaneTaskItem, fallback: () => LaneTask): void => {
    const task = tasks.at(-1) ?? fallback();
    task.items.push(item);
    task.lastTs = Math.max(task.lastTs, item.ts);
    if (item.agentId !== undefined && !task.agentIds.includes(item.agentId)) task.agentIds.push(item.agentId);
  };
  for (const e of events) {
    if (e.type === "user_message") {
      if (e.fromUid === undefined || e.origin !== undefined) continue;
      if (e.relay !== undefined) {
        // 下发：管理员（或任一棒）在回复里 @ 了谁，系统替它落的开场白——归到当前任务，标成下发
        const toAgentIds = e.mentions ?? [];
        attach(
          { key: `r${e.seq}`, ts: e.ts, who: "agent", agentId: e.relay.fromAgentId, text: e.content, handoff: { toAgentIds } },
          () => start({ key: `r${e.seq}`, ts: e.ts, startedBy: "agent", kind: "message", title: titleOf(e.content) }),
        );
        continue;
      }
      if (e.greeting !== undefined) continue; // 招呼 / 汇报 / 总结的开场白是模型可见的内务，不画；它引出的回话会归到当前任务
      const by = who(e.fromUid);
      const last = tasks.at(-1);
      if (last !== undefined && (inCall || (last.startedBy === by && e.ts - last.lastTs < LANE_TASK_GAP_MS))) {
        attach({ key: `u${e.seq}`, ts: e.ts, who: by, text: e.content }, () => last);
        continue;
      }
      const task = start({ key: `u${e.seq}`, ts: e.ts, startedBy: by, kind: "message", title: titleOf(e.content) });
      task.items.push({ key: `u${e.seq}`, ts: e.ts, who: by, text: e.content });
    } else if (e.type === "voice_call_changed") {
      const on = e.participants.length > 0;
      if (on && !inCall) {
        const names = e.participants.map((p) => nameOf(p.agentId));
        const task = start({ key: `c${e.seq}`, ts: e.ts, startedBy: who(e.byUid), kind: "call", title: `打给 ${names.join("、")} 的电话` });
        for (const p of e.participants) if (!task.agentIds.includes(p.agentId)) task.agentIds.push(p.agentId);
      } else if (!on && inCall) {
        attach({ key: `c${e.seq}`, ts: e.ts, who: "agent", text: "通话结束" }, () => start({ key: `c${e.seq}`, ts: e.ts, startedBy: "agent", kind: "call", title: "电话" }));
      }
      inCall = on;
    } else if (e.type === "assistant_message") {
      if (e.content.trim() === "") continue;
      // 情绪记号落日志不落界面（ADR-0355）：车道这条显示路径也剥一次（#1614 真机：抽屉里每句都带「（平）」）
      attach(
        { key: `a${e.seq}`, ts: e.ts, who: "agent", text: stripEmotionTags(e.content), ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) },
        () => start({ key: `a${e.seq}`, ts: e.ts, startedBy: "agent", kind: "message", title: titleOf(e.content) }),
      );
    } else if (e.type === "turn_ended" && e.outcome === "error") {
      attach(
        { key: `e${e.seq}`, ts: e.ts, who: "agent", text: `没答上来：${e.error ?? "出错了"}`, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) },
        () => start({ key: `e${e.seq}`, ts: e.ts, startedBy: "agent", kind: "message", title: "没答上来" }),
      );
    }
  }
  return tasks;
}

/** 抽屉里的一行：要么原样一条，要么一段折起来的「过程」（智能体之间的往返） */
export type LaneDigestRow = { kind: "item"; item: LaneTaskItem } | { kind: "process"; key: string; items: LaneTaskItem[] };

/** 这条任务的「结果」：最后一条不是下发的智能体发言（收尾那句）；没有就 null */
export function laneTaskResult(task: LaneTask): LaneTaskItem | null {
  for (let i = task.items.length - 1; i >= 0; i--) {
    const it = task.items[i]!;
    if (it.who === "agent" && it.handoff === undefined) return it;
  }
  return null;
}

/** 抽屉默认只给主人看人说的话 + 结果（#1601，真机 2026-10-05：翻三屏才看到结论）。
    其余智能体的往返——互相 @ 的中间发言、系统替它落的下发——连续的一段折成一格「过程」，顺序不动。 */
export function laneTaskDigest(task: LaneTask): LaneDigestRow[] {
  const result = laneTaskResult(task);
  const rows: LaneDigestRow[] = [];
  for (const item of task.items) {
    const process = item.who === "agent" && item !== result;
    const last = rows.at(-1);
    if (process && last !== undefined && last.kind === "process") last.items.push(item);
    else rows.push(process ? { kind: "process", key: `p${item.key}`, items: [item] } : { kind: "item", item });
  }
  return rows;
}

/** 折起来那格露的一行预览：最后一条的第一行，截短 */
export function laneItemPreview(item: LaneTaskItem, nameOf: (agentId: string) => string): string {
  if (item.handoff !== undefined) return `下发给 ${item.handoff.toAgentIds.map(nameOf).join("、")}`;
  return titleOf(item.text);
}

/** 这条车道此刻有没有人还欠一个回答（最后一条任务「代办中」的判据），与云会话状态行同一份 */
export function laneBusy(events: readonly SessionEvent[]): boolean {
  return openTurns(events).length > 0;
}

export type LaneTaskStatus = "working" | "replied" | "waiting";

/** 卡上的状态：还在答 = 代办中；最后一句是智能体说的 = 已回复；最后一句是人说的、没人在答 = 等回复 */
export function laneTaskStatus(task: LaneTask, busy: boolean): LaneTaskStatus {
  if (busy) return "working";
  const last = task.items.at(-1);
  if (last === undefined) return task.kind === "call" ? "replied" : "waiting";
  return last.who === "agent" ? "replied" : "waiting";
}

export const LANE_TASK_STATUS_LABEL: Record<LaneTaskStatus, string> = { working: "代办中", replied: "已回复", waiting: "等回复" };

/** 卡的第二行：「管理员、助手 · 3 条 · 已回复」 */
export function laneTaskSubtitle(task: LaneTask, status: LaneTaskStatus, nameOf: (agentId: string) => string): string {
  const names = task.agentIds.map(nameOf);
  const n = task.items.filter((i) => i.who === "agent").length;
  return [names.length > 0 ? names.join("、") : null, n > 0 ? `${n} 条进展` : null, LANE_TASK_STATUS_LABEL[status]].filter((s): s is string => s !== null).join(" · ");
}
