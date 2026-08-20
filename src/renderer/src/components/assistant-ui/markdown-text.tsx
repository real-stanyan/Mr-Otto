"use client";

// registry 原实现走 @assistant-ui/react-markdown 的 MarkdownTextPrimitive——Task 5
// 装好了 streamdown 全家桶却没接上,两项需求(「模型输出用 streamdown」「代码块
// syntax-highlighting」)一直没交付。这里换成 @assistant-ui/react-streamdown 的
// StreamdownTextPrimitive,导出的 MarkdownText 名字/签名不变(见 task-9-brief)。
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import type { StreamdownTextComponents } from "@assistant-ui/react-streamdown";
// 具名导出,不是默认导出(实测 @streamdown/code@1.1.1 / @streamdown/cjk@1.0.3 的 .d.ts)
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { useAuiState } from "@assistant-ui/react";
import { memo } from "react";

import { DataTable } from "@/components/elements/data-table.js";
import { MathBlock } from "@/components/elements/math-block.js";
import { MermaidDiagram } from "@/components/assistant-ui/mermaid-diagram.js";
import { plainTable } from "@/lib/hastTable.js";
import { cn } from "@/lib/utils.js";

// 模块级常量:每次渲染新建对象会让整棵子树白重挂。
// cjk 不是可选项——本仓界面和内容都是中文,缺了 CJK 断行插件排版会散。
// math:$$…$$ 走 KaTeX(样式表在 app.css 里 @import,版本钉死见那条注释)。
// 默认只认双美元的行间公式,不认单美元 —— 单美元在正文里更常见的身份是钱
const PLUGINS = { code, cjk, math };

// 逐字出场的参数（效果本身见 app.css 的 sd-ottoInk）。同样是模块级常量:
// 每次渲染新建对象会让 streamdown 认成"插件换了"而重建整条管线。
//
// sep:"char" 不是可选项 —— 本仓正文是中文,而 "word" 是按空白切的,
// 一整段中文没有空格 = 一个 span,逐字出场就退化成整段一闪。代价是一段话
// 有多少字就有多少 span,所以只在这条消息还在流的时候开(见下面的 running)。
//
// stagger 8ms 不是 40(默认):一次推送常有十几二十个字,40ms 一个的话尾巴要拖
// 快一秒,读起来是"字在追着光标跑"而不是"字落下来"。
// easing 用 ease-out 那条强曲线(与全仓入场同一条):出场是"进来",起手就得快。
const BY_LANGUAGE = {
  mermaid: { SyntaxHighlighter: MermaidDiagram, CodeHeader: () => null },
};

const ANIMATED = {
  animation: "ottoInk",
  sep: "char",
  duration: 420,
  easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  stagger: 8,
} as const;

// 没有显式传 shikiTheme:StreamdownTextPrimitive 在 plugins.code 存在时,
// 主题最终取的是 code.getThemes()(见 node_modules/streamdown/dist/chunk-*.js
// 里 `shikiTheme:(...)=>g?.code?.getThemes()??d`),不是这层的 shikiTheme prop——
// 这个 prop 在有 code 插件时是死的。@streamdown/code 的 code 单例默认主题就是
// ["github-light","github-dark"],正好是明暗一对,浅色贴 --pre-bg 的近白、
// 深色贴 --pre-bg 的近黑(#1d1d1f),不用再传一遍。若以后要换主题,
// 得改成 createCodePlugin({ themes: [...] }) 而不是给这里加 shikiTheme。

// remark-gfm 不用再显式传:streamdown 默认的 remark 插件里已经带 gfm
// (见 node_modules/streamdown/dist/chunk-*.js 里 `Ks={gfm:[$s,{}],...}`)。

const MarkdownTextImpl = () => {
  // 逐字出场只给还在流的那一条:说完了的消息不需要动画,也不该为它留一屏
  // 的 <span>——一条长回答按字包是上千个节点,历史越长背得越重。
  // 收工时这一条会重渲一次(span 全部消失),内容不变、行内元素不占位,看不出来
  const running = useAuiState((s) => s.message.status?.type === "running");
  return (
    <StreamdownTextPrimitive
      className="aui-md"
      components={defaultComponents}
      plugins={PLUGINS}
      animated={running ? ANIMATED : false}
      // 原 dot.css 的流式小圆点是靠 react-markdown 那层 [data-status="running"]
      // 和 .aui-md 同挂一个元素才生效的;换到 streamdown 后 data-status 挂在
      // 外层 wrapper div、aui-md 挂在内层内容 div,两者不再同源,dot.css 已经
      // 失效(见 node_modules/@assistant-ui/react-streamdown 的
      // primitives/StreamdownText.js)。用 streamdown 原生的 caret 补回同等的
      // 「还在生成」视觉反馈。
      // ```mermaid 不走普通代码块:交给 MermaidDiagram（elements/diagram 的画框
      // + mermaid 渲染的 SVG）。CodeHeader 一起换掉——画框自己有标题栏，
      // 上面再顶一条"mermaid + 复制"是两层标题
      componentsByLanguage={BY_LANGUAGE}
      caret="block"
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

// streamdown 自带代码块的 Shiki 高亮 + 复制/行号等 controls(默认开启),
// 原来的 CodeHeader / pre / code(区分 block 的那套)因此整个多余,删掉后
// 逐个 grep 确认过全仓没有别处引用:
//   - CodeHeader:仅这一处定义与使用(`grep -rn "CodeHeader" src/renderer/src`)
//   - TooltipIconButton 的 copy 用法:仅这里用过,组件本身在别处仍有引用不能删文件
//   - useCopyToClipboard / CheckIcon / CopyIcon:仅服务于旧 CodeHeader
// 行内代码(非代码块)的样式挪到下面的 inlineCode——streamdown 会自动只把
// 「没有 data-block」的 code 元素交给它,不用再手动判断是不是代码块。
const defaultComponents = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-3", className)}
      {...props}
    />
  ),
  // 纯文本的表走 elements/data-table 那张卡（纸面 + 列头等宽 + 逐行落位）;
  // 只要有一格带链接/行内代码/图，就退回原生 <table> —— 那张卡吃的是字符串，
  // 交给它等于把可点的路径变成一行字（判断在 lib/hastTable.ts）
  // KaTeX 把行间公式渲染成 <span class="katex-display">(它替掉了 remark-math
  // 那层 math-display 包裹,所以只能从这一层认)。认出来就套上 elements/math-block
  // 的纸面:公式在正文里是一个"块",给它自己的边界比裸着夹在段落之间好读。
  // 行内公式(span.katex 但没有 katex-display)照旧,不套卡
  span: ({ className, node, ...props }) => {
    const classes = node?.properties?.["className"];
    const display =
      Array.isArray(classes) && classes.includes("katex-display");
    if (!display) return <span className={className} {...props} />;
    return (
      <MathBlock
        steps={[{ expression: <span className={className} {...props} /> }]}
        visibleSteps={1}
        // KaTeX 自带整套排版,让位(理由见 math-block 的 expressionClassName)
        expressionClassName=""
        className="my-3 max-w-none"
      />
    );
  },
  table: ({ className, node, ...props }) => {
    const plain = plainTable(node);
    if (plain) {
      return (
        <DataTable
          columns={plain.columns}
          rows={plain.rows}
          className={cn("aui-md-table my-3", className)}
        />
      );
    }
    return (
      <table
        className={cn(
          "aui-md-table my-3 w-full border-separate border-spacing-0 overflow-y-auto",
          className,
        )}
        {...props}
      />
    );
  },
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-relaxed", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  inlineCode: ({ className, ...props }) => (
    <code
      className={cn(
        "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  ),
} satisfies StreamdownTextComponents;
