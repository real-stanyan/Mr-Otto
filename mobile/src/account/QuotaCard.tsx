// 额度的颜色（#1356 A5）：色档 → 条与数字的颜色。颜色只用来说「出事了」——充足时是弱色（ADR-0239）。
// 两扇窗那张卡（Task 9 补在这个文件里）与用量页的大数字共用这一份。
import type { QuotaToneView } from "../../../src/shared/mobileAccount.js";
import type { Palette } from "../theme.js";

export function toneColor(c: Palette, tone: QuotaToneView): string {
  return tone === "deny" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
}
