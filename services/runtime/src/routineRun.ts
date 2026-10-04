// 到点那一段编排（#1283）：验主人 → 找这只的私聊 → 取房（开着就用、没开就开）→ runRoutine。daemon 只接数据源。
import type { RoutineRow } from "../../../src/shared/routines.js";
import type { RoutineRunResult } from "./routineScheduler.js";
import type { CloudSession } from "./sessionService.js";

export interface RoutineRoom {
  isArchived(): boolean;
  runRoutine: CloudSession["runRoutine"];
  logRoutineNote: CloudSession["logRoutineNote"];
}

export interface RoutineRunDeps<S extends RoutineRoom> {
  /** 这个 workspace 现在的主人（daemon 的 workspaceFacts，每次现查）。任务行上的 ownerUid 是建任务那一刻的旧话 */
  ownerOf(workspaceId: string): Promise<string>;
  /** 这只现成的那条私聊（daemon 的 findDmSession）。没有 = 任务没有归宿 */
  findDm(workspaceId: string, agentId: string): Promise<string | null>;
  /** 开着就用、没开就按启动补开的同一套步骤开；归档了回 null（daemon 的 openOriginRoom） */
  room(workspaceId: string, sessionId: string): Promise<S | null>;
}

/** 主人对不上 = 这条任务不属于这个主场（行被改过 / workspace 易主）：不去找私聊、不开房、不起 turn。
    回 no_chat → 调度器标 failed 并停用；别的结果都会让一个不是主人的人的任务借着主场的沙箱与额度跑起来 */
async function ownerMatches<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow): Promise<boolean> {
  return (await d.ownerOf(r.workspaceId)) === r.ownerUid;
}

export async function runRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, firedAt: number): Promise<RoutineRunResult> {
  if (!(await ownerMatches(d, r))) return "no_chat";
  const sessionId = await d.findDm(r.workspaceId, r.agentId);
  if (sessionId === null) return "no_chat";
  const room = await d.room(r.workspaceId, sessionId);
  if (room === null) return "archived";
  // 必须 await 到 turn 跑完：调度器据此判 done / failed，且顺序处理不并发
  const res = await room.runRoutine({ routineId: r.id, title: r.title, instruction: r.instruction, tz: r.tz, firedAt, agentId: r.agentId });
  return res === "ok" ? "started" : res;
}

/** 注记：开得出房才落；没有私聊 / 归档了 / 主人对不上就算了——注记是给人看的，没地方给人看就不必落 */
export async function noteRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void> {
  if (!(await ownerMatches(d, r))) return;
  const sessionId = await d.findDm(r.workspaceId, r.agentId);
  if (sessionId === null) return;
  const room = await d.room(r.workspaceId, sessionId);
  if (room === null) return;
  room.logRoutineNote({ routineId: r.id, title: r.title, reason, plannedAt, tz: r.tz });
}
