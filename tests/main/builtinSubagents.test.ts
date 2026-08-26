import { describe, expect, it } from "vitest";
import { BUILTIN_SOURCE, builtinSubagents, withBuiltins } from "../../src/main/builtinSubagents.js";
import type { SubagentDef } from "../../src/shared/subagent.js";
import { DEFAULT_MODEL } from "../../src/shared/modelCatalog.js";

const ALL = [
  "read_file",
  "write_file",
  "bash",
  "web_search",
  "web_extract",
  "browser_read",
  "todo_write",
];

function onDisk(name: string): SubagentDef {
  return {
    name,
    description: "",
    instructions: "",
    tools: ["read_file"],
    unknownTools: [],
    approval: "deny",
    preamble: { mode: "default" },
    context: [],
    scope: "user",
    path: `/a/${name}.md`,
    source: "/a",
    readOnly: false,
  };
}

describe("builtinSubagents", () => {
  // ADR-0108：不写 model 的含义从"兜底默认"变成了"跟着父会话走"，所以内置这三份
  // 必须显式钉档——不钉的话贵档会话里随手派一个 Explore，账单量级就变了
  it("三份都显式钉了型号：便宜是写出来的选择，不是没人做过选择", () => {
    for (const d of builtinSubagents([...ALL, "memory"])) {
      expect(d.model).toBe(DEFAULT_MODEL);
    }
  });

  it("三份，都标 builtin + readOnly，没有磁盘路径", () => {
    const b = builtinSubagents([...ALL, "memory"]);
    expect(b.map((d) => d.name)).toEqual(["general-purpose", "Explore", "memory-reviewer"]);
    expect(b.every((d) => d.builtin === true && d.readOnly && d.path === "")).toBe(true);
    expect(b.every((d) => d.source === BUILTIN_SOURCE)).toBe(true);
  });

  it("审批档是 inherit —— 跟父会话此刻那一档走", () => {
    expect(builtinSubagents(ALL).every((d) => d.approval === "inherit")).toBe(true);
  });

  it("Explore 拿不到 bash 和 write_file", () => {
    const explore = builtinSubagents(ALL).find((d) => d.name === "Explore")!;
    expect(explore.tools).not.toContain("bash");
    expect(explore.tools).not.toContain("write_file");
  });

  // ADR-0110 D9：子会话自己也拿得到说明书。这份白名单就是 allowTools，
  // 不点名 = 挂不上，所以漏了它 general-purpose 连 skill 工具的影子都见不到
  it("general-purpose 拿得到 skill —— 装配认得这个名字的前提下", () => {
    const gp = builtinSubagents([...ALL, "skill"]).find((d) => d.name === "general-purpose")!;
    expect(gp.tools).toContain("skill");
    // 一把 skill 都没装的机器上 skill ∉ knownTools，过滤掉而不是记成"不认识"
    const bare = builtinSubagents(ALL).find((d) => d.name === "general-purpose")!;
    expect(bare.tools).not.toContain("skill");
    expect(bare.unknownTools).toEqual([]);
  });

  // task 是设计边界(子 agent 不能再派子 agent),内置也不例外
  it("谁都拿不到 task", () => {
    expect(builtinSubagents([...ALL, "task"]).some((d) => d.tools.includes("task"))).toBe(false);
  });

  // 这个装配挂不上的工具过滤掉,不记成 unknownTools:那个徽章是说"你的文件里有个
  // 名字我不认识",而内置的文件不是用户写的,让他去修一份他改不了的东西没意义
  it("装配里没有的工具过滤掉，不进 unknownTools", () => {
    const b = builtinSubagents(["read_file"]);
    expect(b.every((d) => d.tools.every((t) => t === "read_file"))).toBe(true);
    expect(b.every((d) => d.unknownTools.length === 0)).toBe(true);
  });

  it("memory-reviewer：只带 memory 工具；装配里没有 memory 时过滤成空", () => {
    const withMem = builtinSubagents(["read_file", "memory"]).find((d) => d.name === "memory-reviewer")!;
    expect(withMem.tools).toEqual(["memory"]);
    const without = builtinSubagents(["read_file"]).find((d) => d.name === "memory-reviewer")!;
    expect(without.tools).toEqual([]);
  });
});

describe("withBuiltins", () => {
  it("磁盘上没有时补进来", () => {
    expect(withBuiltins([], ALL).map((d) => d.name).sort()).toEqual(
      ["Explore", "general-purpose", "memory-reviewer"].sort()
    );
  });

  // materialize 的落地方式:改了模型就在可写根写出一份同名 .md,从此看到的是自己那份
  it("同名的磁盘定义盖住内置那份", () => {
    const got = withBuiltins([onDisk("general-purpose")], ALL);
    const gp = got.filter((d) => d.name === "general-purpose");
    expect(gp).toHaveLength(1);
    expect(gp[0]!.builtin).toBeUndefined();
    expect(gp[0]!.path).toBe("/a/general-purpose.md");
  });

  // 落地的是 macOS 文件名,APFS 大小写不敏感:Explore 和 explore 是同一个文件
  it("盖不盖不分大小写", () => {
    const got = withBuiltins([onDisk("explore")], ALL);
    expect(got.filter((d) => d.name.toLowerCase() === "explore")).toHaveLength(1);
  });

  // 内置是身份不是状态:配了模型的内置仍留在设置页的「内置」栏,靠这个标记认
  it("盖住内置的磁盘定义标 overridesBuiltin，别的磁盘定义不标", () => {
    const got = withBuiltins([onDisk("general-purpose"), onDisk("my-own")], ALL);
    expect(got.find((d) => d.name === "general-purpose")!.overridesBuiltin).toBe(true);
    expect(got.find((d) => d.name === "my-own")!.overridesBuiltin).toBeUndefined();
    // 大小写不敏感这条对标记同样成立
    expect(withBuiltins([onDisk("explore")], ALL).find((d) => d.name === "explore")!.overridesBuiltin).toBe(true);
  });
});
