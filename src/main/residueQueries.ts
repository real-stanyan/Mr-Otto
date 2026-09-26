// 残留清单的四个查询（issue #759 / #780 I3-I5）。
//
// 为什么单独一个文件：这四个函数原来是 `src/main/index.ts` 里的装配根闭包，
// 而那个文件一 import 就要拉起 Electron —— 于是它们的**全部**执行覆盖只剩两条
// 读源码的断言（tests/main/residueWiring.test.ts）。#780 自己把这件事标成
// 「独立小任务」，理由是这一族**坏掉的样子都是无声的**：少扫几个会话 = 清单里
// 少几条，和「本来就没有」长得一模一样；没有 baseline 兜底成空快照 = 整机的端口
// 全被算成本会话的残留，进了一个默认勾选、一按就清的清单。
//
// 依赖一律注入（store 的三个查询方法 / 进程组身份核对 / 会话的 residue 能力 /
// 出走进程组），所以这个文件自己不碰 Electron、不碰 node:child_process，
// 装配根只剩一句 `createResidueQueries({...})`。
//
// **注入的是 `store` 本身不是三个函数**：那三个方法的形状就是 EventStore 的形状，
// 拆成三个回调只会让装配根多写三行转发，而转发那三行同样进不了 vitest。

import type { SessionEvent } from "../session/events.js";
import { pendingResidue } from "../session/residueProjection.js";
import { diffResidue, mergeResidue, type ResidueItem, type ResidueSnapshot } from "../shared/residue.js";

/** 一次残留快照的能力：`ExecutionWorld.residue` 的结构子集。
    这里只用得上 `snapshot()`——`cleanup()` 的调用方是 residueClean 那个 IPC
    handler，不在这一族查询里。收窄成结构类型而不是 import `ResidueCapability`，
    假 world 在测试里只造一个 `snapshot` 就够。 */
export interface ResidueSnapshotSource {
  snapshot(): Promise<ResidueSnapshot>;
}

export interface ResidueQueriesDeps {
  /** 日志侧的三个查询。形状就是 `EventStore` 的同名方法，装配根直接把 store 递进来 */
  store: {
    sessionIdsWithEvent(type: SessionEvent["type"]): string[];
    eventsOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent[];
    lastOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent | null;
  };
  /** 进程组身份核对：**还活着** 且 命令行对得上（LocalWorld 那条 `ps -o command= -g`
      现查，判据是 `commandMatches`）。**同步**——`pendingResidueNow` 挂在 `bootInfo()`
      上，而那个函数是同步的、有三个调用方。核不上 = 丢弃是安全方向：宁可漏报一条
      陈旧残留，不可把回收给别人的 pgid 当成自己的残留 */
  groupStillIs(pgid: number, label: string): boolean;
  /** 这个会话**自己**那份残留能力（`agents.get(sessionId)?.world.residue`）。
      现查必须问它，不能退到别的会话：baseline 是会话级的，拿 A 的基线减 B 的现场
      得到的不是任何人的残留。清理侧那条 app 级的退路（residueCapFor）是另一回事，
      留在装配根 */
  residueCapOf(sessionId: string): ResidueSnapshotSource | undefined;
  /** 还在出走的进程组（`liveGroups.escaped()` 的投影） */
  escapedGroups(): Array<{ pgid: number; cmd: string }>;
}

export interface ResidueQueries {
  pendingResidueNow(): ResidueItem[];
  currentResidueDiff(sessionId: string): Promise<ResidueItem[]>;
  residueListNow(sessionId: string): Promise<ResidueItem[]>;
  residueCleanPool(sessionId: string): Promise<ResidueItem[]>;
}

/** 这个会话的 detected/cleaned 按 seq 归并回时间序。
    两类事件必须**合并排序**：`pendingResidue` 是按顺序消费的（detected 落进表、
    cleaned 从表里删），先把一整串 detected 喂完再喂 cleaned 的话，
    「先清掉、后又检出」与「先检出、后清掉」会给出同一个答案 */
function residueEventsOf(deps: ResidueQueriesDeps, sessionId: string): SessionEvent[] {
  return [
    ...deps.store.eventsOfType(sessionId, "residue_detected"),
    ...deps.store.eventsOfType(sessionId, "residue_cleaned"),
  ].sort((a, b) => a.seq - b.seq);
}

/** 重放出来的条目里，进程组那一档要过身份核对再放行（其余原样留着） */
function aliveOnly(deps: ResidueQueriesDeps, items: ResidueItem[]): ResidueItem[] {
  return items.filter(
    (item) => item.detector !== "process_groups" || deps.groupStillIs(Number(item.id), item.label)
  );
}

export function createResidueQueries(deps: ResidueQueriesDeps): ResidueQueries {
  /** 上次退出时没清干净的残留（issue #759）：全部会话（归档的也算）的
      residue_detected 减 residue_cleaned 差集，逐条探活后剩下的那些。
      日志是唯一事实来源——"进程还活着吗"重放不出来，所以差集之后还要现探一次。
      只探进程组（groupStillIs：存活 + 身份核对）；模拟器/端口原样留着：
      现拍一次 simctl/lsof 是异步的，而 bootInfo 是同步的、被三处调用，为一行
      可能陈旧的模拟器把整条 boot 链改成异步不划算——多显示一条让用户手动清掉
      的行，比漏报强。
      按类型取事件而不是 store.load 整份日志：残留事件天然稀疏，而
      (session_id, type, seq) 上有索引；load 整份会把每个会话的全部 JSON 都
      解一遍，开机路径上付不起 */
  const pendingResidueNow = (): ResidueItem[] => {
    const out: ResidueItem[] = [];
    // **归档的会话也要扫**：残留是 app 级的（进程组/模拟器/端口都不属于哪个
    // 会话），跟会话收没收起来无关。而且 ports/simulators 条目的**唯一**来源
    // 就是归档那一刻的全量 diff——那条 residue_detected 恰恰写在刚归档的会话
    // 上，滤掉归档会话等于这一类残留永远重放不出来，用户没当场处理就永久丢。
    // **不走 `store.sessions()`**（#780 M4）：它只藏了一半——用户归档的那些照常返回、
    // 带 archived 标志，而**系统**归档的（reason 缺席或 "system"，子会话收尾走的就是
    // 这条）整个不出现在返回值里。按它遍历的话，那批会话上落的残留一条都重放不出来，
    // 而失败是无声的：清单里少几条，看起来和「本来就没有」一模一样
    for (const sessionId of deps.store.sessionIdsWithEvent("residue_detected")) {
      out.push(...aliveOnly(deps, pendingResidue(residueEventsOf(deps, sessionId))));
    }
    return out;
  };

  /** 「这个会话此刻的现场 diff」：baseline 快照 vs 此刻快照 + 还在出走的进程组。
      **没有 baseline 就不做**（review I5）：原来兜底成 `{ts:0,simulators:[],ports:[]}`
      的空快照，等于宣称"这台机器开机时一个端口一个模拟器都没有"——整机的
      LISTEN 端口和 booted 模拟器全被算成本会话新增的残留，进了一个默认勾选、
      一按就清的清单。归档路径（archiveSession）本来就有这道守卫，这里补齐 */
  const currentResidueDiff = async (sessionId: string): Promise<ResidueItem[]> => {
    const residueCap = deps.residueCapOf(sessionId);
    if (!residueCap) return [];
    const baseline = deps.store.lastOfType(sessionId, "residue_baseline");
    if (baseline?.type !== "residue_baseline") return [];
    const now = await residueCap.snapshot();
    return diffResidue(baseline.snapshot, now, deps.escapedGroups());
  };

  /** residueList 的"此刻可见清单"（issue #759）：现查（baseline diff 现拍现算）
      与日志重放（pendingResidue）合并，现查优先（mergeResidue，issue #759
      Task 7）——重放条目是落盘那一刻的旧快照，现查是这一刻的真实现场，两边
      打架时以看得见的那份为准。
      world 无 residue 能力或会话未激活 → 空数组，同 liveBackgroundTasks 语义 */
  const residueListNow = async (sessionId: string): Promise<ResidueItem[]> => {
    if (!deps.residueCapOf(sessionId)) return [];
    const current = await currentResidueDiff(sessionId);
    // 只看这一个会话的 detected/cleaned（本方法是"这个会话此刻的清单"，
    // 不是 pendingResidueNow 那种 app 级全量扫描）
    return mergeResidue(current, aliveOnly(deps, pendingResidue(residueEventsOf(deps, sessionId))));
  };

  /** residueClean 的匹配池（review I3）：**app 级**，与 pendingResidueNow 同源。
      为什么不能复用 residueListNow：那份只重放**这一个会话**的
      detected/cleaned，而弹窗里的条目是 app 级的（归档会话落的那批、别的
      会话落的那批都在里面）——按会话级清单去匹配，跨会话的 id 一条都对不上，
      targets 是空数组、循环一圈不做事，UI 那边 `res.every(...)` 对空数组恒真
      于是报"清理成功"。现查那部分仍然只能问当前会话（baseline 是会话级的），
      合并时现查优先，同 mergeResidue 的语义 */
  const residueCleanPool = async (sessionId: string): Promise<ResidueItem[]> => {
    const current = await currentResidueDiff(sessionId);
    return mergeResidue(current, pendingResidueNow());
  };

  return { pendingResidueNow, currentResidueDiff, residueListNow, residueCleanPool };
}
