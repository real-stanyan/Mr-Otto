// 应用连接卡（#1666，spec 2026-10-05-app-connect-card-design）：智能体要用一个还没连上的连接器目录应用时，
// 会话里出一张卡。纯逻辑零 IO，runtime 与手机共用——「这张卡此刻还开着吗」「手机该给哪个按钮」只能各有一处判据
// （同 friendPick.ts 的纪律）。runtime 读不到主人的云箱（edge 对平台身份回 403），所以按钮由手机按自己的视图判
import type { AppConnectEvent, SessionEvent } from "../session/events.js";
import { MCP_CATALOG, type CuratedEntry } from "./mcpCatalog.js";
import { MOBILE_OAUTH_BLOCKED } from "./mobileConnectors.js";
import type { CloudViewItem } from "./remote/pxCloud.js";

export const REQUEST_APP_CONNECT_TOOL_NAME = "request_app_connect";
export const APP_CONNECT_TTL_MS = 24 * 60 * 60_000;
export const APP_CONNECT_PER_HOUR_MAX = 3;
export const APP_CONNECT_WHY_MAX = 120;

export type ResolvedApp = { kind: "ok"; entry: CuratedEntry } | { kind: "blocked"; entry: CuratedEntry; reason: string } | { kind: "unknown" };

/** 手机上接得了的那份目录（同 mobileConnectors.connectCatalog 的头两道筛：http、不是本机工具）。预览期条目不筛：
    发卡时不知道主人是不是内测账号，接不上由接入弹窗当场说 */
const phoneCatalog = (): CuratedEntry[] => MCP_CATALOG.filter((e) => e.transport === "http" && e.category !== "本机工具");

export function resolveConnectApp(app: string): ResolvedApp {
  const q = app.trim().toLowerCase();
  if (q === "") return { kind: "unknown" };
  const list = phoneCatalog();
  const entry = list.find((e) => e.id === q) ?? list.find((e) => e.name.toLowerCase() === q);
  if (entry === undefined) return { kind: "unknown" };
  const reason = entry.blocked ?? MOBILE_OAUTH_BLOCKED[entry.id];
  return reason !== undefined ? { kind: "blocked", entry, reason } : { kind: "ok", entry };
}

const CLOUD_PREFIX = "cloud-";
export const cloudServerIdOf = (catalogId: string): string => `${CLOUD_PREFIX}${catalogId}`;
export function catalogIdOfServer(serverId: string): string | null {
  return serverId.startsWith(CLOUD_PREFIX) && serverId.length > CLOUD_PREFIX.length ? serverId.slice(CLOUD_PREFIX.length) : null;
}

export interface AppConnectState {
  connectId: string; fromAgentId: string; offeredTs: number; seq: number;
  catalogId: string; appName: string; why: string; reason: "missing" | "needs_login";
  phase: AppConnectEvent["phase"];
  /** 之后同一会话里同一个应用又出了一张卡（这张还开着时被顶掉） */
  superseded: boolean;
}
export type AppConnectFold = Map<string, AppConnectState>;

export function applyAppConnect(fold: AppConnectFold, e: SessionEvent): void {
  if (e.type !== "app_connect") return;
  if (e.phase === "offered") {
    const catalogId = e.catalogId ?? "";
    for (const s of fold.values()) if (s.phase === "offered" && s.catalogId === catalogId) s.superseded = true;
    fold.set(e.connectId, {
      connectId: e.connectId, fromAgentId: e.fromAgentId, offeredTs: e.ts, seq: e.seq,
      catalogId, appName: e.appName ?? catalogId, why: e.why ?? "", reason: e.reason ?? "missing",
      phase: "offered", superseded: false,
    });
    return;
  }
  const prev = fold.get(e.connectId);
  if (prev === undefined) return; // 窗口裁掉了开头
  fold.set(e.connectId, { ...prev, phase: e.phase });
}
export function appConnectFoldOf(events: readonly SessionEvent[]): AppConnectFold {
  const fold: AppConnectFold = new Map();
  for (const e of events) applyAppConnect(fold, e);
  return fold;
}

export type AppConnectStatus = "open" | "connected" | "dismissed" | "expired";
export function appConnectStatus(st: AppConnectState, now: number): AppConnectStatus {
  if (st.phase !== "offered") return st.phase;
  return st.superseded || now - st.offeredTs > APP_CONNECT_TTL_MS ? "expired" : "open";
}
export function openCardFor(fold: AppConnectFold, catalogId: string, now: number): AppConnectState | null {
  for (const s of fold.values()) if (s.catalogId === catalogId && appConnectStatus(s, now) === "open") return s;
  return null;
}

export type AppConnectAction = "connect" | "relogin" | "grant" | "ready";
/** 手机按自己的云端视图判（spec §4.1）：没有 = 新接；needs_login = 重新登录；正常但没开给这个工作区 = 打开；都好 = 直接接着办 */
export function appConnectAction(view: readonly CloudViewItem[], catalogId: string, workspaceId: string): AppConnectAction {
  const item = view.find((v) => v.catalogId === catalogId);
  if (item === undefined) return "connect";
  if (item.status === "needs_login") return "relogin";
  return item.grants.includes(workspaceId) ? "ready" : "grant";
}
export function appConnectTitle(action: AppConnectAction, appName: string): string {
  switch (action) {
    case "connect": return `要连上 ${appName} 才能办`;
    case "relogin": return `${appName} 的登录过期了`;
    case "grant": return `${appName} 还没开给这里`;
    case "ready": return `${appName} 已经连好了`;
  }
}
export const APP_CONNECT_BUTTON: Record<AppConnectAction, string> = { connect: "去连接", relogin: "重新登录", grant: "打开", ready: "好了，接着办" };

/** 工具结果：卡已经出了，用一句话告诉主人（这句走现有回复推送），这一轮别再试那个应用 */
export function appConnectToolText(appName: string): string {
  return `已经在会话里给主人发了一张连接 ${appName} 的卡。用一句话告诉他要连 ${appName}、为什么，然后这一轮就停下，别再试 ${appName}。他连上或者不连，都会有一条消息回到这里，你到时候再接着办。`;
}
export function appConnectedOpening(appName: string): string {
  return `（系统）主人刚连上了 ${appName}，它的工具现在能用了。接着办刚才要用它的那件事。`;
}
export function appDeclinedOpening(appName: string): string {
  return `（系统）主人没连 ${appName}。别再提这件事，看看不用它能不能办；办不了就简单说一句办不了。`;
}
