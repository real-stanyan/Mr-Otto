// 切文本节点这一步的守卫:切歪了的表现是正文少字或多字,而那是在渲染结果里,
// 类型和 e2e 都不一定抓得到。

import { describe, expect, it } from "vitest";
import { rehypeFileRefs, splitTextRefs } from "../../src/renderer/src/lib/rehypeFileRefs.js";
import type { Root } from "hast";

const text = (n: unknown): string =>
  typeof n === "object" && n !== null && "children" in (n as Root)
    ? ((n as Root).children as unknown[]).map(text).join("")
    : ((n as { value?: string }).value ?? "");

describe("splitTextRefs", () => {
  it("没命中返回 null(原节点留着)", () => {
    expect(splitTextRefs("普通一句话")).toBeNull();
  });

  it("命中的那段换成带标记的 span,前后文字一字不差", () => {
    const out = splitTextRefs("看 src/a.ts:3 这行")!;
    expect(out.map(text).join("")).toBe("看 src/a.ts:3 这行");
    const span = out[1] as { properties: Record<string, unknown> };
    expect(span.properties["dataFileRef"]).toBe("src/a.ts");
    expect(span.properties["dataFileLine"]).toBe("3");
  });

  it("没行号就不写 dataFileLine", () => {
    const out = splitTextRefs("见 src/a.ts 里")!;
    const span = out[1] as { properties: Record<string, unknown> };
    expect(span.properties["dataFileLine"]).toBeUndefined();
  });
});

describe("rehypeFileRefs", () => {
  const run = (tree: Root): Root => {
    rehypeFileRefs()(tree);
    return tree;
  };

  it("代码块里的路径不动", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element", tagName: "pre", properties: {},
          children: [{ type: "text", value: "import x from 'src/a.ts:3'" }],
        },
      ],
    };
    const pre = run(tree).children[0] as { children: unknown[] };
    expect(pre.children).toHaveLength(1);
    expect((pre.children[0] as { type: string }).type).toBe("text");
  });

  it("链接里的路径不动(不套两层可点的东西)", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element", tagName: "a", properties: { href: "src/a.ts" },
          children: [{ type: "text", value: "src/a.ts:3" }],
        },
      ],
    };
    const a = run(tree).children[0] as { children: unknown[] };
    expect((a.children[0] as { type: string }).type).toBe("text");
  });

  it("行内代码里的路径要认(模型常写成 `src/a.ts:3`)", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element", tagName: "code", properties: {},
          children: [{ type: "text", value: "src/a.ts:3" }],
        },
      ],
    };
    const code = run(tree).children[0] as { children: { properties?: Record<string, unknown> }[] };
    expect(code.children[0]?.properties?.["dataFileRef"]).toBe("src/a.ts");
  });

  it("跑两遍不套娃", () => {
    const tree: Root = {
      type: "root",
      children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "src/a.ts:3" }] }],
    };
    run(tree);
    run(tree);
    const p = run(tree).children[0] as { children: { children?: unknown[] }[] };
    expect(p.children).toHaveLength(1);
    expect(p.children[0]?.children).toHaveLength(1);
  });
});
