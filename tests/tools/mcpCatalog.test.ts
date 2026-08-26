import { describe, it, expect } from "vitest";
import { mcpCatalogTool } from "../../src/tools/mcpCatalog.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("mcp_catalog 工具", () => {
  it("免审批——只读一份仓内常量，没有副作用", () => {
    expect(mcpCatalogTool.requiresApproval).toBe(false);
  });

  it("deferred——十几条目录不该占初始工具表的位置", () => {
    expect(mcpCatalogTool.exposure).toBe("deferred");
  });

  it("命中时返回可直接照着填的字段", async () => {
    const out = await mcpCatalogTool.run({ query: "supabase" }, world);
    expect(String(out)).toContain("mcp.supabase.com");
    expect(String(out)).toContain("project_ref");
  });

  it("查不到时明说去搜，而不是回一句空", async () => {
    const out = await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, world);
    expect(String(out)).toMatch(/没有|web_search/);
  });

  it("参数不是对象也不炸", async () => {
    await expect(mcpCatalogTool.run(null, world)).resolves.toBeTruthy();
  });
});
