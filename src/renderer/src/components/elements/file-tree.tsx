// assistant-ui elements 的 file-tree（https://www.assistant-ui.com/elements/file-tree）。
//
// 与上游的三处出入，都是因为本仓的这棵树长在**本机**的会话里：
//
// ① **没有 +N/−M**。上游那份是 PR 视图，行末挂增删行数；本仓这棵树画的是
//    write_file 写出去的文件，而 write_file 是整份覆盖——渲染层手里只有新内容，
//    没有旧内容，算不出增删。宁可不说，也不摆一个猜出来的数字。
// ② **行可点**：点了在 Files 面板里打开那个文件（面板只读，ADR-0031）。上游那份
//    是纯展示。本仓这棵树取代的正是原来那张"可下载的文件卡"——文件就在本机磁盘上，
//    "打开看看"比"下载一份副本"更贴近用户真正想做的事。
// ③ 头一行的字是中文，且**只报文件数**（没有增删就没有第二个数字可报）。
//
// 保留上游的：flat nodes + depth 的形状（缩进靠 paddingInlineStart，不靠嵌套 DOM，
// 所以一行就是一行，键盘/命中区都好处理）、逐行 fade+slide 的入场。

import type { ComponentProps } from "react";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { paper } from "@/lib/surfaces.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import type { FileTreeNode } from "@/lib/fileTree.js";

export function FileTree({
  nodes,
  onSelect,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  nodes: readonly FileTreeNode[];
  /** 点一行文件。不给 = 纯展示，行就不是按钮 */
  onSelect?: (path: string) => void;
}) {
  const files = nodes.filter((n) => n.kind === "file").length;
  if (files === 0) return null;

  return (
    <div
      data-slot="file-tree"
      className={cn(paper, "flex w-full flex-col gap-1 rounded-xl p-2", className)}
      {...props}
    >
      <div className="px-1 text-[11px] text-muted-foreground">动了 {files} 个文件</div>

      <div className="flex flex-col">
        {nodes.map((node, i) => {
          const inner = (
            <>
              {node.kind === "folder" ? (
                <>
                  {/* 目录一律展开:这棵树画的是"这一组动过的东西",没有可折的分支 */}
                  <ChevronDownIcon className="size-3 shrink-0 text-foreground/25" />
                  <FolderIcon className="size-3.5 shrink-0 text-foreground/35" />
                  <span className="min-w-0 flex-1 truncate text-foreground/60">{node.name}</span>
                </>
              ) : (
                <>
                  <FileTypeIcon path={node.name} className="ms-3 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">{node.name}</span>
                </>
              )}
            </>
          );
          // 逐行入场:30ms 一档,封顶 240ms —— 一次写十几个文件的时候,
          // 阶梯再长就变成"等它演完"了
          const style = {
            paddingInlineStart: `${0.25 + node.depth * 0.85}rem`,
            animationDelay: `${Math.min(i * 30, 240)}ms`,
          };
          const rowClass =
            "flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] animate-in fade-in slide-in-from-left-1 fill-mode-both duration-200 ease-strong motion-reduce:animate-none";

          return node.kind === "file" && onSelect ? (
            <button
              key={node.path}
              type="button"
              title={node.full ?? node.path}
              onClick={() => onSelect(node.full ?? node.path)}
              // 行是可点的,就得有按下的手感(scale 太重,一行 24px 的东西按下去
              // 缩一下像抽搐)——用底色说话
              className={cn(
                rowClass,
                "cursor-pointer border-none bg-transparent text-left transition-colors duration-[120ms] hover:bg-foreground/[0.06] active:bg-foreground/[0.09]"
              )}
              style={style}
            >
              {inner}
            </button>
          ) : (
            <div key={node.path} className={rowClass} style={style}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
