"use client";

import type { ComponentProps } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { FileTypeIcon } from "@/components/FileTypeIcon.js";
import { codeScroll, codeSurface, inkButton, mono, paper } from "@/lib/surfaces.js";
import type { DiffLine } from "./code-diff.js";

export type HunkDecision = "pending" | "kept" | "discarded";

export interface DiffHunk {
  id: string;
  range: string;
  decision: HunkDecision;
  lines: readonly DiffLine[];
}

// 本仓改动:跟着 code-diff 多认一种 skip(折叠掉的连续未变段)
const GUTTER = { context: "", added: "+", removed: "−", skip: "" } as const;

export function ReviewableDiff({
  filename,
  hunks,
  onKeep,
  onDiscard,
  onApply,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "filename" | "hunks" | "onKeep" | "onDiscard" | "onApply"
> & {
  filename: string;
  hunks: readonly DiffHunk[];
  onKeep?: (id: string) => void;
  onDiscard?: (id: string) => void;
  onApply?: () => void;
}) {
  // 本仓改动:默认保留 —— 没动过的块算保留,不算"待定"。
  // 审批卡的既有语义是"批准 = 照模型说的写",分块只是给它加了减法
  const kept = hunks.filter((hunk) => hunk.decision !== "discarded").length;
  const pending = hunks.filter((hunk) => hunk.decision === "pending").length;

  return (
    <div
      data-slot="reviewable-diff"
      className={cn(
        paper,
        "flex w-full max-w-md flex-col overflow-hidden rounded-2xl",
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
          <span className="min-w-0 truncate font-mono text-xs">{filename}</span>
        </span>
        <span className={cn(mono, "text-foreground/35 tabular-nums")}>
          保留 {kept} / {hunks.length} 块
        </span>
      </div>

      <div className="flex flex-col">
        {hunks.map((hunk) => (
          <div
            key={hunk.id}
            className={cn(
              "border-foreground/[0.06] border-t transition-opacity duration-300",
              hunk.decision === "discarded" && "opacity-40",
            )}
          >
            <div className="flex items-center gap-2 px-4 py-1.5">
              <span className={cn(mono, "text-foreground/30")}>
                {hunk.range}
              </span>
              {/* 本仓改动:两个钮**一直**都在,当前选择高亮。上游是"选完就换成一行状态字",
                  那等于决定不可回头 —— 而这一整张卡在按下最终那个钮之前,
                  每一块的取舍都该改得动。顺带也省掉了"pending"这个第三态在界面上的存在 */}
              <span className="ms-auto flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={hunk.decision === "discarded"}
                  aria-label={`丢掉 ${hunk.range}`}
                  onClick={() => onDiscard?.(hunk.id)}
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]",
                    hunk.decision === "discarded"
                      ? "bg-red-500/12 text-red-700 dark:text-red-300"
                      : "text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90",
                  )}
                >
                  <XIcon className="size-3" />
                  丢掉
                </button>
                <button
                  type="button"
                  aria-pressed={hunk.decision !== "discarded"}
                  aria-label={`保留 ${hunk.range}`}
                  onClick={() => onKeep?.(hunk.id)}
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-[background-color,scale] duration-150 active:scale-[0.96]",
                    hunk.decision !== "discarded"
                      ? "bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                      : "text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90",
                  )}
                >
                  <CheckIcon className="size-3" />
                  保留
                </button>
              </span>
            </div>
            <div className={cn(codeScroll, "pb-1.5 font-mono text-xs")}>
              <div className={codeSurface}>
                {hunk.lines.map((line, i) => (
                  <div
                    key={`${hunk.id}-${i}`}
                    className={cn(
                      "flex px-4 py-0.5 leading-relaxed whitespace-pre",
                      line.kind === "context" && "text-foreground/40",
                      line.kind === "added" &&
                        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      line.kind === "removed" &&
                        "bg-red-500/10 text-red-700 dark:text-red-300",
                    )}
                  >
                    <span className="w-4 shrink-0 select-none">
                      {GUTTER[line.kind]}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 本仓改动:没给 onApply 就不长这条页脚。本仓的"应用"钮和拒绝、授权档位
          在同一排(审批卡自己的动作条)—— 这里再来一个就是两个地方都能定稿。
          上游那个 disabled={pending>0} 的门也一并没了:本仓默认全部保留,
          "还有几块没看"这个状态在本仓不存在(见上面两个钮的注释) */}
      {onApply && (
        <div className="border-foreground/[0.06] flex items-center justify-between border-t px-4 py-2.5">
          <span className={cn(mono, "text-foreground/35")}>
            {pending > 0 ? `${pending} 块待定` : "都看过了"}
          </span>
          <button
            type="button"
            disabled={pending > 0}
            onClick={onApply}
            className={cn(
              inkButton,
              "flex h-7 items-center rounded-full px-3 text-xs font-medium disabled:pointer-events-none disabled:opacity-30",
            )}
          >
            应用 {kept}
          </button>
        </div>
      )}
    </div>
  );
}
