// 助手正文的 streamdown 渲染配置——主聊天（markdown-text.tsx 的 MarkdownTextPrimitive）
// 和旁聊浮窗（SideChatWindow，裸 streamdown 的 <Streamdown>，issue #516）共用这一份。
// 两条路的「组件」不同（aui 的 primitive 要 useAuiState 在消息上下文里，浮窗没有
// aui runtime），但**配置**必须同源：字体排版/代码高亮/CJK 断行/mermaid/otto 块，
// 一处改了另一处自动跟上——不然就是两套「差不多」的模板慢慢 drift。
//
// 每条常量的「为什么」原注都在 markdown-text.tsx，这里只留指针、不复述。
// 注意：本文件是 .ts 不是 .tsx——适配层（MdPre/MdCode）一律用 createElement，不写 JSX。

import { defaultRehypePlugins } from "streamdown";
// 具名导出,不是默认导出(实测 @streamdown/code@1.1.1 / @streamdown/cjk@1.0.3 的 .d.ts)
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";

import { MermaidDiagram } from "@/components/assistant-ui/mermaid-diagram.js";
import { ShikiCodeBlock } from "@/components/assistant-ui/code-block.js";
import { OTTO_BLOCK_COMPONENTS } from "@/components/assistant-ui/otto-blocks.js";
import { rehypeFileRefs } from "@/lib/rehypeFileRefs.js";
import {
  useMemo,
  createElement,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
  type ComponentType,
} from "react";

/** code/cjk/math 三件套（为什么缺一不可：markdown-text.tsx 的 PLUGINS 注） */
export const MD_PLUGINS = { code, cjk, math };

/** ```mermaid 走画框不走普通代码块 + otto 结构化块（出处同上 BY_LANGUAGE 注） */
export const MD_BY_LANGUAGE = {
  mermaid: { SyntaxHighlighter: MermaidDiagram, CodeHeader: () => null },
  ...OTTO_BLOCK_COMPONENTS,
};

/** 消毒三件套摊开在前 + rehypeFileRefs 钉在最后（两处「必须」的出处同上） */
export const MD_REHYPE_PLUGINS = [...Object.values(defaultRehypePlugins), rehypeFileRefs];

/** 语言表之外的代码块兜底（不能省的理由：code-block.tsx 开头） */
export const MD_COMPONENTS = { SyntaxHighlighter: ShikiCodeBlock };

/** 逐字出场动画参数（为什么 sep:"char"/stagger 8：markdown-text.tsx 的 ANIMATED 注） */
export const MD_ANIMATED = {
  animation: "ottoInk",
  sep: "char",
  duration: 420,
  easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  stagger: 8,
} as const;

// ── 裸 <Streamdown> 的接法（旁聊浮窗用；主聊天走 aui 的 primitive 自带这层适配）──
// 逻辑照搬 @assistant-ui/react-streamdown 的 adapters/code-adapter +
// components-adapter：componentsByLanguage 按语言分发 + SyntaxHighlighter 兜底 +
// pre 给 code 打 data-block 标记。裸 Streamdown 拿不到 aui 那层，自己接——
// 两边的「配置」仍是上面那一份，这层只是把它翻译成裸组件听得懂的 components 表。

type AdapterProps = { children?: ReactNode; className?: string; node?: unknown };

/** pre → 把 data-block 打给里面的 code（照搬 aui PreOverride 的标记行为，
    去掉了本仓用不到的 PreContext）。非元素 children 原样包一层 pre 返回 */
function MdPre({ children }: AdapterProps) {
  if (isValidElement(children)) {
    return cloneElement(children as ReactElement<Record<string, unknown>>, {
      "data-block": "true",
    });
  }
  return createElement("pre", null, children);
}

/** code → 块级(带 data-block)按语言分发/兜底；行内 code 原样渲染（照搬 aui code-adapter） */
function MdCode(props: AdapterProps) {
  const { className, children, node } = props;
  const isBlock =
    (node as { properties?: Record<string, unknown> } | undefined)?.properties?.[
      "data-block"
    ] === true ||
    (node as { data?: Record<string, unknown> } | undefined)?.data?.["data-block"] === true;
  if (!isBlock) return createElement("code", { className }, children);
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
  const entry = (
    MD_BY_LANGUAGE as Record<string, { SyntaxHighlighter: unknown; CodeHeader?: unknown }>
  )[language];
  const SyntaxHighlighter = (entry?.SyntaxHighlighter ??
    MD_COMPONENTS.SyntaxHighlighter) as ComponentType<{ code: string; language: string }>;
  const codeText = String(children ?? "").replace(/\n$/, "");
  return createElement(SyntaxHighlighter, { code: codeText, language });
}

/** 裸 Streamdown 用的整份 components（useMemo 钉引用——每次新建 = 整棵子树白重挂） */
export function useMdComponents(): any {
  return useMemo(() => ({ pre: MdPre, code: MdCode }), []);
}
