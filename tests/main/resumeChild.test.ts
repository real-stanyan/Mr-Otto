// 恢复子会话（review I1）—— resume 曾经是绕开 ADR-0046 决定 5 的那条后门：
// 一个 tools: read_file / approval: deny 的搜索员被 resume 回来时带着 bash、
// write_file 和 task。而 resume 是查看子会话的唯一途径。

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childAgentConfig, createChildAgent } from "../../src/main/resumeChild.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { SubagentDef } from "../../src/shared/subagent.js";

const push: AgentPush = {
  event: () => {},
  approvalRequest: () => {},
  askUserRequest: () => {},
  assistantDelta: () => {},
  toolOutput: () => {},
};

function def(over: Partial<SubagentDef> = {}): SubagentDef {
  return {
    name: "searcher",
    description: "只读搜索员",
    instructions: "只看不动。",
    tools: ["read_file"],
    unknownTools: [],
    approval: "deny",
    path: "/a/searcher.md",
    source: "/a",
    readOnly: false,
    ...over,
  };
}

/** 一份典型的子会话日志：session_created(带 spawnedBy) + subagent_briefed */
function childLog(over: { tools?: string[]; briefed?: boolean } = {}): SessionEvent[] {
  const created = {
    seq: 0,
    sessionId: "s-child",
    ts: 1,
    type: "session_created",
    workspace: "/w",
    spawnedBy: { sessionId: "s-parent", toolCallId: "call_1", agent: "searcher" },
  } as SessionEvent;
  if (over.briefed === false) return [created];
  return [
    created,
    {
      seq: 1,
      sessionId: "s-child",
      ts: 2,
      type: "subagent_briefed",
      agent: "searcher",
      instructions: "只看不动。",
      tools: over.tools ?? ["read_file"],
      model: "deepseek-chat",
    } as SessionEvent,
  ];
}

describe("childAgentConfig", () => {
  it("不是子会话 = null（调用方照旧按主会话装配）", () => {
    const main = [
      { seq: 0, sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" } as SessionEvent,
    ];
    expect(childAgentConfig(main, [def()])).toBeNull();
    expect(childAgentConfig([], [def()])).toBeNull();
  });

  it("定义还在 = 按定义还原工具白名单和审批档", () => {
    expect(childAgentConfig(childLog(), [def({ tools: ["read_file", "bash"] })])).toEqual({
      agent: "searcher",
      allowTools: ["read_file", "bash"],
      deny: true,
    });
    expect(childAgentConfig(childLog(), [def({ approval: "ask" })])?.deny).toBe(false);
  });

  it("定义被删/改名了 = 退到日志里的 subagent_briefed 快照，并按最严的 deny 重建", () => {
    // 唯一不可接受的兜底是"当主 agent 建"——那等于删掉一个 md 文件就能提权
    const cfg = childAgentConfig(childLog({ tools: ["read_file", "web_search"] }), []);
    expect(cfg).toEqual({
      agent: "searcher",
      allowTools: ["read_file", "web_search"],
      deny: true,
    });
  });

  it("连快照都没有（理论不可达）= 一把工具都不给", () => {
    expect(childAgentConfig(childLog({ briefed: false }), [])).toEqual({
      agent: "searcher",
      allowTools: [],
      deny: true,
    });
  });
});

describe("createChildAgent", () => {
  function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), "otter-resume-child-"));
    const store = new EventStore(join(dir, "events.db"));
    const attachments = new AttachmentStore(join(dir, "attachments"));
    // 真造一份子会话日志出来，好让 resumeSessionId 有东西可投影
    store.append({
      sessionId: "s-child",
      ts: 1,
      type: "session_created",
      workspace: dir,
      spawnedBy: { sessionId: "s-parent", toolCallId: "call_1", agent: "searcher" },
    });
    store.append({
      sessionId: "s-child",
      ts: 2,
      type: "subagent_briefed",
      agent: "searcher",
      instructions: "只看不动。",
      tools: ["read_file"],
      model: "deepseek-chat",
    });
    return { dir, store, attachments };
  }

  it("重建出来的子 agent 没有 task 工具（ADR-0046 决定 5，resume 这条路上）", () => {
    const { dir, store, attachments } = fixtures();
    const events = store.load("s-child");
    const config = childAgentConfig(events, [def({ tools: ["read_file", "bash", "task"] })])!;
    const agent = createChildAgent({
      store,
      workspace: dir,
      resumeSessionId: "s-child",
      push,
      attachments,
      config,
    });
    const names = agent.toolDefs.map((d) => d.name);
    expect(names).not.toContain("task");
    expect(names).toContain("read_file");
  });

  it("定义没了也不提权：工具表退回日志快照，task 照旧没有", () => {
    const { dir, store, attachments } = fixtures();
    const config = childAgentConfig(store.load("s-child"), [])!;
    const agent = createChildAgent({
      store,
      workspace: dir,
      resumeSessionId: "s-child",
      push,
      attachments,
      config,
    });
    expect(agent.toolDefs.map((d) => d.name)).toEqual(["read_file"]);
  });
});
