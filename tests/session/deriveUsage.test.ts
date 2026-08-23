import { describe, it, expect } from "vitest";
import { totalTokens, usageByModel } from "../../src/session/deriveUsage.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const ev = (e: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent =>
  ({ seq: seq++, sessionId: "s1", ts: 1000 + seq, ...e }) as SessionEvent;

const said = (model: string, p: number, c: number): SessionEvent =>
  ev({
    type: "assistant_message",
    content: "",
    model,
    usage: { promptTokens: p, completionTokens: c },
  });

describe("usageByModel", () => {
  it("空日志 = 没有账", () => {
    expect(usageByModel([])).toEqual([]);
  });

  it("同一型号累加", () => {
    expect(usageByModel([said("m1", 10, 2), said("m1", 5, 3)])).toEqual([
      { model: "m1", promptTokens: 15, completionTokens: 5 },
    ]);
  });

  it("按总量降序 —— 最烧的那款在最上面", () => {
    const rows = usageByModel([said("small", 1, 1), said("big", 100, 50)]);
    expect(rows.map((r) => r.model)).toEqual(["big", "small"]);
  });

  it("总量相同就按名字排 —— 同一份日志两次渲染不能是两个顺序", () => {
    const rows = usageByModel([said("b", 5, 5), said("a", 5, 5)]);
    expect(rows.map((r) => r.model)).toEqual(["a", "b"]);
  });

  it("外挂小调用也进账:压缩/分区/跟进建议都是真的跑了一次模型", () => {
    const rows = usageByModel([
      ev({ type: "context_compacted", model: "cheap", summary: "", usage: { promptTokens: 7, completionTokens: 1 } }),
      ev({ type: "section_classified", title: null, model: "cheap", usage: { promptTokens: 2, completionTokens: 1 } }),
      ev({ type: "suggestions_generated", suggestions: ["a"], model: "cheap", usage: { promptTokens: 3, completionTokens: 1 } }),
    ]);
    expect(rows).toEqual([{ model: "cheap", promptTokens: 12, completionTokens: 3 }]);
  });

  it("没记用量的调用不进账 —— 当 0 会让「没记」和「没花」看起来一样", () => {
    expect(usageByModel([ev({ type: "assistant_message", content: "", model: "m" })])).toEqual([]);
  });

  it("不是模型调用的事件不进账", () => {
    expect(usageByModel([ev({ type: "user_message", content: "hi" })])).toEqual([]);
  });
});

describe("totalTokens", () => {
  it("入 + 出,跨型号求和", () => {
    expect(totalTokens([said("a", 10, 5), said("b", 1, 2)])).toBe(18);
  });

  it("微压缩那一笔也算(ADR-0063) —— 开着的话它是最高频的一笔,漏掉少算最多", () => {
    const events = [
      said("a", 10, 5),
      ev({ type: "micro_compacted", summary: "S", coversUpTo: 3, model: "cheap", usage: { promptTokens: 30, completionTokens: 6 } }),
    ];
    expect(usageByModel(events)).toEqual([
      { model: "cheap", promptTokens: 30, completionTokens: 6 },
      { model: "a", promptTokens: 10, completionTokens: 5 },
    ]);
    expect(totalTokens(events)).toBe(51);
  });

  it("跟进建议那一笔也算 —— 漏掉一类,统计从此少算一截", () => {
    const events = [
      said("a", 10, 5),
      ev({ type: "suggestions_generated", suggestions: ["x"], model: "cheap", usage: { promptTokens: 4, completionTokens: 1 } }),
    ];
    expect(totalTokens(events)).toBe(20);
  });
});
