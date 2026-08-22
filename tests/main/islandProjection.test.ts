import { describe, expect, it } from "vitest";
import { flattenSnapshot, initialIsland, reduceIsland } from "../../src/main/islandProjection.js";

describe("flattenSnapshot", () => {
  it("空闲态：全 null，带上 model", () => {
    const snap = flattenSnapshot(initialIsland, "deepseek-chat");
    expect(snap).toEqual({
      sessionId: null,
      model: "deepseek-chat",
      phase: "idle",
      currentTool: null,
      turnStartedAt: null,
      pendingApproval: null,
    });
  });

  it("跑 bash 工具：currentTool 拍平成 终端 + 命令", () => {
    let s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "sess1", model: "m", running: false, pendingApproval: null },
      now: 1000,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: {
        type: "assistant_message",
        sessionId: "sess1",
        toolCalls: [{ id: "call1", name: "bash", args: { cmd: "npm test" } }],
      } as never,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: { type: "tool_execution_started", sessionId: "sess1", toolCallId: "call1" } as never,
    });
    const snap = flattenSnapshot(s, "m");
    expect(snap.phase).toBe("active");
    expect(snap.currentTool).toEqual({ verb: "终端", target: "npm test" });
  });

  it("挂起审批：pendingApproval 拍平，write_file 带 fullPath 完整路径", () => {
    let s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "sess1", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    s = reduceIsland(s, {
      kind: "approvalRequest",
      req: {
        sessionId: "sess1",
        call: { id: "call9", name: "write_file", args: { path: "src/foo.ts", content: "a\nb" } },
        toolDescription: "写文件",
      } as never,
    });
    const snap = flattenSnapshot(s, "m");
    expect(snap.phase).toBe("approval");
    expect(snap.pendingApproval).toEqual({
      callId: "call9",
      verb: "写入",
      target: "foo.ts",
      fullPath: "src/foo.ts",
    });
  });
});
