// markdown 代码块的 pre 覆盖 —— 右上角挂复制键,hover 才现身。
//
// 复制的内容从 DOM 的 textContent 读,不去翻 react-markdown 的 children:
// 高亮之后 children 是一棵嵌套的 span 树,重新拼回原文既麻烦又容易错一个字符;
// textContent 拿到的就是渲染出来的那份纯文本,和用户刷选复制的结果一致

import { useRef } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { CopyButton } from "./CopyButton.js";

export function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="relative group/code">
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      <CopyButton
        text={() => ref.current?.textContent ?? ""}
        label="复制代码"
        // 不在这写 transition-*:buttonVariants 基类已经带 transition-[...,opacity] duration-150,
        // tailwind-merge 会把这里的 transition-opacity 和基类那条判成同一组、只留后写的那个,
        // 结果按压 scale/hover 变色跟着丢过渡
        className="absolute top-2 right-2 bg-card/80 backdrop-blur-sm opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

/** 模块级单例:每次渲染新建对象会让 react-markdown 整棵子树重挂 */
export const MD_COMPONENTS = { pre: CodeBlock } as const;
