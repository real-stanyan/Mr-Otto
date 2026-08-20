"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { take } from "@/lib/range.js";

export interface MathStep {
  expression: React.ReactNode;
  note?: string;
}

export function MathBlock({
  label,
  steps,
  visibleSteps,
  className,
  expressionClassName = "font-serif text-[17px] italic",
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "label" | "steps" | "visibleSteps"
> & {
  label?: string;
  steps: readonly MathStep[];
  visibleSteps: number;
  /** 本仓改动:算式那一行的排版可换掉。原件自带 font-serif italic ——
      它演示的是手写的 Frac/Sup/Sub（本文件下面那几个），衬线斜体正是数学书的样子；
      而本仓喂进来的是 KaTeX 渲染好的 DOM，它自带 KaTeX_Main 那一整套字体与斜体规则，
      外面再压一层衬线斜体是两套排版打架。传空串即可让位 */
  expressionClassName?: string;
}) {
  return (
    <div
      data-slot="math-block"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-2.5 rounded-2xl p-4",
        className,
      )}

      {...props}
    >
      {label && <span className={cn(mono, "text-foreground/30")}>{label}</span>}

      {take(steps, visibleSteps).map((step, i) => (
        <div
          key={i}
          className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex flex-col gap-1 duration-300"
        >
          <span
            className={cn(
              "text-foreground/90 block overflow-x-auto py-1 text-center leading-relaxed",
              expressionClassName,
            )}
          >
            {step.expression}
          </span>
          {step.note && (
            <span className={cn(mono, "text-foreground/30 text-center")}>
              {step.note}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function Frac({
  over,
  under,
}: {
  over: React.ReactNode;
  under: React.ReactNode;
}) {
  return (
    <span
      data-slot="frac"
      className="inline-flex flex-col items-center align-middle text-[0.85em] leading-tight"
    >
      <span className="px-1">{over}</span>
      <span className="border-foreground/40 w-full border-t px-1">{under}</span>
    </span>
  );
}

export function Sup({ children }: { children: React.ReactNode }) {
  return <sup className="text-[0.65em] not-italic">{children}</sup>;
}

export function Sub({ children }: { children: React.ReactNode }) {
  return <sub className="text-[0.65em] not-italic">{children}</sub>;
}
