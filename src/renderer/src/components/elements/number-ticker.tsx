"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { mono } from "@/lib/surfaces.js";

function RollingDigit({ digit }: { digit: number }) {
  return (
    <span className="inline-flex h-[1.15em] overflow-hidden">
      <span
        className="flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ transform: `translateY(-${digit * 1.15}em)` }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="h-[1.15em] leading-[1.15]">
            {i}
          </span>
        ))}
      </span>
    </span>
  );
}

export function NumberTicker({
  value,
  label,
  format,
  className,
  valueClassName = "text-3xl",
  ...props
}: Omit<ComponentProps<"div">, "children" | "value" | "label"> & {
  value: number;
  /** 本仓改动:改成可选。上下文浮层那处把说明挪到了数字**右边**同一条基线上
      （原来在底下），标题位就只剩数字本身;缺席时那个 span 整个不画,
      免得 gap 在下面留一条看不出来源的空白 */
  label?: string | undefined;
  /** 本仓改动:数字怎么写可换。默认逗号分组;上下文浮层传 fmtCtx 走 K/M 那一路
      —— 同一张卡上只有最大那个数用逗号分组的话,读者要换两次读法。
      滚动照旧:格式化之后逐字符过 RollingDigit,数字位滚、`.`/`K` 静止 */
  format?: ((n: number) => string) | undefined;
  /** 本仓改动:数字号数可换。原件写死 text-3xl（画廊里它独占一屏），
      本仓把它放进一枚 300px 的浮层做标题，3xl 会把整张卡压塌 */
  valueClassName?: string;
}) {
  const formatted = format ? format(value) : value.toLocaleString("en-US");

  return (
    <div
      data-slot="number-ticker"
      className={cn("flex flex-col items-center gap-2.5", className)}

      {...props}
    >
      <span
        className={cn(
          "flex font-medium tracking-tight tabular-nums",
          valueClassName,
        )}
        aria-label={formatted}
      >
        {formatted.split("").map((char, i) =>
          /\d/.test(char) ? (
            <RollingDigit key={i} digit={Number(char)} />
          ) : (
            <span key={i} className="h-[1.15em] leading-[1.15]">
              {char}
            </span>
          ),
        )}
      </span>
      {label !== undefined && <span className={cn(mono, "text-foreground/35")}>{label}</span>}
    </div>
  );
}
