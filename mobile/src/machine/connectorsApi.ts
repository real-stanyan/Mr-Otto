// 手机打 edge 的 /px/v1/cloud*（#1430）。凭据不经过这台手机：token 类是人自己粘的、经 TLS 到 edge，手机不留存。
// 请求核心（路径、头、错误三种说法）在 src/shared/connectFlow.ts 的 createCloudClient（进 vitest），这里只递真依赖。
import { createCloudClient } from "../../../src/shared/connectFlow.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

const client = createCloudClient({ base: EDGE_BASE, token: edgeToken, fetch: (url, init) => fetch(url, init) });

export const fetchCloudApps = client.fetchCloudApps;
export const startConnect = client.startConnect;
export const setGrant = client.setGrant;
export const removeApp = client.removeApp;
