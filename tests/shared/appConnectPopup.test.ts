// 连接卡自动弹窗的判据（#1666，spec §4.2）：只弹一次、翻历史不弹、不在场时来的不弹、一次弹一张
import { describe, expect, it } from "vitest";
import { nextBaseline, popupCandidate } from "../../src/shared/appConnectPopup.js";
import type { ChatRow } from "../../src/shared/mobileChat.js";

type Card = Extract<ChatRow, { kind: "app_connect" }>;
const card = (connectId: string, seq: number, o: Partial<Card> = {}): Card => ({
  kind: "app_connect", key: `app_connect-${connectId}`, ts: 1000 + seq, seq, connectId, agentId: "admin", name: "小管家",
  catalogId: "supabase", appName: "Supabase", why: "查表", status: "open", canAct: true, waitingFor: null, ...o,
});
const text = (seq: number): ChatRow => ({ kind: "mine", key: `m${seq}`, ts: 1000 + seq, text: "hi" }) as unknown as ChatRow;
const ok = { baselineSeq: 10, popped: new Set<string>(), focused: true };

describe("popupCandidate", () => {
  it("基线之后开着、我能点、没弹过、页面在前台 → 弹这张", () => {
    const c = card("c1", 11);
    expect(popupCandidate([text(5), c], ok)).toEqual({ row: c, seen: ["c1"] });
  });
  it("seq 不大于基线的卡不弹（翻历史 / 刚进来时就躺在日志里的）", () => {
    expect(popupCandidate([card("c1", 10)], ok)).toBeNull();
    expect(popupCandidate([card("c1", 3)], ok)).toBeNull();
  });
  it("弹过的不再弹", () => {
    expect(popupCandidate([card("c1", 11)], { ...ok, popped: new Set(["c1"]) })).toBeNull();
  });
  it("我点不了（客人只读）/ 不是 open（连上了 / 不用了 / 过期）不弹", () => {
    expect(popupCandidate([card("c1", 11, { canAct: false })], ok)).toBeNull();
    for (const status of ["connected", "dismissed", "expired"] as const) {
      expect(popupCandidate([card("c1", 11, { status })], ok)).toBeNull();
    }
  });
  it("页面不在前台（别的页盖在上面 / app 在后台）回 null", () => {
    expect(popupCandidate([card("c1", 11)], { ...ok, focused: false })).toBeNull();
  });
  it("两张都符合：弹 seq 大的，不论行的先后；两张都算看过（不接着再弹第二张）", () => {
    const a = card("c1", 11);
    const b = card("c2", 14);
    expect(popupCandidate([a, b], ok)).toEqual({ row: b, seen: ["c2", "c1"] });
    expect(popupCandidate([b, a], ok)).toEqual({ row: b, seen: ["c2", "c1"] });
  });
  it("看过的集合只含此刻符合的：弹过的 / 点不了的不在里面", () => {
    const a = card("c1", 11);
    const b = card("c2", 14);
    const c = card("c3", 12, { canAct: false });
    expect(popupCandidate([a, b, c], { ...ok, popped: new Set(["c1"]) })).toEqual({ row: b, seen: ["c2"] });
  });
  it("没有卡 → null", () => {
    expect(popupCandidate([], ok)).toBeNull();
    expect(popupCandidate([text(20)], ok)).toBeNull();
  });
});

describe("nextBaseline", () => {
  const here = { sessionId: "s1", ready: true, watching: true, maxSeq: () => 42 };
  it("在场、日志到齐、还没有基线 → 取此刻最大 seq", () => {
    expect(nextBaseline(null, here)).toEqual({ sessionId: "s1", seq: 42 });
  });
  it("已有基线就留着，不随新事件上移（新卡要能弹）", () => {
    expect(nextBaseline({ sessionId: "s1", seq: 10 }, here)).toEqual({ sessionId: "s1", seq: 10 });
  });
  it("日志没到齐（连接中 / 缓存）或不在场（页面被盖住 / 在后台）：作废，等下一次在场且到齐再取", () => {
    const base = { sessionId: "s1", seq: 10 };
    expect(nextBaseline(base, { ...here, ready: false })).toBeNull();
    expect(nextBaseline(base, { ...here, watching: false })).toBeNull();
    expect(nextBaseline(null, { ...here, watching: false })).toBeNull();
    expect(nextBaseline(null, { ...here, ready: false })).toBeNull();
  });
  it("走开 → 期间来了卡 → 回来：新基线把期间的卡盖住，回来后不弹它", () => {
    let b = nextBaseline({ sessionId: "s1", seq: 10 }, here);
    b = nextBaseline(b, { ...here, watching: false });
    expect(b).toBeNull();
    // 走开时来了 seq 15 的卡；回来、日志到齐时最大 seq 是 15
    b = nextBaseline(b, { ...here, maxSeq: () => 15 });
    expect(b).toEqual({ sessionId: "s1", seq: 15 });
    expect(popupCandidate([card("c1", 15)], { baselineSeq: b!.seq, popped: new Set(), focused: true })).toBeNull();
    // 回来之后新来的才弹
    expect(popupCandidate([card("c1", 15), card("c2", 16)], { baselineSeq: b!.seq, popped: new Set(), focused: true })?.row.connectId).toBe("c2");
  });
  it("换会话（sessionId 变）旧基线不算数，重新取", () => {
    expect(nextBaseline({ sessionId: "s0", seq: 99 }, here)).toEqual({ sessionId: "s1", seq: 42 });
  });
  it("没有会话 → null；不需要取基线时不去算最大 seq", () => {
    expect(nextBaseline({ sessionId: "s1", seq: 1 }, { ...here, sessionId: null })).toBeNull();
    let calls = 0;
    nextBaseline({ sessionId: "s1", seq: 10 }, { ...here, maxSeq: () => (calls++, 42) });
    expect(calls).toBe(0);
  });
});
