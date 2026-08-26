import { describe, it, expect } from "vitest";
import { mcpCatalogTool } from "../../src/tools/mcpCatalog.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("mcp_catalog 工具", () => {
  it("免审批——只读一份仓内常量，没有副作用", () => {
    expect(mcpCatalogTool.requiresApproval).toBe(false);
  });

  // 这条曾经是 deferred（"十几条目录不该占初始工具表的位置"），终审 A 判定
  // 那是这条链路唯一的致命失败模式：三把刀全 deferred 时模型初始看不见任何
  // 一把，而 tool_search 是纯子串打分，搜"supabase"命中不了 mcp_catalog——
  // 代码全对、功能仍然为零。省下的那点工具表体积不值这个价
  it("direct——它是这条链路的入口，必须在初始工具表里", () => {
    expect(mcpCatalogTool.exposure).toBe("direct");
  });

  it("description 里点了常见服务名，tool_search 那条路也能命中", () => {
    const d = mcpCatalogTool.def.description;
    for (const name of ["supabase", "github", "notion", "linear", "sentry", "stripe"]) {
      expect(d).toContain(name);
    }
  });

  it("命中时把后半段链条点名，模型才知道 deferred 的那两把存在", async () => {
    const out = String(await mcpCatalogTool.run({ query: "supabase" }, world));
    expect(out).toContain("mcp_configure");
    expect(out).toContain("mcp_authorize");
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
