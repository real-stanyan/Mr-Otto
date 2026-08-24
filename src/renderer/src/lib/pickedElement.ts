// 选中元素 → composer 上下文块。纯函数,BrowserPanel 拿结果直接 injectComposer。
//
// 形态选「可读的 markdown 段落」而不是 JSON:注入后停在输入框里,
// 用户要看得懂、能顺手删掉不想要的行,再接着打修改指令。

import type { BrowserPickedElement } from "../../../shared/browser.js";

export function formatPickedElement(p: BrowserPickedElement): string {
  const lines: string[] = [`[选中元素] ${p.url}`, `- selector: \`${p.selector}\``];
  if (p.components?.length) lines.push(`- 组件: ${p.components.join(" ← ")}`);
  if (p.source) lines.push(`- 源码: ${p.source}`);
  if (p.text) lines.push(`- 文本: ${p.text}`);
  lines.push("```html", p.html, "```", "", "");
  return lines.join("\n");
}
