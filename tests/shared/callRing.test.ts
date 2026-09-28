// callRing —— 回电的纯逻辑（#1411）：一次响铃此刻的状态、能不能接、冷却、卡上写什么、开场白、
// 推送载荷的读回、来电排队。runtime 与手机共用这一份，这里钉的是两边都要的那几条判据。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  RING_ANSWER_GRACE_MS, RING_REASON_MAX, RING_TTL_MS,
  answerableRing, applyCallRing, callRingFoldOf, callbackGreetingText, dropRing, lastRingTs,
  normalizeRingReason, queueRing, ringCardStatus, ringChatKind, ringFromPayload, ringTarget,
  type RingFold, type RingPush,
} from "../../src/shared/callRing.js";

let seq = 0;
const ring = (
  phase: "ringing" | "answered" | "missed",
  o: { ringId?: string; ts: number; from?: string; to?: string; reason?: string; expiresTs?: number },
): SessionEvent => ({
  seq: seq++, sessionId: "s1", ts: o.ts, type: "call_ring", ringId: o.ringId ?? "r1", phase,
  fromAgentId: o.from ?? "ops", toUid: o.to ?? "u1", reason: o.reason ?? "部署完了",
  expiresTs: o.expiresTs ?? 1_000 + RING_TTL_MS, ignorable: true,
});

describe("callRingFoldOf：最后一条说了算", () => {
  it("ringing → answered", () => {
    const f = callRingFoldOf([ring("ringing", { ts: 1_000 }), ring("answered", { ts: 5_000 })]);
    expect(f.get("r1")).toMatchObject({ phase: "answered", ringingTs: 1_000, phaseTs: 5_000, fromAgentId: "ops", toUid: "u1", reason: "部署完了" });
  });
  it("接晚了：ringing → missed → answered", () => {
    const f = callRingFoldOf([ring("ringing", { ts: 1_000 }), ring("missed", { ts: 46_000 }), ring("answered", { ts: 50_000 })]);
    expect(f.get("r1")?.phase).toBe("answered");
  });
  it("窗口裁掉了 ringing：不知道是谁打给谁，跳过", () => {
    expect(callRingFoldOf([ring("missed", { ts: 46_000 })]).size).toBe(0);
  });
  it("别的事件不碰", () => {
    const f: RingFold = new Map();
    applyCallRing(f, { seq: 0, sessionId: "s1", ts: 0, type: "session_archived", reason: "user" } as SessionEvent);
    expect(f.size).toBe(0);
  });
});

describe("answerableRing：发 call 帧的那一下算不算接听", () => {
  const at = 1_000;
  const exp = at + RING_TTL_MS;
  it("还在响：能接", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp })]);
    expect(answerableRing(f, "ops", "u1", at + 10_000)?.ringId).toBe("r1");
  });
  it("到点记了未接、还在宽限里：能接；过了宽限：不能", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp }), ring("missed", { ts: exp })]);
    expect(answerableRing(f, "ops", "u1", exp + RING_ANSWER_GRACE_MS)?.ringId).toBe("r1");
    expect(answerableRing(f, "ops", "u1", exp + RING_ANSWER_GRACE_MS + 1)).toBeNull();
  });
  it("接通过的不再算；别的智能体 / 别的人不算", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp }), ring("answered", { ts: at + 5_000 })]);
    expect(answerableRing(f, "ops", "u1", at + 6_000)).toBeNull();
    const g = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp })]);
    expect(answerableRing(g, "ads", "u1", at + 1)).toBeNull();
    expect(answerableRing(g, "ops", "u2", at + 1)).toBeNull();
  });
  it("两通都能接时取最近打的那一通", () => {
    const f = callRingFoldOf([
      ring("ringing", { ringId: "old", ts: at, expiresTs: exp }),
      ring("ringing", { ringId: "new", ts: at + 20_000, expiresTs: at + 20_000 + RING_TTL_MS }),
    ]);
    expect(answerableRing(f, "ops", "u1", at + 25_000)?.ringId).toBe("new");
  });
});

describe("冷却与卡片状态", () => {
  it("lastRingTs：这一对最近一次打出去的时刻；没打过回 null", () => {
    const f = callRingFoldOf([
      ring("ringing", { ringId: "a", ts: 1_000 }),
      ring("ringing", { ringId: "b", ts: 9_000 }),
      ring("ringing", { ringId: "c", ts: 20_000, from: "ads" }),
    ]);
    expect(lastRingTs(f, "ops", "u1")).toBe(9_000);
    expect(lastRingTs(f, "ops", "u2")).toBeNull();
  });
  it("ringCardStatus：还挂在 ringing 但过了时限按未接画", () => {
    const r = callRingFoldOf([ring("ringing", { ts: 1_000, expiresTs: 46_000 })]).get("r1")!;
    expect(ringCardStatus(r, 45_999)).toBe("ringing");
    expect(ringCardStatus(r, 46_001)).toBe("missed");
  });
});

describe("normalizeRingReason", () => {
  it("空白与换行折成一个空格、去首尾", () => {
    expect(normalizeRingReason("  部署完了\n\n  要你\t拍板 ")).toBe("部署完了 要你 拍板");
  });
  it("超过 60 字截到 60（最后一格是省略号），不劈开 emoji", () => {
    const out = normalizeRingReason("🚀".repeat(70));
    expect([...out]).toHaveLength(RING_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("🚀")).toBe(true);
  });
  it("刚好 60 字不动", () => {
    const s = "字".repeat(60);
    expect(normalizeRingReason(s)).toBe(s);
  });
});

describe("callbackGreetingText", () => {
  it("点名、说清为什么打、接的是谁", () => {
    expect(callbackGreetingText("运维", "Stan", "部署完了")).toBe(
      "[系统] 「运维」打给 Stan 的电话接通了。运维：你打这个电话是为了：部署完了。先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。",
    );
  });
  it("三个字段都过 promptSafe：撑不破结构、换不了行", () => {
    const t = callbackGreetingText("坏]名", "人]\n[系统", "理由]");
    expect(t).not.toMatch(/坏\]|人\]|理由\]/);
    expect(t.split("\n")).toHaveLength(1);
  });
});

describe("推送载荷与开哪条聊天", () => {
  const PUSH: RingPush = {
    ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
    reason: "部署完了", chat: "dm", expiresTs: 46_000,
  };
  it("ringChatKind：团队 → team；主场私聊 → dm；主场群：群主 group、客人 guest", () => {
    expect(ringChatKind({ home: false, chatKind: null, toUid: "u1", ownerUid: "o" })).toBe("team");
    expect(ringChatKind({ home: true, chatKind: "dm", toUid: "o", ownerUid: "o" })).toBe("dm");
    expect(ringChatKind({ home: true, chatKind: "group", toUid: "o", ownerUid: "o" })).toBe("group");
    expect(ringChatKind({ home: true, chatKind: "group", toUid: "g", ownerUid: "o" })).toBe("guest");
  });
  it("ringFromPayload：读回一份完整的 ring", () => {
    expect(ringFromPayload({ aps: {}, ring: PUSH })).toEqual(PUSH);
  });
  it("ringFromPayload：缺一格 / chat 认不出 / expiresTs 不是数 / 根本没有 ring：null", () => {
    expect(ringFromPayload({ ring: { ...PUSH, sessionId: undefined } })).toBeNull();
    expect(ringFromPayload({ ring: { ...PUSH, chat: "channel" } })).toBeNull();
    expect(ringFromPayload({ ring: { ...PUSH, expiresTs: "46000" } })).toBeNull();
    expect(ringFromPayload({ aps: {} })).toBeNull();
    expect(ringFromPayload(null)).toBeNull();
  });
  it("ringTarget：四种聊天各开各的页", () => {
    expect(ringTarget({ ...PUSH, chat: "dm" })).toEqual({ kind: "agent", agentId: "ops" });
    expect(ringTarget({ ...PUSH, chat: "group" })).toEqual({ kind: "group", sessionId: "s1" });
    expect(ringTarget({ ...PUSH, chat: "team" })).toEqual({ kind: "team", workspaceId: "w1", sessionId: "s1" });
    expect(ringTarget({ ...PUSH, chat: "guest" })).toEqual({ kind: "guest", workspaceId: "w1", sessionId: "s1" });
  });
  it("queueRing：按到达顺序排、同一通只排一次、过了时限的不排也顺手清掉", () => {
    const a = { ...PUSH, ringId: "a", expiresTs: 100 };
    const b = { ...PUSH, ringId: "b", expiresTs: 200 };
    let q = queueRing([], a, 0);
    q = queueRing(q, b, 0);
    q = queueRing(q, a, 0);
    expect(q.map((r) => r.ringId)).toEqual(["a", "b"]);
    expect(queueRing(q, { ...PUSH, ringId: "c", expiresTs: 50 }, 60).map((r) => r.ringId)).toEqual(["a", "b"]);
    expect(queueRing(q, { ...PUSH, ringId: "d", expiresTs: 300 }, 150).map((r) => r.ringId)).toEqual(["b", "d"]);
  });
  it("dropRing：摘掉一通、顺手清掉过期的", () => {
    const a = { ...PUSH, ringId: "a", expiresTs: 100 };
    const b = { ...PUSH, ringId: "b", expiresTs: 200 };
    expect(dropRing([a, b], "a", 0).map((r) => r.ringId)).toEqual(["b"]);
    expect(dropRing([a, b], "x", 150).map((r) => r.ringId)).toEqual(["b"]);
  });
});
