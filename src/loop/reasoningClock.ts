// 纯思考耗时的测量器 —— 从流式碎片的频道切换里读出「想了多久」。
//
// 为什么这个数必须落日志:日志里只有 assistant_message.ts(消息落盘时刻),
// 推不出思考从哪一刻开始。UI 若拿"上一条事件的 ts"去减,得到的是整次模型
// 调用耗时(思考 + 正文生成),标成"思考耗时"就是 UI 在编。硬规则要求投影
// 可从日志推导 —— 那就把事实写进日志,而不是让投影层猜(ADR-0032)。

import type { DeltaKind } from "../model/adapter.js";

export interface ReasoningClock {
  /** 每来一个流式碎片喂一次(只看频道,不看内容) */
  observe(kind: DeltaKind): void;
  /** 本次调用的纯思考耗时(ms)。没开过思考频道 = 没思考过 → null */
  finish(): number | null;
}

/** now 可注入:测试要确定的时钟。默认 Date.now */
export function createReasoningClock(now: () => number = Date.now): ReasoningClock {
  let start: number | null = null;
  let end: number | null = null;
  return {
    observe(kind) {
      // 无论这次碎片是否被计时采用都先取时刻:调用方按碎片顺序逐个喂,
      // 时钟必须逐次前进才能对应到真实的碎片到达顺序(用 ??= 短路会跳过
      // now() 调用,把后续碎片的时刻错位地记成更早的那个)
      const t = now();
      if (kind === "reasoning") {
        // 只认第一个:正文之后又冒出思考碎片时不重新计时,
        // 否则一次调用会算出好几段"思考",拼不成一个数
        if (start === null) start = t;
        return;
      }
      // 第一个正文碎片 = 思考结束那一刻。之后的正文是生成时间,不再改写
      if (start !== null && end === null) end = t;
    },
    finish() {
      if (start === null) return null;
      // 思考完直接收工(纯工具调用,一个正文碎片都没有):用收工时刻兜底
      return (end ?? now()) - start;
    },
  };
}
