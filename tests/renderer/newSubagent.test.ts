import { describe, expect, it } from "vitest";
import { blankSubagentDef, shadowedSubagent } from "../../src/renderer/src/lib/newSubagent.js";
import { DEFAULT_SUBAGENT_TOOLS, type SubagentDef } from "../../src/shared/subagent.js";

function def(over: Partial<SubagentDef>): SubagentDef {
  return { ...blankSubagentDef("user"), name: "x", ...over };
}

describe("blankSubagentDef", () => {
  // 新建页种子和主进程 createSubagent 写出的空壳必须一字不差:用户没碰过的字段,
  // 从哪个入口建出来都该一样
  it("按缺省工具集 + 直接拒绝起手", () => {
    const d = blankSubagentDef("user");
    expect(d.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
    expect(d.approval).toBe("deny");
    expect(d.preamble).toEqual({ mode: "default" });
    expect(d.context).toEqual([]);
    expect(d.readOnly).toBe(false);
  });

  it("tools 是副本,改草稿不会污染共享常量", () => {
    const d = blankSubagentDef("user");
    d.tools.push("bash");
    expect(DEFAULT_SUBAGENT_TOOLS).not.toContain("bash");
  });

  it("path/source 留空——真地址只能来自主进程", () => {
    expect(blankSubagentDef("workspace")).toMatchObject({ path: "", source: "", scope: "workspace" });
  });
});

describe("shadowedSubagent", () => {
  const list = [def({ name: "Reviewer", scope: "user", source: "~/.mr-otto/agents" })];

  it("空名字不算撞", () => {
    expect(shadowedSubagent("   ", list)).toBeNull();
  });

  // 落地的是 macOS 文件名(APFS 大小写不敏感):reviewer 和 Reviewer 是同一个文件,
  // 分大小写查的话新建会静默覆盖掉已有那份
  it("不分大小写,也不看首尾空白", () => {
    expect(shadowedSubagent(" reviewer ", list)?.name).toBe("Reviewer");
    expect(shadowedSubagent("REVIEWER", list)?.name).toBe("Reviewer");
  });

  it("没撞上回 null", () => {
    expect(shadowedSubagent("searcher", list)).toBeNull();
  });
});
