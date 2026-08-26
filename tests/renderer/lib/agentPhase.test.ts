import { describe, expect, it } from "vitest";
import { agentPhase } from "../../../src/renderer/src/lib/agentPhase.js";
import type { ToolCallRequest } from "../../../src/session/events.js";

const call = (name: string): ToolCallRequest => ({ id: "c1", name, args: {} });

const base = { hasApproval: false, compacting: false, streamingText: "", tool: null };

describe("agentPhase", () => {
  it("六种相位各自的文案与 orb", () => {
    expect(agentPhase({ ...base, hasApproval: true })).toEqual({
      orb: "listening",
      label: "等待审批…",
    });
    expect(agentPhase({ ...base, compacting: true })).toEqual({
      orb: "weaving",
      label: "压缩中…",
    });
    expect(agentPhase({ ...base, tool: call("read_file") })).toEqual({
      orb: "searching",
      label: "检索中…",
    });
    expect(agentPhase({ ...base, tool: call("bash") })).toEqual({
      orb: "working",
      label: "执行中…",
    });
    expect(agentPhase({ ...base, streamingText: "答" })).toEqual({
      orb: "solving",
      label: "作答中…",
    });
    expect(agentPhase(base)).toEqual({ orb: "composing", label: "思考中…" });
  });

  it("read_file 之外的任何工具都是「执行中」——包括 MCP 那一票", () => {
    for (const name of ["write_file", "task", "mcp__github__create_issue", "skill"]) {
      expect(agentPhase({ ...base, tool: call(name) }).label).toBe("执行中…");
    }
  });

  it("审批压倒一切：正在跑工具、正文在流、还在压缩，都让位给「等待审批」", () => {
    expect(
      agentPhase({
        hasApproval: true,
        compacting: true,
        streamingText: "写了一半",
        tool: call("bash"),
      }).label,
    ).toBe("等待审批…");
  });

  it("压缩排在工具之前：压缩期间不会有工具在跑，撞上了以压缩为准", () => {
    expect(agentPhase({ ...base, compacting: true, tool: call("bash") }).label).toBe("压缩中…");
  });

  it("工具排在正文之前：模型说完话再调工具，此刻该报的是工具那一段", () => {
    expect(agentPhase({ ...base, streamingText: "我来看看", tool: call("read_file") }).label).toBe(
      "检索中…",
    );
  });

  it("什么都没有 = 思考中（reasoning 在流，或请求已发、第一个 token 还没回）", () => {
    expect(agentPhase(base).label).toBe("思考中…");
  });
});
