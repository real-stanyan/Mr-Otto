// Quota DO 的耗时分解（#1304）。**只量不改行为**：这一整份东西加进去，额度怎么算、
// 谁被拒、拒了说什么，一个字都没变。
//
// 为什么要它：一趟 DO 往返的代价取决于请求**从哪个 colo 进来** —— `QUOTA` 是一户一个
// 实例（`getByName(uid)`），落点由它第一次被创建时的 colo 决定、之后不动。2026-09-21
// 实测同一个账号同一份请求，`/billing/v1/me`（**一趟** DO、不碰上游）在 SYD 那侧中位
// 0.176s、在 HEL 那侧中位 1.34s，且在 0.83–4.90s 之间跳（ADR-0303 补记）。而云会话跑在
// HEL 那台 VPS 上，每一轮 chat 都在付这笔。
//
// 那 1.34s 里至少有三样东西混在一起，**而它们各自对应一个完全不同的修法**：
//   ① 纯往返（客户端 colo → DO 落点 → 回来）          → 只有放置策略治得了
//   ② DO 里 `plan()` 那两条 Supabase 查询             → `planCache` 落 storage 就治好了（它现在是实例内存，60s，实例被回收就没了）
//   ③ DO 冷启动 `pageAll` 翻 usage_event 重建 state   → 又是另一件事
// 不知道构成之前，任何一个修法都是猜 —— 尤其 Smart Placement：现在已知这些 DO 都在悉尼
// 附近，盲开很可能把欧洲用户的「一趟慢往返」换成「整个请求都慢」。
//
// **两侧各量各的时长再相减，不比对两边的时间戳**：DO 与 Worker 是两台机器、时钟对不齐；
// 而「Worker 观测到这趟 fetch 花了多久」减去「DO 自报在里面花了多久」是两个各自成立的
// 时长之差，天然没有时钟偏移。往返 = `outer - in`，由读的人自己减 —— 这里不预先减好，
// 因为 Workers 的时钟粗化（见下）可能让差值为负，而一个负的「往返」是测量噪声不是事实，
// 夹成 0 会把它伪装成「往返可以忽略」。
//
// **Workers 里的 `Date.now()` 只在 I/O 之后推进**（时序攻击缓解）。这里每一格量的都是
// I/O，所以量得到；哪天有人拿这套去量一段纯 CPU，会得到 0 —— 那不是坏了。

/** 分解结果挂在响应头上。**不进 `src/shared/billing.ts` 的 BILLING_HEADERS**：
    那张表是给客户端读的约定，而这一格没有任何客户端消费方，只给 `curl -D -` 看 */
export const QUOTA_TIMING_HEADER = "x-otto-quota-timing";

/** DO 自报的那一半（它放在回执的 `timing` 字段里） */
export interface QuotaTiming {
  /** 整个 dispatch 在 DO 里花了多久 */
  total: number;
  /** 其中 `plan()` 花了多久（缓存命中时是 0） */
  plan: number;
  /** `plan()` 这一趟是不是真打了 Supabase（缓存没命中）*/
  planCold: boolean;
  /** 其中 `state()` 花了多久 */
  state: number;
  /** `state()` 这一趟是不是做了冷启动重建（`pageAll` 翻 usage_event）*/
  rebuilt: boolean;
}

/** 一趟外部调用的观测：Worker 侧量到的墙上时间 + DO 自报的那一半。
    `inner` 为 null = 这一趟没有内层数据（打的不是 DO，或者 DO 没回 `timing`）*/
export interface QuotaSample {
  label: string;
  outerMs: number;
  inner: QuotaTiming | null;
}

/** DO 回执里的 `timing` → 强类型。**五格缺一不可，缺了回 null 不拿 0/false 冒充** ——
    同 `parseRemaining`（#1304）：一个假的 `in=0` 会把这一趟的全部时间记到「纯往返」
    头上，而「往返还是 DO 内部」正是这次要分辨的那件事，冒充出来的答案比没有答案更坏 */
export function parseTiming(v: unknown): QuotaTiming | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const [total, plan, state] = [n(r.total), n(r.plan), n(r.state)];
  if (total === null || plan === null || state === null) return null;
  if (typeof r.planCold !== "boolean" || typeof r.rebuilt !== "boolean") return null;
  return { total, plan, planCold: r.planCold, state, rebuilt: r.rebuilt };
}

/** 标签只可能来自本仓的字面量，但头里混进换行就是一次响应头注入 —— 一行闸比
    「以后别往这儿传用户输入」这句约定便宜 */
function safeLabel(label: string): string {
  return label.replace(/[^\w:.-]/g, "") || "?";
}

function ms(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0;
}

/** 一行给人读的分解。样本之间用 `; ` 隔开：
    `view outer=1340 in=612 plan=580 cold=1 state=20 reb=0; me:db outer=210`
    往返 = `outer - in`。**没有 `in=` 就是这一趟没有内层数据**，不是内层为 0 */
export function formatQuotaTiming(samples: readonly QuotaSample[]): string {
  return samples
    .map((s) => {
      const head = `${safeLabel(s.label)} outer=${ms(s.outerMs)}`;
      if (!s.inner) return head;
      const t = s.inner;
      return `${head} in=${ms(t.total)} plan=${ms(t.plan)} cold=${t.planCold ? 1 : 0} state=${ms(t.state)} reb=${t.rebuilt ? 1 : 0}`;
    })
    .join("; ");
}

/** 把分解挂到响应上。**两道闸**：一趟都没打过就原样不碰（中继那条 101 升级响应
    连 `new Response` 都构造不出来，而它本来就不碰 DO）；上游那份 Response 的头是
    只读的，`set` 会抛 —— 抛了就算了，一个诊断头不值得把一次正常响应变成 500。
    收的是结构类型不是 `Response`：这个文件要进根门禁，而 `@cloudflare/workers-types`
    只在 `services/edge/tsconfig.json` 里（见那份文件头注） */
export function attachQuotaTiming(res: { headers: { set(k: string, v: string): void } }, samples: readonly QuotaSample[]): void {
  if (samples.length === 0) return;
  try {
    res.headers.set(QUOTA_TIMING_HEADER, formatQuotaTiming(samples));
  } catch {
    /* 只读头：算了 */
  }
}
