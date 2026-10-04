// 定时汇报的调度器（#1569，ADR-0365）：daemon 里一只 60 秒的 setInterval 调 tick()；判断全在这里、数据源注入。
// 顺序纪律同定时任务（#1283）：**先认领（推进 report_next_at）再起 turn**——起 turn 失败不会让它每分钟重试一次烧钱；
// 两台 runtime 同时跑也只有一台认领得到（update … where report_next_at = 读到的那个值）。
import { REPORT_GRACE_MS, nextReportAt, type ReportPlan } from "../../../src/shared/quietHours.js";

export interface ReportRow {
  uid: string;
  plan: ReportPlan;
  tz: string;
  /** null = 刚设好还没排过 */
  nextAt: number | null;
  lastAt: number | null;
}

export interface ReportSchedulerDeps {
  /** 到点的行：开了汇报、且 next 为空或 ≤ now。抛错 = 这一拍查不出来 */
  due(nowMs: number, limit: number): Promise<ReportRow[]>;
  /** 第一次排（或算不出时清空）：只写 next，不写 last */
  setNext(uid: string, nextAt: number | null): Promise<void>;
  /** 认领：next 还等于读到的那个值才推进；回 true = 这一次归我 */
  claim(uid: string, expectedNextAt: number, nextAt: number | null, lastAt: number): Promise<boolean>;
  /** 真跑：拼摘要、开管理员的私聊房、起 turn。抛错只记日志（已经认领过了，不重试） */
  run(r: { uid: string; plan: ReportPlan; tz: string; since: number; firedAt: number }): Promise<void>;
  now(): number;
  log(m: string): void;
}

export const REPORT_TICK_MS = 60_000;
export const REPORT_TICK_LIMIT = 20;

export function createReportScheduler(d: ReportSchedulerDeps): { tick(): Promise<void>; start(periodMs?: number): () => void } {
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = d.now();
      let rows: ReportRow[];
      try {
        rows = await d.due(now, REPORT_TICK_LIMIT);
      } catch (err) {
        d.log(`汇报调度：到点的行查不出来，这一拍跳过：${String(err)}`);
        return;
      }
      for (const r of rows) {
        const next = nextReportAt(r.plan, r.tz, now);
        if (r.nextAt === null) {
          // 刚设好：只排下一跳，不补跑「今天已经过去的那一次」
          await d.setNext(r.uid, next).catch((err: unknown) => d.log(`汇报调度：排不上（uid=${r.uid}）：${String(err)}`));
          continue;
        }
        let mine: boolean;
        try {
          mine = await d.claim(r.uid, r.nextAt, next, now);
        } catch (err) {
          d.log(`汇报调度：认领失败（uid=${r.uid}），下一拍再试：${String(err)}`);
          continue;
        }
        if (!mine) continue;
        if (now - r.nextAt > REPORT_GRACE_MS) {
          d.log(`汇报调度：错过了（uid=${r.uid}，计划 ${new Date(r.nextAt).toISOString()}），不补跑`);
          continue;
        }
        // 这一次覆盖的时段：上一次汇报之后；第一次 = 计划时刻往前 24 小时
        const since = r.lastAt ?? r.nextAt - 86_400_000;
        try {
          await d.run({ uid: r.uid, plan: r.plan, tz: r.tz, since, firedAt: now });
        } catch (err) {
          d.log(`汇报没起来（uid=${r.uid}）：${String(err)}`);
        }
      }
    } finally {
      ticking = false;
    }
  }
  return {
    tick,
    start(periodMs = REPORT_TICK_MS) {
      const h = setInterval(() => void tick(), periodMs);
      void tick();
      return () => clearInterval(h);
    },
  };
}
