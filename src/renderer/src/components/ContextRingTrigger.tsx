// 输入框右下角那枚环，外加它右上角那枚**额度告警点**（#1073）。
//
// 病在哪：那枚环只反映**上下文**，而额度是唯一会真正把人拦住的那一个（上下文满了
// 还能压缩）。额度只画在浮层里，不悬停就看不见 —— 于是「额度用完」那一刻，静息
// 界面上一个字都不说（ADR-0209 的注释早就承认了，#1071 重做那张卡时也没动）。
//
// 为什么是**一枚点**不是「环外补一道弧」（#1073 标题里那个做法）：两道弧同心、
// 同宽、只差一两个像素，而上下文 >75% 时走的也是 warn —— 最坏形态是「橙内环 +
// 橙外弧」，那时人分不出是哪一个在告警，而这个点存在的全部理由就是让人一眼知道
// **是额度出事了**。点的形状与位置都和环不同，橙环 + 橙点仍然分得开。代价是它
// 不报量级；量级由悬停后那两只 62px 的表回答，这个点只负责说「去看一眼」。
//
// 三条实现判据：
//
// ① 判据一律走 `quotaAlert`（lib/billingView.ts）—— `null`（还没查到）不画、
//    没订阅不画、色档与浮层那两只表共用同一组阈值。理由写在那个函数头上。
// ② **点是装饰，话挂在钮的 aria-label 上**。给点自己加 title 的话，原生气泡会
//    跟这枚钮的富浮层抢同一次悬停（那正是这枚钮当初不给 title 的理由）。
// ③ 光环取 `paper`（lib/surfaces.tsx，输入框那张纸的底色）而不是 `ring-background`：
//    深色下那张纸是 popover 不是 background，抄错一个 token 就是常年挂着一圈
//    看得见的浅边。它顺带把点与环隔开 —— 18px 的环塞在 24px 的钮里，对角上
//    只剩三个多像素，不打光环两者会糊在一起。
//
// 表：60 秒一跳。`exhausted` 的记号与 5h 窗都会自己到点失效，而这枚钮是常驻的
// （不像浮层，关着时整棵子树不挂载）—— 不走表的话，一个睡了一觉回来的人会对着
// 一个早就恢复了的红点，而**常年挂着的假警报比不报更坏**。作用域就在这个组件里，
// 每分钟重渲的只有这一枚钮。

import { useChat } from "../store.js";
import { useNow } from "../lib/useNow.js";
import { quotaAlert } from "../lib/billingView.js";
import {
  ContextDisplayTrigger,
  ContextDisplayRingVisual,
} from "./assistant-ui/context-display.js";
import { cn } from "@/lib/utils.js";

/** 颜色只用来说「出事了」，所以这张表里没有第三档 */
const TONE_DOT = { warn: "bg-warn", deny: "bg-deny" } as const;

export function ContextRingTrigger() {
  const billing = useChat((s) => s.billing);
  const now = useNow(60_000);
  const alert = quotaAlert(billing, now);

  return (
    <ContextDisplayTrigger
      className="relative p-[3px] hover:bg-foreground/[0.07]"
      aria-label={alert ? `上下文用量详情 · ${alert.label}` : "上下文用量详情"}
    >
      <ContextDisplayRingVisual />
      {alert && (
        <span
          data-testid="quota-alert-dot"
          data-tone={alert.tone}
          aria-hidden="true"
          className={cn(
            "absolute right-[1px] top-[1px] size-[6px] rounded-full ring-2 ring-background dark:ring-popover",
            TONE_DOT[alert.tone],
          )}
        />
      )}
    </ContextDisplayTrigger>
  );
}
