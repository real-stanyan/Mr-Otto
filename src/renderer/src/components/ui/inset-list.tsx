// inset-list —— 设置面里那种「一组行装在一张圆角卡上」的列表（#1120）。
//
// 换掉的是**每行各自一圈 `border border-border`** 那套：12px 的字配上满屏细框，
// 一屏十几个矩形边全是等价的视觉重量，人得逐个读才知道哪些是一组。分组卡的
// 三件事各自有活干——**卡的边界**说「这几行是一组」、**内缩的分隔线**说「组内还
// 分行」（内缩到与文字对齐，所以它读作「同一份清单里的两条」而不是「两块东西的
// 交界」）、**组尾那段小字**说「这一组是怎么回事」。
//
// 组尾（`InsetNote`）不是装饰：解释性文字原来浮在正文里，与它解释的那组东西
// 隔着一段距离；放进组尾之后「离得近 = 有关系」这件事由排版本身承担，不用读者
// 自己连线。
//
// 分隔线的内缩量**按组给不按行给**（`sepInset`）：同一组里的行前导槽位一致
// （都有图标/头像，或都没有），所以一个值就够；给每行各自算反而会在同一张卡上
// 画出参差不齐的线头。

import type { ReactNode } from "react";
import { cn } from "@/lib/utils.js";

/** 组头那行小字。11px + 0.06em 字距是本仓既有的 SECTION_LABEL 口径 */
export function InsetLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("px-1 pt-4 pb-[7px] text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase", className)}>
      {children}
    </div>
  );
}

/** 组尾解释。挨着它解释的那一组，不飘在正文里 */
export function InsetNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("px-1 pt-[7px] text-[11.5px] leading-[1.5] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function InsetGroup({
  children,
  /** 分隔线左边内缩多少（对齐这一组行的文字起点）。有前导图标的组给 51px，
      有头像的给 58px；缺省 13px = 与行的左内边距对齐 */
  sepInset = 13,
  className,
}: {
  children: ReactNode;
  sepInset?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] bg-card",
        // 组内分隔线：挂在「除第一个之外的每个子元素」的伪元素上。
        // 子元素自己是 relative（InsetRow 保证），所以定位落在行内
        "[&>*+*]:before:absolute [&>*+*]:before:top-0 [&>*+*]:before:right-0 [&>*+*]:before:left-[var(--sep-inset)]",
        "[&>*+*]:before:h-px [&>*+*]:before:bg-border [&>*+*]:before:content-['']",
        className
      )}
      style={{ "--sep-inset": `${sepInset}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export type InsetRowTone = "default" | "action" | "danger";

/**
 * 一行。**能点的行按下就亮**（`active:` 而不是等 click 回来）——反馈落在按下那一刻
 * 是这套东西的地基，晚一步整条链的「直接感」就没了。
 *
 * 行用**高亮**不用缩放：一列行里某一行忽然缩小会把整列的基线打断，而按钮是独立
 * 元素、缩放读起来是「被按下去了」。两种反馈各归各的，别互换。
 */
export function InsetRow({
  leading,
  title,
  subtitle,
  trailing,
  chevron,
  onClick,
  tone = "default",
  disabled,
  className,
  ...rest
}: {
  /** 前导槽位：图标底座、头像，或什么都不放 */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  tone?: InsetRowTone;
  disabled?: boolean;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "onClick">) {
  const body = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span
          className={cn(
            "truncate text-[14px] leading-[1.35] tracking-[-0.006em]",
            tone === "action" && "text-brand",
            tone === "danger" && "text-err"
          )}
        >
          {title}
        </span>
        {subtitle !== undefined && subtitle !== null && (
          <span className="truncate text-[11.5px] leading-[1.4] text-muted-foreground">{subtitle}</span>
        )}
      </span>
      {trailing !== undefined && trailing !== null && (
        <span className="flex shrink-0 items-center gap-[7px] text-[12.5px] text-muted-foreground">{trailing}</span>
      )}
      {chevron && (
        <svg
          className="size-[15px] shrink-0 text-muted-foreground/60"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      )}
    </>
  );

  const shared = cn(
    "relative flex w-full items-center gap-[11px] px-[13px] py-[9px] text-left",
    "min-h-[46px] bg-transparent",
    tone === "danger" && "justify-center",
    className
  );

  if (!onClick) return <div className={shared} {...rest}>{body}</div>;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        shared,
        "transition-colors duration-100 active:bg-foreground/[0.055]",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      )}
      {...rest}
    >
      {body}
    </button>
  );
}

/** 行首那枚中性图标底座。**不上彩色方块**——本仓的颜色只用来说「出事了」
    （ADR-0209/0239/0240），给每个分区安一种彩色会把这条纪律稀释掉 */
export function InsetIcon({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-[27px] shrink-0 place-items-center rounded-[8px] bg-foreground/[0.09] text-muted-foreground [&>svg]:size-[15px]"
    >
      {children}
    </span>
  );
}

/** 空态。**一句「没有」要跟一句「那怎么办」**——只写「还没有 X」的空屏没告诉人下一步 */
export function InsetEmpty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-[8px] px-[18px] py-[26px] text-center">
      {icon && <span className="text-muted-foreground/50 [&>svg]:size-[32px]" aria-hidden>{icon}</span>}
      <span className="text-[13.5px]">{title}</span>
      {hint && <span className="max-w-[26em] text-[11.5px] leading-[1.5] text-muted-foreground">{hint}</span>}
    </div>
  );
}
