// 恢复子会话（review I1）—— resume 曾经是绕开 ADR-0047 决定 5 的那条后门：
// 一个 tools: read_file / approval: deny 的搜索员被 resume 回来时带着 bash、
// write_file 和 task。而 resume 是查看子会话的唯一途径。

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { childAgentConfig, createChildAgent } from "../../src/main/resumeChild.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { SessionEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const push: AgentPush = {
  event: () => {},
  approvalRequest: () => {},
  askUserRequest: () => {},
  assistantDelta: () => {},
  toolOutput: () => {},
};

describe("childAgentConfig", () => {
  it("磁盘上还有同名定义,也不采信它——重建只信快照", () => {
    const events = [
      { type: "session_created", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "r" } },
      { type: "subagent_briefed", agent: "r", instructions: "x", tools: ["read_file"], model: "m" },
    ] as unknown as SessionEvent[];
    const cfg = childAgentConfig(events);
    expect(cfg).toEqual({ agent: "r", allowTools: ["read_file"], deny: true });
  });

  it("没有快照(理论不可达) = 零工具 + deny", () => {
    const events = [
      { type: "session_created", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "r" } },
    ] as unknown as SessionEvent[];
    expect(childAgentConfig(events)).toEqual({ agent: "r", allowTools: [], deny: true });
  });

  it("不是子会话 = null", () => {
    const events = [{ type: "session_created" }] as unknown as SessionEvent[];
    expect(childAgentConfig(events)).toBeNull();
  });

  // 那道守卫是一条三段 OR（!first || 类型不对 || 没有 spawnedBy），三段各有各的
  // 入口。空日志走的是第一段——它曾经有过断言，改签名那轮跟着整块删掉了。
  // 把它单独钉住:有人把这行"简化"成 `!first?.spawnedBy` 时，行为在 first 为
  // undefined 和 first 类型不对这两种情况下会分叉，而没有测试会拦住
  it("空日志 = null,不是崩溃", () => {
    expect(childAgentConfig([])).toBeNull();
  });
});

describe("createChildAgent", () => {
  function fixtures(tools: string[] = ["read_file"]) {
    const dir = tempDir("otter-resume-child-");
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
      tools,
      model: "deepseek-chat",
    });
    return { dir, store, attachments };
  }

  it("重建出来的子 agent 没有 task 工具（ADR-0047 决定 5，resume 这条路上）", () => {
    // 快照里就算混进了 task（理论不可达,但防御式验证)，createChildAgent
    // 不传 subagentRunner 这件事本身就挡住它——不依赖 allowTools 干净
    const { dir, store, attachments } = fixtures(["read_file", "bash", "task"]);
    const events = store.load("s-child");
    const config = childAgentConfig(events)!;
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

  it("按快照工具表重建：deny 一律成立，工具表就是快照记的那份", () => {
    const { dir, store, attachments } = fixtures();
    const config = childAgentConfig(store.load("s-child"))!;
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

  // ADR-0054 / issue #154：重建走的是新造的 LocalWorld（父可能早已不在内存里），
  // 没有一个带着 withMcp 的 world 可以继承，所以这一侧必须显式传 mcp。
  // 两条子 agent 路径的规则必须一样：挂载归挂载，用不用得着由快照里那份白名单说了算
  const mcp = () => ({
    ready: async () => {},
    servers: () => [{
      id: "gh", name: "gh", status: "connected" as const, live: true,
      tools: [{ name: "create_pr", description: "开 PR", inputSchema: {} }],
      resources: [],
      prompts: [],
    }],
    callTool: async () => [{ kind: "text" as const, text: "ok" }],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: async () => {},
    authorize: async () => {},
    configOf: () => undefined,
  });

  it("快照点了名的 mcp 工具，重建回来还在", () => {
    const { dir, store, attachments } = fixtures(["read_file", "mcp__gh__create_pr"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config, mcp: mcp(),
    });
    expect(agent.toolDefs.map((d) => d.name)).toContain("mcp__gh__create_pr");
  });

  it("快照没点名 = 挂了也过不了白名单（与活着那一侧同一套规则）", () => {
    const { dir, store, attachments } = fixtures(["read_file"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config, mcp: mcp(),
    });
    expect(agent.toolDefs.map((d) => d.name)).toEqual(["read_file"]);
  });

  // issue #482 欠账 ①：恢复侧曾经不传 skills，于是 resume 回来的子会话
  // 拿不到 skill 工具，与活着那一侧（subagentRunner）不对称。
  // 白名单是唯一的闸——而快照记的是**实际挂上**的那几把
  const skills = () => ({
    listSkills: () => [
      { name: "ponytail", description: "扎马尾", content: "把头发扎起来。" },
    ],
  });

  it("快照点了名的 skill 工具，重建回来还在（与活着那一侧对称）", () => {
    const { dir, store, attachments } = fixtures(["read_file", "skill"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config,
      skills: skills(),
    });
    expect(agent.toolDefs.map((d) => d.name)).toContain("skill");
  });

  // skills: "none" 的子 agent 当初根本没挂上这把刀（subagentRunner 落 briefed
  // 时写的是 child.toolDefs 的实际名单），所以快照里没有 "skill"。恢复侧不靠
  // "记得别传 skills" 挡它，靠快照本身——skill 功能之前的旧日志同理
  it("快照没点名 skill = 挂了也过不了白名单（skills:none 的子 agent 恢复回来照样没有）", () => {
    const { dir, store, attachments } = fixtures(["read_file"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config,
      skills: skills(),
    });
    expect(agent.toolDefs.map((d) => d.name)).toEqual(["read_file"]);
  });

  it("不给 skills 就没有这把刀（裸装配/测试照旧）", () => {
    const { dir, store, attachments } = fixtures(["read_file", "skill"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config,
    });
    expect(agent.toolDefs.map((d) => d.name)).toEqual(["read_file"]);
  });

  it("不给 mcp 就一把都没有（旧行为，裸装配/测试照旧）", () => {
    const { dir, store, attachments } = fixtures(["read_file", "mcp__gh__create_pr"]);
    const config = childAgentConfig(store.load("s-child"))!;
    const agent = createChildAgent({
      store, workspace: dir, resumeSessionId: "s-child", push, attachments, config,
    });
    expect(agent.toolDefs.map((d) => d.name)).toEqual(["read_file"]);
  });
});
