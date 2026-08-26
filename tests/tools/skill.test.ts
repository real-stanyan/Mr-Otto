import { describe, expect, it } from "vitest";
import { composeSkillIndex, createSkillTool, knownSkillToolName } from "../../src/tools/skill.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const W = {} as ExecutionWorld;

function harness(
  skills = [
    { name: "tdd", description: "先写测试再写实现", content: "TDD 正文" },
    { name: "caveman", description: "极简回话风格", content: "CAVEMAN 正文" },
  ]
) {
  const invoked: { name: string; content: string; args?: string }[] = [];
  const released: string[] = [];
  const active = new Map<string, { source?: "user" | "model" }>();
  const tool = createSkillTool({
    listSkills: () => skills,
    activeSkills: () => active,
    appendInvoked: (name, content, args) => {
      invoked.push({ name, content, ...(args !== undefined ? { args } : {}) });
      active.set(name, { source: "model" });
    },
    appendReleased: (name) => {
      released.push(name);
      active.delete(name);
    },
  });
  return { tool, invoked, released, active };
}

describe("skill 工具", () => {
  it("description 里带索引：每把 skill 一行 name — description", () => {
    const { tool } = harness();
    expect(tool.def.description).toContain("tdd — 先写测试再写实现");
    expect(tool.def.description).toContain("caveman — 极简回话风格");
  });

  // ADR-0122 §一「动态拼」：def 是 getter,每次读都重扫。写成对象字面量里的
  // 一次求值的话,description 在 createSkillTool 那一刻就冻住——而 app 自带
  // 「导入 skill」弹窗,会话开着的时候导入一把,模型的索引里永远没有它
  it("索引是活的：会话中途装的 skill,下一次读 def 就出现在索引里", () => {
    const skills = [{ name: "tdd", description: "先写测试再写实现", content: "TDD 正文" }];
    const { tool } = harness(skills);
    expect(tool.def.description).not.toContain("刚导入的");

    skills.push({ name: "刚导入的", description: "会话中途装进来的", content: "正文" });
    expect(tool.def.description).toContain("刚导入的 — 会话中途装进来的");
  });

  // 零 skill 起步那条最难看的路：available() 翻成 true 的同一刻,索引也得跟上,
  // 否则模型拿到一把 description 以光秃秃的「可用 skill：」结尾的工具
  it("零 skill 起步：装上第一把之后,available 和索引同时变活", () => {
    const skills: { name: string; description: string; content: string }[] = [];
    const { tool } = harness(skills);
    expect(tool.available?.()).toBe(false);
    expect(tool.def.description.trimEnd().endsWith("可用 skill：")).toBe(true);

    skills.push({ name: "第一把", description: "刚装的", content: "正文" });
    expect(tool.available?.()).toBe(true);
    expect(tool.def.description).toContain("第一把 — 刚装的");
  });

  it("一把 skill 都没装时不出这把刀", () => {
    const { tool } = harness([]);
    expect(tool.available?.()).toBe(false);
  });

  it("acquire：落事件、回执不含正文（正文走事件，不走 tool_result）", async () => {
    const { tool, invoked } = harness();
    const out = await tool.run({ action: "acquire", name: "tdd" }, W);
    expect(invoked).toEqual([{ name: "tdd", content: "TDD 正文" }]);
    expect(String(out)).toContain("已启用");
    expect(String(out)).not.toContain("TDD 正文");
  });

  it("acquire 带参数：args 跟着进事件", async () => {
    const { tool, invoked } = harness();
    await tool.run({ action: "acquire", name: "caveman", args: "ultra" }, W);
    expect(invoked[0]).toEqual({ name: "caveman", content: "CAVEMAN 正文", args: "ultra" });
  });

  it("acquire 不存在的 skill：抛错且不落事件", async () => {
    const { tool, invoked } = harness();
    await expect(tool.run({ action: "acquire", name: "nope" }, W)).rejects.toThrow(/不存在/);
    expect(invoked).toEqual([]);
  });

  it("重复 acquire 已启用的：不重复落事件（同一份说明书两遍是白烧 token）", async () => {
    const { tool, invoked } = harness();
    await tool.run({ action: "acquire", name: "tdd" }, W);
    const out = await tool.run({ action: "acquire", name: "tdd" }, W);
    expect(invoked.length).toBe(1);
    expect(String(out)).toContain("已经启用");
  });

  it("release 自己取的：落事件", async () => {
    const { tool, released } = harness();
    await tool.run({ action: "acquire", name: "tdd" }, W);
    await tool.run({ action: "release", name: "tdd" }, W);
    expect(released).toEqual(["tdd"]);
  });

  it("release 用户 $ 启用的：报错且不落事件（用户意图优先级高于模型判断）", async () => {
    const { tool, released, active } = harness();
    active.set("tdd", {}); // 缺省来源 = user
    await expect(tool.run({ action: "release", name: "tdd" }, W)).rejects.toThrow(/用户启用/);
    expect(released).toEqual([]);
  });

  it("release 没启用的：报错且不落事件", async () => {
    const { tool, released } = harness();
    await expect(tool.run({ action: "release", name: "tdd" }, W)).rejects.toThrow(/未启用/);
    expect(released).toEqual([]);
  });

  it("list：按关键词打分，命中名字或描述都算", async () => {
    const { tool } = harness();
    const out = String(await tool.run({ action: "list", query: "测试" }, W));
    expect(out).toContain("tdd");
    expect(out).not.toContain("caveman");
  });

  it("list 无命中：说清楚没命中，不返回空串", async () => {
    const { tool } = harness();
    expect(String(await tool.run({ action: "list", query: "zzz" }, W))).toContain("没有匹配");
  });

  it("非法 action / 缺 name：抛错", async () => {
    const { tool } = harness();
    await expect(tool.run({ action: "eat", name: "tdd" }, W)).rejects.toThrow();
    await expect(tool.run({ action: "acquire" }, W)).rejects.toThrow();
  });
});

describe("composeSkillIndex（索引拼装与截断）", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    name: `skill-${i}`,
    description: `第 ${i} 把的描述`,
  }));

  it("装得下就全列", () => {
    const out = composeSkillIndex(many.slice(0, 3), 8 * 1024);
    expect(out).toContain("skill-0");
    expect(out).toContain("skill-2");
    expect(out).not.toContain("未列出");
  });

  it("装不下：截断 + 说清楚还有几条、怎么找", () => {
    const out = composeSkillIndex(many, 1024);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out).toMatch(/另有 \d+ 个未列出/);
    expect(out).toContain("list");
  });
});

// R3 修复（residuals）：index.ts 的 `known`（子智能体设置页保存时拿来校验工具名的
// 那份清单）不能只信开机那一刻的 TOOL_NAMES 快照——available() 只问"此刻有没有装
// skill"，零 skill 开机时装不出这把刀，之后装了第一把、设置页却还报"工具名无法
// 识别"。knownSkillToolName 是 index.ts 里那处 known 计算抽出来的纯逻辑，
// 这里独立验证；index.ts 怎么接线（连着 scanSkills 现扫磁盘）本身要起 Electron
// 才能跑，不在这个文件的覆盖范围内
describe("knownSkillToolName（R3：known 名单不吃开机快照）", () => {
  it("零 skill：不补这个名字", () => {
    expect(knownSkillToolName(0)).toEqual([]);
  });

  it("装了至少一把：补上 \"skill\"", () => {
    expect(knownSkillToolName(1)).toEqual(["skill"]);
    expect(knownSkillToolName(5)).toEqual(["skill"]);
  });
});
