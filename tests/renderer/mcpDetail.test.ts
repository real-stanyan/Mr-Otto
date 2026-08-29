// 连接器详情页的判断题（issue #745）。
import { describe, it, expect } from "vitest";
import {
  connectorFacts,
  endpointFact,
  paramSuffix,
  sourceNote,
  toolsNote,
  transportFact,
} from "../../src/renderer/src/lib/mcpDetail.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";

const http: CatalogEntry = {
  id: "x",
  name: "X",
  description: "说明",
  category: "开发与部署",
  transport: "http",
  url: "https://x.test/mcp",
  params: [],
  auth: "oauth",
  authNote: "点一次授权",
};

const stdio: CatalogEntry = {
  id: "y",
  name: "Y",
  description: "说明",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@a/b", "--flag", "{v}"],
  params: [],
  auth: "none",
  authNote: "",
};

describe("transportFact", () => {
  it("说的是后果不是 transport 枚举名", () => {
    // 用户在这一页要判断的是"代码跑在谁的机器上"，不是"这条是 http 还是 stdio"
    expect(transportFact(http).value).toContain("对方的机器");
    expect(transportFact(stdio).value).toContain("你的电脑");
  });
});

describe("endpointFact", () => {
  it("http 给地址，stdio 给拼回一行的启动命令", () => {
    expect(endpointFact(http)).toEqual({ label: "地址", value: "https://x.test/mcp", mono: true });
    expect(endpointFact(stdio).value).toBe("npx -y @a/b --flag {v}");
  });
});

describe("connectorFacts", () => {
  it("空值的条目不出 —— 一行「授权：（空）」比没有这行更糟", () => {
    // stdio 那条 authNote 是空串，且没有 category
    expect(connectorFacts(stdio).map((f) => f.label)).toEqual(["连接方式", "启动命令"]);
  });

  it("有分类和授权说明就都出，顺序固定", () => {
    expect(connectorFacts(http).map((f) => f.label)).toEqual([
      "连接方式",
      "地址",
      "分类",
      "授权",
    ]);
  });
});

describe("toolsNote", () => {
  it("没装不说话", () => {
    expect(toolsNote(null, undefined)).toBeNull();
  });

  it("连上了、零个工具，要说出来", () => {
    // 一片空白会被当成"还没加载完"，而"这台没有工具"是个该去查的事实
    expect(toolsNote("connected", [])).toBe("这台没有暴露任何工具");
  });

  it("连上了就报个数", () => {
    expect(toolsNote("connected", ["a", "b"])).toBe("2 个工具");
  });

  it("没连上的时候不许说「这台没有暴露任何工具」", () => {
    // #747：Sentry 装了但停在 needs-auth，工具清单当然是空的——那是关于
    // 连接的事实，不是关于这台 server 的事实。只看 length 的那一版把
    // "还没连上"讲成了"这台是空的"，跟 #722 那个撒谎的勾同一类错
    for (const status of ["needs-auth", "connecting", "failed", "disabled"] as const) {
      const note = toolsNote(status, []);
      expect(note, `${status} 的话术`).not.toBeNull();
      expect(note, `${status} 不该谈"这台有没有工具"`).not.toContain("这台没有暴露");
    }
    expect(toolsNote("needs-auth", [])).toContain("授权");
    expect(toolsNote("failed", [])).toContain("连不上");
  });
});

describe("paramSuffix / sourceNote", () => {
  it("必填选填写在标签上", () => {
    expect(paramSuffix(true)).toBe("必填");
    expect(paramSuffix(false)).toBe("选填");
  });

  it("来路说的是「从哪儿来的」，不是「这台好不好」", () => {
    expect(sourceNote(true)).toContain("人工核过");
    expect(sourceNote(false)).toContain("没有人替你核过");
  });
});
