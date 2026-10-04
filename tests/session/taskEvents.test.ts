// 六种任务事件的登记（#1571 第 3 步）：新事件类型在每一张穷举表里都要表态；模型读得到一句系统话；卡在工具调用之间时先攒着。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type SessionEvent, type TaskAssignedEvent, type TaskCreatedEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { shouldPersist } from "../../src/session/persistencePolicy.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const TYPES = ["task_created", "task_assigned", "task_progress", "task_needs_owner", "task_done", "task_failed"] as const;
const created: TaskCreatedEvent = { sessionId: "s", seq: 2, ts: 2, type: "task_created", taskId: "t_1", byAgentId: "admin", title: "明天出游", ignorable: true };
const assigned: TaskAssignedEvent = { sessionId: "s", seq: 3, ts: 3, type: "task_assigned", taskId: "t_1", byAgentId: "admin", toAgentId: "a_travel", ignorable: true };

describe("任务事件的登记", () => {
  it("六种都是已知类型、落盘、分享包里剥掉、要握笔、桌面时间线不画", () => {
    for (const t of TYPES) {
      expect(KNOWN_EVENT_TYPES.has(t)).toBe(true);
      expect(PRIVACY_VERDICTS[t]).toBe("strip");
      expect(PEN_VERDICTS[t]).toBe("executor");
    }
    expect(shouldPersist("task_created")).toBe(true);
    expect(hiddenFromCloudTimeline(created)).toBe(true);
    expect(hiddenFromCloudTimeline(assigned)).toBe(true);
  });
  it("模型读到一句带 id 的系统话；标题从 task_created 回头找", () => {
    const base = { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } } as const;
    const msgs = deriveMessages([base, created, assigned]);
    const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
    // promptSafe 会把全角引号折成半角的，所以只钉前缀与标题
    expect(users).toHaveLength(2);
    expect(users[0]).toMatch(/^\[任务 t_1\] admin建了任务.明天出游.$/);
    expect(users[1]).toMatch(/^\[任务 t_1\] .明天出游.派给了a_travel$/);
  });
  it("卡在工具调用与 tool_result 之间的任务事件先攒着、结果之后再放", () => {
    const base = { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } } as const;
    const log: SessionEvent[] = [
      base,
      { sessionId: "s", seq: 1, ts: 1, type: "user_message", content: "安排一下", fromUid: "owner", mentions: ["admin"] },
      { sessionId: "s", seq: 2, ts: 2, type: "assistant_message", agentId: "admin", model: "m", content: "", toolCalls: [{ id: "c1", name: "create_task", args: { title: "明天出游" } }] },
      { ...created, seq: 3, ts: 3 },
      { sessionId: "s", seq: 4, ts: 4, type: "tool_result", toolCallId: "c1", status: "ok", output: "建好了" },
    ];
    const msgs = deriveMessages(log);
    const roles = msgs.map((m) => m.role);
    const toolIdx = roles.lastIndexOf("tool");
    const taskIdx = msgs.findIndex((m) => m.role === "user" && String(m.content).startsWith("[任务 t_1]"));
    expect(taskIdx).toBeGreaterThan(toolIdx);
  });
});
