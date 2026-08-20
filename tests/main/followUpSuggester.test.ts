import { describe, expect, it } from "vitest";
import {
  lastExchange,
  parseSuggestions,
  summarizeExchange,
} from "../../src/main/followUpSuggester.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("lastExchange", () => {
  it("从最后一条 user_message 起到末尾", () => {
    const events = [
      ev({ type: "user_message", content: "第一轮" }, 0),
      ev({ type: "assistant_message", content: "答一", model: "m" }, 1),
      ev({ type: "user_message", content: "第二轮" }, 2),
      ev({ type: "assistant_message", content: "答二", model: "m" }, 3),
    ];
    expect(lastExchange(events).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("没人说过话 → 空(无从猜下一句)", () => {
    expect(lastExchange([ev({ type: "session_created" }, 0)])).toEqual([]);
  });
});

describe("summarizeExchange", () => {
  it("只收用户正文和助手正文;工具输出一个字不进", () => {
    const events = [
      ev({ type: "user_message", content: "跑测试" }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x".repeat(9999) }, 1),
      ev({ type: "assistant_message", content: "全绿", model: "m" }, 2),
    ];
    expect(summarizeExchange(events)).toBe("用户：跑测试\n助手：全绿");
  });

  it("纯工具调用的空正文不占一行", () => {
    const events = [
      ev({ type: "user_message", content: "读文件" }, 0),
      ev({ type: "assistant_message", content: "   ", model: "m" }, 1),
    ];
    expect(summarizeExchange(events)).toBe("用户：读文件");
  });
});

describe("parseSuggestions", () => {
  it("裸数组", () => {
    expect(parseSuggestions('["跑一下测试","解释这段"]')).toEqual(["跑一下测试", "解释这段"]);
  });

  it("套 ```json 围栏也认(便宜模型的老毛病)", () => {
    expect(parseSuggestions('```json\n["改成异步"]\n```')).toEqual(["改成异步"]);
  });

  it("包成对象也认", () => {
    expect(parseSuggestions('{"suggestions":["提交吧"]}')).toEqual(["提交吧"]);
  });

  it("封顶三条", () => {
    expect(parseSuggestions('["a","b","c","d","e"]')).toEqual(["a", "b", "c", "d", "e"].slice(0, 3));
  });

  it("去重、去空、去非字符串", () => {
    expect(parseSuggestions('["a","a","  ",42,"b"]')).toEqual(["a", "b"]);
  });

  it("超长的截断 —— 日志 append-only,几 KB 的「建议」落进去就改不掉了", () => {
    const long = "字".repeat(200);
    expect(parseSuggestions(JSON.stringify([long]))![0]).toHaveLength(40);
  });

  it("不是 JSON / 形状不对 / 清洗后一条不剩 → null(调用方据此不落事件)", () => {
    expect(parseSuggestions("我建议你跑个测试")).toBeNull();
    expect(parseSuggestions('{"x":1}')).toBeNull();
    expect(parseSuggestions("[]")).toBeNull();
    expect(parseSuggestions('["","  "]')).toBeNull();
  });
});
