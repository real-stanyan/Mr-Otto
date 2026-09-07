// 账号页底部那张「使用情况」卡（#1022）：左边会话热力图，右边本周各模型的 token 占比。
//
// **为什么是一张卡两半，中间一条发丝线**：一张卡里放两件事，要么有线要么就该是
// 两张卡 —— 中间那片没交代的空地是最难看的第三种（分法与订阅卡里两扇窗一致）。
// 两半共用一副骨架：标题行 / 内容 / 一行脚注，脚注靠 `mt-auto` 压到底，于是两边
// 高矮不齐也不散架；热力图在头脚之间垂直居中，型号多几行不会把左边拽歪。
//
// **两半的口径不同，各自说出口，不硬对齐**：
//   · 左：只数这台电脑上**你自己开的主会话**（子会话不算 —— 派一次活热力图就多
//     一格的话，它说的不再是「你开过多少会话」，issue #141）；云端工作区会话
//     从不写本机日志（cloudSessionClient.ts），所以不在图里。
//   · 右：算**所有**计费调用（含子会话派出去的、含已归档会话）。
// 两个数摆同一张卡上必然被读成该对得上，所以两行脚注各写各的。
//
// **右边只报占比不报 token 数也不报钱**：钱那一列要同时处理 `$`（自带 key）、
// `credit`（托管）、`—`（查不到价）、`托管`（没记到）四种写法，而占比只有一种；
// 代价是占比按 token 算不是按钱算 —— 写在脚注里。
//
// **行本身就是条**：底色按占比从左边铺过去。原来那版是名字和一根灰细线隔着半张卡
// 遥遥相望，眼睛连不起来，而且那根线细得像分隔线不像数据。

import { useEffect, useMemo } from "react";

import { ActivityGraph, ActivityLegend } from "@/components/elements/activity-graph.js";
import { cn } from "@/lib/utils.js";
import { mono } from "../lib/surfaces.js";
import { sessionActivity } from "../../../shared/sessionActivity.js";
import type { ModelShareRow } from "../../../shared/modelShare.js";
import { usageWindowLabel, weeklyUsageWindow } from "../lib/usageWindow.js";
import { ProviderMark } from "./ProviderMark.js";
import { useChat } from "../store.js";

/** 一半的骨架：标题行 / 内容 / 脚注（脚注压到底，两半的小字落在同一条基线上） */
function Half({ title, meta, children, foot, className }: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  foot: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-[10px]", className)}>
      <div className="flex items-baseline justify-between gap-[10px]">
        <span className="text-[12.5px] font-[550]">{title}</span>
        {meta && <span className={cn(mono, "tabular-nums text-muted-foreground")}>{meta}</span>}
      </div>
      {children}
      <div className="mt-auto flex items-center justify-between gap-[14px] pt-[2px] text-[11px] leading-[1.5] text-foreground/40">
        {foot}
      </div>
    </div>
  );
}

/** 一行 = 一根条：底色按占比从左边铺，名字与占比压在上面 */
function ShareRow({ row }: { row: ModelShareRow }) {
  return (
    <div className="relative flex h-[30px] items-center gap-[10px] overflow-hidden rounded-[8px] px-[10px] text-[12.5px]">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-[8px] bg-foreground/[0.08] transition-[width] duration-300 ease-[var(--ease-strong)]"
        style={{ width: `${row.share}%` }}
      />
      {/* 认不出厂商的型号画一枚中性方块：**硬塞进某一家比不画更坏** */}
      {row.provider ? (
        <ProviderMark provider={row.provider} size={18} className="relative shrink-0" />
      ) : (
        <span className="relative size-[18px] shrink-0 rounded-[5px] bg-foreground/10" />
      )}
      <span className="relative min-w-0 flex-1 truncate">{row.label}</span>
      <span className={cn(mono, "relative shrink-0 text-[12px] tabular-nums text-foreground/80")}>
        {row.share.toFixed(1)}%
      </span>
    </div>
  );
}

export function AccountUsageCard() {
  const sessions = useChat((s) => s.sessions);
  const weekResetAt = useChat((s) => s.billing?.me?.windows?.week.resetAt ?? null);
  const share = useChat((s) => s.modelShare);
  const refreshModelShare = useChat((s) => s.refreshModelShare);

  // 只数主会话:子会话(spawnedFrom!=null)是主 agent 派活的产物,不是"人开的会话"——
  // 数进去的话派一次活热力图就多一格(issue #141)
  const roots = useMemo(() => sessions.filter((s) => s.spawnedFrom === null), [sessions]);
  // now 每次渲染取一次就够:这张图的粒度是"天",一次渲染里的毫秒差不会换格子
  const activity = useMemo(() => sessionActivity(roots, Date.now()), [roots]);

  // 窗口起点只在额度快照变化时重算：进了依赖的 Date.now() 会让 effect 每帧重跑
  const window = useMemo(() => weeklyUsageWindow(weekResetAt, Date.now()), [weekResetAt]);
  useEffect(() => {
    void refreshModelShare(window.since);
  }, [refreshModelShare, window.since]);

  const hasGraph = activity.total > 0;
  // null = 还没查过（画骨架都不必，这一页不做加载态）；0 = 这一周真的一次没调过
  const hasShare = share !== null && (share.rows.length > 0 || share.totalTokens > 0);

  // 一个会话都没有、这一周也一次没调过就整张不画:一整片空格子在说"你什么都没干过",
  // 而真相通常是"这台机器刚装好"
  if (!hasGraph && !hasShare) return null;

  return (
    <section className="flex flex-col gap-[7px]">
      <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">使用情况</h2>
      <div className="rounded-[14px] border border-border bg-card p-4">
        <div className={cn("grid gap-[26px]", hasGraph && hasShare && "grid-cols-[auto_minmax(0,1fr)]")}>
          {hasGraph && (
            <Half
              title="会话记录"
              meta={`${activity.total} 个 · 近半年`}
              foot={
                <>
                  <span>只算这台电脑上你自己开的会话，云端不在图里</span>
                  <ActivityLegend />
                </>
              }
            >
              {/* 图在两条对齐的头/脚之间垂直居中：右边型号多几行时左边不会看起来掉下去 */}
              <div className="flex flex-1 items-center">
                <ActivityGraph data={activity.data} start={activity.start} end={activity.end} />
              </div>
            </Half>
          )}

          {hasShare && share && (
            <Half
              className={hasGraph ? "border-l border-border pl-[26px]" : undefined}
              title={usageWindowLabel(window)}
              meta="按 token 计"
              foot={<span>占比按 token 不按钱；含子智能体派出去的调用与已归档的会话</span>}
            >
              <div className="flex flex-col gap-[3px]">
                {share.rows.map((r) => (
                  <ShareRow key={r.model} row={r} />
                ))}
                {/* 没进前 N 的合成一行说出来，不静默截断 */}
                {share.rest.models > 0 && (
                  <div className="flex h-[30px] items-center gap-[10px] px-[10px] text-[11.5px] text-muted-foreground">
                    <span className="size-[18px] shrink-0" />
                    <span className="min-w-0 flex-1 truncate">其余 {share.rest.models} 款</span>
                    <span className={cn(mono, "shrink-0 tabular-nums")}>{share.rest.share.toFixed(1)}%</span>
                  </div>
                )}
                {share.rows.length === 0 && (
                  <p className="text-[12px] text-muted-foreground">这一周还没有调用记录。</p>
                )}
              </div>
            </Half>
          )}
        </div>
      </div>
    </section>
  );
}
