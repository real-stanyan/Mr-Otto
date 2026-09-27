// 额度的颜色（#1356 A5 的 QuotaCard 里抽出来，#1386 那张两扇窗的卡退役了）：颜色只用来说「出事了」——充足时是弱色（ADR-0239）。
// 「订阅与额度」那一格与「这周谁用得多」的大数字共用这一份。
import type { QuotaToneView } from "../../../src/shared/mobileAccount.js";
import type { Palette } from "../theme.js";

export function toneColor(c: Palette, tone: QuotaToneView): string {
  return tone === "deny" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
}
