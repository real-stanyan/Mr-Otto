// 云 runtime 的限流（issue #819）——纯逻辑，时间从外面注入，跑在根门禁里。
//
// 过渡期烧的是**维护者的模型 key**（ADR-0199 spec §6，额度强制执行留到
// 三期）。在此之前，任一工作区的任一成员可以：无限刷 @Agent 烧 key、
// 无限追加事件撑大 VPS 的 SQLite、无限建会话（每条会话 = 一行 Supabase +
// 一个常驻 WebSocket 房间 + 一份 EventStore）。三条路都没有任何闸。
//
// 形状照 ADR-0167 那道现成先例（好友代理执行器的并发 + 令牌桶）：桶按
// **uid** 分，不按 cid——按 cid 分等于"多开几条连接就能多刷几次"，那不是
// 限流是计数器。**被限流的一个时段只记一笔**（onThrottled 的 window）：
// 日志本身不该成为第二个可以被刷爆的东西。
//
// 这里不做配额（"这个月你花了多少钱"）：那是三期计费的事，需要跨进程、
// 跨重启的账。这里只做"每秒别踩油门到底"，进程内、重启即忘——它拦的是
// 脚本，不是节俭。

/** 令牌桶的一档配置。capacity = 突发能攒多少，refillPerMin = 稳态速率 */
export interface BucketSpec {
  capacity: number;
  refillPerMin: number;
}

/** 三档闸门的取值。数字的依据都是"一个人手动操作能有多快"，不是压测出来的：
    - say：群里连着说话，一分钟 30 条已经是很热闹的聊天了（突发 30）
    - turn：每条 @Agent 都可能起一次模型调用 = 真花钱。一分钟 4 次 =
      平均 15 秒一轮，比人类跟 agent 来回的节奏还宽松；突发 10 接住
      "连着补几句上下文"这种真实形态
    - create：建会话是低频动作（每条 = 一行 Supabase + 一个常驻房间 +
      一份 EventStore），一分钟 2 次、突发 5 足够 */
export const SAY_BUCKET: BucketSpec = { capacity: 30, refillPerMin: 30 };
export const TURN_BUCKET: BucketSpec = { capacity: 10, refillPerMin: 4 };
export const CREATE_BUCKET: BucketSpec = { capacity: 5, refillPerMin: 2 };

/** 被限流时的日志窗口：同一个 uid 在这段时间里只记一笔（ADR-0167 同款）。 */
const THROTTLE_LOG_WINDOW_MS = 60_000;

export interface RateLimiter {
  /** 扣一个令牌。true = 放行；false = 这一刻没额度了 */
  take(key: string): boolean;
}

interface Bucket {
  tokens: number;
  /** 上一次结算的时刻——懒补：不跑定时器，取的时候按经过的时间算 */
  at: number;
}

export function createRateLimiter(spec: BucketSpec, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const perMs = spec.refillPerMin / 60_000;
  /** 一个空桶补满要多久——超过这个时间没人碰过的桶，留着和删掉等价
      （删了下次现建，还是满的）。**必须清**：key 是 uid，不清就是一条
      随用户数单调增长的内存泄漏，而这个进程是常驻的 */
  const idleMs = spec.capacity / perMs;

  return {
    take(key) {
      const t = now();
      const b = buckets.get(key) ?? { tokens: spec.capacity, at: t };
      b.tokens = Math.min(spec.capacity, b.tokens + (t - b.at) * perMs);
      b.at = t;

      // 顺手扫一遍已经补满且久未使用的桶。挂在 take 上而不是定时器上：
      // 没人来的时候本来就不需要清（内存不会增长），来的时候才清
      if (buckets.size > 64) {
        for (const [k, v] of buckets) {
          if (k !== key && v.tokens >= spec.capacity && t - v.at > idleMs) buckets.delete(k);
        }
      }

      if (b.tokens < 1) {
        buckets.set(key, b);
        return false;
      }
      b.tokens -= 1;
      buckets.set(key, b);
      return true;
    },
  };
}

export type ThrottleKind = "say" | "turn" | "create";

export interface FrameRateLimiter {
  /** true = 放行。false = 超速，调用方负责回一条**看得见**的拒绝
      （静默丢弃会让人以为消息发出去了） */
  allow(kind: ThrottleKind, uid: string): boolean;
}

/** 三档合一，外加"被限流的一个时段只记一笔"的日志收口。 */
export function createFrameRateLimiter(opts: {
  now?: () => number;
  /** 记一笔"某某在超速"。同一个 (kind, uid) 一分钟只调一次 */
  onThrottled?: (kind: ThrottleKind, uid: string) => void;
} = {}): FrameRateLimiter {
  const now = opts.now ?? Date.now;
  const limiters: Record<ThrottleKind, RateLimiter> = {
    say: createRateLimiter(SAY_BUCKET, now),
    turn: createRateLimiter(TURN_BUCKET, now),
    create: createRateLimiter(CREATE_BUCKET, now),
  };
  const loggedAt = new Map<string, number>();

  return {
    allow(kind, uid) {
      if (limiters[kind].take(uid)) return true;
      const k = `${kind}:${uid}`;
      const t = now();
      const last = loggedAt.get(k);
      if (last === undefined || t - last > THROTTLE_LOG_WINDOW_MS) {
        loggedAt.set(k, t);
        opts.onThrottled?.(kind, uid);
      }
      return false;
    },
  };
}

/** 拒绝时给用户看的那句话。说清楚"是被限速了"而不是"出错了"——
    后者会让人反复重试，正是限流最不想要的反应 */
export function throttleMessage(kind: ThrottleKind): string {
  switch (kind) {
    case "turn":
      return "@Agent 的频率超了，稍等一会儿再试（云端模型额度是共享的）。";
    case "create":
      return "建会话太频繁了，稍等一会儿再试。";
    case "say":
      return "发得太快了，稍等一会儿再说。";
  }
}
