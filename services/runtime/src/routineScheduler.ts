// 定时任务的调度器（#1283，spec §3 / §5.3）。daemon 里一只 30 秒的 setInterval 调 tick()；判断全在这里、
// 数据源全靠注入（daemon.ts 进不了 vitest）。
// 顺序纪律：**先认领（推进 next_run_at）再起 turn**——起 turn 失败不会让它每 30 秒重试一次烧钱。
import { RELAY_BUDGET_FRACTION_OF_REMAINING } from "../../../src/shared/agentRelay.js";
import {
  nextRunAt, ROUTINE_KEEP_DONE_MS, ROUTINE_MIN_GAP_MS, ROUTINE_ONCE_GRACE_MS, ROUTINE_RECURRING_GRACE_MS, type RoutineRow,
} from "../../../src/shared/routines.js";
import type { RoutineStore } from "./routineStore.js";

export type RoutineRunResult = "started" | "no_chat" | "archived" | "no_agent";

export interface RoutineSchedulerDeps {
  store: RoutineStore;
  /** 主人剩余周额度；null = 问不出来——照跑（同 ADR-0238 的降级：问不出钱不等于没钱，且这是主人自己建的任务） */
  quota(ownerUid: string): Promise<{ remainingMicro: number; limitMicro: number } | null>;
  /** 找私聊 → 开房 → session.runRoutine（daemon 接 routineRun.ts 的 runRoutineInRoom）。必须 await 到 turn 跑完 */
  run(r: RoutineRow, firedAt: number): Promise<RoutineRunResult>;
  /** 私聊里落一条 routine_note；开不出房就算了（调用方自己吞错） */
  note(r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void>;
  now(): number;
  log(m: string): void;
}

export const ROUTINE_TICK_MS = 30_000;
/** 一次 tick 最多处理这么多条，顺序处理不并发——50 条 turn 同时起步就是 50 个容器抢 CPU（同启动错峰的理由） */
export const ROUTINE_TICK_LIMIT = 50;

export function createRoutineScheduler(deps: RoutineSchedulerDeps): { tick(): Promise<void>; start(periodMs?: number): () => void } {
  let ticking = false;

  async function handle(r: RoutineRow, now: number): Promise<void> {
    const planned = r.nextRunAt;
    if (planned === null) return;
    const once = r.schedule.kind === "once";
    // 下一跳：严格晚于 max(now, 原定 + 60s)——时钟抖到原定之前一点点也不会算出同一刻
    const next = nextRunAt(r.schedule, r.tz, Math.max(now, planned + ROUTINE_MIN_GAP_MS));
    if (!(await deps.store.claim(r.id, planned, { nextRunAt: next, lastRunAt: now }))) return; // 另一个实例先到
    const late = now - planned;
    if (late > (once ? ROUTINE_ONCE_GRACE_MS : ROUTINE_RECURRING_GRACE_MS)) {
      // 漏跑（spec §3.4）：一次性的标 missed + 注记 + 停用；重复的直接等下一跳，不解释（迟到三小时的早报不如不来）
      if (once) {
        await deps.store.setStatus(r.id, "missed", false);
        await safeNote(r, "missed", planned);
      }
      return;
    }
    const q = await deps.quota(r.ownerUid);
    if (q !== null && q.remainingMicro < q.limitMicro * RELAY_BUDGET_FRACTION_OF_REMAINING) {
      await deps.store.setStatus(r.id, "skipped_quota", once ? false : undefined);
      await safeNote(r, "skipped_quota", planned);
      return;
    }
    let result: RoutineRunResult;
    try {
      result = await deps.run(r, now);
    } catch (err) {
      deps.log(`定时任务起 turn 失败（id=${r.id}「${r.title}」）：${err instanceof Error ? err.message : String(err)}`);
      await deps.store.setStatus(r.id, "failed", once ? false : undefined);
      return;
    }
    if (result === "started") {
      await deps.store.setStatus(r.id, "done", once ? false : undefined);
    } else {
      // 私聊没了 / 那只没了 / 归档了：这条任务没有归宿，停掉（spec §3.5）
      deps.log(`定时任务没地方跑（id=${r.id}「${r.title}」）：${result}`);
      await deps.store.setStatus(r.id, "failed", false);
    }
  }

  async function safeNote(r: RoutineRow, reason: "missed" | "skipped_quota", planned: number): Promise<void> {
    try {
      await deps.note(r, reason, planned);
    } catch (err) {
      deps.log(`定时任务注记没落成（id=${r.id}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return; // 上一轮还没跑完（50 条 turn 起得慢）：这一拍跳过，下一拍再来
    ticking = true;
    try {
      const now = deps.now();
      let due: RoutineRow[];
      try {
        due = await deps.store.due(now, ROUTINE_TICK_LIMIT);
      } catch (err) {
        // 0057 没跑时这里每 30 秒报一次——只记日志，不炸进程
        deps.log(`到点任务读不出来：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const r of due) {
        // 每行各自兜底：一条坏行（bad tz 让 nextRunAt 抛、claim 稳定报错…）不能堵在队头饿死后面的行、也不能拦住 purge。
        // 认领在先的语义不变：claim 偶发抛错没推进 next_run_at，下一拍自然重试。
        // 每行读新鲜时钟：前面行的 run 要 await 到整轮 turn 跑完，共用 tick 起点的 now 会让后面的行拿旧钟算宽限、盖 lastRunAt。
        try {
          await handle(r, deps.now());
        } catch (err) {
          deps.log(`定时任务处理失败（id=${r.id}「${r.title}」）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        const n = await deps.store.purge(now - ROUTINE_KEEP_DONE_MS);
        if (n > 0) deps.log(`清掉 ${n} 条跑完超过 7 天的一次性定时任务`);
      } catch (err) {
        deps.log(`定时任务清理失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(periodMs = ROUTINE_TICK_MS) {
      // .catch 不能省：定时器回调里的 reject 会变成 unhandledRejection 带走整个进程（同 sweepIdle 那只）
      const h = setInterval(() => void tick().catch((err: unknown) => deps.log(`定时任务 tick 失败：${String(err)}`)), periodMs);
      return () => clearInterval(h);
    },
  };
}
