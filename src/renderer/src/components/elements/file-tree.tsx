// assistant-ui elements 的 file-tree（https://www.assistant-ui.com/elements/file-tree）。
//
// 与上游的三处出入，都是因为本仓的这棵树长在**本机**的会话里：
//
// ① **行数来自事件日志,不是渲染层现算的**（ADR-0141）：write_file 是整份覆盖，
//    渲染层手里只有新内容没有旧内容，算不出增删——所以那份账在写盘那一刻由
//    turnDiff 中间件算好、落进 `tool_result.diffStat`。改这条之前的旧日志里
//    没有这个字段，那样的行就**不报数字**，不猜也不填零。
// ② **行可点**：点了在 Files 面板里打开那个文件（面板只读，ADR-0031）。上游那份
//    是纯展示。本仓这棵树取代的正是原来那张"可下载的文件卡"——文件就在本机磁盘上，
//    "打开看看"比"下载一份副本"更贴近用户真正想做的事。
// ③ 头一行的字是中文；总计只汇总"有账可报"的那些行。
//
// 保留上游的：flat nodes + depth 的形状（缩进靠 paddingInlineStart，不靠嵌套 DOM，
// 所以一行就是一行，键盘/命中区都好处理）、逐行 fade+slide 的入场。

import type { ComponentProps } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import type { FileTreeNode } from "@/lib/fileTree.js";

/** 行末那对数字。红绿分工同「本轮改动」面板(TurnDiffPanel):加是 --ok,删是 --err。
    某一边为 0 就不画那一半——「+24」比「+24 −0」读得快,而 0 不携带信息 */
function stat(node: { additions?: number; deletions?: number }) {
  const { additions, deletions } = node;
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className={cn(mono, "shrink-0 tabular-nums")}>
      {additions ? <span className="text-ok">+{additions}</span> : null}
      {additions && deletions ? " " : null}
      {deletions ? <span className="text-err">−{deletions}</span> : null}
    </span>
  );
}

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
  const fileNodes = nodes.filter((n) => n.kind === "file");
  if (fileNodes.length === 0) return null;
  const totals = fileNodes.reduce(
    (acc, n) => ({
      additions: acc.additions + (n.additions ?? 0),
      deletions: acc.deletions + (n.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 }
  );
  // 一份账都没有(全是旧日志)就连总计也不画:一行「+0 −0」比空白更像在说假话
  const hasStats = fileNodes.some((n) => n.additions !== undefined || n.deletions !== undefined);

  return (
    <div
      data-slot="file-tree"
      className={cn(paper, "flex w-full flex-col gap-1 rounded-xl p-2", className)}
      {...props}
    >
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-[11px] text-muted-foreground">动了 {fileNodes.length} 个文件</span>
        {hasStats && <span className="ms-auto shrink-0">{stat(totals)}</span>}
      </div>

      <div className="flex flex-col">
        {nodes.map((node, i) => {
          const inner = (
            <>
              {node.kind === "folder" ? (
                <>
                  {/* 目录一律展开:这棵树画的是"这一组动过的东西",没有可折的分支 */}
                  <ChevronDownIcon className="size-3 shrink-0 text-foreground/25" />
                  {/* 目录图标走本仓那套 material-icon-theme（同 FilesView / 本轮改动），
                      不用 lucide 的线框 —— 一个界面里同一个东西不该有两种画法 */}
                  <FileTypeIcon path={node.name} folder className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-foreground/60">{node.name}</span>
                </>
              ) : (
                <>
                  <FileTypeIcon path={node.name} className="ms-3 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">{node.name}</span>
                  {stat(node)}
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
