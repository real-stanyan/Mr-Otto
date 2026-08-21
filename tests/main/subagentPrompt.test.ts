import { describe, expect, it } from "vitest";
import {
  CONTEXT_DOC_LIMIT,
  composeSubagentPrompt,
  readContextDocs,
  readGlobalPreamble,
} from "../../src/main/subagentPrompt.js";
import { DEFAULT_PREAMBLE, type SubagentDef } from "../../src/shared/subagent.js";

const base: SubagentDef = {
  name: "a",
  description: "d",
  instructions: "正文",
  tools: ["read_file"],
  unknownTools: [],
  approval: "deny",
  preamble: { mode: "default" },
  context: [],
  scope: "user",
  path: "/r/a.md",
  source: "/r",
  readOnly: false,
};

describe("composeSubagentPrompt", () => {
  it("default = 用全局那段", () => {
    const out = composeSubagentPrompt({ def: base, globalPreamble: "全局", docs: [] });
    expect(out).toBe("全局\n\n正文");
  });

  it("off = 一段前置词都不加", () => {
    const def = { ...base, preamble: { mode: "off" } as const };
    expect(composeSubagentPrompt({ def, globalPreamble: "全局", docs: [] })).toBe("正文");
  });

  it("custom 覆盖全局，不是追加", () => {
    const def = { ...base, preamble: { mode: "custom", text: "只输出 JSON" } as const };
    const out = composeSubagentPrompt({ def, globalPreamble: "全局", docs: [] });
    expect(out).toBe("只输出 JSON\n\n正文");
    expect(out).not.toContain("全局");
  });

  it("文档夹在前置词和正文中间，各自带标题", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "全局",
      docs: [{ file: "AGENTS.md", text: "规矩", truncated: false }],
    });
    expect(out).toBe("全局\n\n## 工作区文档：AGENTS.md\n\n规矩\n\n正文");
  });

  it("截断这件事写进正文,不藏", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "",
      docs: [{ file: "AGENTS.md", text: "长", truncated: true }],
    });
    expect(out).toContain("（本文件过长，已截断）");
  });
});

describe("readGlobalPreamble", () => {
  it("文件不在 = 内置默认", () => {
    expect(readGlobalPreamble("/p", { readFile: () => null })).toBe(DEFAULT_PREAMBLE);
  });

  it("空白文件 = 内置默认（存了个空文件不等于要空前置词）", () => {
    expect(readGlobalPreamble("/p", { readFile: () => "  \n\n " })).toBe(DEFAULT_PREAMBLE);
  });

  it("有内容就用它", () => {
    expect(readGlobalPreamble("/p", { readFile: () => "我的\n" })).toBe("我的");
  });
});

describe("readContextDocs", () => {
  it("读不到就跳过,不报错", () => {
    expect(readContextDocs("/w", ["AGENTS.md"], { readFile: () => null })).toEqual([]);
  });

  it("运行时再挡一次 basename——解析时挡过了,这里是第二道", () => {
    const seen: string[] = [];
    const docs = readContextDocs("/w", ["../../etc/passwd", "a/b"], {
      readFile: (p) => {
        seen.push(p);
        return "内容";
      },
    });
    expect(docs).toEqual([]);
    expect(seen).toEqual([]); // 一次盘都没读
  });

  it("超长截断并打标记", () => {
    const long = "x".repeat(CONTEXT_DOC_LIMIT + 10);
    const docs = readContextDocs("/w", ["AGENTS.md"], { readFile: () => long });
    expect(docs[0]?.truncated).toBe(true);
    expect(docs[0]?.text).toHaveLength(CONTEXT_DOC_LIMIT);
  });
});
