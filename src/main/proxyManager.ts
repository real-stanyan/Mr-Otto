// proxyManager —— 好友代理的主进程管理器（issue #622，ADR-0151）。
// 把邀请码生成/接受、A/B 协调器生命周期、授权/撤销/审计收敛到一个可测模块，
// index.ts 只做薄接线（填依赖 + 注册 IPC）。
//
// 两个方向：
//   A 侧（分享者/host）：proxyCreateInvite 生成邀请码 → B 连上后 startProxyHostCoordinator
//     用 A 的真 mcpHub 执行；proxyListGrants/proxyRevoke/proxyAudit 管授权与审计。
//   B 侧（好友/guest）：proxyAcceptInvite 输邀请码 → 连 A 的频道握手 → startProxyGuestCoordinator
//     得到代理 McpCapability，换进会话的 world。
//
// 依赖全部注入（crypto/身份/mcpHub/relay 连接工厂/存储落盘/登录态），本层不碰
// 具体实现——index.ts 装配根填，测试塞假货。

import { createProxyInvite, encodeProxyInvite, decodeProxyInvite, proxyInviteExpired } from "../shared/remote/proxyInvite.js";
import { startProxyHostCoordinator, startProxyGuestCoordinator } from "./proxyCoordinator.js";
import { adaptProxyWire } from "./proxyWire.js";
import {
  emptyProxyStore, grantFor, setGrant, revokeGrant, parseProxyStore, serializeProxyStore,
  type ProxyStoreData,
} from "./proxyStore.js";
import type { ProxyGrant } from "../shared/remote/proxyProtocol.js";
import type { McpCapability } from "../world/executionWorld.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import type { ProxyWireTransport } from "./proxyCoordinator.js";

export type FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** 代理管理器的依赖（index.ts 装配根填） */
export interface ProxyManagerDeps {
  crypto: RemoteCryptoPrimitives;
  /** 本机长期身份（openIdentityStore 的那份，与自远程同一个） */
  identity: KeyPair;
  deviceId: string;
  /** A 自己的真 McpCapability（mcpHub）——host 侧执行落点 */
  mcp: McpCapability;
  /** 当前登录用户的 Supabase uid（B 发起 proxy_req 时写 fromUid；A 侧记录用）。未登录 = null */
  currentUid: () => string | null;
  /** 开一个到 relay 某频道的点对点传输（index.ts 用 createWsTransport + adaptProxyWire 造） */
  openWireTransport: (channelId: string, role: "host" | "guest") => ProxyWireTransport;
  /** proxyStore 的落盘（0600/userData，index.ts 填 readProxyStore/writeProxyStore 的绑定） */
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  now?: () => number;
  log?: (m: string) => void;
}

export interface ProxyManager {
  proxyCreateInvite(friendUid: string, allow: ProxyGrant["allow"]): Promise<FriendsResult<{ invite: string }>>;
  proxyAcceptInvite(invite: string): Promise<FriendsResult<{ grantedCount: number }>>;
  proxyListGrants(): Promise<FriendsResult<{ grants: { friendUid: string; allow: ProxyGrant["allow"] }[] }>>;
  proxyRevoke(friendUid: string): Promise<FriendsResult<null>>;
  proxyAudit(friendUid?: string): Promise<FriendsResult<{ audits: ProxyStoreData["audits"] }>>;
  /** 关停所有活动通道（app 退出 / 登录态失效时调） */
  closeAll(): void;
}

export function createProxyManager(deps: ProxyManagerDeps): ProxyManager {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  // 活动的协调器通道（A 侧按好友、B 侧单条）。close 时一并关
  const active: { close(): void }[] = [];

  return {
    async proxyCreateInvite(friendUid, allow) {
      // A 侧：先把授权写进白名单存储（B 连上后 host 按它执行 + 推 grant 帧）
      const cur = deps.loadStore();
      deps.saveStore(setGrant(cur, { friendUid, allow }));
      // 生成邀请码（频道 id + 一次性 secret + A 的身份公钥）
      const inv = createProxyInvite(deps.crypto, deps.identity.publicKey, now());
      // A 主动连上自己创建的频道（host 角色）等 B——B 用同一 channelId 连进来时，
      // relay 房间里就有 A(host)/B(guest) 两条连接，握手、推 grant、接受调用。
      // peerIdentityPub 此刻还不知道 B 的公钥——握手时由 secret 证明（pairing 机制），
      // 这里先放空，信任在握手层建立（见 proxyConnection 的 TOFU/pin 语义）。
      const transport = deps.openWireTransport(inv.channelId, "host");
      const coord = startProxyHostCoordinator({
        crypto: deps.crypto,
        identity: deps.identity,
        deviceId: deps.deviceId,
        transport,
        mcp: deps.mcp,
        peerIdentityPub: () => [], // B 的公钥握手时经 secret 证明后 pin（host 侧暂空）
        friendUid,
        loadStore: deps.loadStore,
        saveStore: deps.saveStore,
        now,
        log,
      });
      active.push(coord);
      log(`代理邀请码已生成并监听：好友 ${friendUid}，频道 ${inv.channelId}`);
      return { ok: true, value: { invite: encodeProxyInvite(inv) } };
    },

    async proxyAcceptInvite(invite) {
      const uid = deps.currentUid();
      if (!uid) return { ok: false, message: "还没登录——好友代理要先登录" };
      const inv = decodeProxyInvite(invite);
      if (!inv) return { ok: false, message: "邀请码不对——不是合法的代理邀请码（要 otto-proxy 开头的一串）" };
      if (proxyInviteExpired(inv, now())) return { ok: false, message: "邀请码过期了（10 分钟有效）——让 A 重新生成一个" };

      // B 侧：连 A 的频道（guest 角色），握手（pin A 的身份公钥），起 guest 协调器
      const transport = deps.openWireTransport(inv.channelId, "guest");
      const coord = startProxyGuestCoordinator({
        crypto: deps.crypto,
        identity: deps.identity,
        deviceId: deps.deviceId,
        fromUid: uid,
        transport,
        peerIdentityPub: () => [inv.hostIdentityPub],
        grantedServers: [], // 初始空——A 握手后推 proxy_grant 帧更新（proxyMcp 动态收）
        log,
      });
      active.push(coord);
      // TODO(联调): grantedCount 此刻是 0（grant 帧握手后才到）。真实计数要等 proxyMcp
      // 的 onGrantsChanged 回调。先回 0，UI 显示「已连接，等待 A 推送授权」。
      log(`代理通道已连上 A 的频道 ${inv.channelId}（guest）`);
      return { ok: true, value: { grantedCount: 0 } };
    },

    async proxyListGrants() {
      const cur = deps.loadStore();
      return { ok: true, value: { grants: cur.grants.map((g) => ({ friendUid: g.friendUid, allow: g.allow })) } };
    },

    async proxyRevoke(friendUid) {
      deps.saveStore(revokeGrant(deps.loadStore(), friendUid));
      log(`代理授权已撤销：好友 ${friendUid}`);
      return { ok: true, value: null };
    },

    async proxyAudit(friendUid) {
      const cur = deps.loadStore();
      const audits = friendUid ? cur.audits.filter((a) => a.friendUid === friendUid) : cur.audits;
      return { ok: true, value: { audits } };
    },

    closeAll() {
      for (const a of active.splice(0)) a.close();
    },
  };
}
