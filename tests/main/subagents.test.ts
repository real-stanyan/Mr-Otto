import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  parseSubagentMd,
  scanSubagents,
  type SubagentDirReader,
} from "../../src/main/subagents.js";
import { DEFAULT_SUBAGENT_TOOLS } from "../../src/shared/subagent.js";

const KNOWN = ["read_file", "write_file", "bash", "web_search", "web_extract", "todo_write", "ask_user", "browser_read"];

const base = { fallbackName: "fallback", knownTools: KNOWN, path: "/p/x.md", source: "/p", readOnly: false };

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
    { root: otter, readOnly: false },
    { root: claude, readOnly: true },
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
