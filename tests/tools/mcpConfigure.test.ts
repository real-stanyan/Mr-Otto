import { describe, it, expect, vi } from "vitest";
import { createMcpConfigureTool } from "../../src/tools/mcpConfigure.js";
import type { McpCapability } from "../../src/world/executionWorld.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function cap(over: Partial<McpCapability> = {}): McpCapability {
  return {
    ready: async () => {},
    servers: () => [],
    callTool: async () => [],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: vi.fn(async () => {}),
    authorize: async () => {},
    configOf: () => undefined,
    ...over,
  } as McpCapability;
}
const world = (mcp: McpCapability) => ({ mcp }) as ExecutionWorld;

describe("mcp_configure", () => {
  it("必须过审批门——这是这条路上唯一的安全闸", () => {
    expect(createMcpConfigureTool(cap()).requiresApproval).toBe(true);
  });

  it("绝不是 parallelSafe（写盘 + 重连，有副作用）", () => {
    expect(createMcpConfigureTool(cap()).parallelSafe).not.toBe(true);
  });

  it("http：把 url 交给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "supabase", kind: "http", url: "https://mcp.supabase.com/mcp" },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("supabase", {
      kind: "http", url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true,
    });
  });

  it("stdio：command + args + env 一起过去", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("fs", {
      kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, enabled: true,
    });
  });

  it("remove：传 null 给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run({ id: "s", action: "remove" }, world(c));
    expect(c.configure).toHaveBeenCalledWith("s", null);
  });

  it("id 缺失/不是字符串 → 抛人话，不把垃圾写进配置", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ kind: "http", url: "https://x" }, world(c)))
      .rejects.toThrow(/id/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  it("http 少了 url → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http" }, world(c)))
      .rejects.toThrow(/url/);
  });

  it("stdio 少了 command → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "stdio" }, world(c)))
      .rejects.toThrow(/command/);
  });

  it("url 不是 http/https → 拒绝（file:// 之类没有意义，且是个惊喜面）", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: "file:///etc/passwd" }, world(c)))
      .rejects.toThrow(/http/);
  });

  it("world 没有 mcp 能力时给人话", async () => {
    await expect(createMcpConfigureTool(cap()).run({ id: "s", action: "remove" }, {} as ExecutionWorld))
      .rejects.toThrow(/MCP/);
  });
});
