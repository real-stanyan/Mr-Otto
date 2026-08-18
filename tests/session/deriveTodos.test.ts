import { describe, expect, it } from "vitest";
import {
  countTodos,
  deriveTodos,
  parseTodoArgs,
  TODO_TOOL_NAME,
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
