import { describe, it, expect } from "vitest";
import { createTtlCache } from "../../services/runtime/src/ttlCache.js";

describe("TTL 快照（#979 第 5 条，ADR-0232）", () => {
  it("TTL 内命中缓存只查一次；过期重查", async () => {
    let calls = 0;
    let t = 0;
    const c = createTtlCache(async (k: string) => { calls++; return `${k}#${calls}`; }, { ttlMs: 60_000, now: () => t });
    expect(await c.get("w")).toBe("w#1");
    expect(await c.get("w")).toBe("w#1");
    expect(calls).toBe(1);
    t = 60_000;
    expect(await c.get("w")).toBe("w#2");
  });

  it("refresh 无视缓存现查并写入；invalidate 让下一次 get 现查", async () => {
    let calls = 0;
    const c = createTtlCache(async () => { calls++; return calls; }, { ttlMs: 60_000 });
    expect(await c.get("w")).toBe(1);
    expect(await c.refresh("w")).toBe(2);
    expect(await c.get("w")).toBe(2);
    c.invalidate("w");
    expect(await c.get("w")).toBe(3);
  });

  it("查询抛错不写缓存：下一次 get 再查", async () => {
    let fail = true;
    const c = createTtlCache(async () => { if (fail) throw new Error("db down"); return "ok"; }, { ttlMs: 60_000 });
    await expect(c.get("w")).rejects.toThrow("db down");
    fail = false;
    expect(await c.get("w")).toBe("ok");
  });

  it("同一 key 并发 get 合并成一次查询；refresh 不并进正在路上的那次", async () => {
    let calls = 0;
    const releases: Array<() => void> = [];
    const c = createTtlCache(async () => {
      const n = ++calls;
      await new Promise<void>((r) => releases.push(r));
      return n;
    }, { ttlMs: 60_000 });
    const a = c.get("w");
    const b = c.get("w");
    expect(calls).toBe(1);
    expect(a).toBe(b); // 合并成同一个 promise
    const r = c.refresh("w"); // 语义是「此刻之后的事实」，得另打一次
    expect(calls).toBe(2);
    releases[1]!();
    expect(await r).toBe(2);
    releases[0]!();
    expect(await a).toBe(1);
    // 两次都写了缓存，后写的（第一次查询晚回）覆盖——缓存里是"最后落地"的那份；
    // 这里只断言不再发起新查询
    await c.get("w");
    expect(calls).toBe(2);
  });

  it("不同 key 各自缓存", async () => {
    const c = createTtlCache(async (k: string) => k.toUpperCase(), { ttlMs: 60_000 });
    expect(await c.get("a")).toBe("A");
    expect(await c.get("b")).toBe("B");
  });
});
