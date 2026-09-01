// 云 runtime 的三档令牌桶（issue #819）。时间注入，不用假定时器。

import { describe, expect, it } from "vitest";
import {
  CREATE_BUCKET,
  SAY_BUCKET,
  TURN_BUCKET,
  createFrameRateLimiter,
  createRateLimiter,
  throttleMessage,
  type ThrottleKind,
} from "../../services/runtime/src/rateLimit.js";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("createRateLimiter（令牌桶）", () => {
  it("突发不超过 capacity，超了就拒", () => {
    const c = clock();
    const l = createRateLimiter({ capacity: 3, refillPerMin: 60 }, c.now);
    expect([l.take("u"), l.take("u"), l.take("u")]).toEqual([true, true, true]);
    expect(l.take("u")).toBe(false);
  });

  it("按经过的时间懒补，不跑定时器", () => {
    const c = clock();
    const l = createRateLimiter({ capacity: 3, refillPerMin: 60 }, c.now); // 每秒 1 个
    l.take("u"); l.take("u"); l.take("u");
    expect(l.take("u")).toBe(false);
    c.advance(1_000);
    expect(l.take("u")).toBe(true);
    expect(l.take("u")).toBe(false);
    c.advance(10_000); // 补过头也只到 capacity
    expect([l.take("u"), l.take("u"), l.take("u"), l.take("u")]).toEqual([true, true, true, false]);
  });

  it("按 key 分桶 —— 一个人刷爆不影响另一个人", () => {
    const c = clock();
    const l = createRateLimiter({ capacity: 2, refillPerMin: 60 }, c.now);
    l.take("a"); l.take("a");
    expect(l.take("a")).toBe(false);
    expect(l.take("b")).toBe(true);
  });

  it("久未使用且已补满的桶会被清掉 —— key 是 uid，不清就是常驻进程里的内存泄漏", () => {
    const c = clock();
    const l = createRateLimiter({ capacity: 1, refillPerMin: 60 }, c.now);
    for (let i = 0; i < 100; i += 1) l.take(`u${i}`);
    c.advance(60_000); // 全部补满
    l.take("trigger-sweep");
    // 清掉之后再来还是满桶 —— 行为上等价，所以只能从"还能不能用"侧面验：
    // 清错了（把没补满的也删了）会让本该被拒的请求被放行
    expect(l.take("trigger-sweep")).toBe(false); // 刚花掉那一个，还没到补的时候
  });
});

describe("createFrameRateLimiter（三档 + 日志收口）", () => {
  it("三档各自独立：say 刷爆不影响 turn/create", () => {
    const c = clock();
    const l = createFrameRateLimiter({ now: c.now });
    for (let i = 0; i < SAY_BUCKET.capacity; i += 1) expect(l.allow("say", "u")).toBe(true);
    expect(l.allow("say", "u")).toBe(false);
    expect(l.allow("turn", "u")).toBe(true);
    expect(l.allow("create", "u")).toBe(true);
  });

  it("turn 比 say 紧得多 —— 它才是真花钱的那档", () => {
    expect(TURN_BUCKET.capacity).toBeLessThan(SAY_BUCKET.capacity);
    expect(TURN_BUCKET.refillPerMin).toBeLessThan(SAY_BUCKET.refillPerMin);
    expect(CREATE_BUCKET.refillPerMin).toBeLessThanOrEqual(TURN_BUCKET.refillPerMin);
  });

  // ADR-0167 同款：日志本身不该成为第二个能被刷爆的东西
  it("被限流的一个时段只记一笔", () => {
    const c = clock();
    const hits: ThrottleKind[] = [];
    const l = createFrameRateLimiter({ now: c.now, onThrottled: (kind) => hits.push(kind) });
    for (let i = 0; i < TURN_BUCKET.capacity + 50; i += 1) l.allow("turn", "u");
    expect(hits).toEqual(["turn"]);
    // 过了窗口再被限一次 → 再记一笔（61 秒会补回几个令牌，所以要重新刷爆）
    c.advance(61_000);
    for (let i = 0; i < TURN_BUCKET.capacity + 50; i += 1) l.allow("turn", "u");
    expect(hits).toEqual(["turn", "turn"]);
  });

  it("不同人各记各的", () => {
    const c = clock();
    const hits: string[] = [];
    const l = createFrameRateLimiter({ now: c.now, onThrottled: (kind, uid) => hits.push(`${kind}:${uid}`) });
    for (let i = 0; i < CREATE_BUCKET.capacity + 3; i += 1) l.allow("create", "a");
    for (let i = 0; i < CREATE_BUCKET.capacity + 3; i += 1) l.allow("create", "b");
    expect(hits).toEqual(["create:a", "create:b"]);
  });

  it("拒绝语说的是「慢一点」不是「出错了」—— 后者会让人反复重试", () => {
    for (const kind of ["say", "turn", "create"] as const) {
      expect(throttleMessage(kind)).toMatch(/稍等|太快|超了/);
    }
  });
});
