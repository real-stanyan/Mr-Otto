// 手机接应用的编排纯逻辑（#1430 Task 11）：connect → （浏览器登录的）开授权会话拦 mrotto://connector-done → 解析结果，
// 以及借给团队 / 断开的两步顺序。住在 shared 不住 mobile：手机代码依赖 react-native / 手机 supabase，进不了 vitest、
// 也过不了根 tsc（手机是 CJS 包、自己的 tsconfig）；判据全在这里，手机端 connectApp.ts 只递真依赖。
// 顺序：接入是「箱先于目录」，撤销是「授权先删、目录行后删」（计划开头第 1 条）——授权是钥匙，
// 目录行只是给团队看的招牌，宁可招牌晚挂 / 早摘，不能招牌在而钥匙没有。
import { CONNECT_DONE_URL, parseConnectDone, type ConnectReply } from "./remote/pxCloud.js";

/**
 * `connected.serverId` 只是「这次流程自称接上了哪一台」的信号，不是证据：`mrotto://connector-done?...`
 * 任何 App 都能打开。调用方必须接着 `refreshConnectors()` 重拉云端视图，界面从拉回来的清单画，
 * 不许拿这个 serverId 直接当「已接入」去渲染或去借给团队。
 */
export type ConnectOutcome = { kind: "connected"; serverId: string } | { kind: "cancelled" } | { kind: "error"; message: string };

export interface ConnectDeps {
  startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply>;
  openAuth(url: string, redirect: string): Promise<{ type: string; url?: string }>;
}

export async function runConnect(deps: ConnectDeps, catalogId: string, params: Record<string, string>): Promise<ConnectOutcome> {
  try {
    const reply = await deps.startConnect(catalogId, params);
    if (reply.kind === "connected") return reply;
    const res = await deps.openAuth(reply.authorizeUrl, CONNECT_DONE_URL);
    // cancel / dismiss = 人自己关了浏览器：什么都不说（spec §9 第一行）
    if (res.type !== "success" || typeof res.url !== "string") return { kind: "cancelled" };
    const done = parseConnectDone(res.url);
    return done.ok ? { kind: "connected", serverId: done.serverId } : { kind: "error", message: done.message };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export interface TeamDeps {
  setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void>;
  removeApp(serverId: string): Promise<void>;
  upsertRow(row: { workspaceId: string; hostUid: string; serverId: string; label: string; tools: string[] }): Promise<void>;
  deleteRow(workspaceId: string, hostUid: string, serverId: string): Promise<void>;
}

/** 借出：授权先、目录行后；收回：授权先关、目录行后删。第一步抛了第二步不做 */
export async function lendToTeamWith(
  deps: TeamDeps,
  o: { serverId: string; workspaceId: string; on: boolean; label: string; uid: string },
): Promise<void> {
  await deps.setGrant(o.serverId, o.workspaceId, o.on);
  if (o.on) {
    await deps.upsertRow({ workspaceId: o.workspaceId, hostUid: o.uid, serverId: o.serverId, label: o.label, tools: [] });
  } else {
    await deps.deleteRow(o.workspaceId, o.uid, o.serverId);
  }
}

/** 断开：先删云端（凭据与所有授权一起没），再删各团队的目录行；云端没删成就一行都不动 */
export async function disconnectWith(
  deps: TeamDeps,
  o: { serverId: string; uid: string; workspaceIds: readonly string[] },
): Promise<void> {
  await deps.removeApp(o.serverId);
  for (const ws of o.workspaceIds) await deps.deleteRow(ws, o.uid, o.serverId);
}
