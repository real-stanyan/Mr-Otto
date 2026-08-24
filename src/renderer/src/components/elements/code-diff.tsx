"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { FileTypeIcon } from "@/components/FileTypeIcon.js";
import { codeScroll, codeSurface, mono, paper } from "@/lib/surfaces.js";

// 本仓改动:多一种 skip —— 折叠掉的连续未变段("… N 行未变 …")。
// 上游假设 diff 整段摊开;审批卡不能这么干,一个几百行的文件里改三行,
// 摊开等于让审批人自己去找。折叠是本仓的产品判断(见 shared/diffView.ts)
export type DiffKind = "context" | "added" | "removed" | "skip";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const GUTTER: Record<DiffKind, string> = {
  context: "",
  added: "+",
  removed: "−",
  skip: "",
};

export function CodeDiff({
  filename,
  additions,
  deletions,
  lines,
  cycle = 0,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "filename" | "additions" | "deletions" | "lines" | "cycle"
> & {
  filename: string;
  additions: number;
  deletions: number;
  lines: readonly DiffLine[];
  /** 本仓改动:可选。上游拿它做动画重放的 key(演示里循环播放);
      本仓的 diff 是一次性的,没有"再播一遍"这回事 */
  cycle?: number;
}) {
  return (
    <div
      data-slot="code-diff"
      className={cn(
        paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className,
      )}

      {...props}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        {/* 本仓改动:文件名前面加一枚按类型走的图标(FileTypeIcon)。
            审批卡是"要不要让它动这个文件"的判断,而判断的第一步是认出
            这是个什么文件 —— 一行等宽文件名要读到后缀才知道 */}
        <span className="flex min-w-0 items-center gap-1.5">
          <FileTypeIcon path={filename} className="size-[15px]" />
          <span className="min-w-0 truncate text-foreground/90">{filename}</span>
        </span>
        <span className={cn(mono, "tabular-nums")}>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{additions}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">−{deletions}</span>
        </span>
      </div>
      <div className={codeScroll}>
        <div className={codeSurface}>
          {lines.map((line, i) => (
            <div
              key={`${cycle}-${i}-${line.text}`}
              className={cn(
                "fade-in animate-in fill-mode-both flex px-4 py-0.5 leading-relaxed whitespace-pre duration-300",
                line.kind === "context" && "text-foreground/45",
                line.kind === "added" &&
                  "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                line.kind === "removed" &&
                  "bg-red-500/10 text-red-700 dark:text-red-300",
                // 本仓加的:折叠行是一句说明,不是代码 —— 居中、斜体、不给底色
                line.kind === "skip" &&
                  "text-foreground/35 justify-center italic",
              )}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {line.kind !== "skip" && (
                <span className="w-4 shrink-0 select-none">
                  {GUTTER[line.kind]}
                </span>
              )}
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
