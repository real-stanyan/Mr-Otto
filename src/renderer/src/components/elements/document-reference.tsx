"use client";

import type { ComponentProps } from "react";
import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono, paper } from "@/lib/surfaces.js";

export interface DocumentAnchor {
  page: number;
  quote: string;
}

export function DocumentReference({
  title,
  pages,
  anchors,
  activePage,
  onJump,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "title" | "pages" | "anchors" | "activePage" | "onJump"
> & {
  title: string;
  pages: number;
  anchors: readonly DocumentAnchor[];
  activePage: number;
  onJump?: (page: number) => void;
}) {
  // 一页可能被好几个锚点引用,只有其中一个是当前项
  const currentIndex = anchors.findIndex(
    (anchor) => anchor.page === activePage,
  );

  return (
    <div
      data-slot="document-reference"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-3.5",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-8 shrink-0 items-center justify-center rounded-lg">
          <FileTextIcon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-medium">{title}</span>
          {/* 本仓改动:中文文案(原件是英文 "N pages · N cited") */}
          <span className={cn(mono, "text-foreground/30")}>
            共 {pages} 页 · 引用 {anchors.length} 处
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {anchors.map((anchor, i) => (
          <button
            key={`${anchor.page}-${i}`}
            type="button"
            aria-current={i === currentIndex || undefined}
            onClick={() => onJump?.(anchor.page)}
            className={cn(
              // 本仓改动:补上按压反馈(设计铁律:pressable 一律 active:scale-[0.97]),
              // 原件只有 hover 底色,没有点按反馈
              "flex flex-col gap-1 rounded-xl px-2.5 py-2 text-start transition-[background-color,transform] duration-150 ease-strong active:scale-[0.97] motion-reduce:transition-none",
              anchor.page === activePage
                ? field
                : "hover:bg-foreground/[0.035]",
            )}
          >
            {/* 本仓改动:中文文案(原件是 "p. N") */}
            <span className={cn(mono, "text-foreground/30")}>
              第 {anchor.page} 页
            </span>
            <span className="text-foreground/65 border-foreground/15 border-s-2 ps-2 text-xs leading-relaxed break-words">
              {anchor.quote}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
