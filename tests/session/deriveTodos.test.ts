import { describe, expect, it } from "vitest";
import {
  countTodos,
  deriveTodos,
  parseTodoArgs,
  TODO_TOOL_NAME,
  turnsSinceTodoUpdate,
} from "../../src/session/deriveTodos.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

/** 一次完整的 todo_write 调用：assistant 请求 + ok 结果 */
function todoCall(id: string, items: unknown, status: "ok" | "error" | "denied" = "ok"): SessionEvent[] {
  return [
    {
      ...env(),
      type: "assistant_message",
      content: "",
      model: "m",
      toolCalls: [{ id, name: TODO_TOOL_NAME, args: { items } }],
    },
    { ...env(), type: "tool_result", toolCallId: id, status, output: "清单已更新" },
  ];
}

describe("deriveTodos（清单 = 最后一次生效的整表快照）", () => {
  it("空日志 / 老日志：空清单，不炸", () => {
    expect(deriveTodos([])).toEqual([]);
    expect(
      deriveTodos([
        { ...env(), type: "session_created", workspace: "/w" },
        { ...env(), type: "user_message", content: "写个函数" },
      ])
    ).toEqual([]);
  });

  it("整表覆盖：后一次调用完全取代前一次，不做合并", () => {
    const events: SessionEvent[] = [
      ...todoCall("c1", [
        { text: "读代码", status: "in_progress" },
        { text: "写测试", status: "pending" },
      ]),
      ...todoCall("c2", [{ text: "写测试", status: "completed" }]),
    ];
    expect(deriveTodos(events)).toEqual([{ text: "写测试", status: "completed" }]);
  });

  it("被拒绝 / 报错的调用不生效：清单停在上一次成功那份", () => {
    const good = [{ text: "读代码", status: "in_progress" }];
    const events: SessionEvent[] = [
      ...todoCall("c1", good),
      ...todoCall("c2", [{ text: "不该出现", status: "pending" }], "denied"),
      ...todoCall("c3", [{ text: "也不该出现", status: "pending" }], "error"),
    ];
    expect(deriveTodos(events)).toEqual(good);
  });

  it("只发出未落结果的调用（app 在执行中退出）不生效", () => {
    const events: SessionEvent[] = [
      ...todoCall("c1", [{ text: "读代码", status: "completed" }]),
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c2", name: TODO_TOOL_NAME, args: { items: [{ text: "悬空", status: "pending" }] } }],
      },
    ];
    expect(deriveTodos(events)).toEqual([{ text: "读代码", status: "completed" }]);
  });

  it("形状非法的 args 不生效：宁可显示旧清单，也不显示半张烂表", () => {
    const good = [{ text: "读代码", status: "pending" }];
    const events: SessionEvent[] = [
      ...todoCall("c1", good),
      ...todoCall("c2", [{ text: "缺状态" }]),
      ...todoCall("c3", [{ text: "状态是瞎编的", status: "doing" }]),
      ...todoCall("c4", "根本不是数组"),
    ];
    expect(deriveTodos(events)).toEqual(good);
  });

  it("同名的别的工具不参与：只认 todo_write", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "write_file", args: { items: [{ text: "假的", status: "pending" }] } }],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "ok" },
    ];
    expect(deriveTodos(events)).toEqual([]);
  });

  it("compact 不清空清单：压缩收的是模型上下文，日志没被改写", () => {
    const events: SessionEvent[] = [
      ...todoCall("c1", [{ text: "读代码", status: "in_progress" }]),
      {
        ...env(),
        type: "context_compacted",
        summary: "摘要",
        model: "m",
        usage: { promptTokens: 100, completionTokens: 10 },
      },
    ];
    expect(deriveTodos(events)).toEqual([{ text: "读代码", status: "in_progress" }]);
  });

  it("空表是合法的一次更新：模型可以主动清空清单", () => {
    const events: SessionEvent[] = [
      ...todoCall("c1", [{ text: "读代码", status: "pending" }]),
      ...todoCall("c2", []),
    ];
    expect(deriveTodos(events)).toEqual([]);
  });
});

describe("parseTodoArgs", () => {
  it("合法输入原样返回，多余字段不带进来", () => {
    expect(parseTodoArgs({ items: [{ text: "a", status: "pending", 乱入: 1 }] })).toEqual([
      { text: "a", status: "pending" },
    ]);
  });

  it("null / 非对象 / 缺 items / 空 text 一律 null", () => {
    expect(parseTodoArgs(null)).toBeNull();
    expect(parseTodoArgs("x")).toBeNull();
    expect(parseTodoArgs({})).toBeNull();
    expect(parseTodoArgs({ items: [{ text: "", status: "pending" }] })).toBeNull();
  });

  it("一项烂掉整表作废：不做部分接收（半张表比没有表更误导）", () => {
    expect(parseTodoArgs({ items: [{ text: "好的", status: "pending" }, { text: "坏的" }] })).toBeNull();
  });
});

describe("countTodos", () => {
  it("三态计数 + 总数", () => {
    expect(
      countTodos([
        { text: "a", status: "in_progress" },
        { text: "b", status: "pending" },
        { text: "c", status: "pending" },
        { text: "d", status: "completed" },
      ])
    ).toEqual({ inProgress: 1, pending: 2, completed: 1, total: 4 });
  });
});

describe("投影不受清单影响", () => {
  it("todo_write 走的是普通 toolCall 通道：deriveMessages 照常给出 assistant + tool 两条", () => {
    // 没有新事件类型要投影层特判——这正是不加 todo_updated 事件的好处
    const messages = deriveMessages(todoCall("c1", [{ text: "读代码", status: "pending" }]));
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  });
});

describe("turnsSinceTodoUpdate（这张清单是不是已经被丢下了）", () => {
  const user = (content: string): SessionEvent => ({ ...env(), type: "user_message", content });
  const one = [{ text: "量尺子", status: "pending" }];

  it("压根没有清单 = 0，不会被误判成陈旧", () => {
    expect(turnsSinceTodoUpdate([])).toBe(0);
    expect(turnsSinceTodoUpdate([user("写个函数")])).toBe(0);
  });

  it("触发这次写入的那条用户消息不算 —— 它在清单之前", () => {
    expect(turnsSinceTodoUpdate([user("拆一下"), ...todoCall("t1", one)])).toBe(0);
  });

  it("清单之后用户又说了几次话，就是几轮", () => {
    const events = [...todoCall("t1", one), user("继续"), user("那换个思路")];
    expect(turnsSinceTodoUpdate(events)).toBe(2);
  });

  it("重新写过清单就重新计数 —— 模型回来维护了，它就不是被丢下的那张", () => {
    const events = [...todoCall("t1", one), user("继续"), ...todoCall("t2", one), user("再来")];
    expect(turnsSinceTodoUpdate(events)).toBe(1);
  });

  it("没生效的那次写入不重置计数（被拒/出错的调用从来没改过清单）", () => {
    const events = [...todoCall("t1", one), user("继续"), ...todoCall("t2", one, "denied"), user("再来")];
    expect(turnsSinceTodoUpdate(events)).toBe(2);
  });

  it("一个 turn 里刷多少条事件都不算轮次 —— 活还在干，清单不动很正常", () => {
    const events: SessionEvent[] = [
      ...todoCall("t1", one),
      { ...env(), type: "assistant_message", content: "在查", model: "m" },
      { ...env(), type: "tool_result", toolCallId: "x", status: "ok", output: "..." },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];
    expect(turnsSinceTodoUpdate(events)).toBe(0);
  });
});
