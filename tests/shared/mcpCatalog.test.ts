import { describe, it, expect } from "vitest";
import { MCP_CATALOG, searchCatalog } from "../../src/shared/mcpCatalog.js";

describe("mcpCatalog", () => {
  it("id 唯一", () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("http 的条目必须有 url，stdio 的必须有 command", () => {
    for (const e of MCP_CATALOG) {
      if (e.transport === "http") expect(e.url, e.id).toBeTruthy();
      else expect(e.command, e.id).toBeTruthy();
    }
  });

  it("url 模板里出现的占位符都在 params 里声明过", () => {
    for (const e of MCP_CATALOG) {
      const holes = [...(e.url ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const h of holes) {
        expect(e.params.map((p) => p.name), `${e.id} 的 {${h}}`).toContain(h);
      }
    }
  });

  it("按 id 精确命中", () => {
    expect(searchCatalog("supabase").map((e) => e.id)).toContain("supabase");
  });

  it("按名字/描述模糊命中，大小写无关", () => {
    expect(searchCatalog("SUPABASE").length).toBeGreaterThan(0);
  });

  it("查不到就是空数组，不抛", () => {
    expect(searchCatalog("绝无此物xyzzy")).toEqual([]);
  });

  it("空查询返回全部——agent 想看看有哪些", () => {
    expect(searchCatalog("")).toHaveLength(MCP_CATALOG.length);
  });
});
