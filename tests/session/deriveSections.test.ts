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
function assistant(content: string): SessionEvent {
  return { ...env(), type: "assistant_message", content, model: "m" };
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
    expect(deriveSections(events)).toEqual([
      { title: "修登录 bug", startSeq: 0, eventCount: 2, preview: "修 bug" },
    ]);
  });

  it("title 为 null 只延续，不开新分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), classify(null)];
    expect(deriveSections(events).map((s) => s.title)).toEqual(["第一段"]);
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
      { title: "第一段", startSeq: 0, eventCount: 2, preview: "a" },
      { title: "第二段", startSeq: 4, eventCount: 1, preview: "c" },
    ]);
  });

  it("日志尾巴上未分类的那段不成区（不猜标题）", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), user("c")];
    expect(deriveSections(events)).toEqual([
      { title: "第一段", startSeq: 0, eventCount: 1, preview: "a" },
    ]);
  });

  it("两条分类事件相邻（空跨度）不产生分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), classify("鬼分区")];
    expect(deriveSections(events).map((s) => s.title)).toEqual(["第一段"]);
  });

  it("还没有任何分区时收到延续 → 那段跨度丢弃，不凭空造区", () => {
    seq = 0;
    const events = [user("a"), classify(null), user("b"), classify("第一段")];
    expect(deriveSections(events)).toEqual([
      { title: "第一段", startSeq: 2, eventCount: 1, preview: "b" },
    ]);
  });
});

describe("eventCount（刻度宽度编码的分区体量）", () => {
  it("数的是分区里的事件，分类事件本身不算", () => {
    seq = 0;
    const events = [user("a"), assistant("b"), assistant("c"), classify("一段")];
    expect(deriveSections(events)[0]?.eventCount).toBe(3);
  });

  it("延续段的事件算进上一分区——不算就会低报体量", () => {
    seq = 0;
    const events = [
      user("a"),
      classify("一段"),   // 此时 eventCount = 1
      assistant("b"),
      assistant("c"),
      classify(null),      // 延续：+2
    ];
    expect(deriveSections(events)[0]?.eventCount).toBe(3);
  });

  it("尾巴上还没分类的事件不计入任何分区（它们还没有归属）", () => {
    seq = 0;
    const events = [user("a"), classify("一段"), assistant("b"), assistant("c")];
    expect(deriveSections(events)[0]?.eventCount).toBe(1);
  });
});

describe("preview（悬停卡片的正文预览）", () => {
  it("取本分区第一条 user_message，后面的不覆盖", () => {
    seq = 0;
    const events = [assistant("模型先说"), user("第一句"), user("第二句"), classify("一段")];
    expect(deriveSections(events)[0]?.preview).toBe("第一句");
  });

  it("换行和连续空白压成单空格", () => {
    seq = 0;
    const events = [user("第一行\n\n  第二行\t尾巴 "), classify("一段")];
    expect(deriveSections(events)[0]?.preview).toBe("第一行 第二行 尾巴");
  });

  it("超长正文截断并加省略号", () => {
    seq = 0;
    const events = [user("字".repeat(200)), classify("一段")];
    const p = deriveSections(events)[0]?.preview ?? "";
    expect(p).toHaveLength(121);
    expect(p.endsWith("…")).toBe(true);
  });

  it("整段没人说话 → 空串（不拿模型输出冒充用户的话）", () => {
    seq = 0;
    const events = [assistant("只有模型在说"), classify("一段")];
    expect(deriveSections(events)[0]?.preview).toBe("");
  });

  it("空白正文不算说话（只带附件的那条消息）", () => {
    seq = 0;
    const events = [user("   "), user("真正的第一句"), classify("一段")];
    expect(deriveSections(events)[0]?.preview).toBe("真正的第一句");
  });

  it("开头无人说话的分区，用延续段的第一句补上预览", () => {
    seq = 0;
    const events = [assistant("模型先说"), classify("一段"), user("延续里的第一句"), classify(null)];
    expect(deriveSections(events)[0]?.preview).toBe("延续里的第一句");
  });
});
