import { describe, expect, it } from "vitest";
import {
  runtimePatch,
  type RuntimeSlice,
} from "../../../src/renderer/src/lib/runtimeHydration.js";
import type { ApprovalRequest, AskUserRequest, SessionRuntime } from "../../../src/shared/shellBridge.js";

const empty: RuntimeSlice = {
  statusBySession: {},
  turnIdBySession: {},
  compactingBySession: {},
  approvals: {},
  asks: {},
};

const idle: SessionRuntime = { status: "idle", compacting: false, approval: null, ask: null };
const running: SessionRuntime = { status: "running", compacting: false, approval: null, ask: null };

const approval = (sessionId: string): ApprovalRequest => ({
  sessionId,
  call: { id: "c1", name: "bash", args: { cmd: "rm -rf /" } },
  toolDescription: "跑一条 shell 命令",
  availableDecisions: ["approve", "deny"],
});

const ask = (sessionId: string): AskUserRequest => ({
  sessionId,
  toolCallId: "c2",
  questions: [{ question: "去哪个环境？", header: "环境", options: [], multiSelect: false }],
});

describe("runtimePatch", () => {
  it("查无此会话：状态落位（这正是重载后丢掉的那一拍，issue #548）", () => {
    expect(runtimePatch(empty, "s1", { ...running, turnId: 7 })).toEqual({
      statusBySession: { s1: "running" },
      turnIdBySession: { s1: 7 },
    });
  });

  it("idle 也照样落位：「确认它闲着」和「不知道」不是一回事", () => {
    expect(runtimePatch(empty, "s1", idle)).toEqual({ statusBySession: { s1: "idle" } });
  });

  it("店里已经有这条会话 = 推送这一路是通的，快照一个字都不许改", () => {
    const prev: RuntimeSlice = { ...empty, statusBySession: { s1: "idle" } };
    expect(runtimePatch(prev, "s1", { ...running, turnId: 7, compacting: true })).toEqual({});
  });

  it("别的会话有记录不影响这一条", () => {
    const prev: RuntimeSlice = { ...empty, statusBySession: { other: "running" } };
    expect(runtimePatch(prev, "s1", running).statusBySession).toEqual({
      other: "running",
      s1: "running",
    });
  });

  it("压缩标记跟着 running 一起补", () => {
    expect(runtimePatch(empty, "s1", { ...running, compacting: true })).toEqual({
      statusBySession: { s1: "running" },
      compactingBySession: { s1: true },
    });
  });

  it("idle 却说自己在压缩 = 自相矛盾的快照，标记不补（补错了没人会来纠正）", () => {
    expect(runtimePatch(empty, "s1", { ...idle, compacting: true })).toEqual({
      statusBySession: { s1: "idle" },
    });
  });

  it("turnId 缺席时不写空值——插话乐观锁宁可没有，也不要一个假的", () => {
    expect(runtimePatch(empty, "s1", running).turnIdBySession).toBeUndefined();
  });

  it("挂起的审批一起补回来（重载后卡片也会消失，同一个洞）", () => {
    const patch = runtimePatch(empty, "s1", { ...running, approval: approval("s1") });
    expect(patch.approvals?.["s1"]?.call.name).toBe("bash");
  });

  it("审批和状态各判各的：状态已知、审批未知时，只补审批", () => {
    const prev: RuntimeSlice = { ...empty, statusBySession: { s1: "running" } };
    const patch = runtimePatch(prev, "s1", { ...running, approval: approval("s1") });
    expect(patch.statusBySession).toBeUndefined();
    expect(patch.approvals?.["s1"]).toBeDefined();
  });

  it("已经有卡了就不盖：推来的那张比快照新", () => {
    const pushed = approval("s1");
    const prev: RuntimeSlice = { ...empty, approvals: { s1: pushed } };
    expect(runtimePatch(prev, "s1", { ...running, approval: approval("s1") }).approvals)
      .toBeUndefined();
  });

  it("问卷同审批", () => {
    expect(runtimePatch(empty, "s1", { ...running, ask: ask("s1") }).asks?.["s1"]?.toolCallId)
      .toBe("c2");
    const prev: RuntimeSlice = { ...empty, asks: { s1: ask("s1") } };
    expect(runtimePatch(prev, "s1", { ...running, ask: ask("s1") }).asks).toBeUndefined();
  });

  it("没什么可补就返回空对象（调用方可以无脑 set）", () => {
    const prev: RuntimeSlice = {
      ...empty,
      statusBySession: { s1: "running" },
      approvals: { s1: approval("s1") },
      asks: { s1: ask("s1") },
    };
    expect(runtimePatch(prev, "s1", { ...running, approval: approval("s1"), ask: ask("s1") }))
      .toEqual({});
  });
});
