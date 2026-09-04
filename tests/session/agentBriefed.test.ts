import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { projectForAgent } from "../../src/session/agentView.js";
import type { SessionEvent } from "../../src/session/events.js";

const brief = (agentId: string, name: string): SessionEvent => ({
  sessionId: "s1", seq: 0, ts: 0, type: "agent_briefed", agentId, name,
  instructions: "你管店铺运营",
  roster: [{ name: "广告", description: "管投放" }],
} as never);

describe("agent_briefed（#928 切片 1a）", () => {
  it("投影成一条 user 消息，带上自己的职责和群里还有谁", () => {
    const msgs = deriveMessages([brief("ops", "运营")]);
    const mine = msgs.find((m) => m.role === "user");
    expect(mine?.content).toContain("运营");
    expect(mine?.content).toContain("你管店铺运营");
    expect(mine?.content).toContain("广告");
    expect(mine?.content).toContain("管投放");
  });

  it("**不说自己是 subagent，也不说最终文本是返回值** —— 那是另一种 agent", () => {
    const mine = deriveMessages([brief("ops", "运营")]).find((m) => m.role === "user");
    expect(mine?.content).not.toContain("subagent");
    expect(mine?.content).not.toContain("返回值");
  });

  it("别人的 briefing 不进我的上下文 —— 我要知道群里有广告这个人，不要读它的提示词", () => {
    const out = projectForAgent([brief("ops", "运营")], "ads");
    expect(out).toEqual([]);
  });
});
