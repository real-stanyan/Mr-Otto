import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_CATEGORIES, MCP_CATALOG, searchCatalog } from "../../src/shared/mcpCatalog.js";

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

  it("精选层每一条都得有图标——色块兜底是长尾层的待遇（issue #715）", () => {
    // ADR-0171 第四节：精选层用打进包的本地 SVG，长尾层才一律首字母色块。
    // #661 落地时 19 条只放了 9 个图标文件，剩下 10 条静默走了长尾层的兜底——
    // 没有任何报错，只是"有一半卡片没有 logo"。新加条目忘了配图会在这里红。
    const missing = MCP_CATALOG.filter((e) => e.icon === undefined).map((e) => e.id);
    expect(
      missing,
      `这些精选条目没有 icon，会退化成首字母色块：${missing.join("、")}。` +
        "放一个 src/renderer/src/assets/mcp/<key>.svg 并把 key 填进 icon"
    ).toEqual([]);
  });

  it("填了 icon 的条目，资源文件必须真的在", () => {
    // icon 是资源键不是 URL（见 CatalogEntry.icon 的注释）。填了键却没放文件，
    // UI 上是一个静默的空白格——这类失败不会自己冒头，只能靠断言抓。
    // svg 或 png 都算：有一批牌子根本不发 SVG 标（#725，见 McpDirectory 的 iconUrl）
    const dir = join(__dirname, "..", "..", "src", "renderer", "src", "assets", "mcp");
    for (const e of MCP_CATALOG) {
      if (e.icon === undefined) continue;
      const found =
        existsSync(join(dir, `${e.icon}.svg`)) || existsSync(join(dir, `${e.icon}.png`));
      expect(found, `${e.id} 的图标`).toBe(true);
    }
  });

  it("用到的分类全在 CATALOG_CATEGORIES 里 —— 漏一个，那一段整段不出现", () => {
    // 联合类型和那个有序数组是两份东西：给联合加一个分类、忘了往数组里加，
    // tsc 全绿，而 groupByCategory 是照数组遍历的——那一整段条目在界面上
    // 直接消失，没有任何报错（#725）
    const listed = new Set<string>(CATALOG_CATEGORIES);
    const orphan = [...new Set(MCP_CATALOG.map((e) => e.category))].filter((c) => !listed.has(c));
    expect(orphan, "这些分类没写进 CATALOG_CATEGORIES，整段不会出现在目录页").toEqual([]);
  });

  it("每条都有分类 —— 没分类就掉出所有分段", () => {
    const missing = MCP_CATALOG.filter((e) => e.category === undefined).map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it("「连不上」这件事只能写进 blocked，不能写进 authNote（#760）", () => {
    // 这就是 #760 本体：结论写对了，但写进了一个只在未核验条目的确认框里
    // 才露面的字段，于是一个用户都没看见，界面照发「授权」按钮。
    // authNote 说的是"要授权的话该干什么"，blocked 说的是"现在干不成，因为…"——
    // 后者是 installSlot 唯一读得懂的那个
    const wrong = MCP_CATALOG.filter((e) => /连不上|接不上/.test(e.authNote)).map((e) => e.id);
    expect(
      wrong,
      `这些条目把"接不上"写进了 authNote：${wrong.join("、")}。搬进 blocked 字段，` +
        "界面才会据此收起那颗必然失败的按钮"
    ).toEqual([]);
  });

  it("blocked 写了就得有内容 —— 空串等于把按钮收了却不说为什么", () => {
    for (const e of MCP_CATALOG) {
      if (e.blocked === undefined) continue;
      expect(e.blocked.trim().length, `${e.id} 的 blocked`).toBeGreaterThan(10);
    }
  });

  it("此刻一条 blocked 都没有 —— 有的话是笔明账，不是默认状态（#766）", () => {
    // 机制留着（ADR-0190），使用者暂时归零：GitHub 改走 token 就能连，
    // Asana / Figma 确认没有不经 OAuth 的路，删了。
    // 这条不是在禁止 blocked——是让"目录里躺着一台接不上的"必须有人**改红了
    // 才能进来**，顺手把 #766 的判断（是真没路，还是只试了 OAuth 那一条）
    // 逼到那一刻去做
    const blocked = MCP_CATALOG.filter((e) => e.blocked !== undefined).map((e) => e.id);
    expect(
      blocked,
      `这些条目标着接不上：${blocked.join("、")}。` +
        "先确认不是只试了 OAuth 那一条路（#766 就是这么错过 GitHub 的 token 路的）；" +
        "确实没路就删掉条目，要留就改这条断言并说明为什么留"
    ).toEqual([]);
  });
});
