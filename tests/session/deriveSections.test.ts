import { describe, expect, it } from "vitest";
import { deriveSections } from "../../src/session/deriveSections.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}
function user(content: string): SessionEvent {
  return { ...env(), type: "user_message", content };
}
function classify(title: string | null): SessionEvent {
  return { ...env(), type: "section_classified", title, model: "c" };
}

describe("deriveSections（分区 = 被分类事件收口的跨度）", () => {
  it("空日志 = 没有分区", () => {
    expect(deriveSections([])).toEqual([]);
  });

  it("一条分类事件 → 一个分区，起点是它前面那段的第一条事件", () => {
    seq = 0;
    const events = [user("修 bug"), user("再看看"), classify("修登录 bug")];
    expect(deriveSections(events)).toEqual([{ title: "修登录 bug", startSeq: 0 }]);
  });

  it("title 为 null 只延续，不开新分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), classify(null)];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("延续之后再开新区：新区起点是延续那条之后的第一条事件", () => {
    seq = 0;
    const events = [
      user("a"),          // 0
      classify("第一段"), // 1
      user("b"),          // 2
      classify(null),     // 3
      user("c"),          // 4
      classify("第二段"), // 5
    ];
    expect(deriveSections(events)).toEqual([
      { title: "第一段", startSeq: 0 },
      { title: "第二段", startSeq: 4 },
    ]);
  });

  it("日志尾巴上未分类的那段不成区（不猜标题）", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), user("c")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("两条分类事件相邻（空跨度）不产生分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), classify("鬼分区")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("还没有任何分区时收到延续 → 那段跨度丢弃，不凭空造区", () => {
    seq = 0;
    const events = [user("a"), classify(null), user("b"), classify("第一段")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 2 }]);
  });
});
