import { describe, it, expect } from "vitest";
import { EventStore } from "../../src/session/store.js";
import { createHistoryCapability } from "../../src/main/historyCapability.js";

function seed(store: EventStore, id: string, msgs: string[], ts = 1) {
  store.append({ sessionId: id, ts, type: "session_created", workspace: "/w" });
  msgs.forEach((m, i) => {
    store.append({ sessionId: id, ts: ts + i + 1, type: "user_message", content: m });
    store.append({ sessionId: id, ts: ts + i + 1, type: "assistant_message", content: `回：${m}`, model: "m" });
  });
}

describe("historyCapability", () => {
  it("search 排除当前会话；window 取区间；load 全段；recent 按 lastTs 倒序带 userTurns", () => {
    const store = new EventStore(":memory:");
    seed(store, "cur", ["关键词甲乙丙"], 100);
    seed(store, "old", ["关键词甲乙丙", "第二句"], 1);
    const h = createHistoryCapability(store, () => "cur");
    // "old" 的回复文案里嵌了同一个关键词（trigram 支持子串命中，见 store.fts.test.ts），
    // 两行都命中——但 searchText 按 session 去重只回分最高的一条（issue #190），
    // search 同时排除 cur
    expect(h.search("关键词甲乙丙").map((x) => x.sessionId)).toEqual(["old"]);
    expect(h.window("old", 1, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(h.load("old")).toHaveLength(5);
    expect(h.load("nope")).toEqual([]);
    expect(h.recent(10)).toMatchObject([{ sessionId: "old", userTurns: 2, title: "关键词甲乙丙" }]);
  });
});
