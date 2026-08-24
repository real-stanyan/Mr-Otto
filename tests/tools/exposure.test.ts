import { describe, expect, it } from "vitest";
import {
  applyExposurePolicy,
  DEFAULT_DEFER_THRESHOLD,
} from "../../src/tools/exposure.js";
import { createToolSearchTool, type DeferredToolInfo } from "../../src/tools/toolSearch.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

// ToolExposure 三态 + MCP 延迟暴露（issue #348）。

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const tool = (name: string, description = "", extra: Partial<Tool> = {}): Tool => ({
  def: { name, description, parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run: async () => "ok",
  ...extra,
});

describe("applyExposurePolicy", () => {
  it("数量未超阈值：全部 direct；超阈值：整批 deferred", () => {
    const few = applyExposurePolicy([tool("a"), tool("b")]);
    expect(few.every((t) => t.exposure === "direct")).toBe(true);

    const many = applyExposurePolicy(
      Array.from({ length: DEFAULT_DEFER_THRESHOLD + 1 }, (_, i) => tool(`t${i}`))
    );
    expect(many.every((t) => t.exposure === "deferred")).toBe(true);
  });

  it("单工具超 8KB 降 hidden（不报错）；总量烧完后面的降 hidden", () => {
    const fat = tool("fat", "x".repeat(9 * 1024));
    const out = applyExposurePolicy([tool("slim"), fat]);
    expect(out.find((t) => t.def.name === "fat")!.exposure).toBe("hidden");
    expect(out.find((t) => t.def.name === "slim")!.exposure).toBe("direct");

    // 每把约 5KB，64KB 总预算只装得下前 12 把左右
    const bulk = Array.from({ length: 20 }, (_, i) => tool(`t${i}`, "y".repeat(5 * 1024)));
    const budgeted = applyExposurePolicy(bulk);
    expect(budgeted.some((t) => t.exposure === "hidden")).toBe(true);
    expect(budgeted[0]!.exposure).not.toBe("hidden"); // 预算按序烧：前面的活着
  });

  it("显式标过 exposure 的不覆盖（策略只填空）", () => {
    const marked = tool("secret", "", { exposure: "hidden" });
    const out = applyExposurePolicy([marked, tool("open")]);
    expect(out.find((t) => t.def.name === "secret")!.exposure).toBe("hidden");
    expect(out.find((t) => t.def.name === "open")!.exposure).toBe("direct");
  });
});

describe("createToolSearchTool", () => {
  const deferred: DeferredToolInfo[] = [
    { name: "mcp__gh__create_pr", description: "在 GitHub 建 PR" },
    { name: "mcp__gh__list_issues", description: "列 GitHub issue" },
    { name: "mcp__slack__send", description: "发 Slack 消息" },
  ];

  it("命中即曝光：搜到的名字进共享可见集；没命中不动", async () => {
    const exposed = new Set<string>();
    const search = createToolSearchTool(() => deferred.filter((d) => !exposed.has(d.name)), exposed);

    const out = (await search.run({ query: "github pr" }, fakeWorld)) as string;
    expect(out).toContain("mcp__gh__create_pr");
    expect(exposed.has("mcp__gh__create_pr")).toBe(true);
    expect(exposed.has("mcp__slack__send")).toBe(false);

    expect(await search.run({ query: "不存在的东西xyz" }, fakeWorld)).toContain("没有匹配");
  });

  it("deferred 清单空 = 这把刀自己也不可见（available false）", () => {
    const search = createToolSearchTool(() => [], new Set());
    expect(search.available!()).toBe(false);
  });

  it("空 query 拒绝", async () => {
    const search = createToolSearchTool(() => deferred, new Set());
    await expect(search.run({ query: "  " }, fakeWorld)).rejects.toThrow(/query/);
  });
});
