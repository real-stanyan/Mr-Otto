import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/main/agent.js";
import { denyingApprover } from "../../src/main/uiApprover.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { SubagentRunner } from "../../src/tools/task.js";
import type { SubagentDef } from "../../src/shared/subagent.js";

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "otter-subagent-"));
  const store = new EventStore(join(dir, "events.db"));
  const attachments = new AttachmentStore(join(dir, "attachments"));
  const push: AgentPush = {
    event: () => {},
    approvalRequest: () => {},
    askUserRequest: () => {},
    assistantDelta: () => {},
    toolOutput: () => {},
  };
  return { dir, store, attachments, push };
}

describe("createAgent 的 subagent 接缝", () => {
  it("allowTools 给了 = 只挂名字在内的工具", () => {
    const { dir, store, attachments, push } = fixtures();
    const agent = createAgent({
      store,
      workspace: dir,
      push,
      attachments,
      allowTools: ["read_file", "web_search"],
    });
    expect(agent.toolDefs.map((d) => d.name).sort()).toEqual(["read_file", "web_search"]);
  });

  it("allowTools 不给 = 全套工具照旧（现有装配一字不受影响）", () => {
    const { dir, store, attachments, push } = fixtures();
    const agent = createAgent({ store, workspace: dir, push, attachments });
    expect(agent.toolDefs.map((d) => d.name)).toContain("bash");
    expect(agent.toolDefs.map((d) => d.name)).toContain("write_file");
  });

  it("spawnedBy 写进 session_created 第 0 条", () => {
    const { dir, store, attachments, push } = fixtures();
    const spawnedBy = { sessionId: "s-parent", toolCallId: "call_1", agent: "searcher" };
    const agent = createAgent({ store, workspace: dir, push, attachments, spawnedBy });
    const first = store.load(agent.sessionId)[0];
    expect(first?.type).toBe("session_created");
    expect(first?.type === "session_created" && first.spawnedBy).toEqual(spawnedBy);
  });

  it("world 给了 = 用它，不另造一个（v2 换 SandboxWorld 时子 agent 要在同一个容器里）", () => {
    const { dir, store, attachments, push } = fixtures();
    const parentWorld = createLocalWorld({ root: dir });
    const agent = createAgent({ store, workspace: dir, push, attachments, world: parentWorld });
    expect(agent.world).toBe(parentWorld);
  });

  it("task 的挂载在 subagentRunner 存在时一次定终身；清单从空变非空只影响 toolDefs 里报不报（finding 3）", () => {
    const { dir, store, attachments, push } = fixtures();
    let roster: SubagentDef[] = [];
    const runner: SubagentRunner = {
      run: async () => ({ report: "", childSessionId: "s-child" }),
    };
    const agent = createAgent({
      store,
      workspace: dir,
      push,
      attachments,
      subagentRunner: runner,
      listSubagents: () => roster,
    });
    // 清单空着：task 挂了（toolsByName 里在，误调能报清楚错误），但不进 toolDefs
    expect(agent.toolDefs.map((d) => d.name)).not.toContain("task");
    roster = [
      {
        name: "searcher",
        description: "只读搜索员",
        instructions: "你是一个只读搜索员。",
        tools: ["read_file"],
        unknownTools: [],
        approval: "deny",
        preamble: { mode: "default" },
        context: [],
        scope: "user",
        path: "/a/searcher.md",
        source: "/a",
        readOnly: false,
      },
    ];
    // 清单现在非空：同一个 agent，不重开会话，toolDefs 立刻报出 task
    expect(agent.toolDefs.map((d) => d.name)).toContain("task");
  });

  it("denyingApprover 一律拒绝，且带得出理由", async () => {
    const outcome = await denyingApprover.decide(
      { id: "call_1", name: "bash", args: {} },
      { def: { name: "bash", description: "", parameters: {} }, requiresApproval: true, run: async () => "" }
    );
    expect(outcome.decision).toBe("denied");
    expect(outcome.reason).toBeTruthy();
  });
});
