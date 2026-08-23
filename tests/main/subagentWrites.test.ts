// 两个写盘动作的测试（issue #146）。它们**会往用户磁盘写文件**，出错的代价是
// 用户的文件而不是一次报错，而抽出 subagentWrites.ts 之前它们长在 createWindow
// 的闭包里，被任何测试覆盖的部分是零。
//
// 这里断言的是不变量，不是实现细节：落点只认信任侧的清单、作用域参与查找、
// 只读拒绝、名字校验、同槽查重、前置词上限。

import { describe, expect, it } from "vitest";
import {
  createSubagentDef,
  saveSubagentDef,
  type SubagentWriteDeps,
} from "../../src/main/subagentWrites.js";
import { CONTEXT_DOC_LIMIT } from "../../src/main/subagentPrompt.js";
import type { SubagentRoot } from "../../src/main/subagents.js";
import type { SubagentDef } from "../../src/shared/subagent.js";

const USER_ROOT: SubagentRoot = { root: "/home/u/.mr-otto/agents", readOnly: false, scope: "user" };
const WS_ROOT: SubagentRoot = { root: "/w/.mr-otto/agents", readOnly: false, scope: "workspace" };

function def(over: Partial<SubagentDef> & { name: string }): SubagentDef {
  return {
    description: "",
    instructions: "",
    tools: ["read_file"],
    unknownTools: [],
    approval: "deny",
    preamble: { mode: "default" },
    context: [],
    scope: "user",
    path: `${USER_ROOT.root}/${over.name}.md`,
    source: USER_ROOT.root,
    readOnly: false,
    ...over,
  };
}

/** 假依赖：写盘只记账，清单按作用域给不同的答案 */
function harness(opts: {
  byScope?: Record<string, SubagentDef[]>;
  taken?: boolean;
  trustedThrows?: boolean;
} = {}) {
  const written: SubagentDef[] = [];
  const deps: SubagentWriteDeps = {
    listSubagents: (ws) => opts.byScope?.[ws ?? "user"] ?? [],
    trustedForWrite: (ws) => {
      if (opts.trustedThrows) throw new Error("不认识这个工作区");
      return typeof ws === "string" && ws !== "" ? ws : null;
    },
    roots: (ws) => (ws ? [WS_ROOT, USER_ROOT] : [USER_ROOT]),
    slotTaken: () => opts.taken ?? false,
    write: (d) => void written.push(d),
    join: (dir, file) => `${dir}/${file}`,
  };
  return { deps, written };
}

describe("saveSubagentDef", () => {
  it("落地地址来自信任侧的清单，不采信渲染层传来的 path / readOnly / scope", () => {
    const found = def({ name: "reviewer", path: "/w/.mr-otto/agents/reviewer.md", scope: "workspace", source: WS_ROOT.root });
    const { deps, written } = harness({ byScope: { "/w": [found] } });
    // 渲染层送来一份指向别处、还自称可写的定义
    const incoming = def({ name: "reviewer", path: "/etc/passwd", scope: "user", source: "/somewhere", description: "改过了" });
    saveSubagentDef(deps, incoming, "/w");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      path: "/w/.mr-otto/agents/reviewer.md",
      scope: "workspace",
      source: WS_ROOT.root,
      description: "改过了", // 内容照收，只有落地坐标从信任侧来
    });
  });

  it("作用域参与查找：工作区里改的那份不会写穿到同名的用户级那份上", () => {
    const userOne = def({ name: "reviewer", path: "/home/u/.mr-otto/agents/reviewer.md" });
    const wsOne = def({ name: "reviewer", path: "/w/.mr-otto/agents/reviewer.md", scope: "workspace", source: WS_ROOT.root });
    const { deps, written } = harness({ byScope: { user: [userOne], "/w": [wsOne] } });
    saveSubagentDef(deps, def({ name: "reviewer" }), "/w");
    expect(written[0]!.path).toBe("/w/.mr-otto/agents/reviewer.md");
  });

  it("清单里没有 = 抛错，不凭空建一份", () => {
    const { deps, written } = harness();
    expect(() => saveSubagentDef(deps, def({ name: "nobody" }), null)).toThrow(/没有名叫/);
    expect(written).toHaveLength(0);
  });

  it("只读的（内置 / .claude 来的）拒绝保存", () => {
    const found = def({ name: "searcher", readOnly: true, source: "内置" });
    const { deps, written } = harness({ byScope: { user: [found] } });
    expect(() => saveSubagentDef(deps, def({ name: "searcher" }), null)).toThrow(/只读/);
    expect(written).toHaveLength(0);
  });

  it("认不出的工作区 = 当场抛，一个字节都不写", () => {
    const { deps, written } = harness({ trustedThrows: true });
    expect(() => saveSubagentDef(deps, def({ name: "reviewer" }), "/不认识")).toThrow(/工作区/);
    expect(written).toHaveLength(0);
  });

  it("行内前置词有上限：超了抛错，且拦在清单查找之前", () => {
    const found = def({ name: "reviewer" });
    const { deps, written } = harness({ byScope: { user: [found] } });
    const tooLong = def({ name: "reviewer", preamble: { mode: "custom", text: "x".repeat(CONTEXT_DOC_LIMIT + 1) } });
    expect(() => saveSubagentDef(deps, tooLong, null)).toThrow(/前置词太长/);
    expect(written).toHaveLength(0);
    // 刚好卡在上限上放行
    const exact = def({ name: "reviewer", preamble: { mode: "custom", text: "x".repeat(CONTEXT_DOC_LIMIT) } });
    saveSubagentDef(deps, exact, null);
    expect(written).toHaveLength(1);
  });
});

describe("createSubagentDef", () => {
  it("建在当前作用域可写的第一条根里，带缺省 frontmatter", () => {
    const { deps, written } = harness();
    createSubagentDef(deps, "demo-agent", "/w");
    expect(written[0]).toMatchObject({
      name: "demo-agent",
      path: "/w/.mr-otto/agents/demo-agent.md",
      scope: "workspace",
      approval: "deny",
      readOnly: false,
    });
    expect(written[0]!.tools.length).toBeGreaterThan(0);
  });

  it("名字两头的空白先剥掉再校验、再落盘", () => {
    const { deps, written } = harness();
    createSubagentDef(deps, "  demo-agent  ", null);
    expect(written[0]!.name).toBe("demo-agent");
    expect(written[0]!.path).toBe("/home/u/.mr-otto/agents/demo-agent.md");
  });

  it("非 ASCII / 空名字 = 抛错，不落文件（否则会写出一个 ---.md）", () => {
    const { deps, written } = harness();
    expect(() => createSubagentDef(deps, "搜索员", null)).toThrow();
    expect(() => createSubagentDef(deps, "   ", null)).toThrow();
    expect(written).toHaveLength(0);
  });

  it("落点那一层已经占了 = 抛错", () => {
    const { deps, written } = harness({ taken: true });
    expect(() => createSubagentDef(deps, "reviewer", null)).toThrow(/换个名字/);
    expect(written).toHaveLength(0);
  });

  it("认不出的工作区 = 当场抛，一个字节都不写", () => {
    const { deps, written } = harness({ trustedThrows: true });
    expect(() => createSubagentDef(deps, "demo-agent", "/不认识")).toThrow(/工作区/);
    expect(written).toHaveLength(0);
  });
});
