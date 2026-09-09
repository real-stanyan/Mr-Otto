// tests/session/agentView.test.ts
import { describe, it, expect } from "vitest";
import { projectForAgent, agentView } from "../../src/session/agentView.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { EventLog } from "../../src/session/eventLog.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"]; seq: number }): SessionEvent {
  return { sessionId: "s1", ts: 0, ...partial } as SessionEvent;
}

describe("projectForAgent（#928 切片 1a）", () => {
  it("别人的 assistant_message 投影成带名字的 chat_message —— 剥掉 toolCalls（留着它会让悬空自愈捏造一条「没执行」），且不再冒充我自己的发言（#1146）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "agent_briefed", agentId: "ops", name: "运营", instructions: "盯销量", roster: [] } as never),
      ev({ seq: 1, type: "assistant_message", content: "查了，下滑 12%", model: "m", agentId: "ops", reasoning: "先看昨天的",
           usage: { promptTokens: 1, completionTokens: 1 },
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
      ev({ seq: 2, type: "tool_result", toolCallId: "c1", status: "ok", output: "12%", agentId: "ops" } as never),
    ];
    const out = projectForAgent(log, "ads");
    // 它的 briefing 照旧不进我的视图（drop），但名字从那里来
    expect(out).toEqual([
      { seq: 1, sessionId: "s1", ts: 0, type: "chat_message", fromUid: "ops", label: "运营", content: "查了，下滑 12%", mention: false },
    ]);
  });

  it("名字按日志顺序现取：改名之前说的话叫旧名字，之后的叫新名字（同 chat_message 的「发言那一刻的快照」）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "agent_briefed", agentId: "ops", name: "运营", instructions: "", roster: [] } as never),
      ev({ seq: 1, type: "assistant_message", content: "第一句", model: "m", agentId: "ops" } as never),
      ev({ seq: 2, type: "agent_briefed", agentId: "ops", name: "运营部", instructions: "", roster: [] } as never),
      ev({ seq: 3, type: "assistant_message", content: "第二句", model: "m", agentId: "ops" } as never),
    ];
    expect(projectForAgent(log, "ads").map((e) => (e as { label: string }).label)).toEqual(["运营", "运营部"]);
  });

  it("日志里没有它的 briefing（旧日志）：标签退回 agentId，不编名字", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "第一句", model: "m", agentId: "a_8e93" } as never),
    ];
    expect(projectForAgent(log, "ads")).toMatchObject([{ type: "chat_message", fromUid: "a_8e93", label: "a_8e93" }]);
  });

  it("别人纯工具调用那一轮（content 为空）整条丢弃 —— 它没说话", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ops",
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });

  it("自己的事件一条不动 —— 含 toolCalls / reasoning / usage", () => {
    const mine = ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ads",
                      toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never);
    expect(projectForAgent([mine], "ads")).toEqual([mine]);
  });

  it("没有 agentId 的事件一律放行 —— 那是全场共有的（chat_message / user_message / session_created）", () => {
    const shared = [
      ev({ seq: 0, type: "session_created", workspace: null } as never),
      ev({ seq: 1, type: "user_message", content: "[alice]: 看下销量" } as never),
      ev({ seq: 2, type: "chat_message", fromUid: "u1", label: "alice", content: "顺便看下投放", mention: false } as never),
    ];
    expect(projectForAgent(shared, "ads")).toEqual(shared);
  });

  it("别人的 user_message（护栏 / 后台注给它的私话）不进我的视图（#957 A-5）", () => {
    // 这两条是 engine 注给某一只 agent 看的，不是人在群里说的话。
    // 早退路径放行的话，运营那只「你在原地打转」会出现在广告那只的上下文里，
    // 而且长得和人说的话一模一样——它会当成群主在骂它
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "你在原地打转", origin: "loop_guard", agentId: "ops" } as never),
      ev({ seq: 1, type: "user_message", content: "[后台任务 bg-1 完成]", origin: "background", agentId: "ops" } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
    // 自己的照留
    expect(projectForAgent(log, "ops")).toEqual(log);
  });

  it("没有 agentId 的 user_message 照旧放行 —— 人说的话、接力开场白走早退路径（#957 A-5）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "[alice]: 看下销量", mentions: ["ops"] } as never),
      ev({ seq: 1, type: "user_message", content: "运营请你接一下", relay: { fromAgentId: "ops", depth: 1 }, mentions: ["ads"] } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual(log);
  });

  it("别人的 turn 期事件整条丢弃", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "tool_execution_started", toolCallId: "c1", agentId: "ops" } as never),
      ev({ seq: 1, type: "tool_result", toolCallId: "c1", status: "ok", output: "x", agentId: "ops" } as never),
      ev({ seq: 2, type: "turn_ended", agentId: "ops" } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });

  it("别人的 workspace_memory_loaded 不进我的视图，自己的照留（#949）", () => {
    const events = [
      { seq: 0, ts: 1, sessionId: "s", type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "S", own: "ops 的" },
      { seq: 1, ts: 2, sessionId: "s", type: "workspace_memory_loaded", agentId: "ads", agentName: "广告", shared: "S", own: "ads 的" },
    ] as unknown as SessionEvent[];
    const mine = projectForAgent(events, "ops");
    expect(mine.map((e) => e.seq)).toEqual([0]);
  });

  it("别人的 workspace_wiki_loaded 不进我的视图，自己的照留（#1140）", () => {
    const events = [
      { seq: 0, ts: 1, sessionId: "s", type: "workspace_wiki_loaded", agentId: "ops", agentName: "运营", index: "# 索引", pinned: [], own: null, nudge: null },
      { seq: 1, ts: 2, sessionId: "s", type: "workspace_wiki_loaded", agentId: "ads", agentName: "广告", index: "# 索引", pinned: [], own: null, nudge: null },
    ] as unknown as SessionEvent[];
    const mine = projectForAgent(events, "ops");
    expect(mine.map((e) => e.seq)).toEqual([0]);
  });
});

describe("agentView（#928 切片 1a：EventLog wrapper）", () => {
  // 手写假 EventLog
  function memoryLog(events: SessionEvent[]): EventLog {
    let allEvents = [...events];
    return {
      append: (e: SessionEvent) => {
        allEvents.push(e);
        return e;
      },
      load: (sessionId: string) =>
        allEvents.filter((e) => e.sessionId === sessionId),
      forkOrigin: () => null,
      lastOfType: (sessionId: string, type: SessionEvent["type"]) =>
        [...allEvents.filter((e) => e.sessionId === sessionId && e.type === type)].pop() ?? null,
      ofType: (sessionId: string, type: SessionEvent["type"]) =>
        allEvents.filter((e) => e.sessionId === sessionId && e.type === type),
    };
  }

  it("load 不放行别人的 context_compacted —— Critical 修复：运营压缩过一次，广告 load 出来的事件里没有它", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "需求一：检查销量", sessionId: "s1" }),
      ev({ seq: 1, type: "assistant_message", content: "已查阅", model: "m", agentId: "ops", sessionId: "s1" }),
      ev({ seq: 2, type: "context_compacted", summary: "ops 已检查销量", agentId: "ops", sessionId: "s1" } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const projected = adsView.load("s1");
    // ads 看不见 ops 的 context_compacted
    const hasContextCompacted = projected.some((e) => e.type === "context_compacted");
    expect(hasContextCompacted).toBe(false);
    // ads 看得见 user_message 和别人的 assistant_message（剥了 toolCalls）
    expect(projected).toHaveLength(2);
  });

  it("lastOfType context_compacted 在最后一条检查点属于别人时回 null", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "问题", sessionId: "s1" }),
      ev({ seq: 1, type: "context_compacted", summary: "ops 的摘要", agentId: "ops", sessionId: "s1" } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    // ads 查最后一个 context_compacted,它属于 ops,所以回 null
    const hit = adsView.lastOfType("s1", "context_compacted");
    expect(hit).toBe(null);
  });

  it("lastOfType user_message 跳过别人的私话往前走，别把我的 turn 边界丢了（#957 A-5）", () => {
    // user_message 现在也可能带 agentId（护栏 / 后台注给某一只的私话）。
    // boundedContextEvents 拿 lastOfType 找「上一个 user turn 从哪开始」——
    // 撞上别人的私话就回 null 的话，重建会当成「检查点之前没有 user turn」，
    // 把我真正的那一段整段丢掉：上下文静默变短
    const events: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "人问的问题", sessionId: "s1" }),
      ev({ seq: 1, type: "user_message", content: "你在原地打转", origin: "loop_guard", agentId: "ops" } as never),
    ];
    const base: EventLog = {
      append: () => { throw new Error("不该写"); },
      load: () => events,
      forkOrigin: () => null,
      lastOfType: (_s, type, opts) =>
        [...events].reverse().find((e) => e.type === type && (opts?.beforeSeq === undefined || e.seq < opts.beforeSeq)) ?? null,
      ofType: (_s, type) => events.filter((e) => e.type === type),
    };
    const hit = agentView(base, "ads").lastOfType("s1", "user_message");
    expect(hit).toMatchObject({ seq: 0, content: "人问的问题" });
  });

  it("lastOfType user_message 原样回来（不带 agentId，不该被过滤成 null）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "来自人的话", sessionId: "s1" }),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const hit = adsView.lastOfType("s1", "user_message");
    expect(hit).not.toBe(null);
    expect(hit?.type).toBe("user_message");
  });

  it("deriveMessages 链条验证：ops 压缩不会污染 ads 的上下文", () => {
    // 构造场景：ads 有自己的消息，ops 压缩过，ads 再 load 并投影给模型
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "ads 自己的需求", sessionId: "s1" }),
      ev({
        seq: 1,
        type: "assistant_message",
        content: "ads 的回复",
        model: "m",
        agentId: "ads",
        sessionId: "s1",
      } as never),
      // ops 压缩并生成了摘要（这种摘要包含 ops 私有的视角信息）
      ev({
        seq: 2,
        type: "context_compacted",
        summary: "ops 已压缩过，这是 ops 视角的摘要",
        agentId: "ops",
        sessionId: "s1",
      } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const projected = adsView.load("s1");

    // 第一关：投影层应该过滤掉 ops 的 context_compacted
    const hasOpsCompacted = projected.some((e) => e.type === "context_compacted" && e.agentId === "ops");
    expect(hasOpsCompacted).toBe(false);

    // 第二关：deriveMessages 不应该包含任何来自 ops 的摘要内容
    const messages = deriveMessages(projected);
    const hasSummary = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("ops 已压缩过")
    );
    expect(hasSummary).toBe(false);

    // 第三关：不应该有幻影工具消息（deriveMessages 的自愈机制）
    const phantomToolMessages = messages.filter((m) => m.role === "tool");
    expect(phantomToolMessages).toHaveLength(0);

    // ads 自己的消息应该还在
    const adsOwnMessage = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("ads 的回复")
    );
    expect(adsOwnMessage).toBe(true);
  });
});

// #1146：真机上「管理员」那一轮 400——`The reasoning_content in the thinking mode must be
// passed back to the API`。用真接口对着从日志重建的请求逐字复现过（记在 #1146）：DeepSeek
// thinking 模式 + 请求带 tools 时，**最后一条 user 之后的任何 assistant 消息**都得带
// reasoning_content；而别人的发言此前被投影成 assistant 角色（没有工具调用、也不可能有它的
// reasoning），于是接力开场白之后跟着的两条「开发」的话就是那两条 assistant。同一个投影还让
// 每只 agent 把别人说过的话读成自己说过的（真机上「开发」答「收到接力，管理员这棒我来收个尾」）。
// 群里我听得见你说话，但那是**你**在说——投影成 `[名字]: 内容` 的成员发言，两个病一起好。
describe("别人的发言是群里的话，不是我说过的话（#1146）", () => {
  it("接力之后紧跟着别人的两条发言：模型看到的是两条带名字的 user 消息，最后一条 user 之后没有 assistant", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "session_created", workspace: null, title: "t",
           cloud: { workspaceId: "w", workspaceName: "mandy", memberLabels: [] } } as never),
      ev({ seq: 1, type: "agent_briefed", agentId: "dev", name: "开发", instructions: "写代码", roster: [] } as never),
      ev({ seq: 2, type: "agent_briefed", agentId: "admin", name: "管理员", instructions: "管群", roster: [] } as never),
      ev({ seq: 3, type: "user_message", content: "[stan]: @开发 @管理员 对接得怎么样", fromUid: "u1", mentions: ["dev", "admin"] } as never),
      ev({ seq: 4, type: "user_message", content: "[系统] 「设计」在上一条发言里 @ 了「管理员」（接力第 1 棒）。",
           fromUid: "u1", mentions: ["admin"], relay: { fromAgentId: "design", depth: 1 } } as never),
      ev({ seq: 5, type: "assistant_message", content: "收到接力，我先查一件事。", model: "m", agentId: "dev", reasoning: "…",
           toolCalls: [{ id: "call_00_x", name: "bash", arguments: "{\"command\":\"ls\"}" }] } as never),
      ev({ seq: 6, type: "tool_result", toolCallId: "call_00_x", status: "ok", output: "README.md", agentId: "dev" } as never),
      ev({ seq: 7, type: "assistant_message", content: "查完了，闭环。", model: "m", agentId: "dev", reasoning: "…" } as never),
      ev({ seq: 8, type: "turn_ended", outcome: "completed", agentId: "dev" } as never),
    ];
    const messages = deriveMessages(projectForAgent(log, "admin"));
    const roles = messages.map((m) => m.role);
    const lastUser = roles.lastIndexOf("user");
    // 这条断言就是那家 API 的规矩：最后一条 user 之后一条 assistant 都不许有（我这一轮还没开口）
    expect(roles.slice(lastUser)).not.toContain("assistant");
    expect(roles).not.toContain("tool");
    const tail = messages.slice(-3).map((m) => m.content);
    expect(tail).toEqual([
      "[系统] 「设计」在上一条发言里 @ 了「管理员」（接力第 1 棒）。",
      "[开发]: 收到接力，我先查一件事。",
      "[开发]: 查完了，闭环。",
    ]);
  });

  it("自己的视图一个字不变：自己的 assistant_message 仍是 assistant 角色、带 tool_calls（工具回合要配对）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "[stan]: @开发 看看目录", fromUid: "u1", mentions: ["dev"] } as never),
      ev({ seq: 1, type: "assistant_message", content: "我看看。", model: "m", agentId: "dev",
           toolCalls: [{ id: "call_00_x", name: "bash", arguments: "{}" }] } as never),
      ev({ seq: 2, type: "tool_result", toolCallId: "call_00_x", status: "ok", output: "README.md", agentId: "dev" } as never),
    ];
    const roles = deriveMessages(projectForAgent(log, "dev")).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
  });
});
