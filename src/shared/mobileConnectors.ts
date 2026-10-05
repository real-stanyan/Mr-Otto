// 手机上接应用的界面判据（#1430，spec §8）。手机端只画与接线，判断都在这儿（进 vitest）。
// 数据两份：edge 的无凭据视图（手机上接的，GET /px/v1/cloud）与主场快照的 connectors（电脑上接的，只读，
// 见 mobileMachine.appRows）。文案以维护者点完 demo 后的定稿为准（.demo/connectors/mobile.src.html）。
import { CATALOG_CATEGORIES, MCP_CATALOG, type CuratedEntry } from "./mcpCatalog.js";
import { missingParams } from "./mcpCatalogFill.js";
import { catalogIcon } from "./appIcon.js";
import type { CloudViewItem } from "./remote/pxCloud.js";

/** 用 edge 的 https 回调实测过接不上的（Task 13 的探针产出）。值是给人看的那句原因。
    2026-10-05 跑的那次（#1607）：7 个全在动态注册那一步拒了 edge 的回调地址——厂商只放白名单里的域名
    （Dropbox 只放「预先登记的伙伴」）。电脑上走回环回调不受影响，所以一律指去电脑上接。
    厂商哪天把我们加进白名单，删掉对应一行即可；要不靠厂商就让手机接上，见 #1594 */
const CLOUD_CALLBACK_REFUSED = "它不接受从云端回来的登录，去电脑上接";
export const MOBILE_OAUTH_BLOCKED: Readonly<Record<string, string>> = {
  vercel: CLOUD_CALLBACK_REFUSED,
  monday: CLOUD_CALLBACK_REFUSED,
  shortcut: CLOUD_CALLBACK_REFUSED,
  dropbox: CLOUD_CALLBACK_REFUSED,
  cal: CLOUD_CALLBACK_REFUSED,
  intercom: CLOUD_CALLBACK_REFUSED,
  square: CLOUD_CALLBACK_REFUSED,
};

export type ConnectKind = "browser" | "form" | "direct";

/** 有参数要填 = 表单；无参数的 oauth = 去浏览器登录；其余直接连 */
export function connectKind(entry: CuratedEntry): ConnectKind {
  if (entry.params.length > 0) return "form";
  return entry.auth === "oauth" ? "browser" : "direct";
}

export interface CatalogItemView {
  id: string;
  name: string;
  /** 本地图标键；没有就画首字母 */
  icon: string | null;
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
          icon: e.icon ?? null,
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

/** 弹窗顶上那几句：接入 / 重新登录两种。重新登录不再说「以你的身份」（接的时候说过了），参数照问（token 过期要粘新的） */
export function connectDialogText(entry: CuratedEntry, relogin: boolean): { title: string; lead: string; note: string | null; action: string } {
  if (relogin) return { ...reloginIntro(entry), note: null };
  const intro = connectIntro(entry);
  return { title: `接入 ${entry.name}`, lead: intro.lead, note: intro.note, action: intro.action };
}

/** 发给 edge 的参数：只带这个条目认的那几格，去掉首尾空白，空的不带 */
export function connectParams(entry: CuratedEntry, values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of entry.params) {
    const v = (values[p.name] ?? "").trim();
    if (v !== "") out[p.name] = v;
  }
  return out;
}

/**
 * 接入 / 重新登录之后「真的接上了」的判据：看**重拉回来的云端视图**，不看回调深链自称的 serverId
 * （mrotto://connector-done 谁都能打开，见 connectFlow.ts 的 ConnectOutcome）。要三样都对上：
 * 视图里有这一台、它就是这个目录条目、状态是 ok（重新登录后还写着 needs_login = 没登上）。
 */
export function landedApp(
  view: readonly CloudViewItem[] | null,
  catalogId: string,
  claimedServerId: string
): CloudViewItem | null {
  return view?.find((v) => v.serverId === claimedServerId && v.catalogId === catalogId && v.status === "ok") ?? null;
}

/** 应用图标位的首字母方块（手机包里还没有厂商 logo）。按码点取，不劈开代理对 */
export const appInitial = (name: string): string => ([...name.trim()][0] ?? "?").toUpperCase();

export function paramFormError(entry: CuratedEntry, values: Readonly<Record<string, string>>): string | null {
  const miss = missingParams(entry, values);
  return miss.length === 0 ? null : `还缺：${miss.join("、")}`;
}

const titleOf = (catalogId: string): string => MCP_CATALOG.find((e) => e.id === catalogId)?.name ?? catalogId;

export interface PhoneAppRow {
  serverId: string;
  title: string;
  icon: string | null;
  detail: string;
  needsLogin: boolean;
  trailing: string | null;
}

/** 手机上接的那一段。`homeId` = 主场工作区 id（借给「团队」不算它自己；读不到就传 null） */
export function phoneAppRows(view: readonly CloudViewItem[], homeId: string | null): PhoneAppRow[] {
  return view.map((v) => {
    const lent = v.grants.filter((g) => g !== homeId).length;
    const tools = toolCountText(v.tools.length);
    return {
      serverId: v.serverId,
      title: titleOf(v.catalogId),
      icon: catalogIcon(v.catalogId),
      detail: lent > 0 ? `${tools} · 借给了 ${lent} 个团队` : tools,
      needsLogin: v.status === "needs_login",
      trailing: v.status === "needs_login" ? "点一下重新登录" : null,
    };
  });
}

export interface AppDetailView {
  serverId: string;
  title: string;
  icon: string | null;
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
    icon: catalogIcon(item.catalogId),
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
export const CONNECTED_MARK = "已接入";
export const toolCountText = (n: number): string => (n === 0 ? "没有工具" : `${n} 个工具`);
export const allToolsLabel = (n: number): string => `全部 ${n} 个`;
export const disconnectedToast = (name: string): string => `已断开 ${name}`;
