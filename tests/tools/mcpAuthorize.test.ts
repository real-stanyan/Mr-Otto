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
    expect(createMcpAuthorizeTool().requiresApproval).toBe(false);
  });

  it("调 capability 的 authorize", async () => {
    const c = cap();
    await createMcpAuthorizeTool().run({ id: "supabase" }, world(c));
    expect(c.authorize).toHaveBeenCalledWith("supabase");
  });

  it("成功后回报这台现在有哪些工具", async () => {
    const c = cap({
      servers: () => [{ id: "s", name: "s", status: "connected", live: true,
        tools: [{ name: "list_tables", description: "", inputSchema: {} }], resources: [], prompts: [] }],
    });
    const out = await createMcpAuthorizeTool().run({ id: "s" }, world(c));
    expect(String(out)).toContain("list_tables");
  });

  // 终审 B Important：新工具要到下一个 turn 才进模型的工具表
  // （engine.rebuildTools()），这一轮照着"可用工具 N 个"直接调会命中"未知
  // 工具"，逃生舱 tool_search 也不通（listDeferred 闭包捕获的是这一轮的
  // list）。断关键子串不断整句——否则改一次文案就脆
  it("成功文案说「这一轮就能用」，别再把用户支去发下一条消息（#750）", async () => {
    const c = cap({
      servers: () => [{ id: "s", name: "s", status: "connected", live: true,
        tools: [{ name: "list_tables", description: "", inputSchema: {} }], resources: [], prompts: [] }],
    });
    const out = String(await createMcpAuthorizeTool().run({ id: "s" }, world(c)));
    expect(out).toContain("这一轮就能用");
    expect(out).not.toContain("下一条消息");
  });

  it("授权失败把原因转述给模型，让它能告诉用户下一步", async () => {
    const c = cap({ authorize: vi.fn(async () => { throw new Error("等授权超时（300 秒没等到浏览器回调）"); }) });
    await expect(createMcpAuthorizeTool().run({ id: "s" }, world(c))).rejects.toThrow(/超时/);
  });

  it("id 不是字符串 → 人话", async () => {
    const c = cap();
    await expect(createMcpAuthorizeTool().run({}, world(c))).rejects.toThrow(/id/);
  });
});
