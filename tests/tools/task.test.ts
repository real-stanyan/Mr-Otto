import { describe, expect, it, vi } from "vitest";
import { createTaskTool, type SubagentRunner } from "../../src/tools/task.js";
import type { SubagentDef } from "../../src/shared/subagent.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld; // task 工具压根不碰 world

function def(name: string, description: string): SubagentDef {
  return {
    name,
    description,
    instructions: "干活",
    tools: ["read_file"],
    unknownTools: [],
    approval: "deny",
    path: `/a/${name}.md`,
    source: "/a",
    readOnly: false,
  };
}

const okRunner: SubagentRunner = {
  run: async ({ agent, task }) => ({ report: `${agent} 做完了：${task}`, childSessionId: "s-child" }),
};

describe("createTaskTool", () => {
  it("def 随清单现算：设置页加了人，下一轮就在 enum 里", () => {
    let defs = [def("searcher", "只读搜索员")];
    const tool = createTaskTool(okRunner, () => defs);
    const first = tool.def.parameters as { properties: { agent: { enum: string[] } } };
    expect(first.properties.agent.enum).toEqual(["searcher"]);

    defs = [def("searcher", "只读搜索员"), def("writer", "写手")];
    const second = tool.def.parameters as { properties: { agent: { enum: string[] } } };
    expect(second.properties.agent.enum).toEqual(["searcher", "writer"]);
  });

  it("description 把每个 subagent 的自我介绍列给模型（模型靠它挑人）", () => {
    const tool = createTaskTool(okRunner, () => [def("searcher", "只读搜索员")]);
    expect(tool.def.description).toContain("searcher");
    expect(tool.def.description).toContain("只读搜索员");
  });

  it("不需要审批：派活本身不危险，危险动作在子 agent 里各自过门", () => {
    expect(createTaskTool(okRunner, () => [def("a", "")]).requiresApproval).toBe(false);
  });

  it("跑通时返回汇报正文", async () => {
    const tool = createTaskTool(okRunner, () => [def("searcher", "")]);
    const out = await tool.run({ agent: "searcher", task: "找调用点" }, world, { toolCallId: "call_1" });
    expect(out).toBe("searcher 做完了：找调用点");
  });

  it("把 parentToolCallId 和 signal 透给 runner", async () => {
    const run = vi.fn(async () => ({ report: "ok", childSessionId: "s-child" }));
    const tool = createTaskTool({ run }, () => [def("searcher", "")]);
    const ac = new AbortController();
    await tool.run({ agent: "searcher", task: "T" }, world, {
      toolCallId: "call_9",
      signal: ac.signal,
    });
    expect(run).toHaveBeenCalledWith({
      agent: "searcher",
      task: "T",
      parentToolCallId: "call_9",
      signal: ac.signal,
    });
  });

  it("派给不存在的人 = 抛错（engine 转成 tool_result: error，模型能改口重派）", async () => {
    const tool = createTaskTool(okRunner, () => [def("searcher", "")]);
    await expect(
      tool.run({ agent: "nobody", task: "T" }, world, { toolCallId: "call_1" })
    ).rejects.toThrow(/nobody/);
  });

  it("参数形状不对 = 抛错，不把 undefined 传下去", async () => {
    const tool = createTaskTool(okRunner, () => [def("searcher", "")]);
    await expect(tool.run({ agent: "searcher" }, world, { toolCallId: "call_1" })).rejects.toThrow();
    await expect(tool.run("随便", world, { toolCallId: "call_1" })).rejects.toThrow();
  });

  it("没有 toolCallId（裸管线）也不炸", async () => {
    const tool = createTaskTool(okRunner, () => [def("searcher", "")]);
    await expect(tool.run({ agent: "searcher", task: "T" }, world)).resolves.toBeTruthy();
  });
});
