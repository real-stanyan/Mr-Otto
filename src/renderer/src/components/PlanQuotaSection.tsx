// 上下文浮层**顶上**那段「套餐额度」：本周那扇窗，画成一只表（#1392 / ADR-0324 之前是 5h + 本周
// 并排两只）。
//
// 为什么挤进上下文那张卡，而不是给它自己一枚常驻控件：额度是**全账号**的，
// 上下文是**这个会话**的，两件事；但用户问它们的时机是同一个——「我还能接着干吗」。
// 代价写在这儿，免得下次有人当疏漏来修：**不悬停就看不见**；真用完那一下靠
// 时间线上那条 route_changed 说话（Timeline.tsx）。
//
// 三条判据（每条都是被否掉的另一条路的反面）：
//
// ① **吃紧由颜色说，不由大小说**——那只表变色，布局一个像素都不动。
//    （两扇窗那时候是平级并排、谁先拦住人谁变色；只剩一扇之后这条照旧成立。）
// ② **环填「剩余」，色档按「已用」判**——与设置页、上下文环共用的那组阈值
//    （>90 危 / >75 警，ADR-0239 决定 1）。填已用的话，闲着的账号是两只几乎
//    空的环，在屏幕上和「组件坏了」一样（#1026 那笔账）；同一件事的两个说法，
//    判据只能有一份。**充足时是中性灰不是品牌蓝**：颜色在这两处只用来说「出事了」。
// ③ **清零的窗不画倒计时**。窗口过了 resetAt 之后，下一段的刷新时刻要等网关下一次
//    回话才知道，原来那版会同时说「100.0% 可用」和「已恢复」，两行自相矛盾，
//    读者得停下来想一秒。
//
// 数字是活的，这里却不 refresh 也不轮询：hostedQuota.noteHeaders 每次网关响应都把响应头
// 里的剩余额度换算成 usedMicro 推给渲染层（main/hostedQuota.ts → onBillingChanged），
// 所以只读 store 就够。判据是 `me.windows`：服务端只在订阅 active 时下发它，
// 非 active 时报一份满额度的窗口是谎话（services/edge/src/billingQueries.ts 的 meFromParts）。

import { useChat } from "../store.js";
import { useNow } from "../lib/useNow.js";
import {
  WINDOW_LABELS, addonLine, countdown, fmtRemainingPercent, liveWindow, planBadge,
  quotaTone, remainingPercent, usageTitle, windowPercent,
  type LiveWindow,
} from "../../../shared/billingView.js";
import { PlanBadge } from "./PlanBadge.js";
import { cn } from "@/lib/utils.js";

/** 环的几何。62px 是环心还写得下「100.0%」的尺寸（当初按两只并排塞进 300px 卡里定的，只剩一只之后没改） */
const RING = 62;
const STROKE = 4.5;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 弧色与数字色。充足 = 中性灰（同 TONE_BAR 那张表的 `bg-foreground/40`）*/
const TONE_ARC = { brand: "stroke-foreground/40", warn: "stroke-warn", deny: "stroke-deny" } as const;
const TONE_NUM = { brand: "text-foreground", warn: "text-warn", deny: "text-deny" } as const;

function QuotaGauge({ label, w, now }: { label: string; w: LiveWindow; now: number }) {
  const tone = quotaTone(windowPercent(w));
  const left = remainingPercent(w);
  return (
    <div className="flex flex-1 flex-col items-center gap-1 pt-[2px]" title={usageTitle(w)}>
      <div className="relative" style={{ width: RING, height: RING }}>
        <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="-rotate-90" aria-hidden="true">
          <circle cx={RING / 2} cy={RING / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-foreground/10" />
          {/* 弧长会动（额度是活的），走 transition 不走 keyframes：下一帧数据到了要能就地改道 */}
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE - (left / 100) * CIRCUMFERENCE}
            className={cn("transition-[stroke-dashoffset,stroke] duration-300 ease-[var(--ease-strong)]", TONE_ARC[tone])}
          />
        </svg>
        {/* 环心两行：数 + 「可用」。只写一个百分数会读成「已用」——填的是剩余，
            那个字必须在场 */}
        <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span className={cn("text-[13px] font-[590] tabular-nums tracking-[-0.02em]", TONE_NUM[tone])}>
            {fmtRemainingPercent(w)}
          </span>
          <span className="mt-[1.5px] text-[9px] tracking-[0.04em] text-muted-foreground">可用</span>
        </div>
      </div>
      <span className="text-[11px] text-foreground/80">{label}</span>
      {/* 清零的窗没有「几点恢复」可言（判据 ③） */}
      {!w.rolled && <span className="text-[10.5px] text-muted-foreground">{countdown(w.resetAt, now)}</span>}
    </div>
  );
}

export function PlanQuotaSection() {
  const me = useChat((s) => s.billing?.me ?? null);
  // 60 秒一跳：倒计时的最小刻度就是分钟，裸 Date.now() 只在挂载那一刻取一次。
  // 这个表只在浮层开着时走——Radix 的 TooltipContent 关着时整棵子树不挂载
  const now = useNow(60_000);

  if (!me?.windows) return null; // 没有活跃订阅 = 没有窗口可言
  const addon = addonLine(me.addon, now);

  // 这一段现在住在卡片**最上面**，所以分隔线挂在自己下沿：它 return null 那天，
  // 线跟着一起消失，下面那半不用知道上面有没有画（调用方判分支迟早会漏一种）
  return (
    <div className="mb-[8px] border-b border-border pb-[7px]">
      <div className="mb-[2px] flex items-center justify-between gap-3">
        <span className="text-[11px] text-foreground/80">套餐额度</span>
        {/* 档位徽章走仓库那一张色表（ADR-0240）：「Lite 是什么颜色」的答案只能有一份。
            传 planBadge(me) 的 id 不是 me.plan —— null（还没查到）不许退成 Free */}
        <PlanBadge id={planBadge(me)} />
      </div>
      <div className="flex">
        <QuotaGauge label={WINDOW_LABELS.week} w={liveWindow(me.windows.week, now)} now={now} />
      </div>
      {addon && <div className="mt-[6px] text-[11px] text-muted-foreground">{addon}</div>}
    </div>
  );
}
