import { describe, it, expect, vi } from "vitest";
import { createMcpTools } from "../../src/tools/mcpTool.js";
import type { ExecutionWorld, McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";

function handle(over: Partial<McpServerHandle> = {}): McpServerHandle {
  return {
    id: "github",
    name: "github",
    status: "connected",
    live: true,
    tools: [{ name: "create_pr", description: "开一个 PR", inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    ...over,
  };
}

function capWith(
  servers: McpServerHandle[],
  callTool: McpCapability["callTool"] = async () => [{ kind: "text", text: "ok" }]
): McpCapability {
  return {
    ready: async () => {},
    servers: () => servers,
    callTool,
    readResource: async () => [],
    getPrompt: async () => "",
    configure: async () => {},
    authorize: async () => {},
    configOf: () => undefined,
  };
}

const worldWith = (mcp: McpCapability): ExecutionWorld => ({
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
  mcp,
});

describe("createMcpTools", () => {
  it("每个 server 的每个 tool 各出一把刀，名字带前缀", () => {
    const tools = createMcpTools(capWith([handle()]));
    expect(tools.map((t) => t.def.name)).toEqual(["mcp__github__create_pr"]);
  });

  it("description 与 inputSchema 原样透给模型", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.def.description).toBe("开一个 PR");
    expect(t!.def.parameters).toEqual({ type: "object" });
  });

  it("全部要审批 —— server 是外部代码，readOnlyHint 是它自报的，不采信", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.requiresApproval).toBe(true);
  });

  it("run 把调用转给 world.mcp.callTool，带上 serverId 与原始工具名", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "开好了" }]);
    const cap = capWith([handle()], callTool);
    const [t] = createMcpTools(cap);
    const out = await t!.run({ title: "x" }, worldWith(cap), { toolCallId: "c1" });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", { title: "x" }, undefined);
    expect(out).toBe("开好了");
  });

  it("signal 从 ctx 透下去（turn 中断要能杀掉在飞的调用）", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "ok" }]);
    const cap = capWith([handle()], callTool);
    const [t] = createMcpTools(cap);
    const ac = new AbortController();
    await t!.run({}, worldWith(cap), { toolCallId: "c1", signal: ac.signal });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", {}, ac.signal);
  });

  it("live 的 server，available() 为 true", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.available?.()).toBe(true);
  });

  it("server 掉线后 available() 转 false —— 刀还挂着，只是不进声明表", () => {
    const servers = [handle()];
    const [t] = createMcpTools(capWith(servers));
    servers[0] = handle({ live: false, status: "failed" });
    expect(t!.available?.()).toBe(false);
  });

  it("掉线时调用它，报的是人话而不是崩", async () => {
    const servers = [handle()];
    const cap = capWith(servers);
    const [t] = createMcpTools(cap);
    servers[0] = handle({ live: false, status: "failed" });
    await expect(t!.run({}, worldWith(cap), { toolCallId: "c1" })).rejects.toThrow(/github/);
  });

  it("装配时没连上的 server 不出刀 —— 没有清单就无从挂起", () => {
    const tools = createMcpTools(capWith([handle({ live: false, status: "failed", tools: [] })]));
    expect(tools).toEqual([]);
  });

  it("两台 server 各自的同名工具不撞名", () => {
    const tools = createMcpTools(capWith([
      handle({ id: "a", name: "a" }),
      handle({ id: "b", name: "b" }),
    ]));
    expect(tools.map((t) => t.def.name)).toEqual(["mcp__a__create_pr", "mcp__b__create_pr"]);
  });

  it("world 上没有 mcp 时 run 报人话（裸装配的兜底）", async () => {
    const cap = capWith([handle()]);
    const [t] = createMcpTools(cap);
    const bare: ExecutionWorld = {
      fs: { read: async () => "", write: async () => {} },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      http: { postJson: async () => ({}) },
    };
    await expect(t!.run({}, bare, { toolCallId: "c1" })).rejects.toThrow(/MCP/);
  });
});

// ── server 返回的图（#594）────────────────────────────────────────
//
// MCP 是这条链上的第一个消费者：协议里图片是 base64 字符串，本仓要的是字节。
// 解码放在工具层而不是 shared/mcp.ts —— 那一层手机端会 import 同一份源码，
// 而 Buffer 在 RN 上不存在（tests/architecture.test.ts 第 5 条）。

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

describe("server 返回图片", () => {
  it("image content → 字节挂在 images 上，output 仍然是给模型看的那段文字", async () => {
    const cap = capWith([handle()], async () => [
      { kind: "text", text: "画好了" },
      { kind: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    const out = await createMcpTools(cap)[0]!.run({}, worldWith(cap));
    expect(typeof out).toBe("object");
    if (typeof out === "string") return;
    expect(out.images).toEqual([{ data: PNG_BYTES, mimeType: "image/png" }]);
    // 模型看到的那句话要点明"用户看得见"——否则它以为这次调用什么都没产出
    expect(out.output).toContain("已显示给用户");
  });

  it("没有图时返回字符串：与从前逐字节一致", async () => {
    const cap = capWith([handle()], async () => [{ kind: "text", text: "ok" }]);
    const out = await createMcpTools(cap)[0]!.run({}, worldWith(cap));
    expect(out).toBe("ok");
  });

  it("空的/解不开的 base64 跳过，调用照常成功", async () => {
    const cap = capWith([handle()], async () => [
      { kind: "image", data: "", mimeType: "image/png" },
      { kind: "image", data: "!!!!", mimeType: "image/png" },
    ]);
    const out = await createMcpTools(cap)[0]!.run({}, worldWith(cap));
    expect(typeof out).toBe("string");
  });
});
