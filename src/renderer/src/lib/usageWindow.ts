// 账号页那半张「用量」卡看的是哪一段时间（#1022）。
//
// 判据只有一条：**能对齐额度卡那扇「本周」就对齐，对不齐就把话说清楚**。
// 两半摆在同一张卡上，一个说「本周」一个其实是「最近 7 天」的话，没人分得出来 ——
// 而这两段时间在周中差着好几天。所以对不齐时标签跟着换。
//
// 窗口起点从 `me.windows.week.resetAt` 反推：那是**下一次**清零的时刻，
// 当前这扇窗就是它往前数一周。没有订阅时服务端压根不下发 windows
// （billingQueries 的 meFromParts：非 active 时报一份满额度的窗口是谎话），
// 于是退回滚动 7 天。

export interface UsageWindow {
  since: number;
  /** true = 与额度卡那扇「本周」是同一扇；false = 滚动 7 天（没有订阅时） */
  aligned: boolean;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * @param resetAt 额度周窗的下次清零时刻；null = 没有活跃订阅
 * @param now     现在。显式传入，函数才是纯的
 */
export function weeklyUsageWindow(resetAt: number | null | undefined, now: number): UsageWindow {
  if (!resetAt) return { since: now - WEEK_MS, aligned: false };
  // 快照可能已经过期（窗口在用户盯着这一页时清零了）：那一刻新窗从 resetAt 起算，
  // 而不是「resetAt 往前一周」——照旧减一周会把上一扇窗的调用算进这一扇
  return { since: resetAt <= now ? resetAt : resetAt - WEEK_MS, aligned: true };
}

/** 这半张卡的标题。对不齐时不写「本周」—— 那是一句没人能验证的假话 */
export function usageWindowLabel(w: UsageWindow): string {
  return w.aligned ? "本周用量" : "近 7 天用量";
}
