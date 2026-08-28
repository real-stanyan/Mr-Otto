import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

  it("url / stdio args 模板里出现的占位符都在 params 里声明过", () => {
    // 也扫 stdio 的 args（#474）：filesystem 条目的 {root} 此前不被覆盖——
    // 今天没缺陷，但未来的 stdio 条目漏声明占位符不会被抓到
    for (const e of MCP_CATALOG) {
      const sources = [e.url ?? "", ...(e.args ?? [])];
      const holes = sources.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      for (const h of holes) {
        expect(e.params.map((p) => p.name), `${e.id} 的 {${h}}`).toContain(h);
      }
    }
  });

  it("按 id 精确命中", () => {
    expect(searchCatalog("supabase").map((e) => e.id)).toContain("supabase");
  });

  it("按名字/描述模糊命中，大小写无关", () => {
    // length > 0 断不出命中的是谁（#474）——命中一堆无关条目也绿
    expect(searchCatalog("SUPABASE").map((e) => e.id)).toContain("supabase");
  });

  it("查不到就是空数组，不抛", () => {
    expect(searchCatalog("绝无此物xyzzy")).toEqual([]);
  });

  it("空查询返回全部——agent 想看看有哪些", () => {
    expect(searchCatalog("")).toHaveLength(MCP_CATALOG.length);
  });

  it("填了 icon 的条目，资源文件必须真的在", () => {
    // icon 是资源键不是 URL（见 CatalogEntry.icon 的注释）。填了键却没放文件，
    // UI 上是一个静默的空白格——这类失败不会自己冒头，只能靠断言抓
    const dir = join(__dirname, "..", "..", "src", "renderer", "src", "assets", "mcp");
    for (const e of MCP_CATALOG) {
      if (e.icon === undefined) continue;
      expect(existsSync(join(dir, `${e.icon}.svg`)), `${e.id} 的图标`).toBe(true);
    }
  });
});
