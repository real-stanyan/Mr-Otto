import { describe, it, expect } from "vitest";
import { groupThread } from "../../src/renderer/src/lib/threadGroups.js";
import type { SessionEvent, ToolCallRequest } from "../../src/session/events.js";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1000 + seq });

const call = (id: string, name = "read_file"): ToolCallRequest => ({ id, name, args: {} });

/** 纯工具调用的 assistant 消息(content 为空串) */
const tools = (...calls: ToolCallRequest[]): SessionEvent =>
  ({ ...env(), type: "assistant_message", content: "", model: "m", toolCalls: calls }) as SessionEvent;

const says = (content: string, ...calls: ToolCallRequest[]): SessionEvent =>
  ({
    ...env(),
    type: "assistant_message",
    content,
    model: "m",
    ...(calls.length ? { toolCalls: calls } : {}),
  }) as SessionEvent;

const result = (toolCallId: string, status: "ok" | "error" = "ok"): SessionEvent =>
  ({ ...env(), type: "tool_result", toolCallId, status, output: "" }) as SessionEvent;

const started = (toolCallId: string): SessionEvent =>
  ({ ...env(), type: "tool_execution_started", toolCallId }) as SessionEvent;

const user = (content: string): SessionEvent =>
  ({ ...env(), type: "user_message", content }) as SessionEvent;

const approval = (decision: "approved" | "denied"): SessionEvent =>
  ({ ...env(), type: "approval_decision", toolCallId: "x", decision }) as SessionEvent;

const turnEnded = (outcome: "completed" | "error" | "aborted"): SessionEvent =>
  ({ ...env(), type: "turn_ended", outcome, ...(outcome === "error" ? { error: "炸了" } : {}) }) as SessionEvent;

describe("groupThread", () => {
  it("空日志出空数组", () => {
    expect(groupThread([])).toEqual([]);
  });

  it("单个工具调用也成组——是否加折叠壳由渲染层按 calls.length 决定", () => {
    const items = groupThread([tools(call("a"))]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "toolGroup", key: "a" });
    expect((items[0] as { calls: ToolCallRequest[] }).calls).toHaveLength(1);
  });

  it("跨事件的连续工具调用合成一组——agent 循环里这本来就是一段连续动作", () => {
    const items = groupThread([
      tools(call("a")),
      started("a"),
      result("a"),
      tools(call("b")),
      started("b"),
      result("b"),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("同一条消息里的多个调用进同一组", () => {
    const items = groupThread([tools(call("a"), call("b"), call("c"))]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("模型正文打断分组:正文前后各一组", () => {
    const items = groupThread([tools(call("a")), result("a"), says("先看了下", call("b")), result("b")]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a"]);
    expect((items[2] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["b"]);
  });

  it("思考内容也算正文,一样打断分组", () => {
    const thinking = {
      ...env(),
      type: "assistant_message",
      content: "",
      model: "m",
      reasoning: "想想",
      toolCalls: [call("b")],
    } as SessionEvent;
    const items = groupThread([tools(call("a")), result("a"), thinking]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("用户发话打断分组", () => {
    const items = groupThread([tools(call("a")), result("a"), user("再来"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("时间线上看不见的事件不打断分组:tool_result / 执行开始 / 已批准 / turn 正常结束", () => {
    const items = groupThread([
      tools(call("a")),
      started("a"),
      approval("approved"),
      result("a"),
      turnEnded("completed"),
      tools(call("b")),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("被拒绝的审批看得见,打断分组", () => {
    const items = groupThread([tools(call("a")), approval("denied"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("turn 失败看得见,打断分组", () => {
    const items = groupThread([tools(call("a")), result("a"), turnEnded("error"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("纯正文的 assistant 消息不产生空组", () => {
    const items = groupThread([says("说完了")]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("event");
  });

  it("组的 key 取组内第一个调用的 id,事件项的 key 取 seq", () => {
    const u = user("hi");
    const items = groupThread([u, tools(call("first"), call("second"))]);
    expect(items[0]!.key).toBe(u.seq);
    expect(items[1]!.key).toBe("first");
  });
  it("turn 正常收工(completed)看不见,不打断分组——'ok' 不是这个字段的合法值", () => {
    const items = groupThread([tools(call("a")), result("a"), turnEnded("completed"), tools(call("b"))]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

});
