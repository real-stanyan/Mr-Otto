import { describe, it, expect, vi } from "vitest";
import { createMcpReadResourceTool } from "../../src/tools/mcpReadResource.js";
import type { ExecutionWorld, McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";

function handle(resources: McpServerHandle["resources"]): McpServerHandle {
  return { id: "fs", name: "fs", status: "connected", live: true, tools: [], resources, prompts: [] };
}

function capWith(
  servers: McpServerHandle[],
  readResource: McpCapability["readResource"] = async () => [{ kind: "text", text: "料" }]
): McpCapability {
  return {
    ready: async () => {},
    servers: () => servers,
    callTool: async () => [],
    readResource,
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

const RES = [{ uri: "file:///a.txt", name: "A", description: "第一份" }];

describe("mcp_read_resource", () => {
  it("不审批 —— 纯读，照 browser_read / web_extract", () => {
    expect(createMcpReadResourceTool(capWith([handle(RES)])).requiresApproval).toBe(false);
  });

  it("可读清单进 description，模型才知道有什么可读", () => {
    const t = createMcpReadResourceTool(capWith([handle(RES)]));
    expect(t.def.description).toContain("file:///a.txt");
    expect(t.def.description).toContain("第一份");
  });

  it("一台 resource 都没有时 available() 为 false —— 不给模型一把没用的刀", () => {
    expect(createMcpReadResourceTool(capWith([handle([])])).available?.()).toBe(false);
  });

  it("有 resource 时 available() 为 true", () => {
    expect(createMcpReadResourceTool(capWith([handle(RES)])).available?.()).toBe(true);
  });

  it("清单超上限时截断，并明说截了", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ uri: `file:///f${i}`, name: `F${i}` }));
    const t = createMcpReadResourceTool(capWith([handle(many)]));
    expect(t.def.description).toContain("还有");
    expect(t.def.description).not.toContain("file:///f199");
  });

  it("run 把 server + uri 转给 world.mcp.readResource", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "正文" }]);
    const cap = capWith([handle(RES)], readResource);
    const t = createMcpReadResourceTool(cap);
    const out = await t.run({ server: "fs", uri: "file:///a.txt" }, worldWith(cap), { toolCallId: "c" });
    expect(readResource).toHaveBeenCalledWith("fs", "file:///a.txt", undefined);
    expect(out).toBe("正文");
  });

  it("signal 透传", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "x" }]);
    const cap = capWith([handle(RES)], readResource);
    const ac = new AbortController();
    await createMcpReadResourceTool(cap).run(
      { server: "fs", uri: "file:///a.txt" }, worldWith(cap), { toolCallId: "c", signal: ac.signal }
    );
    expect(readResource).toHaveBeenCalledWith("fs", "file:///a.txt", ac.signal);
  });

  it("认不得的 server 名报人话，并列出认得哪些", async () => {
    const cap = capWith([handle(RES)]);
    await expect(
      createMcpReadResourceTool(cap).run({ server: "nope", uri: "x" }, worldWith(cap), { toolCallId: "c" })
    ).rejects.toThrow(/fs/);
  });

  it("参数缺 uri 时报人话，不是 undefined 一路传下去", async () => {
    const cap = capWith([handle(RES)]);
    await expect(
      createMcpReadResourceTool(cap).run({ server: "fs" }, worldWith(cap), { toolCallId: "c" })
    ).rejects.toThrow(/uri/);
  });

  it("同时缺 uri 和 server 不存在时，uri 检查优先", async () => {
    const cap = capWith([handle(RES)]);
    await expect(
      createMcpReadResourceTool(cap).run({ server: "nope" }, worldWith(cap), { toolCallId: "c" })
    ).rejects.toThrow(/uri/);
  });
});
