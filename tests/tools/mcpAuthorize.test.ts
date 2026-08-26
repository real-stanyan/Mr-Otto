import { describe, it, expect, vi } from "vitest";
import { createMcpAuthorizeTool } from "../../src/tools/mcpAuthorize.js";
import type { McpCapability, ExecutionWorld } from "../../src/world/executionWorld.js";

function cap(over: Partial<McpCapability> = {}): McpCapability {
  return {
    ready: async () => {}, servers: () => [], callTool: async () => [],
    readResource: async () => [], getPrompt: async () => "",
    configure: async () => {}, authorize: vi.fn(async () => {}), configOf: () => undefined,
    ...over,
  } as McpCapability;
}
const world = (mcp: McpCapability) => ({ mcp }) as ExecutionWorld;

describe("mcp_authorize", () => {
  it("免审批——浏览器必然弹出、用户必须亲手点同意，人天然在环里", () => {
    expect(createMcpAuthorizeTool(cap()).requiresApproval).toBe(false);
  });

  it("调 capability 的 authorize", async () => {
    const c = cap();
    await createMcpAuthorizeTool(c).run({ id: "supabase" }, world(c));
    expect(c.authorize).toHaveBeenCalledWith("supabase");
  });

  it("成功后回报这台现在有哪些工具", async () => {
    const c = cap({
      servers: () => [{ id: "s", name: "s", status: "connected", live: true,
        tools: [{ name: "list_tables", description: "", inputSchema: {} }], resources: [], prompts: [] }],
    });
    const out = await createMcpAuthorizeTool(c).run({ id: "s" }, world(c));
    expect(String(out)).toContain("list_tables");
  });

  it("授权失败把原因转述给模型，让它能告诉用户下一步", async () => {
    const c = cap({ authorize: vi.fn(async () => { throw new Error("等授权超时（300 秒没等到浏览器回调）"); }) });
    await expect(createMcpAuthorizeTool(c).run({ id: "s" }, world(c))).rejects.toThrow(/超时/);
  });

  it("id 不是字符串 → 人话", async () => {
    const c = cap();
    await expect(createMcpAuthorizeTool(c).run({}, world(c))).rejects.toThrow(/id/);
  });
});
