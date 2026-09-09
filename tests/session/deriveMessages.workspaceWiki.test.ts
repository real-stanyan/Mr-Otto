// tests/session/deriveMessages.workspaceWiki.test.ts
// workspace_wiki_loaded 的投影（#1140）：拼进 system 尾部、最新一条胜出、没有 system 时静默不补造——
// 与 deriveMessages.workspaceMemory.test.ts 的三条底线逐字相同，只是事件换了。
import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const ev = (e: Omit<SessionEvent, "seq" | "ts">): SessionEvent => ({ ...e, seq: seq++, ts: 1000 + seq } as SessionEvent);
const wiki = (over: Partial<{ index: string; own: string | null; nudge: string | null }>) =>
  ev({ sessionId: "s", type: "workspace_wiki_loaded", agentId: "ops", agentName: "运营", index: "# 索引", pinned: [{ path: "team.md", title: "团队口径", body: "销量含退款" }], own: null, nudge: null, ...over } as never);
function base(): SessionEvent[] {
  seq = 0;
  return [ev({ sessionId: "s", type: "session_created", workspace: "/w", cloud: { workspaceId: "w1" } } as never)];
}

describe("workspace_wiki_loaded 的投影（#1140）", () => {
  it("拼进 system 尾部：约定摘要 + 索引 + 常驻页 + 自己那页", () => {
    const events = base();
    events.push(wiki({ own: "按月查" }));
    const c = deriveMessages(events)[0]!.content as string;
    expect(c).toContain("wiki_read");
    expect(c).toContain("[索引]\n# 索引");
    expect(c).toContain("销量含退款");
    expect(c).toContain("按月查");
  });
  it("最新一条胜出：两条快照只渲后一条", () => {
    const events = base();
    events.push(wiki({ index: "旧索引" }));
    events.push(ev({ sessionId: "s", type: "user_message", content: "[alice]: hi" } as never));
    events.push(wiki({ index: "新索引" }));
    const c = deriveMessages(events)[0]!.content as string;
    expect(c).toContain("新索引");
    expect(c).not.toContain("旧索引");
    expect(c.split("[索引]")).toHaveLength(2);
  });
  it("旧日志里的 workspace_memory_loaded 照旧投影（重放不变）", () => {
    const events = base();
    events.push(ev({ sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "[运营] 老口径", own: "" } as never));
    expect(deriveMessages(events)[0]!.content as string).toContain("[运营] 老口径");
  });
  it("没有 system（旧日志没带 workspace）时静默不补造", () => {
    const events = [wiki({})];
    expect(deriveMessages(events).some((m) => m.role === "system")).toBe(false);
  });
});
