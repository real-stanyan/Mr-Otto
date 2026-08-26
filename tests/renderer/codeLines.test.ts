// 切行的守卫。切错的表现是行号和内容对不上——而"跳到第 386 行"整件事,
// 全押在这个对应关系上。

import { describe, expect, it } from "vitest";
import { splitLines, wrapLines } from "../../src/renderer/src/lib/codeLines.js";
import type { Element, ElementContent } from "hast";

const t = (value: string): ElementContent => ({ type: "text", value });
const el = (...children: ElementContent[]): ElementContent => ({
  type: "element", tagName: "span", properties: { className: ["hljs-comment"] }, children,
});
const flat = (nodes: readonly ElementContent[]): string =>
  nodes.map((n) => (n.type === "text" ? n.value : n.type === "element" ? flat(n.children as ElementContent[]) : "")).join("");

describe("splitLines", () => {
  it("纯文本按 \\n 切", () => {
    expect(splitLines([t("a\nb\nc")]).map(flat)).toEqual(["a", "b", "c"]);
  });

  it("跨行的元素每行各留一个副本(块注释不会只有第一行是灰的)", () => {
    const lines = splitLines([t("x"), el(t("/* one\ntwo */")), t("y")]);
    expect(lines.map(flat)).toEqual(["x/* one", "two */y"]);
    expect((lines[1]?.[0] as Element).properties?.["className"]).toEqual(["hljs-comment"]);
  });

  it("空行保留(行号才不会串)", () => {
    expect(splitLines([t("a\n\nb")]).map(flat)).toEqual(["a", "", "b"]);
  });

  it("文件末尾的换行不算一行", () => {
    expect(splitLines([t("a\nb\n")]).map(flat)).toEqual(["a", "b"]);
  });
});

describe("wrapLines", () => {
  it("行号从 1 开始,写在 data-line 上", () => {
    const out = wrapLines([t("a\nb")]);
    expect(out.map((n) => n.properties?.["dataLine"])).toEqual(["1", "2"]);
    expect(out.map((n) => flat(n.children as ElementContent[]))).toEqual(["a", "b"]);
  });
});
