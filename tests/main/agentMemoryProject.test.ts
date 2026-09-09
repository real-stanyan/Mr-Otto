// #1155：memory-reviewer 写了近七成记忆却没有项目档——子会话装配时 memoryProject
// 是 null（没有 memory 快照、日志里也没有 memory_loaded），于是 memory 工具的
// target 枚举里没有 project、点名守卫（ADR-0143）也整段跳过，项目事实只能落全局档。
// 这里钉住 createAgent 这一层的契约：显式给的 memoryProject 决定工具挂不挂 project
// 档，且 agent 把它暴露出来（子会话装配要从父身上拿这一份，不重新解析）。
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createAgent, type AgentPush } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { tempDir } from "../helpers/tempDir.js";

const push: AgentPush = {
  event: () => {}, approvalRequest: () => {}, askUserRequest: () => {},
  assistantDelta: () => {}, toolOutput: () => {},
};

function targetEnum(agent: { toolDefs: { name: string; parameters?: unknown }[] }): string[] | undefined {
  const def = agent.toolDefs.find((d) => d.name === "memory");
  const props = (def?.parameters as { properties?: { target?: { enum?: string[] } } } | undefined)?.properties;
  return props?.target?.enum;
}

function fixtures() {
  const dir = tempDir("otter-memproj-");
  const world = createLocalWorld({ root: dir, configRoot: join(dir, "cfg") });
  const store = new EventStore(":memory:");
  const attachments = new AttachmentStore(join(dir, "att"));
  return { dir, world, store, attachments };
}

describe("createAgent 的 memoryProject（#1155）", () => {
  it("显式给 memoryProject：memory 工具挂上 project 档，getter 原样回", () => {
    const { dir, world, store, attachments } = fixtures();
    const project = { id: "github.com/x/y", root: "/repo/y", dir: "memories/projects/abc" };
    const agent = createAgent({ store, workspace: dir, world, push, attachments, memoryProject: project });
    expect(agent.memoryProject).toEqual(project);
    expect(targetEnum(agent)).toContain("project");
    store.close();
  });

  it("不给 memoryProject、也没有记忆快照：null，枚举里没有 project（原行为不变）", () => {
    const { dir, world, store, attachments } = fixtures();
    const agent = createAgent({ store, workspace: dir, world, push, attachments });
    expect(agent.memoryProject).toBeNull();
    expect(targetEnum(agent)).toBeDefined();
    expect(targetEnum(agent)).not.toContain("project");
    store.close();
  });

  it("从记忆快照推导出来的那份也从 getter 出来（主会话那条路）", () => {
    const { dir, world, store, attachments } = fixtures();
    const agent = createAgent({
      store, workspace: dir, world, push, attachments,
      memory: { memory: "", user: "", project: "", projectRoot: "/repo/y", projectScope: "github.com/x/y" },
    });
    expect(agent.memoryProject).toMatchObject({ id: "github.com/x/y", root: "/repo/y" });
    expect(targetEnum(agent)).toContain("project");
    store.close();
  });
});
