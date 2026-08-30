"use client";

import type { ComponentProps, ReactNode } from "react";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { take } from "@/lib/range.js";

export function TerminalBlock({
  command,
  lines,
  visibleCount,
  done,
  exitCode,
  variant = "paper",
  bodyClassName,
  footer,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "command" | "lines" | "visibleCount" | "done" | "variant"
> & {
  command: string;
  lines: readonly string[];
  visibleCount: number;
  done: boolean;
  /** 本仓改动:退出码。原件把 "exit 0" 写死在完成态里——它画的是文档里那个
      永远成功的示例;本仓这块要画真跑过的后台任务,失败是常态 */
  exitCode?: number;
  variant?: "paper" | "ink";
  /** 本仓改动:输出区的类。原件是个固定 8.5rem 高的展示块,而本仓这一块贴在
      工具行底下直播,得能限高 + 顶部裁掉旧行(justify-end)——终端只看最新那几行 */
  bodyClassName?: string;
  /** 本仓改动:卡片底部的状态条(已跑多久 / 结果还没贴回对话)。这些字说的是
      **这个任务在会话里的处境**,不是命令吐出来的东西——混进输出区就是在
      伪造终端输出,所以单开一格,拿一条细线跟输出分开 */
  footer?: ReactNode;
}) {
  const ink = variant === "ink";
  const failed = done && exitCode !== undefined && exitCode !== 0;

  return (
    <div
      data-slot="terminal-block"
      className={cn(
        ink ? "bg-foreground dark:bg-popover" : paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className,
      )}

      {...props}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
        {/* 本仓改动:命令截断。这块卡会被塞进右侧那条能拖到很窄的槽位,
            不截的话长命令会把右边的状态整个顶出可视区 */}
        <span
          className={cn(
            "min-w-0 truncate",
            ink
              ? "text-background/90 dark:text-foreground/90"
              : "text-foreground/90",
          )}
          title={command}
        >
          {command}
        </span>
        {done ? (
          <div className="flex shrink-0 items-center gap-1 pl-2">
            {failed ? (
              <XIcon className="size-3 text-red-500" />
            ) : (
              <CheckIcon className="size-3 text-emerald-500" />
            )}
            <span
              className={cn(
                mono,
                ink
                  ? "text-background/40 dark:text-foreground/40"
                  : "text-foreground/40",
              )}
            >
              exit {exitCode ?? 0}
            </span>
          </div>
        ) : (
          <Loader2Icon
            className={cn(
              "size-3 shrink-0 animate-spin motion-reduce:animate-none",
              ink
                ? "text-background/35 dark:text-foreground/35"
                : "text-foreground/35",
            )}
          />
        )}
      </div>
      <div
        className={cn(
          "flex min-h-[8.5rem] flex-col gap-1 px-4 pt-1 pb-3.5",
          ink
            ? "text-background/55 dark:text-foreground/50"
            : "text-foreground/50",
          bodyClassName,
        )}
      >
        {take(lines, visibleCount).map((line, i) => {
          const isLast = i === lines.length - 1;
          return (
            <div
              key={`${i}-${line}`}
              className={cn(
                // 本仓改动:终端输出里的空格是有意义的(缩进/对齐/表格),HTML 默认
                // 折叠空白会把它们吃掉;break-all 是给不带空格的长串(URL/base64)兜底
                "whitespace-pre-wrap break-all",
                "fade-in animate-in fill-mode-both duration-300",
                isLast &&
                  (ink
                    ? "text-background/90 dark:text-foreground/90"
                    : "text-foreground/90"),
              )}
            >
              {line}
            </div>
          );
        })}
        {!done && (
          <span
            aria-hidden
            className="inline-block h-3 w-1.5 animate-pulse bg-blue-500/70 motion-reduce:animate-none dark:bg-blue-400/70"
          />
        )}
      </div>
      {footer !== undefined && (
        <div
          className={cn(
            "border-t px-4 py-1.5 text-[11px]",
            ink
              ? "border-background/10 text-background/45 dark:border-foreground/10 dark:text-foreground/45"
              : "border-border/60 text-foreground/45",
          )}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
