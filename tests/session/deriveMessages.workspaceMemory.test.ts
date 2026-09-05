// workspace_memory_loaded 的投影（#949）：拼进 system 尾部、最新一条胜出、
// 没有 system（旧日志 / 没带 workspace）时静默不补造——同 memory_loaded 的三条底线。
import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const ev = (e: Omit<SessionEvent, "seq" | "ts">): SessionEvent => ({ ...e, seq: seq++, ts: 1000 + seq } as SessionEvent);

function base(): SessionEvent[] {
  seq = 0;
  return [
    ev({ sessionId: "s", type: "session_created", workspace: "/w", cloud: { workspaceId: "w1" } } as never),
  ];
}

describe("workspace_memory_loaded 的投影（#949）", () => {
  it("拼进 system 尾部：判据 + SHARED/OWN 两块；两档都空也要说「你有记忆」", () => {
    const events = base();
    events.push(ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "[运营] 销量含退款", own: "" } as never));
    const msgs = deriveMessages(events);
    const sys = msgs[0]!;
    expect(sys.role).toBe("system");
    const c = sys.content as string;
    expect(c).toContain("换一只 agent 还成立吗");
    expect(c).toContain("SHARED");
    expect(c).toContain("[运营] 销量含退款");
    expect(c).not.toContain("OWN (只有");   // own 为空不渲块
    expect(c).toContain("memory 工具");

    const empty = base();
    empty.push(ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "", own: "" } as never));
    expect(deriveMessages(empty)[0]!.content as string).toContain("memory 工具");
  });

  it("最新一条快照胜出：两条快照只渲后一条的内容", () => {
    const events = base();
    events.push(ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "旧口径", own: "" } as never));
    events.push(ev({ sessionId: "s", type: "user_message", content: "[alice]: hi" } as never));
    events.push(ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "新口径", own: "我的手感" } as never));
    const c = deriveMessages(events)[0]!.content as string;
    expect(c).toContain("新口径");
    expect(c).toContain("我的手感");
    expect(c).not.toContain("旧口径");
    // 只渲一次：用指引开场白计数而不是 "SHARED" 这个词——workspaceTierRuleText
    // 本身在判据句里就把 "SHARED" 写了三遍（一次调用天然出现 4 次），数这个词
    // 测不出「渲了几次」，只有开场白这句话在每次 renderWorkspaceMemoryPrompt
    // 调用里只出现一次，两条快照没去重就会看见它出现两遍
    expect(c.split("你有这个工作区里的长期记忆").length).toBe(2);
  });

  it("没有 system（旧日志没带 workspace）时静默不拼，不补造", () => {
    seq = 0;
    const events: SessionEvent[] = [
      ev({ sessionId: "s", type: "session_created" } as never),
      ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "x", own: "" } as never),
    ];
    expect(deriveMessages(events).some((m) => m.role === "system")).toBe(false);
  });
});
