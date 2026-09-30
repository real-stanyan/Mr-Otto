// 手机上接应用的界面判据（#1430，spec §8）。手机端只画与接线，判断都在这儿（进 vitest）。
// 数据两份：edge 的无凭据视图（手机上接的，GET /px/v1/cloud）与主场快照的 connectors（电脑上接的，只读，
// 见 mobileMachine.appRows）。文案以维护者点完 demo 后的定稿为准（.demo/connectors/mobile.src.html）。
import { CATALOG_CATEGORIES, MCP_CATALOG, type CuratedEntry } from "./mcpCatalog.js";
import { missingParams } from "./mcpCatalogFill.js";
import type { CloudViewItem } from "./remote/pxCloud.js";

/** 用 edge 的 https 回调实测过接不上的（Task 13 的探针产出）。值是给人看的那句原因 */
export const MOBILE_OAUTH_BLOCKED: Readonly<Record<string, string>> = {};

export type ConnectKind = "browser" | "form" | "direct";

/** 有参数要填 = 表单；无参数的 oauth = 去浏览器登录；其余直接连 */
export function connectKind(entry: CuratedEntry): ConnectKind {
  if (entry.params.length > 0) return "form";
  return entry.auth === "oauth" ? "browser" : "direct";
}

export interface CatalogItemView {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: ConnectKind;
  connected: boolean;
  /** 实测接不上的那句原因；已接的条目屏上不看它（真连上了以现实为准） */
  blocked: string | null;
}

/** 手机上接得了的目录：只列 http、不列「本机工具」（要装在电脑上的那几类）；按分类分组，空组不出 */
export function connectCatalog(
  view: readonly CloudViewItem[] | null,
  query: string
): { category: string; items: CatalogItemView[] }[] {
  const connected = new Set((view ?? []).map((v) => v.catalogId));
  const q = query.trim().toLowerCase();
  const entries = MCP_CATALOG.filter((e) => e.transport === "http" && e.category !== "本机工具").filter(
    (e) => q === "" || [e.id, e.name, e.description].some((f) => f.toLowerCase().includes(q))
  );
  return CATALOG_CATEGORIES.filter((c) => c !== "本机工具")
    .map((category) => ({
      category,
      items: entries
        .filter((e) => e.category === category)
        .map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          category,
          kind: connectKind(e),
          connected: connected.has(e.id),
          blocked: e.blocked ?? MOBILE_OAUTH_BLOCKED[e.id] ?? null,
        })),
    }))
    .filter((g) => g.items.length > 0);
}

export const TOOLS_PREVIEW = 6;

/** 接入弹窗里的三段话。oauth 多说一句「密码不经过 Mr Otto」 */
export function connectIntro(entry: CuratedEntry): { lead: string; note: string; action: string } {
  const oauth = entry.auth === "oauth";
  return {
    lead: entry.description,
    note: "接好后，你的智能体会以你的身份操作它。" + (oauth ? `登录在 ${entry.name} 自己的页面上完成，密码不经过 Mr Otto。` : ""),
    action: oauth ? "去登录" : "连接",
  };
}

export function reloginIntro(entry: CuratedEntry): { title: string; lead: string; action: string } {
  return {
    title: `重新登录 ${entry.name}`,
    lead: "登录过期了。登录之后，借给团队的设置都还在。",
    action: connectIntro(entry).action,
  };
}

export function paramFormError(entry: CuratedEntry, values: Readonly<Record<string, string>>): string | null {
  const miss = missingParams(entry, values);
  return miss.length === 0 ? null : `还缺：${miss.join("、")}`;
}

const titleOf = (catalogId: string): string => MCP_CATALOG.find((e) => e.id === catalogId)?.name ?? catalogId;

export interface PhoneAppRow {
  serverId: string;
  title: string;
  detail: string;
  needsLogin: boolean;
  trailing: string | null;
}

/** 手机上接的那一段。`homeId` = 主场工作区 id（借给「团队」不算它自己；读不到就传 null） */
export function phoneAppRows(view: readonly CloudViewItem[], homeId: string | null): PhoneAppRow[] {
  return view.map((v) => {
    const lent = v.grants.filter((g) => g !== homeId).length;
    const tools = v.tools.length === 0 ? "没有工具" : `${v.tools.length} 个工具`;
    return {
      serverId: v.serverId,
      title: titleOf(v.catalogId),
      detail: lent > 0 ? `${tools} · 借给了 ${lent} 个团队` : tools,
      needsLogin: v.status === "needs_login",
      trailing: v.status === "needs_login" ? "点一下重新登录" : null,
    };
  });
}

export interface AppDetailView {
  serverId: string;
  title: string;
  description: string;
  needsLogin: boolean;
  /** 全部工具名；屏取前 TOOLS_PREVIEW 个，其余折在「全部 N 个」后面 */
  tools: string[];
  statusText: string;
}

export function appDetail(item: CloudViewItem, now: number): AppDetailView {
  const needsLogin = item.status === "needs_login";
  const days = Math.floor((now - item.connectedTs) / 86_400_000);
  return {
    serverId: item.serverId,
    title: titleOf(item.catalogId),
    description: MCP_CATALOG.find((e) => e.id === item.catalogId)?.description ?? "",
    needsLogin,
    tools: item.tools,
    statusText: needsLogin ? "登录过期了，智能体暂时用不了" : `你的智能体能用 · ${days <= 0 ? "今天接入" : `${days} 天前接入`}`,
  };
}

export interface LendRow {
  workspaceId: string;
  name: string;
  on: boolean;
}

export function lendRows(teams: readonly { id: string; name: string }[], item: CloudViewItem): LendRow[] {
  return teams.map((t) => ({ workspaceId: t.id, name: t.name, on: item.grants.includes(t.id) }));
}

export const PHONE_APPS_FOOTER = "凭据存在云端，不在这台手机上。你的智能体随时能用，手机关机也行。";
export const DESKTOP_APPS_FOOTER = "在电脑上的 Mr Otto 里接的，要在电脑上管。";
export const LEND_FOOTER = "借给团队后，团队里的智能体会以你的身份用它。随时能关。";
export const PHONE_APPS_EMPTY = "手机上还没接应用。\n接好之后，你的智能体会以你的身份用它。";
export const CATALOG_FOOTER = "只列能在云端跑的应用；要装在电脑上的那几类（本机工具）在电脑上接。";
export const catalogEmpty = (query: string): string => `没找到「${query}」。\n目录外的应用要在电脑上接。`;
export const disconnectTitle = (title: string): string => `断开 ${title}？`;
export const DISCONNECT_LEAD = "断开后，你的智能体和借到它的团队都用不了它，云端存的登录凭据会一起删掉。";
export const connectedToast = (name: string): string => `接好了。你的智能体现在能用 ${name}`;
export const reloginToast = (name: string): string => `${name} 重新登录好了`;
export const lendToast = (team: string, on: boolean): string => (on ? `借给了「${team}」` : `不再借给「${team}」`);
export const APP_GONE = "这个应用已经断开了。";
