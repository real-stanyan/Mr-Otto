import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { projectForAgent } from "../../src/session/agentView.js";
import type { SessionEvent } from "../../src/session/events.js";

const created: SessionEvent = {
  sessionId: "s1", seq: 0, ts: 0, type: "session_created",
  title: "t", workspace: "/w", cloud: { workspaceId: "w1" },
} as never;

const brief = (agentId: string, name: string, instructions = "你管店铺运营"): SessionEvent => ({
  sessionId: "s1", seq: 0, ts: 0, type: "agent_briefed", agentId, name,
  instructions,
  roster: [{ name: "广告", description: "管投放" }],
} as never);

/** 围栏 system 消息的正文——brief 现在焊在它的尾部（A-3） */
const sys = (msgs: ReturnType<typeof deriveMessages>) =>
  msgs.find((m) => m.role === "system")?.content ?? "";

describe("agent_briefed（#928 切片 1a）", () => {
  it("投影进围栏 system 尾部，带上自己的职责和群里还有谁", () => {
    const s = sys(deriveMessages([created, brief("ops", "运营")]));
    expect(s).toContain("运营");
    expect(s).toContain("你管店铺运营");
    expect(s).toContain("广告");
    expect(s).toContain("管投放");
  });

  it("**不说自己是 subagent，也不说最终文本是返回值** —— 那是另一种 agent", () => {
    const s = sys(deriveMessages([created, brief("ops", "运营")]));
    expect(s).not.toContain("subagent");
    expect(s).not.toContain("返回值");
  });

  it("别人的 briefing 不进我的上下文 —— 我要知道群里有广告这个人，不要读它的提示词", () => {
    const out = projectForAgent([brief("ops", "运营")], "ads");
    expect(out).toEqual([]);
  });
});

describe("agent_briefed 最新一条胜出 + 压缩幸存（#957 A-3）", () => {
  it("改了提示词再 brief 一次：只有后一条进上下文，前一条一个字都不在", () => {
    const msgs = deriveMessages([
      created,
      brief("ops", "运营", "旧口径：按下单量算业绩"),
      { sessionId: "s1", seq: 0, ts: 0, type: "user_message", content: "在吗" } as never,
      brief("ops", "运营", "新口径：按回款算业绩"),
    ]);
    const all = msgs.map((m) => m.content).join("\n");
    expect(all).toContain("新口径：按回款算业绩");
    expect(all).not.toContain("旧口径");
    // 两个身份块叠着 = 模型读到新旧两套口径而不报错（#949 同款教训）
    expect(sys(msgs).split("你是这个工作区里的").length - 1).toBe(1);
  });

  it("brief 之后压缩：身份仍在 system 里，且只出现一次", () => {
    const msgs = deriveMessages([
      created,
      brief("ops", "运营"),
      { sessionId: "s1", seq: 0, ts: 0, type: "user_message", content: "在吗" } as never,
      { sessionId: "s1", seq: 0, ts: 0, type: "context_compacted", summary: "摘要", model: "m" } as never,
    ]);
    const s = sys(msgs);
    expect(s).toContain("你管店铺运营");
    expect(s.split("你是这个工作区里的").length - 1).toBe(1);
    // 别的消息里也不许再有一份
    const others = msgs.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
    expect(others).not.toContain("你管店铺运营");
  });

  it("brief 排在工作区记忆块之前 —— 先知道自己是谁，再读记着的事", () => {
    const s = sys(deriveMessages([
      created,
      brief("ops", "运营"),
      { sessionId: "s1", seq: 0, ts: 0, type: "workspace_memory_loaded",
        agentId: "ops", agentName: "运营", shared: "[运营] 销量含退款", own: "" } as never,
    ]));
    expect(s.indexOf("你管店铺运营")).toBeGreaterThan(-1);
    expect(s.indexOf("你管店铺运营")).toBeLessThan(s.indexOf("SHARED"));
  });

  it("没有围栏 system 消息（旧日志 / 没带 workspace）：退回事件位置那条 user 消息，不静默丢掉身份", () => {
    const msgs = deriveMessages([brief("ops", "运营")]);
    const mine = msgs.find((m) => m.role === "user");
    expect(mine?.content).toContain("你管店铺运营");
    expect(msgs.some((m) => m.role === "system")).toBe(false);
  });
});
