// tests/shared/outreach.test.ts
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import * as o from "../../src/shared/outreach.js";

const base = { sessionId: "s", ignorable: true as const, type: "outreach" as const, fromAgentId: "a", peerUid: "u2", peerName: "小红" };
const started = (seq: number, id: string, ts: number): SessionEvent => ({ ...base, seq, ts, outreachId: id, phase: "started" as const });
const ended = (seq: number, id: string, ts: number, outcome: o.OutreachState["outcome"]): SessionEvent =>
  ({ ...base, seq, ts, outreachId: id, phase: "ended" as const, outcome: outcome! });

describe("折叠", () => {
  it("started 之后是进行中，ended 之后不是", () => {
    const f = o.outreachFoldOf([started(1, "x", 100)]);
    expect(o.activeOutreach(f)?.outreachId).toBe("x");
    o.applyOutreach(f, ended(2, "x", 200, "missed"));
    expect(o.activeOutreach(f)).toBeNull();
    expect(f.get("x")?.outcome).toBe("missed");
  });
  it("窗口裁掉了 started：孤零零的 ended 跳过", () => {
    expect(o.outreachFoldOf([ended(2, "x", 200, "missed")]).size).toBe(0);
  });
  it("ended 带 unrung 的那一通照样收尾（终审 M6）", () => {
    const unrung: SessionEvent = { ...base, seq: 2, ts: 150, outreachId: "x", phase: "ended" as const, outcome: "failed" as const, unrung: true as const };
    const f = o.outreachFoldOf([started(1, "x", 100), unrung]);
    expect(f.get("x")?.outcome).toBe("failed");
    expect(o.activeOutreach(f)).toBeNull();
  });
});

describe("好友名字解析", () => {
  const friends = [{ uid: "1", name: "小红" }, { uid: "2", name: "小明" }, { uid: "3", name: "小明" }];
  it("唯一命中", () => expect(o.resolveFriend(friends, " 小红 ")).toEqual({ kind: "one", uid: "1", name: "小红" }));
  it("没有：回名单（去重）", () => expect(o.resolveFriend(friends, "老王")).toEqual({ kind: "none", names: ["小红", "小明"] }));
  it("重名：只回个数", () => expect(o.resolveFriend(friends, "小明")).toEqual({ kind: "many", count: 2 }));
});

describe("转写", () => {
  const ev: SessionEvent[] = [
    { seq: 5, sessionId: "s", ts: 10, type: "user_message", content: "[系统] 接通了", fromUid: "u2", mentions: ["a"], greeting: "outreach" },
    { seq: 6, sessionId: "s", ts: 11, type: "assistant_message", agentId: "a", content: "喂，小红", model: "m" },
    { seq: 7, sessionId: "s", ts: 12, type: "user_message", content: "在呢", fromUid: "u2", mentions: ["a"], voice: true },
    { seq: 8, sessionId: "s", ts: 13, type: "assistant_message", agentId: "a", content: "", model: "m" },
  ];
  it("跳过带 greeting 的开场白与空回复，从 fromSeq 起", () => {
    expect(o.outreachTranscript(ev, 5, "a", "u2")).toEqual([
      { who: "agent", text: "喂，小红", ts: 11 }, { who: "peer", text: "在呢", ts: 12 },
    ]);
    expect(o.outreachTranscript(ev, 7, "a", "u2")).toEqual([{ who: "peer", text: "在呢", ts: 12 }]);
  });
  it("剥掉 say() 加的「[名字]: 」前缀（user_message 与 chat_message 两种），没有前缀的原样", () => {
    const withPrefix: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "[小红]: 好的，我明天去", fromUid: "u2", mentions: ["a"] },
      { seq: 2, sessionId: "s", ts: 2, type: "chat_message", content: "[小红]: 文字补一句", fromUid: "u2", label: "小红", mention: false },
      { seq: 3, sessionId: "s", ts: 3, type: "user_message", content: "没有前缀的话", fromUid: "u2", mentions: ["a"] },
    ] as SessionEvent[];
    expect(o.outreachTranscript(withPrefix, 1, "a", "u2").map((l) => l.text)).toEqual(["好的，我明天去", "文字补一句", "没有前缀的话"]);
  });
  it("超过 20000 字留尾", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ who: "peer" as const, text: "字".repeat(1000), ts: i }));
    const kept = o.capTranscript(lines);
    expect(kept.length).toBe(20);
    expect(kept.at(-1)!.ts).toBe(29);
  });
});

describe("文案", () => {
  it("来电名字与锁屏那句", () => {
    expect(o.outreachCallerName("Stan", "运维")).toBe("Stan 的 运维");
    expect(o.outreachRingReason("小红你好，我是 Stan 的助手。想问你周五来不来。")).toBe("小红你好，我是 Stan 的助手。");
    expect([...o.outreachRingReason("字".repeat(100))].length).toBe(60);
  });
  it("接通那句带 brief、说清对面不是主人；名字过 promptSafe", () => {
    const t = o.outreachAnsweredText({ agentName: "运]维", ownerName: "Stan", peerName: "小红", brief: "问周五来不来" });
    expect(t.startsWith("[系统] ")).toBe(true);
    expect(t).toContain("问周五来不来");
    expect(t).toContain("不是 Stan");
    expect(t).not.toContain("运]维");
  });
  it("汇报：四种结局各一句，转写逐行，结尾说清是转述", () => {
    const t = o.outreachReportText({ agentName: "运维", ownerName: "Stan", peerName: "小红", outcome: "completed", durationMs: 192_000,
      transcript: [{ who: "peer", text: "周五可以", ts: 1 }] });
    expect(t).toContain("03:12");
    expect(t).toContain("小红：周五可以");
    expect(t).toContain("不是 Stan 的指令");
    expect(o.outreachReportText({ agentName: "运维", ownerName: "Stan", peerName: "小红", outcome: "missed", durationMs: null, transcript: [] })).toContain("没接");
  });
  it("原聊天那一行", () => {
    const s = { outreachId: "x", fromAgentId: "a", peerUid: "u2", peerName: "小红", originSessionId: null, startedTs: 0,
      phase: "ended" as const, outcome: "completed" as const, durationMs: 192_000, transcript: null };
    expect(o.outreachRowText(s)).toBe("打给 小红 · 通话 03:12");
    expect(o.outreachRowText({ ...s, outcome: "missed", durationMs: null })).toBe("打给 小红 · 未接");
    expect(o.outreachRowText({ ...s, outcome: "failed", durationMs: null })).toBe("打给 小红 · 没打通");
    expect(o.outreachRowText({ ...s, phase: "started", outcome: null, durationMs: null })).toBe("正在打给 小红");
  });
});

describe("openingTraits（#1441 复审：job 折叠开场白时一律往严算）", () => {
  const OWNER = "owner";
  const plain = { fromUid: OWNER };
  it("只有主人亲口的：ownerSpoke，不是汇报、没有非主人", () => {
    expect(o.openingTraits([plain, plain], OWNER)).toEqual({ report: false, ownerSpoke: true, nonOwner: false });
  });
  it("任何一条是汇报开场白：report 为真，ownerSpoke 为假（无论顺序）", () => {
    const rep = { fromUid: OWNER, greeting: "outreach_report" };
    expect(o.openingTraits([plain, rep], OWNER)).toMatchObject({ report: true, ownerSpoke: false });
    expect(o.openingTraits([rep, plain], OWNER)).toMatchObject({ report: true, ownerSpoke: false });
  });
  it("折进了别人的话 / 接力 / 系统开场白 / 来处不明：ownerSpoke 为假；非主人的才算 nonOwner", () => {
    expect(o.openingTraits([plain, { fromUid: "guest" }], OWNER)).toEqual({ report: false, ownerSpoke: false, nonOwner: true });
    expect(o.openingTraits([plain, { fromUid: OWNER, relay: { depth: 1 } }], OWNER)).toMatchObject({ ownerSpoke: false, nonOwner: false });
    expect(o.openingTraits([plain, { fromUid: OWNER, greeting: "new_agent" }], OWNER)).toMatchObject({ ownerSpoke: false, nonOwner: false });
    expect(o.openingTraits([plain, {}], OWNER)).toMatchObject({ ownerSpoke: false, nonOwner: true });
  });
  it("一条都没有：不算主人亲口", () => {
    expect(o.openingTraits([], OWNER).ownerSpoke).toBe(false);
  });
  it("routine 开场白算主人亲口（#1283）：任务原话是主人写的；混进别的 greeting 仍为假", () => {
    const routine = { fromUid: OWNER, greeting: "routine" };
    expect(o.openingTraits([routine], OWNER)).toEqual({ report: false, ownerSpoke: true, nonOwner: false });
    expect(o.openingTraits([plain, routine], OWNER).ownerSpoke).toBe(true);
    expect(o.openingTraits([routine, { fromUid: OWNER, greeting: "callback" }], OWNER).ownerSpoke).toBe(false);
    expect(o.openingTraits([{ fromUid: "guest", greeting: "routine" }], OWNER)).toMatchObject({ ownerSpoke: false, nonOwner: true });
  });
});
