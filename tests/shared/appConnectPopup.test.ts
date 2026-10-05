// 连接卡自动弹窗的判据（#1666，spec §4.2）：只弹一次、翻历史不弹、页面不在前台不弹
import { describe, expect, it } from "vitest";
import { popupCandidate } from "../../src/shared/appConnectPopup.js";
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
    expect(popupCandidate([text(5), c], ok)).toBe(c);
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
  it("两张都符合取 seq 大的，不论行的先后", () => {
    const a = card("c1", 11);
    const b = card("c2", 14);
    expect(popupCandidate([a, b], ok)).toBe(b);
    expect(popupCandidate([b, a], ok)).toBe(b);
  });
  it("大的那张弹过了，剩下还符合的那张轮到它（弹过的集合是唯一的「别再弹」）", () => {
    const a = card("c1", 11);
    const b = card("c2", 14);
    expect(popupCandidate([a, b], { ...ok, popped: new Set(["c2"]) })).toBe(a);
  });
  it("没有卡 → null", () => {
    expect(popupCandidate([], ok)).toBeNull();
    expect(popupCandidate([text(20)], ok)).toBeNull();
  });
});
