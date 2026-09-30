// 桌面撤回一台「手机上接的」连接器（#1430，spec §6.1）：它的授权在 edge 的 cloud 键里，本机台账里根本没有——
// 走本机 withdrawConnector 那条路只会删掉目录行，留下「目录没了、授权还在」的暗门。
import { parseCloudError } from "../shared/remote/pxCloud.js";

export function createPxCloudGrant(deps: {
  baseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): (workspaceId: string, serverId: string, on: boolean) => Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  return async (workspaceId, serverId, on) => {
    const token = await deps.accessToken();
    if (!token) throw new Error("还没登录");
    const res = await f(`${deps.baseUrl()}/px/v1/cloud/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ serverId, workspaceId, on }),
    });
    if (res.ok) return;
    const payload: unknown = await res.json().catch(() => null);
    throw new Error(parseCloudError(res.status, payload) ?? `HTTP ${res.status}`);
  };
}
