import { describe, expect, it } from "vitest";
import { subagentScopeOptions } from "../../src/renderer/src/lib/subagentScopes.js";
import type { SessionSummary } from "../../src/shared/shellBridge.js";

const s = (workspace: string | null, lastTs: number): SessionSummary =>
  ({ workspace, lastTs, spawnedFrom: null }) as unknown as SessionSummary;

describe("subagentScopeOptions", () => {
  it("第一项永远是「用户」", () => {
    expect(subagentScopeOptions([])[0]).toEqual({ workspace: null, label: "用户" });
  });

  it("工作区按最近用过排在后面,短名取路径末段", () => {
    const opts = subagentScopeOptions([s("/a/proj-x", 2), s("/a/proj-y", 5)]);
    expect(opts.slice(1)).toEqual([
      { workspace: "/a/proj-y", label: "proj-y" },
      { workspace: "/a/proj-x", label: "proj-x" },
    ]);
  });

  it("同一个工作区只出现一次", () => {
    expect(subagentScopeOptions([s("/a/p", 1), s("/a/p", 9)])).toHaveLength(2);
  });

  it("没有工作区的史前会话不入选", () => {
    expect(subagentScopeOptions([s(null, 1)])).toHaveLength(1);
  });
});
