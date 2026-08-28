// proxyManager —— 好友代理的主进程管理器（issue #622 / #657，ADR-0151 / ADR-0162）。
// 把邀请码生成/接受、A/B 协调器生命周期、授权/撤销/审计收敛到一个可测模块，
// index.ts 只做薄接线（填依赖 + 注册 IPC）。
//
// 两个方向：
//   A 侧（分享者/host）：proxyCreateInvite 生成邀请码 → B 连上后 startProxyHostCoordinator
//     用 A 的真 mcpHub 执行；proxyListGrants/proxyRevoke/proxyAudit 管授权与审计。
//   B 侧（好友/guest）：proxyAcceptInvite 输邀请码 → 连 A 的频道握手 → startProxyGuestCoordinator
//     得到代理 McpCapability，换进会话的 world。
//
// **握手层认人**（ADR-0162）：A 手里那张邀请的一次性 secret 只活在内存里，
// B 在 hello 里证明持有它，A 验过才 pin B 的公钥；pin 落进 proxyStore，
// 之后的连接走正常 pin 路径。channelId 落盘（A 重启后房间要开得回来），
// **secret 不落盘**——一次性的东西落了盘就不是一次性的了。
//
// 依赖全部注入（crypto/身份/mcpHub/relay 连接工厂/存储落盘/登录态），本层不碰
// 具体实现——index.ts 装配根填，测试塞假货。

import {
  createProxyInvite, encodeProxyInvite, decodeProxyInvite, proxyInviteExpired,
  type ProxyInvite,
} from "../shared/remote/proxyInvite.js";
import { startProxyHostCoordinator, startProxyGuestCoordinator } from "./proxyCoordinator.js";
import {
  allBorrows, channelFor, pinnedIdentities, removeBorrow, revokeGrant, setBorrow,
  setBorrowRevoked, setChannel, setGrant, setPin, usableBorrows,
  type ProxyStoreData,
} from "./proxyStore.js";
import type { ProxyGrant } from "../shared/remote/proxyProtocol.js";
import type { ProxyChannelView } from "./proxyNamespace.js";
import type { McpCapability } from "../world/executionWorld.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import type { ProxyWireTransport } from "./proxyCoordinator.js";

export type FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** B 侧一条借来的通道，给 UI 看的样子 */
export interface ProxyBorrowStatus {
  hostUid: string;
  /** 好友的人话名字。查不到时 UI 自己退回短标签 */
  label: string;
  /** 握手过了没有——不是「配过没有」。断线时这里是 false，而台账里那条还在 */
  connected: boolean;
  /** 对方此刻授了几个服务（A 推来的清单）。0 = 还没推到 / 被撤光了 */
  serverCount: number;
  /** 对方**明说**撤销了，以及理由（issue #680）。有值 = 别等了，要用得重走邀请码；
      没值 + connected=false = 只是这会儿没连上，等着就行 */
  revokedReason?: string;
}

/**
 * A 侧一条对外通道，给 UI 看的样子（issue #680）。
 *
 * 白名单内的调用是**全自动**的——没有这块表，「有人正在用我的凭证」这件事
 * 在界面上完全没有痕迹，只能事后翻审计账。ADR-0151 的三道防线里，
 * 「审计」那一道要能当场看见才算数。
 */
export interface ProxyHostStatus {
  friendUid: string;
  label: string;
  /** 好友此刻握上手没有 */
  connected: boolean;
  /** 此刻正在跑几笔。>0 = **正在**用 A 的凭证动 A 的账号 */
  inflight: number;
  /** 最近一笔调用的时间（含被拒的）。null = 从没调过 */
  lastCallAt: number | null;
}

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
  /** A 此刻的好友 uid 集；**null = 名单还没同步好**（没登录 / 首次快照还没到）。
      ADR-0151 决策 1：friendships 被删除 = 代理权限跟着死。null 一律按「拒」处理
      （见 proxyHost 的 friendUids 注释），所以这里不能拿空数组冒充「还不知道」 */
  friendUids: () => readonly string[] | null;
  /** 好友的人话名字（进代理工具的描述与 UI）。查不到回空串——调用方自己退回短标签 */
  friendLabel: (uid: string) => string;
  /** B 侧任一条借来的通道状态变了（接上/断开/授权清单更新）。装配根据此推给渲染层 */
  onChange?: () => void;
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
  /**
   * A 侧：改一个**已有**好友的白名单，不重发邀请码（issue #680）。
   *
   * 与 `proxyCreateInvite` 的差别就是这一条：那边会换一张邀请、重开房间、
   * 逼对方重新接受一次；而「把 read 改成 read+write」根本不是一次新的配对。
   * 改完当场推一帧新的授权清单，对面的工具表立刻跟着变。
   */
  proxyUpdateGrant(friendUid: string, allow: ProxyGrant["allow"]): Promise<FriendsResult<null>>;
  proxyRevoke(friendUid: string): Promise<FriendsResult<null>>;
  proxyAudit(friendUid?: string): Promise<FriendsResult<{ audits: ProxyStoreData["audits"] }>>;
  /**
   * 把落盘的通道全部重新连起来（登录那一刻调）：A 侧已授权好友的房间 +
   * B 侧借来的那些。邀请码是一次性的，重启不该要求用户重发一张——
   * 两边都靠落盘的 channelId + pin 走正常路径，不消耗邀请。
   */
  resume(): void;
  /** B 侧：当前借来的那些通道的状态（UI 用）。connected 来自握手层，不是「有没有配过」 */
  borrowStatus(): readonly ProxyBorrowStatus[];
  /** A 侧：我授出去的那些此刻怎么样（连没连、正在跑几笔、最近一次什么时候） */
  hostStatus(): readonly ProxyHostStatus[];
  /** B 侧：不再借某好友的服务——关通道 + 从台账里删掉（下次启动不再连回去） */
  proxyDisconnect(hostUid: string): Promise<FriendsResult<null>>;
  /**
   * B 侧：此刻活着的代理通道（issue #670）。装配根拿它把好友的 MCP 合并进
   * 会话的 world（`mergeProxyMcp`）——**这是 proxyMcp 唯一的出口**。
   * 回的是快照：通道随时来去，调用方每次现取（工具表每 turn 现算）。
   */
  activeProxies(): readonly ProxyChannelView[];
  /** 关停所有活动通道（app 退出 / 登录态失效时调） */
  closeAll(): void;
}

export function createProxyManager(deps: ProxyManagerDeps): ProxyManager {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** A 侧：每个好友一条 host 通道（重开时先关旧的，免得两条连接抢同一个房间） */
  const hosts = new Map<string, {
    pushGrant(): void; pushRevoked(reason: string): void;
    isReady(): boolean; inflight(): number; close(): void;
  }>();
  /** B 侧：借来的每条通道（issue #676 之前是单条变量，所以一次只能代理一个好友；
      合并层本身一直支持多条）。带 friendUid 是因为下游要按它加前缀，
      带 mcp 是因为它就是那个出口，带 isReady 是因为 UI 要显示连没连 */
  const guests = new Map<string, { mcp: McpCapability; isReady: () => boolean; close(): void }>();
  const changed = (): void => deps.onChange?.();

  /**
   * 开一条 A 侧的 host 通道。`invite` 有值 = 这一轮还接受邀请码证明（首次配对）；
   * 没有 = 只认 pin 组（重启后的恢复路径）。
   */
  function openHost(friendUid: string, channelId: string, invite: ProxyInvite | null): void {
    hosts.get(friendUid)?.close();
    // 一次性 secret：只在内存里，验过一次就作废（consume）。过期了也不再认
    let secret: Uint8Array | null = invite?.secret ?? null;
    const transport = deps.openWireTransport(channelId, "host");
    const coord = startProxyHostCoordinator({
      crypto: deps.crypto,
      identity: deps.identity,
      deviceId: deps.deviceId,
      transport,
      mcp: deps.mcp,
      // 已 pin 的那把先试（B 重连走这条，不消耗邀请）
      peerIdentityPub: () => pinnedIdentities(deps.loadStore(), friendUid),
      pairing: {
        // pin 组全验不过时才轮到它：手里那张还活着的邀请
        verifyWith: () => (secret && invite && !proxyInviteExpired(invite, now()) ? secret : null),
        // 验过了才落 pin —— 这一步就是「这个公钥是被邀请的那个 B」的全部依据
        onPaired: (pub) => { deps.saveStore(setPin(deps.loadStore(), friendUid, pub)); },
        consume: () => { secret = null; },
      },
      friendUid,
      friendUids: deps.friendUids,
      loadStore: deps.loadStore,
      saveStore: deps.saveStore,
      // A 侧那块表的信号源：握手完成 / 好友离场 / 调用起跑收尾 / 记了一笔审计
      onStateChange: changed,
      now,
      log,
    });
    hosts.set(friendUid, coord);
  }

  /**
   * 开一条 B 侧的通道。`secret` 有值 = 首次配对那一轮（hello 里带持有证明）；
   * 没有 = 重启后的恢复路径，A 早就 pin 了 B，两边都走 pin。
   */
  function openGuest(
    hostUid: string,
    channelId: string,
    hostIdentityPub: Uint8Array,
    secret: Uint8Array | null,
    selfUid: string
  ): void {
    guests.get(hostUid)?.close();
    const transport = deps.openWireTransport(channelId, "guest");
    const coord = startProxyGuestCoordinator({
      crypto: deps.crypto,
      identity: deps.identity,
      deviceId: deps.deviceId,
      fromUid: selfUid,
      transport,
      peerIdentityPub: () => [hostIdentityPub],
      ...(secret ? { pairing: { proveWith: () => secret } } : {}),
      grantedServers: [], // 初始空——A 握手后推 proxy_grant 帧更新（proxyMcp 动态收）
      onStateChange: changed,
      // A 明说撤销了：**标记不删除**。删掉的话列表里那条凭空消失，
      // 和「对方今天没开机」长得一样；标记之后它还在，只是配着一句原因，
      // 而 usableBorrows 已经把它排除在自动重连之外
      onRevoked: (reason) => {
        guests.get(hostUid)?.close();
        guests.delete(hostUid);
        deps.saveStore(setBorrowRevoked(deps.loadStore(), hostUid, reason));
        changed();
        log(`好友撤销了代理授权：${hostUid}（${reason}）`);
      },
      log,
    });
    guests.set(hostUid, { mcp: coord.mcp, isReady: () => coord.connection.isReady(), close: coord.close });
  }

  return {
    async proxyCreateInvite(friendUid, allow) {
      // 邀请码里要写进 A 自己的 uid（B 拿它贴标签 + 记绑定，issue #670），
      // 没登录就没有这个 uid —— 而没登录本来也连不上 relay
      const selfUid = deps.currentUid();
      if (!selfUid) return { ok: false, message: "还没登录——好友代理要先登录" };
      // A 侧：先把授权写进白名单存储（B 连上后 host 按它执行 + 推 grant 帧）
      let store = setGrant(deps.loadStore(), { friendUid, allow });
      // 同一个好友复用同一个频道：重发邀请不该把 B 已经连着的那条房间换掉
      const channelId = channelFor(store, friendUid);
      const fresh = createProxyInvite(deps.crypto, deps.identity.publicKey, now(), selfUid);
      const inv: ProxyInvite = channelId ? { ...fresh, channelId } : fresh;
      store = setChannel(store, friendUid, inv.channelId);
      deps.saveStore(store);
      // A 主动连上这个频道（host 角色）等 B——B 用同一 channelId 连进来时，
      // relay 房间里就有 A(host)/B(guest) 两条连接，握手、推 grant、接受调用
      openHost(friendUid, inv.channelId, inv);
      log(`代理邀请码已生成并监听：好友 ${friendUid}，频道 ${inv.channelId.slice(0, 8)}…`);
      return { ok: true, value: { invite: encodeProxyInvite(inv) } };
    },

    async proxyAcceptInvite(invite) {
      const uid = deps.currentUid();
      if (!uid) return { ok: false, message: "还没登录——好友代理要先登录" };
      const inv = decodeProxyInvite(invite);
      if (!inv) return { ok: false, message: "邀请码不对——不是合法的代理邀请码（要 otto-proxy 开头的一串）" };
      if (proxyInviteExpired(inv, now())) return { ok: false, message: "邀请码过期了（10 分钟有效）——让对方重新生成一个" };
      // 对面得是自己的好友。A 那边本来就有同样一道闸（ADR-0164），这一道纯粹是为了
      // **把话说清楚**：不加这句，非好友的码也能「连上」，然后永远停在等授权
      const known = deps.friendUids();
      if (known === null) return { ok: false, message: "好友名单还没同步好，过一会儿再试" };
      if (!known.includes(inv.hostUid)) {
        return { ok: false, message: "这张邀请码的主人不在你的好友里——先互加好友再试" };
      }

      // B 侧：连 A 的频道（guest 角色），hello 里带上「我持有这张邀请的 secret」的证明，
      // 同时 pin 邀请码里 A 的身份公钥（双向认证都靠这张带外传来的码）。
      // **落盘**：邀请码一次性，不记下来 B 一重启就得让对方重发一张（issue #676）
      deps.saveStore(setBorrow(deps.loadStore(), inv.hostUid, inv.channelId, inv.hostIdentityPub));
      openGuest(inv.hostUid, inv.channelId, inv.hostIdentityPub, inv.secret, uid);
      changed();
      // grantedCount 此刻是 0：授权清单在握手后才由 A 推 proxy_grant 帧过来。
      // UI 据此显示「已连上，等待对方推送授权」，不是「授权为空」——
      // 真实数字随后由 onStateChange 推过去
      log(`代理通道已连上对方的频道 ${inv.channelId.slice(0, 8)}…（guest）`);
      return { ok: true, value: { grantedCount: 0 } };
    },

    async proxyListGrants() {
      const cur = deps.loadStore();
      return { ok: true, value: { grants: cur.grants.map((g) => ({ friendUid: g.friendUid, allow: g.allow })) } };
    },

    async proxyUpdateGrant(friendUid, allow) {
      // 没通道也照样存：好友还没接受邀请时改白名单是合理的（等他连上就按新的推）。
      // 有通道就当场推一帧——不推的话对面的工具表要等到下次握手才变
      deps.saveStore(setGrant(deps.loadStore(), { friendUid, allow }));
      hosts.get(friendUid)?.pushGrant();
      changed();
      log(`代理授权已更新：好友 ${friendUid}，${allow.length} 个服务`);
      return { ok: true, value: null };
    },

    async proxyRevoke(friendUid) {
      // 四步的顺序都有理由：
      // ① 存储先清——下一笔调用立即被拒（反过来的话中间那一瞬还能放行一笔）；
      // ② 再推一帧授权清单：此刻存储已空，推出去的就是 `servers: []`，
      //    B 的工具表当场清干净。不推的话那几把刀一直留在 B 的模型眼前，
      //    调起来还要等满超时才失败（issue #672）；
      // ③ **明说一句「撤销了」**（issue #680）：只做 ② 和 ④ 的话，B 看到的
      //    是「工具表空了 + 连接断了」——和「A 关机了」完全一样，而这两件事
      //    该做的动作相反（等一等 vs 重走一次邀请码）；
      // ④ 最后关房间。
      deps.saveStore(revokeGrant(deps.loadStore(), friendUid));
      const host = hosts.get(friendUid);
      host?.pushGrant();
      host?.pushRevoked("对方撤销了这条代理授权——要继续用得让他重新发一张邀请码");
      host?.close();
      hosts.delete(friendUid);
      changed();
      log(`代理授权已撤销：好友 ${friendUid}`);
      return { ok: true, value: null };
    },

    async proxyAudit(friendUid) {
      const cur = deps.loadStore();
      const audits = friendUid ? cur.audits.filter((a) => a.friendUid === friendUid) : cur.audits;
      return { ok: true, value: { audits } };
    },

    resume() {
      const cur = deps.loadStore();
      // ── A 侧：把已授权好友的房间重新开起来 ──
      for (const g of cur.grants) {
        const channelId = channelFor(cur, g.friendUid);
        // 没频道 = 邀请码还没发过；没 pin = B 还没连上过，那张邀请也已经不在内存里了，
        // 重开房间也握不了手（得让用户重发一张）。两种都跳过
        if (!channelId) continue;
        if (pinnedIdentities(cur, g.friendUid).length === 0) continue;
        openHost(g.friendUid, channelId, null);
      }
      if (hosts.size > 0) log(`代理：已恢复 ${hosts.size} 条对外通道`);

      // ── B 侧：把借来的那些重新连回去。没有 secret（一次性、不落盘），
      // 走 pin 路径——A 早就 pin 了 B，B 这边 pin 的是台账里那把公钥 ──
      const selfUid = deps.currentUid();
      if (selfUid) {
        for (const b of usableBorrows(cur)) {
          openGuest(b.hostUid, b.channelId, b.hostIdentityPub, null, selfUid);
        }
        if (guests.size > 0) log(`代理：已恢复 ${guests.size} 条借来的通道`);
      }
      changed();
    },

    activeProxies() {
      return [...guests.entries()].map(([friendUid, g]) => ({
        friendUid, label: deps.friendLabel(friendUid), mcp: g.mcp,
      }));
    },

    borrowStatus() {
      // 台账是底本，活着的通道往上贴状态：断线的那条**仍然要在列表里**——
      // 用户得看得见「配过、但现在没连上」，而不是它凭空消失。
      // 用 allBorrows 不用 usableBorrows：被撤销的那条**更**要看得见（带着理由），
      // 它只是不该再自动连回去（issue #680）
      return allBorrows(deps.loadStore()).map((b) => {
        const g = guests.get(b.hostUid);
        return {
          hostUid: b.hostUid,
          label: deps.friendLabel(b.hostUid),
          connected: g?.isReady() ?? false,
          serverCount: g?.mcp.servers().length ?? 0,
          ...(b.revokedReason !== undefined ? { revokedReason: b.revokedReason } : {}),
        };
      });
    },

    hostStatus() {
      const cur = deps.loadStore();
      // 同 borrowStatus 的口径：**授权台账是底本**，活着的通道往上贴状态。
      // 反过来（列举活着的通道）的话，好友没上线的那些授权在界面上就不存在了——
      // 而「授出去了但对方没连」恰恰是 A 最该看见的一格
      return cur.grants.map((g) => {
        const h = hosts.get(g.friendUid);
        // 最近一次被调用：审计是新→旧排的，第一条命中的就是最近的（含被拒的——
        // 「有人在拿被拒的请求敲门」同样是 A 该看见的活动）
        const last = cur.audits.find((a) => a.friendUid === g.friendUid);
        return {
          friendUid: g.friendUid,
          label: deps.friendLabel(g.friendUid),
          connected: h?.isReady() ?? false,
          inflight: h?.inflight() ?? 0,
          lastCallAt: last?.ts ?? null,
        };
      });
    },

    async proxyDisconnect(hostUid) {
      guests.get(hostUid)?.close();
      guests.delete(hostUid);
      deps.saveStore(removeBorrow(deps.loadStore(), hostUid));
      changed();
      log(`已断开借来的代理通道：${hostUid}`);
      return { ok: true, value: null };
    },

    closeAll() {
      for (const h of hosts.values()) h.close();
      hosts.clear();
      for (const g of guests.values()) g.close();
      guests.clear();
      // 登出时也走这里（issue #680）：界面得当场变成「都没连上」，
      // 而不是留着一排看起来还连着的绿点
      changed();
    },
  };
}
