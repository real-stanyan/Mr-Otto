// appsDrawer —— 主页下拉出来的应用抽屉（#1648，参考微信下拉小程序）的纯逻辑：最近使用怎么记、怎么排、搜索怎么筛。
import type { AppRow } from "./apps.js";

/** 下拉多少触发（pt）：列表顶到头之后再往下拽过这条线、松手就开 */
export const APPS_PULL_TRIGGER = 80;
export const RECENT_APPS_MAX = 8;

/** 记一次打开：放到最前、去重、封顶 */
export function touchRecent(recent: readonly string[], appId: string): string[] {
  return [appId, ...recent.filter((id) => id !== appId)].slice(0, RECENT_APPS_MAX);
}

/** 最近使用那一排：按记的顺序，只留还在的应用 */
export function recentApps(recent: readonly string[], apps: readonly AppRow[]): AppRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  return recent.map((id) => byId.get(id)).filter((a): a is AppRow => a !== undefined);
}

/** 搜索：名字或一句说明里含（不分大小写） */
export function searchApps(apps: readonly AppRow[], q: string): AppRow[] {
  const s = q.trim().toLowerCase();
  if (s === "") return [...apps];
  return apps.filter((a) => a.name.toLowerCase().includes(s) || a.description.toLowerCase().includes(s));
}

/** 记下来的那串从存储读回：形状不对当空 */
export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_APPS_MAX) : [];
  } catch {
    return [];
  }
}
