import { describe, it, expect } from "vitest";
import { createMembershipCache } from "../../services/runtime/src/membershipCache.js";

describe("在籍缓存", () => {
  it("60s 内命中缓存，只打一次查询", async () => {
    let calls = 0;
    let t = 0;
    const c = createMembershipCache(async () => { calls++; return new Set(["u1"]); }, { now: () => t });
    expect(await c.isMember("w", "u1")).toBe(true);
    expect(await c.isMember("w", "u2")).toBe(false);
    expect(calls).toBe(1);
    t = 61_000;
    await c.isMember("w", "u1");
    expect(calls).toBe(2);
  });
  it("查询抛错 fail-closed 且不污染缓存", async () => {
    let fail = true;
    const c = createMembershipCache(async () => { if (fail) throw new Error("db down"); return new Set(["u1"]); });
    expect(await c.isMember("w", "u1")).toBe(false);
    fail = false;
    expect(await c.isMember("w", "u1")).toBe(true);   // 错误不占 60s 缓存位
  });
  // #957 终审 Critical 1：补跑那条路径上「查不到」被当成「确认不在籍」的代价是
  // 一条 append-only 的永久收口，所以它要的是三态而不是 fail-closed 的两态
  it("isMemberOrUnknown：查询抛错回 \"unknown\"，不是 false", async () => {
    let fail = true;
    const c = createMembershipCache(async () => { if (fail) throw new Error("db down"); return new Set(["u1"]); });
    expect(await c.isMemberOrUnknown("w", "u1")).toBe("unknown");
    expect(await c.isMember("w", "u1")).toBe(false);   // 同一次故障，另一个出口仍 fail-closed
    fail = false;
    expect(await c.isMemberOrUnknown("w", "u1")).toBe(true);
    expect(await c.isMemberOrUnknown("w", "u2")).toBe(false);  // 查得到就是真答案，不是 unknown
  });
  it("invalidate 立即失效", async () => {
    let members = new Set(["u1"]);
    const c = createMembershipCache(async () => members);
    await c.isMember("w", "u1");
    members = new Set<string>();
    c.invalidate("w");
    expect(await c.isMember("w", "u1")).toBe(false);
  });
});
