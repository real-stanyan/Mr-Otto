"use client";

// 正文里的「文件:行号」chip —— 点一下开 Files 面板、滚到那一行并高亮。
//
// 为什么是 button 不是 a:它不去任何 URL,做的是"把右侧面板挪过去"。写成 a
// 会带上链接的一整套语义(中键新窗口、拷贝链接地址),而这里没有一个成立。
//
// 三条来路都汇到这一枚:正文纯文本(rehypeFileRefs 标出来的 span)、行内代码、
// 以及 href 本身就是路径的 markdown 链接(本仓的 AGENTS.md 就要求这么写)。

import { useChat } from "@/store.js";
import { cn } from "@/lib/utils.js";

export function FileRefChip({
  path,
  line,
  className,
  children,
}: {
  path: string;
  line: number | null;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const openFileAt = useChat((s) => s.openFileAt);
  return (
    <button
      type="button"
      data-testid="file-ref"
      data-file-ref={path}
      data-file-line={line ?? undefined}
      title={line === null ? `在文件面板中打开 ${path}` : `在文件面板中打开 ${path} 第 ${line} 行`}
      onClick={() => openFileAt(path, line)}
      className={cn(
        // 行内元素:不能用 inline-flex/align-middle 之类会改行高的排法,
        // 一段话里夹几个 chip 不该把行距顶开
        "aui-file-ref rounded-[3px] px-[2px] font-mono text-[0.85em] text-primary",
        "bg-primary/[0.08] underline decoration-dotted underline-offset-2",
        "hover:bg-primary/15 hover:decoration-solid",
        className,
      )}
    >
      {children}
    </button>
  );
}
