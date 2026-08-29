import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  parseSubagentMd,
  scanSubagents,
  serializeSubagent,
  subagentRoots,
  subagentSlotTaken,
  trustedWorkspace,
  trustedWorkspaceForWrite,
  type SubagentDirReader,
} from "../../src/main/subagents.js";
import { DEFAULT_SUBAGENT_TOOLS, isSafeContextFile } from "../../src/shared/subagent.js";

const KNOWN = ["read_file", "write_file", "bash", "web_search", "web_extract", "todo_write", "ask_user", "browser_read"];

const base = {
  fallbackName: "fallback",
  knownTools: KNOWN,
  path: "/p/x.md",
  source: "/p",
  readOnly: false,
  scope: "user" as const,
};

describe("parseSubagentMd", () => {
  it("全字段齐备时逐个读出来", () => {
    const def = parseSubagentMd(
      `---
name: searcher
description: 只读搜索员
tools: read_file, web_search
model: deepseek-chat
thinking: off
approval: deny
---
你是一个只读搜索员。`,
      base
    );
    expect(def).toEqual({
      name: "searcher",
      description: "只读搜索员",
      instructions: "你是一个只读搜索员。",
      tools: ["read_file", "web_search"],
      unknownTools: [],
      model: "deepseek-chat",
      thinking: "off",
      approval: "deny",
      preamble: { mode: "default" },
      context: [],
      scope: "user",
      path: "/p/x.md",
      source: "/p",
      readOnly: false,
    });
  });

  it("没有 frontmatter = 不是 subagent（返回 null）", () => {
    expect(parseSubagentMd("# 只有正文", base)).toBeNull();
  });

  it("name 缺席退回文件名；tools 缺席给只读那几把；approval 缺席是 deny", () => {
    const def = parseSubagentMd("---\ndescription: 无名氏\n---\n正文", base);
    expect(def?.name).toBe("fallback");
    expect(def?.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
    expect(def?.approval).toBe("deny");
    expect(def?.model).toBeUndefined();
    expect(def?.thinking).toBeUndefined();
  });

  it("认不出的工具名丢进 unknownTools，不让整个 subagent 报废", () => {
    const def = parseSubagentMd("---\nname: a\ntools: read_file, Grep, Glob\n---\n正文", base);
    expect(def?.tools).toEqual(["read_file"]);
    expect(def?.unknownTools).toEqual(["Grep", "Glob"]);
  });

  it("task 出现在 tools 里 = 丢弃（子 agent 不能再派子 agent）", () => {
    const def = parseSubagentMd("---\nname: a\ntools: read_file, task\n---\n正文", base);
    expect(def?.tools).toEqual(["read_file"]);
    expect(def?.unknownTools).toEqual([]);
  });

  it("工具名全认不出时退回缺省，而不是零工具", () => {
    const def = parseSubagentMd("---\nname: a\ntools: Read, Grep\n---\n正文", base);
    expect(def?.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
    expect(def?.unknownTools).toEqual(["Read", "Grep"]);
  });

  it("skills: none 读出来；其它值（含 inherit）= 缺席 = 继承（ADR-0068）", () => {
    const none = parseSubagentMd("---\nname: a\nskills: none\n---\n正文", base);
    expect(none?.skills).toBe("none");
    const inherit = parseSubagentMd("---\nname: a\nskills: inherit\n---\n正文", base);
    expect(inherit && "skills" in inherit).toBe(false);
    const garbage = parseSubagentMd("---\nname: a\nskills: 全都要\n---\n正文", base);
    expect(garbage && "skills" in garbage).toBe(false);
  });

  it("非法 approval / thinking 值当缺席处理，不炸", () => {
    const def = parseSubagentMd("---\nname: a\napproval: 随便\nthinking: 超猛\n---\n正文", base);
    expect(def?.approval).toBe("deny");
    expect(def?.thinking).toBeUndefined();
  });

  it("CRLF 换行也认", () => {
    const def = parseSubagentMd("---\r\nname: a\r\n---\r\n正文", base);
    expect(def?.name).toBe("a");
    expect(def?.instructions).toBe("正文");
  });
});

describe("scanSubagents", () => {
  const otter = "/roots/otter";
  const claude = "/roots/claude";
  const roots = [
    { root: otter, readOnly: false, scope: "user" as const },
    { root: claude, readOnly: true, scope: "user" as const },
  ];

  function fakeReader(
    files: Record<string, string[]>,
    contents: Record<string, string>
  ): SubagentDirReader {
    return {
      listFiles: (root) => files[root] ?? [],
      readFile: (path) => contents[path] ?? null,
    };
  }

  it("根目录不存在 = 空列表，不炸", () => {
    expect(scanSubagents(roots, KNOWN, fakeReader({}, {}))).toEqual([]);
  });

  it("同名先到先得——原生目录排前面 = 覆盖优先", () => {
    const defs = scanSubagents(
      roots,
      KNOWN,
      fakeReader(
        { [otter]: ["a.md"], [claude]: ["a.md"] },
        {
          [join(otter, "a.md")]: "---\nname: a\ndescription: 原生\n---\n正文",
          [join(claude, "a.md")]: "---\nname: a\ndescription: 兼容\n---\n正文",
        }
      )
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]?.description).toBe("原生");
    expect(defs[0]?.readOnly).toBe(false);
  });

  it("~/.claude/agents 扫来的标 readOnly", () => {
    const defs = scanSubagents(
      roots,
      KNOWN,
      fakeReader({ [claude]: ["b.md"] }, { [join(claude, "b.md")]: "---\nname: b\n---\n正文" })
    );
    expect(defs[0]?.readOnly).toBe(true);
  });

  it("没有 frontmatter 的 .md 不是 subagent，跳过", () => {
    const defs = scanSubagents(
      roots,
      KNOWN,
      fakeReader({ [otter]: ["c.md"] }, { [join(otter, "c.md")]: "# 随手记" })
    );
    expect(defs).toEqual([]);
  });

  it("按名字排序（设置页列表要稳定）", () => {
    const defs = scanSubagents(
      roots,
      KNOWN,
      fakeReader(
        { [otter]: ["z.md", "a.md"] },
        {
          [join(otter, "z.md")]: "---\nname: zed\n---\n正文",
          [join(otter, "a.md")]: "---\nname: alpha\n---\n正文",
        }
      )
    );
    expect(defs.map((d) => d.name)).toEqual(["alpha", "zed"]);
  });
});

describe("preamble 块标量", () => {
  const parse = (text: string) =>
    parseSubagentMd(text, {
      fallbackName: "x",
      knownTools: ["read_file"],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("不写 preamble = 用全局", () => {
    const def = parse("---\nname: a\ndescription: d\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "default" });
  });

  it("preamble: off = 一段都不加", () => {
    const def = parse("---\nname: a\npreamble: off\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "off" });
  });

  it("块标量吃掉缩进更深的连续行，并去掉公共缩进", () => {
    const def = parse("---\nname: a\npreamble: |\n  第一行\n  第二行\napproval: ask\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "第一行\n第二行" });
    // 块结束后的键照常解析，不被块吞掉
    expect(def?.approval).toBe("ask");
  });

  it("块中间的空行留在内容里", () => {
    const def = parse("---\nname: a\npreamble: |\n  上\n\n  下\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "上\n\n下" });
  });

  it("空块退回默认——写了个 | 却什么都没写，不该变成空前置词", () => {
    const def = parse("---\nname: a\npreamble: |\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "default" });
  });

  it("块首的空行不是内容——留着它,设置页会把一个没人碰过的行判成有未保存改动", () => {
    const def = parse("---\nname: a\npreamble: |\n\n  正文\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "正文" });
  });

  it("块标量写的 off 是内容,不是保留字——否则用户存的自定义前置词被静默改成「关闭」", () => {
    const def = parse("---\nname: a\npreamble: |\n  off\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "off" });
  });
});

describe("context 只收 basename", () => {
  const parse = (ctx: string) =>
    parseSubagentMd(`---\nname: a\ncontext: ${ctx}\n---\n正文`, {
      fallbackName: "x",
      knownTools: [],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("留下正常文件名", () => {
    expect(parse("AGENTS.md, CLAUDE.md")?.context).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("带路径分隔符的一律丢掉——定义文件不能是任意文件读取原语", () => {
    expect(parse("../../etc/passwd, /etc/passwd, a/b, ..")?.context).toEqual([]);
  });

  it("带逗号的一律丢掉——context 是逗号分隔的列表，逗号会破坏往返", () => {
    expect(isSafeContextFile("a,b")).toBe(false);
  });

  it("不写 context = 空数组", () => {
    const def = parseSubagentMd("---\nname: a\n---\n正文", {
      fallbackName: "x",
      knownTools: [],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "workspace",
    });
    expect(def?.context).toEqual([]);
    expect(def?.scope).toBe("workspace");
  });
});

describe("序列化往返", () => {
  const parse = (text: string) =>
    parseSubagentMd(text, {
      fallbackName: "x",
      knownTools: ["read_file", "bash"],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("parse ∘ serialize ∘ parse 与 parse 同结果（块标量的公共缩进不是内容）", () => {
    const src =
      "---\nname: a\ndescription: d\ntools: read_file, bash\napproval: ask\n" +
      "context: AGENTS.md\npreamble: |\n  第一行\n  第二行\n---\n\n正文\n";
    const once = parse(src);
    expect(once).not.toBeNull();
    const twice = parse(serializeSubagent(once!));
    expect(twice).toEqual(once);
  });

  it("preamble 为 default 时整行不写", () => {
    const def = parse("---\nname: a\ndescription: d\ntools: read_file\n---\n正文")!;
    expect(serializeSubagent(def)).not.toContain("preamble:");
  });

  it("custom 内容正好是 off 时,往返不改语义", () => {
    const once = parse(
      "---\nname: a\ndescription: d\ntools: read_file\npreamble: |\n  off\n---\n正文"
    )!;
    expect(once.preamble).toEqual({ mode: "custom", text: "off" });
    expect(parse(serializeSubagent(once))).toEqual(once);
  });
});

describe("subagentRoots", () => {
  // 第一个参数自 ADR-0186 起是**解析好的用户配置目录**（账号抽屉），不是 home ——
  // 用户级的定义跟着账号走，不再是 `<home>/.mr-otto/`
  const USER_CONFIG = "/home/u/.mr-otto/accounts/deadbeefdeadbeef";

  it("有工作区时两条，工作区排在用户前面（同名先到先得 = 工作区盖用户）", () => {
    expect(subagentRoots(USER_CONFIG, "/work/proj")).toEqual([
      { root: "/work/proj/.mr-otto/agents", readOnly: false, scope: "workspace" },
      { root: `${USER_CONFIG}/agents`, readOnly: false, scope: "user" },
    ]);
  });

  it("用户那条根不再自己拼 .mr-otto —— 拼在 accountScope 那一层（ADR-0186）", () => {
    const user = subagentRoots("/anywhere", null)[0];
    expect(user?.root).toBe("/anywhere/agents");
  });

  it("不扫 .claude/agents(ADR-0056)", () => {
    expect(subagentRoots(USER_CONFIG, "/work/proj").some((r) => r.root.includes(".claude"))).toBe(false);
  });

  it("没有工作区就只有用户那一条", () => {
    expect(subagentRoots(USER_CONFIG, null).map((r) => r.scope)).toEqual(["user"]);
  });
});

describe("scanSubagents 的覆盖顺序", () => {
  it("同名时工作区那份赢，且 scope 跟着赢的那条根走", () => {
    const files: Record<string, string[]> = {
      "/work/.mr-otto/agents": ["r.md"],
      "/home/agents": ["r.md"],
    };
    const reader = {
      listFiles: (root: string) => files[root] ?? [],
      readFile: (path: string) =>
        path.startsWith("/work")
          ? "---\nname: r\ndescription: 工作区那份\n---\n正文"
          : "---\nname: r\ndescription: 用户那份\n---\n正文",
    };
    const defs = scanSubagents(subagentRoots("/home", "/work"), ["read_file"], reader);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.description).toBe("工作区那份");
    expect(defs[0]?.scope).toBe("workspace");
  });
});

describe("trustedWorkspace（读路径）", () => {
  const known = ["/work/proj", null];

  it("在名单里的原样放行", () => {
    expect(trustedWorkspace("/work/proj", known)).toBe("/work/proj");
  });

  it("不在名单里的降级成用户级——读只决定界面看哪一层,降级是无害的", () => {
    expect(trustedWorkspace("/Users/victim/Desktop", known)).toBeNull();
  });

  it("空串、非字符串、null 一律降级", () => {
    expect(trustedWorkspace("", known)).toBeNull();
    expect(trustedWorkspace(null, known)).toBeNull();
    expect(trustedWorkspace(42, known)).toBeNull();
    expect(trustedWorkspace({ toString: () => "/work/proj" }, known)).toBeNull();
  });
});

describe("trustedWorkspaceForWrite（写路径）", () => {
  const known = ["/work/proj", null];

  it("在名单里的原样放行", () => {
    expect(trustedWorkspaceForWrite("/work/proj", known)).toBe("/work/proj");
  });

  it("不在名单里的**抛**,不降级——降级 = 对话框说建在 W,文件落进 ~/.mr-otto/agents", () => {
    expect(() => trustedWorkspaceForWrite("/Users/victim/Desktop", known)).toThrow(/不认识这个工作区/);
  });

  it("null 和空串仍然是合法的「用户级」,不抛", () => {
    expect(trustedWorkspaceForWrite(null, known)).toBeNull();
    expect(trustedWorkspaceForWrite("", known)).toBeNull();
  });

  it("压根不是字符串的也抛——那是渲染层出了 bug,不该悄悄当成用户级", () => {
    expect(() => trustedWorkspaceForWrite(42, known)).toThrow(/必须是一个路径字符串/);
    expect(() => trustedWorkspaceForWrite({ toString: () => "/work/proj" }, known)).toThrow();
  });
});

describe("subagentSlotTaken", () => {
  const wsRoot = { root: "/w/.mr-otto/agents", readOnly: false, scope: "workspace" as const };
  const md = (name: string) => `---\nname: ${name}\ndescription: d\n---\n正文\n`;

  const readerFor = (files: Record<string, string>): SubagentDirReader => ({
    listFiles: (root) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${root}/`))
        .map((p) => p.slice(root.length + 1)),
    readFile: (p) => files[p] ?? null,
  });

  it("落点空着 = 没占——哪怕用户级有个同名的:盖住用户级正是覆盖规则的用法", () => {
    const reader = readerFor({
      "/home/.mr-otto/agents/reviewer.md": md("reviewer"),
      "/w/.mr-otto/agents/other.md": md("other"),
    });
    expect(subagentSlotTaken(wsRoot, "reviewer", KNOWN, reader)).toBe(false);
  });

  it("大小写不同也算占了——APFS 大小写不敏感,不这么判就是一次无声的覆盖", () => {
    const reader: SubagentDirReader = {
      listFiles: (r) => (r === wsRoot.root ? ["Reviewer.md"] : []),
      readFile: () => md("Reviewer"),
    };
    expect(subagentSlotTaken(wsRoot, "reviewer", KNOWN, reader)).toBe(true);
  });

  it("同一层已经有同名的 = 占了", () => {
    const reader = readerFor({ "/w/.mr-otto/agents/reviewer.md": md("reviewer") });
    expect(subagentSlotTaken(wsRoot, "reviewer", KNOWN, reader)).toBe(true);
  });

  it("文件名对得上但没 frontmatter 也算占了——覆盖上去等于抹掉别人的文件", () => {
    const reader = readerFor({ "/w/.mr-otto/agents/reviewer.md": "只是一篇随手记的笔记\n" });
    expect(subagentSlotTaken(wsRoot, "reviewer", KNOWN, reader)).toBe(true);
  });

  it("文件名和 name: 不一致时撞的是名字,不是路径", () => {
    const reader = readerFor({ "/w/.mr-otto/agents/foo.md": md("reviewer") });
    expect(subagentSlotTaken(wsRoot, "reviewer", KNOWN, reader)).toBe(true);
    expect(subagentSlotTaken(wsRoot, "bar", KNOWN, reader)).toBe(false);
  });
});
