// 上下文占用估计 — 圆环的数据源。
// 精确占用只有下一次 API 账单知道；此前圆环冻结在"上次账单"上——
// 一条几十 KB 的 tool_result 落地后环纹丝不动，直到下次模型调用才跳变。
// 校准 = 已计费锚点（真实账单）+ 锚点之后未计费事件的字符估算（会进下一次 prompt 的那些）。
// 纯函数放 shared：渲染层用、测试逼边界，都不碰运行时。

import type { SessionEvent } from "../session/events.js";

/** 粗粒度 token 估算：CJK ≈ 0.6 token/字，其余 ≈ 4 字符/token。
    校准用途，不求精确——离真值 ±30% 也比"冻结到上次账单"诚实。
    按码点数（for..of），不用 .length：surrogate pair 别算成两个字符 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    // CJK 统一表意 + 日文假名/标点 + 全角区
    if (/[　-ヿ一-鿿＀-￯]/.test(ch)) cjk++;
    else rest++;
  }
  return Math.ceil(cjk * 0.6 + rest / 4);
}

/** 当前上下文占用估计。
    锚点：最近一次带 usage 的事件（API 报的账单，事实）；compact 锚点 = 摘要体积
    （之后历史只剩摘要）。尾巴：锚点之后会进入下一次 prompt 的事件，按字符估算——
    投影会丢弃的 human-only 事件（审批、turn_ended、reasoning…）不计。 */
export function contextUsed(events: SessionEvent[]): number {
  let anchor = 0;
  let anchorIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.type === "assistant_message" || e.type === "context_compacted") && e.usage) {
      anchor =
        e.type === "context_compacted"
          ? e.usage.completionTokens
          : e.usage.promptTokens + e.usage.completionTokens;
      anchorIdx = i;
      break;
    }
  }

  let pending = 0;
  for (let i = anchorIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    switch (e.type) {
      case "user_message":
        pending += estimateTokens(e.content);
        break;
      case "tool_result":
        pending += estimateTokens(e.output);
        break;
      case "skill_invoked":
        pending += estimateTokens(e.content); // 投影成 user 消息进上下文，得计
        break;
      case "image_described":
        pending += estimateTokens(e.content); // 同上:代读文本注入为 user 消息
        break;
      case "assistant_message":
        // 只有 API 没回账单的消息才落到估算侧（回了账单它就是锚点）
        pending += estimateTokens(e.content) + estimateTokens(JSON.stringify(e.toolCalls ?? []));
        break;
      default:
        break;
    }
  }
  return anchor + pending;
}
