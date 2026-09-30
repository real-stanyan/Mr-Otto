// 手机打 edge 的 /px/v1/cloud*（#1430）。凭据不经过这台手机：token 类是人自己粘的、经 TLS 到 edge，手机不留存。
import {
  parseCloudError, parseCloudView, parseConnectReply, type CloudViewItem, type ConnectReply,
} from "../../../src/shared/remote/pxCloud.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await edgeToken();
  if (token === null) throw new Error("还没登录。");
  const res = await fetch(`${EDGE_BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parseCloudError(res.status, payload) ?? `HTTP ${res.status}`);
  return payload;
}

export async function fetchCloudApps(): Promise<CloudViewItem[]> {
  const apps = parseCloudView(await call("/px/v1/cloud"));
  if (apps === null) throw new Error("应用清单的形状不对。");
  return apps;
}

export async function startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply> {
  const r = parseConnectReply(await call("/px/v1/cloud/connect", { method: "POST", body: JSON.stringify({ catalogId, params }) }));
  if (r === null) throw new Error("服务端回的形状不对。");
  return r;
}

export async function setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void> {
  await call("/px/v1/cloud/grant", { method: "POST", body: JSON.stringify({ serverId, workspaceId, on }) });
}

export async function removeApp(serverId: string): Promise<void> {
  await call(`/px/v1/cloud/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}
