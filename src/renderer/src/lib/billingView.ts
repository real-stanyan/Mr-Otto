// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { fmtCredit, type BillingMe, type PlanId, type WindowState } from "../../../shared/billing.js";

export const PLAN_CARDS: ReadonlyArray<{ id: PlanId; name: string; priceUsd: number; blurb: string }> = [
  { id: "lite", name: "Lite", priceUsd: 19, blurb: "日常对话与轻量编码" },
  { id: "pro", name: "Pro", priceUsd: 59, blurb: "整天开着水獭干活" },
  { id: "max", name: "Max", priceUsd: 89, blurb: "多只水獭并行、长会话" },
];

export function windowPercent(w: WindowState): number {
  if (w.limitMicro <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((w.usedMicro / w.limitMicro) * 100)));
}

export function countdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "已恢复";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "不到 1 分钟后恢复";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h} 小时 ${m} 分后恢复` : `${m} 分钟后恢复`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}
