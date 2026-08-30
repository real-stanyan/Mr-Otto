import { describe, expect, it } from "vitest";
import type { Element, ElementContent } from "hast";

import { plainTable } from "../../src/renderer/src/lib/hastTable.js";

const text = (value: string): ElementContent => ({ type: "text", value });

const el = (tagName: string, children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

const cell = (tag: "th" | "td", ...children: ElementContent[]) => el(tag, children);

/** 一张 remark 产出的典型表：thead > tr > th，tbody > tr > td */
const table = (head: Element[], body: Element[][]) =>
  el("table", [
    el("thead", [el("tr", head)]),
    el("tbody", body.map((row) => el("tr", row))),
  ]);

describe("plainTable —— markdown 表格能不能交给 data-table", () => {
  it("全是纯文本 → 列名 + 行", () => {
    const node = table(
      [cell("th", text("型号")), cell("th", text("入")), cell("th", text("出"))],
      [
        [cell("td", text("glm-5.3")), cell("td", text("1200")), cell("td", text("340"))],
        [cell("td", text("ollama/qwen3")), cell("td", text("80")), cell("td", text("12"))],
      ],
    );
    expect(plainTable(node)).toEqual({
      columns: ["型号", "入", "出"],
      rows: [
        ["glm-5.3", "1200", "340"],
        ["ollama/qwen3", "80", "12"],
      ],
    });
  });

  it("强调标签压平 —— 丢的是语气不是内容", () => {
    const node = table(
      [cell("th", text("项"))],
      [[cell("td", el("strong", [text("必填")]))]],
    );
    expect(plainTable(node)?.rows).toEqual([["必填"]]);
  });

  it("单元格里有链接就整张作废 —— 交给它等于把可点的路径变成一行字", () => {
    const node = table(
      [cell("th", text("文件"))],
      [[cell("td", el("a", [text("src/main/index.ts")]))]],
    );
    expect(plainTable(node)).toBeNull();
  });

  it("行内代码同理 —— 等宽本身就是信息", () => {
    const node = table(
      [cell("th", text("参数"))],
      [[cell("td", el("code", [text("--force")]))]],
    );
    expect(plainTable(node)).toBeNull();
  });

  it("只有表头、还没流出行 → null（半张表不画卡）", () => {
    expect(plainTable(table([cell("th", text("列"))], []))).toBeNull();
  });

  it("没有表头 → null（对不上列）", () => {
    const node = el("table", [el("tbody", [el("tr", [cell("td", text("a"))])])]);
    expect(plainTable(node)).toBeNull();
  });

  it("tr 直接挂在 table 下（手写 HTML）也认", () => {
    const node = el("table", [
      el("tr", [cell("th", text("A"))]),
      el("tr", [cell("td", text("1"))]),
    ]);
    expect(plainTable(node)).toEqual({ columns: ["A"], rows: [["1"]] });
  });

  it("没有 node 就没有表", () => {
    expect(plainTable(undefined)).toBeNull();
  });
});
