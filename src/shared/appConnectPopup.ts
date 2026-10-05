// 连接卡发来时手机该不该自动弹窗（#1666，spec §4.2）。纯判据零 IO，弹不弹只有这一处说了算。
//
// 「只弹一次、翻历史不弹」：
//   · 只弹**这一页看着的时候新来的**卡——seq 要大于「这一页第一次拿到完整日志时的最大 seq」（baselineSeq）。
//     点进会话翻出来的老卡躺在日志里，它们只是卡，不弹；
//   · 一张卡只弹一回（popped 记着）：人点了「稍后」，卡还在会话里，想连自己点，不再追着弹；
//   · 页面不在前台（别的页盖在上面 / app 在后台）不弹——弹了他也看不见，等他回来再弹就成了「翻历史」；
//   · 一张都不符合就是 null；符合的取 seq 最大的（最新那张），别的留在卡上。
// 「此刻已经有弹窗 / 接入弹窗开着」这类界面状态不在这里判：调用方持有它们。
import type { ChatRow } from "./mobileChat.js";

export function popupCandidate(
  rows: readonly ChatRow[],
  o: { baselineSeq: number; popped: ReadonlySet<string>; focused: boolean },
): Extract<ChatRow, { kind: "app_connect" }> | null {
  if (!o.focused) return null;
  let best: Extract<ChatRow, { kind: "app_connect" }> | null = null;
  for (const r of rows) {
    if (r.kind !== "app_connect") continue;
    if (r.seq <= o.baselineSeq || r.status !== "open" || !r.canAct || o.popped.has(r.connectId)) continue;
    if (best === null || r.seq > best.seq) best = r;
  }
  return best;
}
