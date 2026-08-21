import { describe, expect, it } from "vitest";
import {
  CONTEXT_DOCS_BUDGET,
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
      docs: [{ file: "AGENTS.md", text: "规矩", truncated: false, skipped: false }],
    });
    expect(out).toBe("全局\n\n## 工作区文档：AGENTS.md\n\n规矩\n\n正文");
  });

  it("截断这件事写进正文,不藏", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "",
      docs: [{ file: "AGENTS.md", text: "长", truncated: true, skipped: false }],
    });
    expect(out).toContain("（本文件过长，已截断）");
  });

  it("整份没注入的也写进正文——静默少一份文档正是要修的毛病", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "",
      docs: [{ file: "CLAUDE.md", text: "", truncated: false, skipped: true }],
    });
    expect(out).toContain("## 工作区文档：CLAUDE.md");
    expect(out).toContain("（工作区文档总量已超上限，本文件未注入）");
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

  it("空白文件跳过,不拼出一个只有标题的空段落", () => {
    expect(readContextDocs("/w", ["AGENTS.md"], { readFile: () => "  \n\n " })).toEqual([]);
  });

  it("超长截断并打标记", () => {
    const long = "x".repeat(CONTEXT_DOC_LIMIT + 10);
    const docs = readContextDocs("/w", ["AGENTS.md"], { readFile: () => long });
    expect(docs[0]?.truncated).toBe(true);
    expect(docs[0]?.text).toHaveLength(CONTEXT_DOC_LIMIT);
  });

  it("总预算封顶:多份加起来不超 CONTEXT_DOCS_BUDGET,被削的那份打截断标记", () => {
    const long = "x".repeat(CONTEXT_DOC_LIMIT);
    const files = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md"];
    const docs = readContextDocs("/w", files, { readFile: () => long });
    const total = docs.reduce((n, d) => n + d.text.length, 0);
    expect(total).toBe(CONTEXT_DOCS_BUDGET);
    // 前两份把 128 KB 吃满,第三份一个字都放不下
    expect(docs[0]?.truncated).toBe(false);
    expect(docs[1]?.truncated).toBe(false);
    expect(docs[2]?.skipped).toBe(true);
  });

  it("预算见底后不再读盘,但每一份声明过的文档都留一条 skipped 记录", () => {
    const seen: string[] = [];
    const long = "y".repeat(CONTEXT_DOCS_BUDGET + 1);
    const docs = readContextDocs("/w", ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md"], {
      readFile: (p) => {
        seen.push(p);
        return long;
      },
    });
    // 前两份各被单份上限削到 64 KB,加起来正好花光预算;后两份一次盘都没读
    expect(seen).toEqual(["/w/AGENTS.md", "/w/CLAUDE.md"]);
    expect(docs.map((d) => d.file)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CONTEXT.md",
      "README.md",
    ]);
    expect(docs[2]).toEqual({ file: "CONTEXT.md", text: "", truncated: false, skipped: true });
    expect(docs[3]?.skipped).toBe(true);
  });

  it("卡在预算边界上的那份被削一半,标记的是「截断」不是「未注入」", () => {
    const texts: Record<string, string> = {
      "/w/AGENTS.md": "a".repeat(CONTEXT_DOC_LIMIT),
      "/w/CLAUDE.md": "b".repeat(CONTEXT_DOC_LIMIT),
      "/w/CONTEXT.md": "c".repeat(5000),
    };
    // 先把预算花掉 64 KB + 63 KB,留 1 KB 给第三份
    texts["/w/CLAUDE.md"] = "b".repeat(CONTEXT_DOC_LIMIT - 1024);
    const docs = readContextDocs("/w", ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"], {
      readFile: (p) => texts[p] ?? null,
    });
    expect(docs[2]?.skipped).toBe(false);
    expect(docs[2]?.truncated).toBe(true);
    expect(docs[2]?.text).toHaveLength(1024);
  });
});
