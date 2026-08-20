// 侧栏会话前面那颗小球。状态判定在 lib/sessionOrb.ts（有测试钉着），
// 这里只管画：颜色 + 动效各自说一件事。
//
// 为什么是一颗球而不是一行字：原来那行「8/20/2026 · 133 条 运行中」把三件事
// 挤在同一行里，而其中两件（日期、条数）没人会照着它做决定。状态是唯一会
// 改变你下一步动作的那一件，给它一个不占宽度、扫一眼就看见的位置。
//
// 动效分两种，不是同一个动作换颜色：
//   · 运行中 = 往外扩的环（ping）—— 有东西正在发生
//   · 等你处理 = 整颗呼吸（pulse）—— 它停在那儿，等的是你
// 一个是"它在动"，一个是"它不动了"，用同一个动效会把这两件事讲成一件。

import { cn } from "@/lib/utils.js";
import { orbLabel, type OrbState } from "@/lib/sessionOrb.js";

export function SessionOrb({ state, className }: { state: OrbState; className?: string }) {
  const label = orbLabel(state);
  return (
    <span
      className={cn("relative flex size-[7px] shrink-0", className)}
      title={label}
      role="img"
      aria-label={label}
    >
      {state === "running" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60 motion-reduce:hidden" />
      )}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          state === "running" && "bg-brand",
          state === "waiting" && "bg-warn animate-pulse motion-reduce:animate-none",
          // 闲着的那颗不隐身:整列都没有球的时候,有球的那几行会显得是"多出来的";
          // 留一颗暗的,列对得齐,状态是"颜色变了"而不是"多长出一个东西"
          state === "idle" && "bg-foreground/20",
        )}
      />
    </span>
  );
}
