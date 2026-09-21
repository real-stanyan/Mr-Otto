// 「回到这一步」分出的那条分支怎么落盘（#1252，ADR-0311）。
//
// 两种落法，判据一条：**这条会话上不上云**。
//  - 项目会话（与 ADR-0311 之前留在本机的存量分叉）走 `store.fork` 的引用式零拷贝（ADR-0084 /
//    issue #352）：只写一条 session_created{forkedFrom}，前缀与父会话共享。
//  - 任务会话走复制式：把父会话 0..boundary 那一段整份抄成一条**独立**会话，不写 forkedFrom。
//
// 为什么任务会话不能用引用式：引用式分叉 `load()` 扁平化之后有**两条** session_created
// （seq 0 是父会话的，endSeq+1 是自己的），而 0036 的 RPC 只许 seq 0 有 session_created ——
// 推上去就是 P0012 → 整条会话永久冻结。#1223 当时的处置是在同步层把这种分叉整个挡在云外
// （ADR-0291 终审 C2），代价是用户在任务会话里「回到这一步」之后聊的那条分支**只在本机、
// 而且界面上一个字都不说**。这里把代价挪到更便宜的一侧：放弃前缀共享，换这条分支上得了云。
//
// 复制式的三笔代价（都是明知的）：
//  1. 前缀不再零拷贝 —— 父会话那一段在库里存了第二份，推上云也是第二份。
//  2. `store.forks(parent)` 看不到这条分支，于是 purge 的 fork 保护（#352）不再挡删父会话。
//     不是漏做：复制式分支的历史住在它自己的行里，删父**不会**把它的记忆抽走，那道保护
//     此刻没有要保护的东西。
//  3. 侧栏上它从「新会话」变成「<父标题>（分支）」—— 这不是顺手改的，是必须改：复制式分支
//     继承了父会话的全部 user_message，`sessions()` 的标题投影因此会给出与父会话**逐字相同**
//     的一行，两条会话在侧栏上分不出来。`store.fork` 的 payload 里本来就写着「（分支）」
//     （只是 `sessions()` 从不读 session_created.title，那一格一直是死数据）。
import type { EventStore, NewSessionEvent } from "../session/store.js";
import { retargetForImport } from "../shared/sessionPackage.js";
import { isCloudTaskSession } from "../shared/taskSync.js";

export type RewindStore = Pick<EventStore, "load" | "append" | "fork" | "forkOrigin" | "has" | "titleOf">;

/** 这条分支是怎么落的。调用方拿它写日志 / 断言，不影响返回的会话 id */
export type RewindKind = "referenced" | "copied";

/** 把 `sessionId` 在 `boundarySeq`（必须是一条 turn_ended）处分出一条新会话 `newId`。
    两条路的前置校验逐字相同 —— 复制式那条不许比引用式松，否则同一个非法输入在两种会话上
    给出两种结局（一条抛错、一条落下一个半截会话）。 */
export function rewindBranch(
  store: RewindStore,
  sessionId: string,
  boundarySeq: number,
  newId: string,
  ts: number
): RewindKind {
  const first = store.load(sessionId, { untilSeq: 0 })[0];
  if (!isCloudTaskSession(first, store.forkOrigin(sessionId))) {
    store.fork(sessionId, boundarySeq, newId, ts);
    return "referenced";
  }
  const prefix = store.load(sessionId, { untilSeq: boundarySeq });
  const boundary = prefix.at(-1);
  if (!boundary || boundary.seq !== boundarySeq) {
    throw new Error(`fork 点不存在：${sessionId} 没有 seq=${boundarySeq} 的事件`);
  }
  if (boundary.type !== "turn_ended") {
    throw new Error(
      `fork 点必须是 turn 收口（turn_ended），seq=${boundarySeq} 是 ${boundary.type}——不继承半截 turn`
    );
  }
  if (store.has(newId)) throw new Error(`会话已存在：${newId}`);
  // append 一条一条来（同 taskSessionSync 的 forkCopy）：没有跨会话的事务原语，所以这一步
  // 排在调用方动文件**之前** —— 半路抛错时侧栏上多一条残会话，磁盘一个字节没动。
  for (const e of retargetForImport(prefix, newId)) store.append(e as NewSessionEvent);
  store.append({
    sessionId: newId,
    ts,
    type: "session_renamed",
    title: `${store.titleOf(sessionId) ?? "会话"}（分支）`,
  });
  return "copied";
}
