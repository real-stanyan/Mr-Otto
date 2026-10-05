// 「应用」页里的 Apple 健康（#1671，维护者从 demo 三个方向里挑的 B）：健康是「手机上接的」第一行，「接入」目录最上面
// 「这台手机」一类也列它；设置页那个开关撤了，只在这里管。开关状态仍是 healthPrefs（#1656 / ADR-0373），这一层只出
// 文案与「这一行怎么画」——纯函数，两端不共用但放 shared 才测得动（同 mobileConnectors）。
import type { HealthMetric } from "./health.js";

export const HEALTH_APP_NAME = "Apple 健康";
export const HEALTH_CATALOG_CATEGORY = "这台手机";

/** 详情页「智能体能读的」那一排，顺序同 HEALTH_METRICS（Record 穷举：加了新类别不写名字 tsc 直接红） */
export const HEALTH_METRIC_NAMES: Record<HealthMetric, string> = {
  steps: "步数", distance: "步行距离", activeEnergy: "活动能量", flights: "爬楼层数", exerciseMinutes: "锻炼时长",
  standHours: "站立小时", sleep: "睡眠", heartRate: "心率", restingHeartRate: "静息心率", hrv: "心率变异性",
  spo2: "血氧", bodyMass: "体重", bodyFat: "体脂率", workouts: "体能训练",
};

export type HealthAppState = "off" | "on" | "unavailable";

/** 「手机上接的」里那一行：没连给「连接」、连上点进详情、设备不支持灰掉不给动作（不藏——藏了人会以为没这功能） */
export function healthAppRow(state: HealthAppState): { detail: string; action: "connect" | "detail" | null; connected: boolean } {
  if (state === "on") return { detail: "已连接 · 只在 Otto 开着时读", action: "detail", connected: true };
  if (state === "unavailable") return { detail: "这台设备读不了健康数据", action: null, connected: false };
  return { detail: "让智能体读你的步数、睡眠、心率…", action: "connect", connected: false };
}

/** 目录搜索：名字、英文、能读的类别名都算 */
export function healthCatalogMatches(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [HEALTH_APP_NAME, "apple health", "health", HEALTH_CATALOG_CATEGORY, ...Object.values(HEALTH_METRIC_NAMES)];
  return hay.some((h) => h.toLowerCase().includes(q));
}

/** 「手机上还没接应用」那个空态：健康那一行在的时候这一组永远不空 */
export function showPhoneAppsEmpty(o: { healthAvailable: boolean; cloudApps: number }): boolean {
  return !o.healthAvailable && o.cloudApps === 0;
}

export const HEALTH_CATALOG_DESCRIPTION = "步数、睡眠、心率、体重和体能训练";

export const HEALTH_CONNECT = {
  title: "连接 Apple 健康",
  lead: "你问智能体健康相关的问题时，它会从这台 iPhone 读你的步数、睡眠、心率、体重和体能训练（按天汇总）。",
  note: "接下来是 iOS 的授权页，想让它读哪几类就开哪几类。之后随时能在「健康」App 里改。",
  confirm: "继续",
} as const;

export const HEALTH_DISCONNECT = {
  title: "断开 Apple 健康？",
  lead: "智能体之后读不到你的健康数据。已经读过、写进聊天记录的那几次不受影响。",
  confirm: "断开",
} as const;

export const HEALTH_DETAIL = {
  status: "已连接 · 这台 iPhone",
  readsHeader: "智能体能读的",
  readsFooter: "按天汇总，只读。某一类读不到，多半是在系统授权页里没允许它。",
  askHeader: "这样问就行",
  examples: ["「我昨晚睡得怎样？」", "「这周比上周多走了多少步？」", "「最近静息心率有变化吗？」"],
  askFooter: "只在你本人问的时候读；群里别人、好友的智能体、定时任务都读不到。每读一次，聊天里会多一行灰字。",
  openHealth: "在「健康」App 里改能读哪几类",
  disconnect: "断开",
  disconnectFooter: "断开后智能体不再读；要彻底收回权限，去「健康」App 里关。",
} as const;

export const healthConnectedToast = "已连接 Apple 健康";
export const healthDisconnectedToast = "已断开 Apple 健康";
