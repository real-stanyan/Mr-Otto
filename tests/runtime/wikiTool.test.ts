import { describe, expect, it } from "vitest";
import { createWikiTools, WIKI_READ_TOOL_NAME, WIKI_TOOL_NAME } from "../../services/runtime/src/wikiTool.js";
import type { WikiService } from "../../services/runtime/src/wikiService.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

function fakeService(over: Partial<WikiService> = {}) {
  const calls: unknown[] = [];
  const svc: WikiService = {
    ensure: async () => "present",
    snapshot: async () => ({ index: "", pinned: [], own: null, nudge: null }),
    invalidateSnapshot: () => {},
    read: async (paths) => { calls.push(["read", paths]); return paths.map((p) => ({ path: p, text: p === "nope.md" ? null : `内容 of ${p}`, truncated: false })); },
    search: async (q) => { calls.push(["search", q]); return q === "空" ? [] : [{ path: "a.md", line: 3, text: "命中行" }]; },
    write: async (args, author) => { calls.push(["write", args, author]); return { path: args.path, chars: 7 }; },
    remove: async (path, author) => { calls.push(["remove", path, author]); },
    check: async (author) => { calls.push(["check", author]); return "体检完成：没有发现问题。"; },
    ...over,
  };
  return { svc, calls };
}

describe("createWikiTools", () => {
  it("两把刀的形状：wiki_read 只读且 parallelSafe，wiki 写不过审批门，都 requiresApproval:false", () => {
    const [read, write] = createWikiTools({ service: fakeService().svc, agentId: "ops", agentName: () => "运营" });
    expect(read.def.name).toBe(WIKI_READ_TOOL_NAME);
    expect(read.parallelSafe).toBe(true);
    expect(read.requiresApproval).toBe(false);
    expect(write.def.name).toBe(WIKI_TOOL_NAME);
    expect(write.parallelSafe).toBeUndefined();
    expect(write.requiresApproval).toBe(false);
    expect(write.def.description).toContain("check");
  });
  it("wiki_read：paths 读页（缺页说没有这页；单个字符串也认）；query 搜索（空结果说没有匹配）；两样都没给报错", async () => {
    const { svc, calls } = fakeService();
    const [read] = createWikiTools({ service: svc, agentId: "ops", agentName: () => "运营" });
    expect(await read.run({ paths: ["a.md", "nope.md"] }, world)).toBe("### a.md\n内容 of a.md\n\n### nope.md\n（没有这页）");
    expect(await read.run({ paths: "a.md" }, world)).toContain("### a.md");
    expect(await read.run({ query: "月结" }, world)).toBe("a.md:3: 命中行");
    expect(await read.run({ query: "空" }, world)).toBe("没有匹配。换个词，或读 index.md 看有哪些页。");
    await expect(read.run({}, world)).rejects.toThrow("paths 或 query");
    expect(calls[0]).toEqual(["read", ["a.md", "nope.md"]]);
  });
  it("wiki write：content 别名 body；作者用**此刻**的名字；回「已写 …（N 字）」；remove / check 各自回执", async () => {
    let name = "运营";
    const { svc, calls } = fakeService();
    const [, wiki] = createWikiTools({ service: svc, agentId: "ops", agentName: () => name });
    expect(await wiki.run({ action: "write", path: "customers/acme.md", title: "Acme", summary: "s", body: "月结 60 天", pinned: false }, world)).toBe("已写 customers/acme.md（7 字）。");
    expect(calls[0]).toEqual(["write", { path: "customers/acme.md", title: "Acme", summary: "s", body: "月结 60 天", pinned: false, sources: undefined }, { kind: "agent", id: "ops", label: "运营" }]);
    name = "运营二号";
    expect(await wiki.run({ action: "remove", path: "customers/acme.md" }, world)).toBe("已删 customers/acme.md。");
    expect(calls[1]).toEqual(["remove", "customers/acme.md", { kind: "agent", id: "ops", label: "运营二号" }]);
    expect(await wiki.run({ action: "check" }, world)).toContain("体检完成");
    await expect(wiki.run({ action: "write", path: "x.md" }, world)).rejects.toThrow("title");
    await expect(wiki.run({ action: "bogus" }, world)).rejects.toThrow("action 只能是 write / remove / check");
  });
  it("连续失败 3 次回终态不再重试（同 memory 工具）", async () => {
    const { svc } = fakeService({ write: async () => { throw new Error("boom"); } });
    const [, wiki] = createWikiTools({ service: svc, agentId: "ops", agentName: () => "运营" });
    const args = { action: "write", path: "x.md", title: "t", summary: "", content: "c" };
    for (let i = 0; i < 3; i++) await expect(wiki.run(args, world)).rejects.toThrow("boom");
    expect(await wiki.run(args, world)).toContain("连续失败 3 次");
  });
});
