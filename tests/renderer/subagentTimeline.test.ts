import { describe, expect, it } from "vitest";

import {
  formatElapsed,
  groupSubagentSpawns,
  spawnedFromOf,
  subagentFact,
  subagentRowState,
} from "../../src/renderer/src/lib/subagentTimeline.js";
import { buildToolIndex } from "../../src/renderer/src/lib/toolIndex.js";
import type { SessionEvent } from "../../src/session/events.js";

function assistantWithTask(seq: number, calls: string[]): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    ts: seq * 1000,
    type: "assistant_message",
    content: "",
    model: "deepseek-v4-pro",
    toolCalls: calls.map((id) => ({ id, name: "task", args: {} })),
  };
}

function spawned(seq: number, toolCallId: string, agent = "reviewer"): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    ts: seq * 1000,
    type: "subagent_spawned",
    toolCallId,
    childSessionId: `child-${toolCallId}`,
    agent,
    task: "看看这段代码",
  };
}

function toolResult(seq: number, toolCallId: string): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    ts: seq * 1000,
    type: "tool_result",
    toolCallId,
    status: "ok",
    output: "报告正文",
  };
}

describe("groupSubagentSpawns —— 按所属 assistant_message 分组", () => {
  it("一条消息一个 task 调用 → 一个单成员组", () => {
    const events = [assistantWithTask(1, ["call_1"]), spawned(2, "call_1")];
    const groups = groupSubagentSpawns(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  it("一条消息两个 task 调用，都已落盘 → 一个双成员组（用 SubagentList）", () => {
    const events = [
      assistantWithTask(1, ["call_1", "call_2"]),
      spawned(2, "call_1"),
      spawned(3, "call_2"),
    ];
    const groups = groupSubagentSpawns(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((e) => e.toolCallId)).toEqual(["call_1", "call_2"]);
  });

  it("执行是串行的：第二个还没落盘时，组只有一个成员（跟着日志节奏走，不预支）", () => {
    // 模型一次请求了两个 task，但第一个还没跑完——第二个的 subagent_spawned
    // 压根不存在，组此刻天然只有一个成员，渲染层据此仍走单个 AgentStatus
    const events = [assistantWithTask(1, ["call_1", "call_2"]), spawned(2, "call_1")];
    expect(groupSubagentSpawns(events)).toHaveLength(1);
    expect(groupSubagentSpawns(events)[0]).toHaveLength(1);
  });

  it("两条不同的 assistant_message 各自派活 → 两个独立的组", () => {
    const events = [
      assistantWithTask(1, ["call_1"]),
      spawned(2, "call_1"),
      toolResult(3, "call_1"),
      assistantWithTask(4, ["call_2"]),
      spawned(5, "call_2"),
    ];
    expect(groupSubagentSpawns(events)).toHaveLength(2);
  });
});

describe("subagentRowState —— 状态全从父会话自己的日志/实时镜像推导", () => {
  const spawn = spawned(2, "call_1") as Extract<SessionEvent, { type: "subagent_spawned" }>;

  it("父会话里这次 task 调用有了 tool_result → done", () => {
    const index = buildToolIndex([spawn, toolResult(3, "call_1")]);
    expect(subagentRowState(spawn, index, false, false)).toBe("done");
  });

  it("没结果、也没有冒泡上来的审批/问卷 → working", () => {
    const index = buildToolIndex([spawn]);
    expect(subagentRowState(spawn, index, false, false)).toBe("working");
  });

  it("没结果、但有审批/问卷冒泡到父会话 → waiting", () => {
    const index = buildToolIndex([spawn]);
    expect(subagentRowState(spawn, index, true, false)).toBe("waiting");
    expect(subagentRowState(spawn, index, false, true)).toBe("waiting");
  });

  it("done 优先于 waiting：哪怕审批状态还没来得及清，有结果就是有结果", () => {
    const index = buildToolIndex([spawn, toolResult(3, "call_1")]);
    expect(subagentRowState(spawn, index, true, false)).toBe("done");
  });
});

describe("formatElapsed —— mm:ss", () => {
  it("零和负数都钳到 0:00（时钟漂移不该显示负数）", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(-500)).toBe("0:00");
  });

  it("跨分钟：秒数补零到两位", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(9_000)).toBe("0:09");
  });
});

describe("subagentFact —— 收口后的紧凑事实", () => {
  it("子日志没取到 → null，不拿 0 冒充问过了", () => {
    expect(subagentFact(undefined)).toBeNull();
  });

  it("数 assistant_message 条数当步数，token 走 deriveUsage 的求和", () => {
    const childEvents: SessionEvent[] = [
      { sessionId: "child", seq: 0, ts: 0, type: "session_created" },
      {
        sessionId: "child", seq: 1, ts: 1, type: "assistant_message", content: "",
        model: "m", usage: { promptTokens: 100, completionTokens: 50 },
      },
      {
        sessionId: "child", seq: 2, ts: 2, type: "assistant_message", content: "done",
        model: "m", usage: { promptTokens: 900, completionTokens: 450 },
      },
    ];
    expect(subagentFact(childEvents)).toBe("2 步 · 1.5k tokens");
  });

  it("低于 1000 的 token 数不换算成 k", () => {
    const childEvents: SessionEvent[] = [
      {
        sessionId: "child", seq: 0, ts: 0, type: "assistant_message", content: "",
        model: "m", usage: { promptTokens: 10, completionTokens: 5 },
      },
    ];
    expect(subagentFact(childEvents)).toBe("1 步 · 15 tokens");
  });
});

describe("spawnedFromOf —— 当前会话是不是子会话", () => {
  it("session_created 带 spawnedBy → 父会话 id", () => {
    const events: SessionEvent[] = [
      {
        sessionId: "child", seq: 0, ts: 0, type: "session_created",
        spawnedBy: { sessionId: "parent", toolCallId: "call_1", agent: "reviewer" },
      },
    ];
    expect(spawnedFromOf(events)).toBe("parent");
  });

  it("普通会话（没有 spawnedBy）→ null", () => {
    const events: SessionEvent[] = [
      { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/p" },
    ];
    expect(spawnedFromOf(events)).toBeNull();
  });

  it("空日志 → null，不猜", () => {
    expect(spawnedFromOf([])).toBeNull();
  });
});
