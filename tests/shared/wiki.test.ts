import { describe, expect, it } from "vitest";
import {
  WIKI_SCHEMA_PATH, agentIdOfPage, agentPagePath, classifyWikiPath, extractWikiLinks, indexGroups,
  isRemovableWikiPath, parseIndex, parseWikiPage, renderIndex, serializeWikiPage, singleLine,
  validateWikiFields, type WikiPage,
} from "../../src/shared/wiki.js";

const page = (path: string, over: Partial<WikiPage["front"]> = {}, body = "正文"): WikiPage => ({
  path,
  front: { title: path, summary: "", pinned: false, updatedBy: "运营", updatedAt: "2026-09-09T00:00:00Z", sources: [], ...over },
  body,
});

describe("路径判据（spec §1.1）", () => {
  it.each([
    ["team.md", "page"], ["customers/acme.md", "page"], ["agents/admin.md", "page"], ["SCHEMA.md", "page"],
    ["index.md", "tool-owned"], ["log.md", "tool-owned"],
    ["a/b/c.md", "invalid"], ["../x.md", "invalid"], ["/etc/passwd", "invalid"], ["Acme.md", "invalid"],
    ["客户.md", "invalid"], ["a.txt", "invalid"], [".tmp/x.md", "invalid"], ["-a.md", "invalid"], ["", "invalid"],
  ])("%s → %s", (p, kind) => {
    expect(classifyWikiPath(p)).toBe(kind);
  });
  it("保留页：SCHEMA / team 不可删，index / log 也不可删，普通页可删", () => {
    expect(isRemovableWikiPath(WIKI_SCHEMA_PATH)).toBe(false);
    expect(isRemovableWikiPath("team.md")).toBe(false);
    expect(isRemovableWikiPath("index.md")).toBe(false);
    expect(isRemovableWikiPath("customers/acme.md")).toBe(true);
  });
  it("agents 页与 agentId 互相推得出", () => {
    expect(agentPagePath("admin")).toBe("agents/admin.md");
    expect(agentIdOfPage("agents/admin.md")).toBe("admin");
    expect(agentIdOfPage("customers/acme.md")).toBeNull();
  });
});

describe("页头（spec §1.2）：读宽写严", () => {
  it("序列化 → 解析往返逐字段相等，sources 里带逗号的项也不丢", () => {
    const p = page("customers/acme.md", { title: "Acme", summary: "华东最大客户", pinned: true, sources: ["s-9f2a#118", "/work/docs/a, b.xlsx"] }, "正文\n第二行\n");
    const text = serializeWikiPage(p);
    expect(text.startsWith("---\ntitle: Acme\n")).toBe(true);
    expect(parseWikiPage("customers/acme.md", text)).toEqual(p);
  });
  it("没有页头的文件：title 退回 slug、summary 空、其余默认；正文原样", () => {
    const p = parseWikiPage("customers/acme.md", "裸正文");
    expect(p.front).toEqual({ title: "acme", summary: "", pinned: false, updatedBy: "", updatedAt: "", sources: [] });
    expect(p.body).toBe("裸正文");
  });
  it("未知键忽略、pinned 只认字面 true", () => {
    const p = parseWikiPage("x.md", "---\ntitle: X\nfoo: bar\npinned: yes\n---\nbody");
    expect(p.front.title).toBe("X");
    expect(p.front.pinned).toBe(false);
    expect(p.body).toBe("body");
  });
  it("validateWikiFields：空标题 / 超长 / 换行 / 含 [[ 或 —— 分隔符 / summary 超长各报一句", () => {
    expect(validateWikiFields({ title: "", summary: "s" })).toContain("title");
    expect(validateWikiFields({ title: "a".repeat(81), summary: "s" })).toContain("80");
    expect(validateWikiFields({ title: "a\nb", summary: "s" })).toContain("换行");
    expect(validateWikiFields({ title: "a [[b]]", summary: "s" })).toContain("[[");
    expect(validateWikiFields({ title: "a — b", summary: "s" })).toContain("—");
    expect(validateWikiFields({ title: "ok", summary: "s".repeat(141) })).toContain("140");
    expect(validateWikiFields({ title: "ok", summary: "s", sources: ["x".repeat(201)] })).toContain("sources");
    expect(validateWikiFields({ title: "ok", summary: "一句话" })).toBeNull();
  });
  it("singleLine 折叠换行与多余空白", () => {
    expect(singleLine("  a\n\n  b\tc  ")).toBe("a b c");
  });
});

describe("链接", () => {
  it("[[path]] 与 [[path|别名]] 都认，补 .md，去重", () => {
    expect(extractWikiLinks("见 [[customers/acme]] 与 [[team|团队口径]]，再 [[customers/acme.md]]")).toEqual(["customers/acme.md", "team.md"]);
  });
});

describe("索引（spec §1.3）", () => {
  const pages = [
    page("team.md", { title: "团队口径", summary: "所有智能体都该知道的", pinned: true }),
    page("agents/admin.md", { title: "管理员", summary: "管理员的习惯" }),
    page("customers/zeta.md", { title: "Zeta", summary: "" }),
    page("customers/acme.md", { title: "Acme", summary: "华东最大客户" }),
    page("notes.md", { title: "杂记", summary: "没目录的" }),
    page("SCHEMA.md", { title: "约定", summary: "怎么用" }),
  ];
  it("分组顺序：常驻 → agents → 目录按字母 → 未分目录；组内按路径；SCHEMA 不进索引；pinned 只在常驻组出现", () => {
    const groups = indexGroups(pages);
    expect(groups.map((g) => g.name)).toEqual(["常驻", "agents", "customers", "未分目录"]);
    expect(groups[2]!.entries.map((e) => e.path)).toEqual(["customers/acme.md", "customers/zeta.md"]);
    expect(groups.flatMap((g) => g.entries).filter((e) => e.path === "team.md")).toHaveLength(1);
    expect(groups.flatMap((g) => g.entries).some((e) => e.path === "SCHEMA.md")).toBe(false);
  });
  it("渲染 → 解析是逆运算；summary 为空的行没有破折号", () => {
    const text = renderIndex(pages);
    expect(text).toContain("# 索引");
    expect(text).toContain("- [[customers/acme]] Acme — 华东最大客户");
    expect(text).toContain("- [[customers/zeta]] Zeta\n");
    expect(parseIndex(text)).toEqual(indexGroups(pages));
  });
  it("宽读进来的标题里含「 — 」时折成 en dash，渲染 → 解析仍然互逆", () => {
    const p = [page("q.md", { title: "Q — A", summary: "one" })];
    const text = renderIndex(p);
    expect(text).toContain("- [[q]] Q – A — one");
    expect(parseIndex(text)).toEqual([{ name: "未分目录", entries: [{ path: "q.md", title: "Q – A", summary: "one", pinned: false }] }]);
  });
});
