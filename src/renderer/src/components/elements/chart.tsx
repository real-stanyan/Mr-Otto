"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { clamp, take } from "@/lib/range.js";

export type ChartVariant = "area" | "line" | "bars";

const W = 300;
const H = 88;
const PAD = 6;

const scale = (points: readonly number[]) => {
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  return (value: number) => H - PAD - ((value - min) / span) * (H - PAD * 2);
};

export function Chart({
  label,
  value,
  delta,
  points,
  visibleCount,
  variant = "area",
  stacks,
  layerClass,
  renderTip,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "label"
  | "value"
  | "delta"
  | "points"
  | "visibleCount"
  | "variant"
  | "stacks"
  | "layerClass"
  | "renderTip"
> & {
  label: string;
  value: string;
  delta?: string;
  points: readonly number[];
  /** 本仓改动:可省。原件靠它做"逐根长出来"的入场,省略即全部画出 */
  visibleCount?: number;
  variant?: ChartVariant;
  /**
   * 本仓改动:分层柱。stacks[i] = 第 i 根柱自下而上各层的值,和应当等于 points[i]
   * (高度仍由 points 定标 —— 分层只是把同一根柱切开,不改变纵轴)。
   * 只对 variant="bars" 生效;不给就是原件那种单色柱。
   */
  stacks?: readonly (readonly number[])[];
  /** 本仓改动:第 n 层的填色类名。配色归调用方 —— 元件只管几何,
      "哪个型号是哪个颜色"是业务语义,写死在元件里两边都别扭 */
  layerClass?: (layer: number) => string;
  /** 本仓改动:悬停第 i 根柱时浮窗里显示什么。不给就没有悬停这回事 */
  renderTip?: (index: number) => ReactNode;
}) {
  const shown = take(points, clamp(visibleCount ?? points.length, 1, points.length));
  const y = scale(points);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;

  const coords = shown.map((p, i) => ({ x: x(i), y: y(p) }));
  const line = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const last = coords.at(-1);
  const area = last
    ? `M ${PAD},${H - PAD} ${coords.map((c) => `L ${c.x},${c.y}`).join(" ")} L ${last.x},${H - PAD} Z`
    : "";
  const lastIndex = shown.length - 1;
  const falling = delta !== undefined && /^\s*[-−–]/.test(delta);
  const rising = delta !== undefined && !falling;
  // 本仓改动:悬停在哪一根柱上。null = 没悬停
  const [hover, setHover] = useState<number | null>(null);
  const baseY = H - PAD;

  return (
    <div
      data-slot="chart"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-baseline justify-between">
        <span className={cn(mono, "text-foreground/35")}>{label}</span>
        {delta !== undefined && (
          <span
            className={cn(
              mono,
              "tabular-nums",
              rising
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
            )}
          >
            {delta}
          </span>
        )}
      </div>

      {/* 本仓改动:value 传空串就不画这一行。原件的大数是这张卡的主语（画廊里
          它单独一张），而本仓把曲线挂在上下文浮层里，主语已经由上面那枚
          number-ticker 报过一遍了 —— 同一个数隔 100px 写两次，读者会以为是两件事 */}
      {value !== "" && (
        <span className="text-2xl font-medium tracking-tight tabular-nums">
          {value}
        </span>
      )}

      {/* 本仓改动:悬停浮窗要贴着某一根柱定位,得有个定位上下文 */}
      <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: ${value}`}
        className="h-[88px] w-full overflow-visible"
        preserveAspectRatio="none"
        {...(renderTip ? { onPointerLeave: () => setHover(null) } : {})}
      >
        <line
          x1="0"
          x2={W}
          y1={H - PAD}
          y2={H - PAD}
          className="stroke-foreground/[0.08]"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {variant === "bars" ? (
          shown.map((p, i) => {
            const top = y(p);
            const barWidth = Math.max(2, step * 0.55);
            const full = Math.max(1, baseY - top);
            const layers = stacks?.[i];
            // 本仓改动:分层时不再高亮最后一根。原件用"末柱变蓝"表达"这是今天",
            // 但分层之后颜色已经被型号占用了 —— 一根柱同时用颜色说两件事,
            // 读者只能猜哪一件才算数
            const flat = (
              <rect
                x={x(i) - barWidth / 2}
                y={top}
                width={barWidth}
                height={full}
                rx="1.5"
                className={cn(
                  "fade-in animate-in fill-mode-both duration-300",
                  stacks
                    ? "fill-foreground/25"
                    : i === lastIndex
                      ? "fill-blue-500 dark:fill-blue-400"
                      : "fill-foreground/25",
                )}
                style={{ animationDelay: `${i * 40}ms` }}
              />
            );
            if (!layers || p <= 0) return <g key={i}>{flat}</g>;

            // 自下而上摞:每层高度按它在本柱里的占比,总高仍是 points[i] 定的那个
            let cursor = baseY;
            return (
              <g key={i}>
                {layers.map((v, li) => {
                  if (v <= 0) return null;
                  const h = (v / p) * full;
                  cursor -= h;
                  return (
                    <rect
                      key={li}
                      x={x(i) - barWidth / 2}
                      y={cursor}
                      width={barWidth}
                      height={h}
                      // 只给最上面那层圆角:每层都圆会摞成一串药丸
                      rx={li === layers.length - 1 ? 1.5 : 0}
                      className={cn(
                        "fade-in animate-in fill-mode-both duration-300",
                        layerClass?.(li) ?? "fill-foreground/25",
                        hover !== null && hover !== i && "opacity-45",
                      )}
                      style={{ animationDelay: `${i * 40}ms` }}
                    />
                  );
                })}
              </g>
            );
          })
        ) : (
          <>
            {variant === "area" && shown.length > 1 && (
              <path
                d={area}
                className="fill-blue-500/12 dark:fill-blue-400/15"
              />
            )}
            <polyline
              points={line}
              fill="none"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="stroke-blue-500 dark:stroke-blue-400"
            />
            {last && (
              <circle
                cx={last.x}
                cy={last.y}
                r="3"
                className="fill-blue-500 dark:fill-blue-400"
              />
            )}
          </>
        )}

        {/* 本仓改动:整列透明命中区。只对柱子本身做 hover 的话,矮柱几乎点不着 ——
            一根 2px 高的柱要求用户把鼠标停在底边那一线上 */}
        {renderTip &&
          shown.map((_, i) => (
            <rect
              key={`hit-${i}`}
              x={x(i) - step / 2}
              y={0}
              width={Math.max(step, 4)}
              height={H}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
            />
          ))}
      </svg>

      {renderTip &&
        hover !== null &&
        (() => {
          const frac = x(hover) / W;
          // 靠边的柱子改成侧贴,不居中:浮窗比一根柱宽得多,居中会有一半探到卡片外,
          // 而外面那层卡是 overflow-hidden —— 探出去的部分直接被切掉
          const shift = frac < 0.25 ? "0" : frac > 0.75 ? "-100%" : "-50%";
          return (
            <div
              style={{ left: `${frac * 100}%`, transform: `translateX(${shift})` }}
              className="pointer-events-none absolute top-0 z-10 w-max max-w-[240px] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11.5px] shadow-md duration-150 ease-out fade-in-0 animate-in"
            >
              {renderTip(hover)}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
