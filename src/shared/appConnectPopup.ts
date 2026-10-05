// 连接卡发来时手机该不该自动弹窗（#1666，spec §4.2）。纯判据零 IO，弹不弹只有这一处说了算。
//
// 只弹**主人正看着这一页的时候新来的**卡：
//   · 「新来的」= seq 大于基线（baselineSeq）。基线是主人在场、日志到齐（第一次 ready，不是缓存）的那一刻的最大 seq，
//     点进会话翻出来的老卡躺在日志里，只是卡，不弹；
//   · 「正看着」：页面不在前台（别的页盖在上面 / app 在后台）不弹，而且**走开过就作废基线**（nextBaseline）：
//     走开期间来的卡、以及回前台重连时补发的那一段，都在下一次「在场且日志到齐」时被新基线盖住——
//     弹了他也没看见它来，等他回来再弹就成了翻历史；
//   · 一张卡只弹一回（popped 记着）：人点了「稍后」，卡还在会话里，想连自己点，不再追着弹；
//   · 一次只弹一张：弹最新（seq 最大）那张，此刻符合的**每一张**都算看过（seen），不接着弹第二张——
//     没弹的那几张留在会话里当卡。
// 「此刻已经有弹窗 / 接入弹窗开着 / 别的 Modal 正在退场」这类界面状态不在这里判：调用方持有它们。
import type { ChatRow } from "./mobileChat.js";

type AppConnectRow = Extract<ChatRow, { kind: "app_connect" }>;

export function popupCandidate(
  rows: readonly ChatRow[],
  o: { baselineSeq: number; popped: ReadonlySet<string>; focused: boolean },
): { row: AppConnectRow; /** 此刻符合条件的每一张（含 row 自己）：调用方一并记进「弹过」 */ seen: string[] } | null {
  if (!o.focused) return null;
  const fit: AppConnectRow[] = [];
  for (const r of rows) {
    if (r.kind !== "app_connect") continue;
    if (r.seq <= o.baselineSeq || r.status !== "open" || !r.canAct || o.popped.has(r.connectId)) continue;
    fit.push(r);
  }
  if (fit.length === 0) return null;
  fit.sort((a, b) => b.seq - a.seq);
  return { row: fit[0]!, seen: fit.map((r) => r.connectId) };
}

export type PopupBaseline = { sessionId: string; seq: number } | null;

/** 下一份基线。在场（watching = 页面在前台且 app 在前台）且日志到齐（ready = 已 ready 且不是缓存）才有基线：
    还没有就取此刻最大 seq（maxSeq 惰性：留着旧基线时不算）；已有就原样留着，新事件不让它上移（新卡要能弹）；
    走开或日志不齐（后台暂停连接 / 重连中）一律作废，下一次在场且到齐再取——回前台重连补发的那一段因此被盖住 */
export function nextBaseline(
  prev: PopupBaseline,
  o: { sessionId: string | null; ready: boolean; watching: boolean; maxSeq: () => number },
): PopupBaseline {
  if (o.sessionId === null || !o.ready || !o.watching) return null;
  if (prev !== null && prev.sessionId === o.sessionId) return prev;
  return { sessionId: o.sessionId, seq: o.maxSeq() };
}
