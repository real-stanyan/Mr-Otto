"use client";

// 来自 assistant-ui registry: elements-image-generation
// (https://r.assistant-ui.com/elements-image-generation.json)
// 取回于 2026-08-27（registry 不发版本号，只能记日期：升级时拿这个日期之后的
// upstream diff 对着下面这份改动一览人工合）
//
// 本仓改动一览（升级时要人工合）：
//  ① surfaces 从 @/lib/surfaces.js 引（上游是同目录 ./surfaces）。
//  ② **收 src，真显示图片**。上游那张卡从头到尾没有 <img>：generating 时画点阵，
//     完成态画的是一坨写死的 oklch 渐变 —— 它是官网上的一个视觉演示，不是
//     一个能显示图的元件。本仓拿它装的是工具真产出的图（#594），所以完成态
//     必须是图本身；那坨渐变降级成"ref 有了、data URL 还没读回来"的占位。
//  ③ 尺寸标签用 img 的 naturalWidth × naturalHeight，读不到就不显示。
//     上游写死 "1024 × 1024" —— 生成出来的图不一定是这个尺寸，
//     写死一个数字是在对着用户撒谎，而这行字的全部价值就是可信。
//  ④ 去掉 aspect-square：出图不一定是方的，方框会把非方图裁掉或留两条黑边。
//  ⑤ 去掉 Regenerate 按钮，改成点卡就地看大图。本仓接不上"重新生成"——
//     工具调用是模型发起的，那颗按钮点了没有东西可接，摆一颗点不动的按钮
//     比没有按钮更糟。就地摊开的交互语义同 message-attachment 本仓改动 ②
//     和 artifact-card 本仓改动 ②：东西本来就在手边，另开一层浮窗是白绕一圈。
//  ⑥ 展开/收起**不做动效**，只有图自己的淡入。时间线是刻意静止的界面
//     （同 artifact-card 本仓改动 ③）；而且展开改的是尺寸 = 布局动画，
//     它既不便宜也不好看。上游那段 1000ms 的 blur→sharp 收到 500ms：
//     UI 动效超过 300ms 就开始显慢，这条是内容首次出现所以放宽，但不到一秒。
//  ⑦ 缺图态（附件库文件丢了）画成一张空框 + 一行说明，而不是返回 null：
//     日志里记着这次产出过一张图，界面上凭空少一块等于日志在说谎。

import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper, pressable, ShimmerLabel } from "@/lib/surfaces.js";

const DOTS = Array.from({ length: 64 }, (_, i) => i);

export function ImageGeneration({
  prompt,
  generating,
  src,
  lost = false,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "prompt" | "generating" | "src" | "lost"
> & {
  /** 卡下面那行字。上游叫 prompt（他们的场景就是出图提示词），本仓传的是
      调用方能拿到的最好的一句说明：工具参数里的 prompt，没有就退到文件名 */
  prompt: string;
  /** true = 还没拿到图（本仓语义：ref 有了，data URL 还在路上） */
  generating: boolean;
  /** 图本身（data URL）。generating 时不给 */
  src?: string;
  /** 附件库里那份文件丢了。与 generating 互斥——一个是"还没到"，一个是"到不了" */
  lost?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // 尺寸只有图真的解出来才知道；解不出来就不显示这行（本仓改动 ③）
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const openable = src !== undefined && !generating && !lost;

  return (
    <div
      data-slot="image-generation"
      className={cn(
        "flex flex-col gap-2.5",
        expanded ? "w-full" : "w-52",
        className,
      )}
      {...props}
    >
      <div
        {...(openable
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-expanded": expanded,
              "aria-label": expanded ? "收起图片" : "查看大图",
              onClick: () => setExpanded((v) => !v),
              onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setExpanded((v) => !v);
              },
            }
          : {})}
        className={cn(
          paper,
          "relative w-full overflow-hidden rounded-2xl outline-none",
          // 收起时是缩略图，撑成方块；展开后按原图比例，不裁不留边（本仓改动 ④）
          expanded ? "min-h-24" : "aspect-square",
          openable &&
            "cursor-zoom-in focus-visible:ring-1 focus-visible:ring-foreground/20",
          // 展开后不再按压缩放：里面是要盯着看的东西（同 artifact-card）
          openable && !expanded && pressable,
        )}
      >
        {/* 点阵：图没到位时守住这块地方不塌版。上游那份逐点错开的延迟保留 */}
        <div
          className="absolute inset-0 grid grid-cols-8 place-items-center p-6"
          aria-hidden
        >
          {DOTS.map((dot) => {
            const row = Math.floor(dot / 8);
            const col = dot % 8;
            return (
              <span
                key={dot}
                className={cn(
                  "bg-foreground/20 size-1 rounded-full transition-opacity duration-500",
                  generating
                    ? "animate-pulse motion-reduce:animate-none"
                    : "opacity-0",
                )}
                style={{ animationDelay: `${(row + col) * 90}ms` }}
              />
            );
          })}
        </div>

        {lost ? (
          <div className="text-foreground/45 absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-4 text-center">
            <ImageOff className="size-4" />
            <span className="text-xs">图片文件已丢失</span>
          </div>
        ) : (
          src !== undefined && (
            <img
              src={src}
              alt={prompt}
              onLoad={(e) =>
                setDims({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
              className={cn(
                "relative block w-full",
                expanded ? "max-h-[520px] object-contain" : "h-full object-cover",
                // blur → sharp：图不是"啪"一下出现的，它是解出来的（本仓改动 ⑥）
                "transition-[opacity,filter] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                generating ? "opacity-0 blur-xl" : "blur-0 opacity-100",
              )}
            />
          )
        )}

        {dims !== null && !generating && !lost && (
          <span
            className={cn(
              mono,
              "absolute end-2.5 top-2.5 rounded-full bg-black/35 px-1.5 py-0.5 tabular-nums text-white/80",
            )}
          >
            {dims.w} × {dims.h}
          </span>
        )}
      </div>

      {/* 上游在 generating 时把说明整个换成 "Generating"；本仓给同一行字加
          shimmer 而不是换词 —— 这一档在本仓只持续到 data URL 读回来（几十毫秒），
          换词会看成闪一下的抖动，而且那行字本来就是这张图的说明，没有理由藏起来 */}
      <p className="text-foreground/45 min-w-0 truncate text-xs">
        <ShimmerLabel active={generating} className="relative">
          {prompt}
        </ShimmerLabel>
      </p>
    </div>
  );
}
