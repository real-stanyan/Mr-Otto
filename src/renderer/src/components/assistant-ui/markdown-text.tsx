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
import { memo } from "react";

import { cn } from "@/lib/utils.js";

// 模块级常量:每次渲染新建对象会让整棵子树白重挂。
// cjk 不是可选项——本仓界面和内容都是中文,缺了 CJK 断行插件排版会散。
const PLUGINS = { code, cjk };

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
  return (
    <StreamdownTextPrimitive
      className="aui-md"
      components={defaultComponents}
      plugins={PLUGINS}
      // 原 dot.css 的流式小圆点是靠 react-markdown 那层 [data-status="running"]
      // 和 .aui-md 同挂一个元素才生效的;换到 streamdown 后 data-status 挂在
      // 外层 wrapper div、aui-md 挂在内层内容 div,两者不再同源,dot.css 已经
      // 失效(见 node_modules/@assistant-ui/react-streamdown 的
      // primitives/StreamdownText.js)。用 streamdown 原生的 caret 补回同等的
      // 「还在生成」视觉反馈。
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
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-3 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
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
