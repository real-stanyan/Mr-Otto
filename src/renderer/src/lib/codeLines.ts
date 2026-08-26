// 高亮后的代码 → 一行一个元素。Files 面板的预览要靠它才能有行号、才能"跳到第 N 行"。
//
// 为什么不是按 \n 切字符串再逐行高亮:hljs 的 token 会跨行(块注释、模板字符串),
// 逐行高亮的表现是块注释只有第一行是灰的。所以先整篇高亮,再在 hast 上切行 ——
// 切到一半的元素在下一行原样再开一个(和编辑器里的做法一致)。

import type { Element, ElementContent, Root } from "hast";

/** 把一串行内节点按 \n 切成若干行。跨行的元素会在每一行各留一个同名副本 */
export function splitLines(nodes: readonly ElementContent[]): ElementContent[][] {
  const lines: ElementContent[][] = [[]];
  const push = (n: ElementContent) => lines[lines.length - 1]?.push(n);
  for (const node of nodes) {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part !== "") push({ type: "text", value: part });
      });
      continue;
    }
    if (node.type === "element") {
      const inner = splitLines(node.children as ElementContent[]);
      inner.forEach((chunk, i) => {
        if (i > 0) lines.push([]);
        push({ ...node, children: chunk });
      });
      continue;
    }
    push(node);
  }
  // 文件末尾的换行不是"还有一行":留着的话每个文件底下都多一个空行号
  if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
  return lines;
}

/** 一行 → <span class="code-line" data-line="N">。行号走 CSS 的 ::before(attr),
    不塞进 DOM 文本:塞进去的话选中复制会把行号一起拷走 */
export function wrapLines(nodes: readonly ElementContent[]): Element[] {
  return splitLines(nodes).map((children, i) => ({
    type: "element" as const,
    tagName: "span",
    properties: { className: ["code-line"], dataLine: String(i + 1) },
    children,
  }));
}

/** rehype 插件:预览里的 <pre><code> 逐行包起来。只动 pre 底下的 code —— 
    行内代码没有"行"这回事 */
export function rehypeCodeLines() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "pre") {
          for (const code of child.children) {
            if (code.type === "element" && code.tagName === "code") {
              code.children = wrapLines(code.children as ElementContent[]);
            }
          }
          continue;
        }
        walk(child);
      }
    };
    walk(tree);
  };
}
