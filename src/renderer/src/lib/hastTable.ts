// markdown 表格 → 纯文本矩阵。给 markdown-text 的 table 渲染器用:
// 认得出这张表"全是纯文本"时，才把它交给 elements/data-table 那张卡。
//
// 为什么要这道判断:data-table 吃的是字符串，单元格里的链接、行内代码、粗体
// 到它手上只剩字面文字 —— 一张写着文件路径（本仓的路径是 markdown 链接）
// 的表会当场失去全部可点性。宁可这一张退回原生 <table>，也不能默默把内容降级。
//
// 输入是 hast（streamdown 交给 components.table 的 node），不是 DOM ——
// streamdown 导出的 extractTableDataFromElement 收的是 HTMLElement，
// 渲染期还没有 DOM 可读，用不上。

import type { Element, RootContent } from "hast";

/** 允许出现在单元格里、且丢掉标签也不丢信息的行内标签。
    em/strong 只是强调，转成纯文本损失的是语气不是内容；
    a / code / img 不在此列 —— 它们的信息就在标签上（地址、等宽、图） */
const FLATTENABLE = new Set(["em", "strong", "span", "p", "del", "sup", "sub"]);

const isElement = (n: RootContent): n is Element => n.type === "element";

/** 取纯文本;碰到不能压平的标签就整张表作废（返回 null） */
function flatten(nodes: readonly RootContent[]): string | null {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.value;
    else if (isElement(n)) {
      if (!FLATTENABLE.has(n.tagName)) return null;
      const inner = flatten(n.children);
      if (inner === null) return null;
      out += inner;
    }
    // comment / doctype 之类:没有可见内容，跳过
  }
  return out;
}

const childElements = (node: Element): Element[] => node.children.filter(isElement);

/** 把 <tr> 摊成一行字符串 */
function row(tr: Element): string[] | null {
  const cells: string[] = [];
  for (const cell of childElements(tr)) {
    if (cell.tagName !== "th" && cell.tagName !== "td") continue;
    const text = flatten(cell.children);
    if (text === null) return null;
    cells.push(text.trim());
  }
  return cells;
}

export interface PlainTable {
  columns: string[];
  rows: string[][];
}

/** 整张表都是纯文本 → {列名, 行}；只要有一格带链接/代码/图 → null（调用方退回原生表格）。
    没有表头、或一行数据都没有的表也返回 null:前者对不上列，后者是还在流的半张表 */
export function plainTable(node: Element | undefined): PlainTable | null {
  if (!node) return null;
  let columns: string[] | null = null;
  const rows: string[][] = [];
  // thead/tbody 可有可无（remark 产出的表一般两者都有，手写 HTML 未必）
  const sections = childElements(node);
  const trs = sections.flatMap((s) =>
    s.tagName === "tr" ? [s] : childElements(s).filter((c) => c.tagName === "tr"),
  );
  for (const tr of trs) {
    const cells = row(tr);
    if (cells === null) return null;
    const isHeader = childElements(tr).some((c) => c.tagName === "th");
    if (isHeader && columns === null) columns = cells;
    else rows.push(cells);
  }
  if (columns === null || rows.length === 0) return null;
  return { columns, rows };
}
