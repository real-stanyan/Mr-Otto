// 上下文浮层底部的「套餐额度」段：ADR-0174 那两扇固定窗（5 小时 / 本周）+ 加购余额。
//
// 为什么挤进上下文那张卡，而不是给它自己一枚常驻控件：额度是**全账号**的，上下文是
// **这个会话**的，两件事；但用户问它们的时机是同一个——「我还能接着干吗」。给它第二枚
// 常驻控件要在输入框那条已经很挤的工具条上再占一格，而它多数时候是个不需要盯着的数。
// 代价写在这儿，免得下次有人当疏漏来修：**不悬停就看不见**；真用完那一下靠时间线上
// 那条 route_changed 说话（Timeline.tsx）。
//
// 数字是活的，这里却不 refresh 也不轮询：hostedQuota.noteHeaders 每次网关响应都把响应头
// 里的剩余额度换算成 usedMicro 推给渲染层（main/hostedQuota.ts → onBillingChanged），
// 所以只读 store 就够。判据是 `me.windows`：服务端只在订阅 active 时下发它，
// 非 active 时报一份满额度的窗口是谎话（services/edge/src/billingQueries.ts 的 meFromParts）。

import { useChat } from "../store.js";
import { useNow } from "../lib/useNow.js";
import {
  WINDOW_LABELS, addonLine, bindingWindow, countdown, liveWindow, planName, quotaTone, usageLine, windowPercent,
  type LiveWindow,
} from "../lib/billingView.js";
import { cn } from "@/lib/utils.js";

const TONE_BAR = { brand: "bg-brand", warn: "bg-warn", deny: "bg-deny" } as const;

/** 一扇窗：标签 + 用量一行，条一行（同设置页 WindowRow 的版式，尺寸按浮层收紧）。
    非当主的那扇整条走中性灰：一张卡里两条彩条会互相抢，而先拦住人的只有一扇。

    倒计时**只在当主那扇底下、单独一行**：三样东西挤一行时最长的形态
    （「4.1 / 6.7 credit · 2 小时 12 分后恢复」）会顶出这张 300px 的卡，标签跟着折行；
    而另一扇窗的恢复时刻本来也不是此刻要做决定的依据——真轮到它拦人时它就是当主的那扇。 */
function WindowRow({ label, w, primary, now }: { label: string; w: LiveWindow; primary: boolean; now: number }) {
  const pct = windowPercent(w);
  return (
    <div className="mt-[5px] first:mt-0">
      <div className="flex justify-between items-baseline gap-3 text-[11px]">
        <span className={primary ? "text-foreground/80" : "text-muted-foreground"}>{label}</span>
        <span className="font-mono tabular-nums text-muted-foreground whitespace-nowrap">{usageLine(w)}</span>
      </div>
      <div className="mt-[3px] h-[4px] overflow-hidden rounded-full bg-foreground/10">
        {/* 条宽会动（额度是活的），走 transition 不走 keyframes：下一帧数据到了要能就地改道 */}
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-[var(--ease-strong)]",
            primary ? TONE_BAR[quotaTone(pct)] : "bg-foreground/25",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {primary && (
        <div className="mt-[3px] text-[11px] text-muted-foreground">{countdown(w.resetAt, now)}</div>
      )}
    </div>
  );
}

export function PlanQuotaSection() {
  const me = useChat((s) => s.billing?.me ?? null);
  // 60 秒一跳：倒计时的最小刻度就是分钟，裸 Date.now() 只在挂载那一刻取一次。
  // 这个表只在浮层开着时走——Radix 的 TooltipContent 关着时整棵子树不挂载
  const now = useNow(60_000);

  if (!me?.windows) return null; // 没有活跃订阅 = 没有窗口可言
  const binding = bindingWindow(me.windows, now);
  const addon = addonLine(me.addon, now);
  const name = planName(me.plan);

  return (
    <div className="pt-[6px] border-t border-border">
      <div className="flex justify-between items-baseline gap-3 text-[11px] mb-[5px]">
        <span className="text-foreground/80">套餐额度</span>
        {name && <span className="font-mono tabular-nums text-muted-foreground">{name}</span>}
      </div>
      <WindowRow label={WINDOW_LABELS.h5} w={liveWindow(me.windows.h5, now)} primary={binding.key === "h5"} now={now} />
      <WindowRow label={WINDOW_LABELS.week} w={liveWindow(me.windows.week, now)} primary={binding.key === "week"} now={now} />
      {addon && <div className="mt-[6px] text-[11px] text-muted-foreground">{addon}</div>}
    </div>
  );
}
