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
  PROXY_INVITE_TTL_MS,
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
import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";
import type { McpContent, McpServerConfig } from "../shared/mcp.js";
import type { CloudGrantedServer } from "./pxCloudClient.js";
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
  /** 这条授权云端接得住吗（ADR-0197 切片 4）：好友授的服务里有一台已进
      托管箱 = 好友在 A 不在线时也用得上。**不是** connected 的反义词——
      连着时它照样为 true，只是那会儿没人走云端那条路 */
  cloudReady: boolean;
  /**
   * 配对到哪一步了（issue #682）。**这一格不是「连上了没」的同义词**：
   *
   *   paired      —— 对方的公钥已经 pin 下来，长期信任成立。连没连看 `connected`
   *   waiting     —— 邀请码发出去了、还没过期，就等对方粘进去
   *   needsInvite —— **那张邀请已经没用了**，得重发一张
   *
   * 最后这一档是一个真死锁的名字：一次性 secret 只活在内存里（ADR-0162），
   * A 在对方接受之前退出 app，secret 就没了；重启时 `resume()` 因为没有 pin
   * 而跳过这个好友，房间再也不开。B 那边无限重连显示「没连上」，
   * A 这边看着一切正常——两边都不知道修法是「A 重发一张」。
   * 判据全在已有数据里（有 channel、无 pin、房间没开着），只是一直没有名字。
   */
  pairing: "paired" | "waiting" | "needsInvite";
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
  /** A 侧**白名单本身**变了（发邀请/改授权/撤销），与 onChange 分开：那条
      连接状态一抖就响，而这条只在授权落盘时响——云端托管的 re-sync 挂这里
      （ADR-0197 切片 2）。撤销也走它：整箱重传/删除的判断在同步层，不在这层 */
  onGrantsChanged?: () => void;
  /** 开一个到 relay 某频道的点对点传输（index.ts 用 createWsTransport + adaptProxyWire 造） */
  openWireTransport: (channelId: string, role: "host" | "guest") => ProxyWireTransport;
  /** proxyStore 的落盘（0600/userData，index.ts 填 readProxyStore/writeProxyStore 的绑定） */
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  now?: () => number;
  log?: (m: string) => void;
  /** proxyAcceptInvite 等握手完成的上限（issue #788）。默认 12s；测试注小值 */
  acceptWaitMs?: number;
  /**
   * 云端执行面（ADR-0197 切片 3，issue #798）。不注入 = 没有云借用，
   * 一切退回纯通道行为（旧测试与旧装配零改动）。
   *
   * 注入后 B 侧的每条借用变成**一把会自己选路的刀**：live 通道 ready 走通道
   * （免费、快、A 看得见 inflight），否则打云端——A 关机也能用。
   */
  cloud?: {
    /** A 托管的授权清单。null = 查询失败（保留旧缓存，别当成授权清空） */
    fetchGrants(hostUid: string): Promise<readonly CloudGrantedServer[] | null>;
    call(hostUid: string, serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  };
  /** 云端授权清单缓存的保鲜期（默认 5 分钟）。过了鲜期且通道不在时，
      servers() 顺手踢一脚后台刷新 */
  cloudTtlMs?: number;
  /**
   * A 侧：此刻托管在云端的 serverId 清单（escrowSync.hostedServerIds，切片 4）。
   * null = 箱子不在云端。hostStatus 用它算每条授权的「云端可用」——
   * 好友授的服务里有一台进了箱，TA 不在线也能用
   */
  cloudHostedServerIds?: () => readonly string[] | null;
  /** 工作区连接器的 host（workspaceManager.hostUids()），无通道恒走云端；
      与配对借用按 hostUid 去重，配对那条优先。 */
  workspaceHosts?: () => readonly string[];
}

export interface ProxyManager {
  /** `ttlMs` 缺席 = 手动复制粘贴那条路的 10 分钟；随会话分享发出去的那种传
      `PROXY_SHARE_INVITE_TTL_MS`（异步兑换，issue #694 / ADR-0177） */
  proxyCreateInvite(
    friendUid: string, allow: ProxyGrant["allow"], ttlMs?: number
  ): Promise<FriendsResult<{ invite: string }>>;
  /** `ttlMs` 同上。B 侧这次判定只是提前给人话——权威判定在 A 侧的 `verifyWith` */
  proxyAcceptInvite(invite: string, ttlMs?: number): Promise<FriendsResult<{ grantedCount: number }>>;
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
   * A 侧：给所有连着的好友**补推**一帧授权清单（issue #792）。
   *
   * grant 帧原本只在握手 onReady 时推一次——那一刻 A 的 mcpHub 里某台服务
   * 还没 live（刚重启还在连 / OAuth 待授权），推出去的就是残缺清单，服务
   * 随后活了 B 也永远看不见。装配根把它挂在 mcpHub.onChange 上：A 的服务
   * 清单一变，所有 host 通道各补一帧。没握上手的通道 sendSealed 自己会
   * 拒发，不用在这层分辨
   */
  refreshGrants(): void;
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
   * 已经发出去、还没被人接受的邀请：好友 uid → 过期时刻（epoch ms）。
   *
   * **只在内存里**，和那把一次性 secret 同生共死（ADR-0162）——落盘的话就是在
   * 落盘一个「一次性」的东西的影子。进程一没，这张表跟着没，
   * 而那正是 `needsInvite` 要表达的事实本身。
   */
  const pendingInvites = new Map<string, number>();

  // ── 云借用（ADR-0197 切片 3）：hostUid → 云端授权清单的本地缓存 ──
  // 「缓存 + 后台刷」而不是每次现拉：servers() 是同步接口（工具表每 turn 现算），
  // 而清单在网络那头。查询失败保留旧缓存——「拿不到」≠「被清空」，
  // 真撤销有 proxy_revoked 帧与云端 403 双保险，不靠这份缓存表达
  const cloudServers = new Map<string, McpServerHandle[]>();
  const cloudFetchedAt = new Map<string, number>();
  const cloudInflight = new Set<string>();
  const cloudTtlMs = deps.cloudTtlMs ?? 5 * 60_000;

  function refreshCloudBorrow(hostUid: string): void {
    if (!deps.cloud || cloudInflight.has(hostUid)) return;
    cloudInflight.add(hostUid);
    void deps.cloud.fetchGrants(hostUid).then((granted) => {
      cloudInflight.delete(hostUid);
      if (granted === null) return; // 查询失败：旧缓存继续用
      cloudFetchedAt.set(hostUid, now());
      const handles = granted.map((g): McpServerHandle => ({
        // name 取 serverId：mcpHub 的 name 恒等于 id，云端与通道两条路
        // 由此长出**同一批**前缀工具名——审批记忆、share_grant_note 全都不用分家
        id: g.serverId, name: g.serverId, status: "connected", live: true,
        tools: [...g.toolDefs], resources: [], prompts: [],
      }));
      const before = JSON.stringify(cloudServers.get(hostUid) ?? []);
      if (JSON.stringify(handles) !== before) {
        cloudServers.set(hostUid, handles);
        changed(); // 工具表变了：渲染层与下个 turn 的工具表都要跟上
      }
    }).catch(() => { cloudInflight.delete(hostUid); });
  }

  /** 一把会自己选路的刀：live 通道 ready 走通道，否则打云端。
      **每次调用现判**，不在构造时定死——通道来去是常态 */
  function routedBorrowMcp(hostUid: string): McpCapability {
    const channel = (): { mcp: McpCapability; isReady: () => boolean } | undefined => guests.get(hostUid);
    const ready = (): boolean => channel()?.isReady() ?? false;
    const cloudView = (): McpServerHandle[] => {
      // 通道不在、缓存过鲜：顺手踢一脚后台刷新（本轮先用旧的，刷到了 changed 会再来）
      if (deps.cloud && now() - (cloudFetchedAt.get(hostUid) ?? 0) > cloudTtlMs) refreshCloudBorrow(hostUid);
      return cloudServers.get(hostUid) ?? [];
    };
    // 好友+同群重叠：对方既是配对好友（有活着的通道）又是工作区 host 时，
    // 工作区那份授权只在云端复刻，通道那头压根不知道有这些 server。旧写法
    // 「通道 ready 就整个替掉云视图」会让工作区授权的服务在 host 上线的
    // 那一刻反而从工具表里消失、host 下线后又冒出来——按台 id 求并集，
    // 通道那份撞车时赢（同一 id 两边都报，通道数据更新鲜），才是对的形状
    // （终审 H2）。
    const mergedServers = (): McpServerHandle[] => {
      const chan = ready() ? channel()!.mcp.servers() : [];
      const byId = new Map<string, McpServerHandle>();
      for (const s of cloudView()) byId.set(s.id, s);
      for (const s of chan) byId.set(s.id, s); // 通道赢
      return [...byId.values()];
    };
    return {
      ready: async () => {},
      servers: mergedServers,
      callTool: async (serverId, tool, args, signal) => {
        // 按台现选路：通道 ready 且通道视图确实曝光这台 serverId 才走通道，
        // 否则打云端——工作区授权的那些 server 通道执行器根本不认识
        const chanReady = ready() && (channel()!.mcp.servers().some((s) => s.id === serverId));
        if (chanReady) return channel()!.mcp.callTool(serverId, tool, args, signal);
        if (!deps.cloud) {
          // 没有云端执行面时保持旧话术（proxyMcp 同款）：抛错不回落本地（ADR-0166）
          throw new Error("代理通道断了——A（分享者）不在线。A 关机或吊销时好友代理不可用，这是设计");
        }
        return deps.cloud.call(hostUid, serverId, tool, args, signal);
      },
      // 以下四个与 proxyMcp 同一口径（通道路那边也是抛同样的话）
      readResource: () => { throw new Error("好友代理第一期不支持读资源（只代理工具调用）"); },
      getPrompt: () => { throw new Error("好友代理第一期不支持取提示（只代理工具调用）"); },
      configure: () => { throw new Error("好友代理的 server 配置在分享者（A）那边，B 不能改"); },
      authorize: () => { throw new Error("好友代理的授权在分享者（A）那边，B 不能替 A 授权"); },
      configOf: (): McpServerConfig | undefined => undefined,
    };
  }

  /**
   * 开一条 A 侧的 host 通道。`invite` 有值 = 这一轮还接受邀请码证明（首次配对）；
   * 没有 = 只认 pin 组（重启后的恢复路径）。
   */
  function openHost(
    friendUid: string, channelId: string, invite: ProxyInvite | null,
    ttlMs: number = PROXY_INVITE_TTL_MS
  ): void {
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
        verifyWith: () => (secret && invite && !proxyInviteExpired(invite, now(), ttlMs) ? secret : null),
        // 验过了才落 pin —— 这一步就是「这个公钥是被邀请的那个 B」的全部依据
        onPaired: (pub) => {
          deps.saveStore(setPin(deps.loadStore(), friendUid, pub));
          pendingInvites.delete(friendUid); // 有人接了，这张邀请不再「等着」
        },
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
        cloudServers.delete(hostUid); // 撤销 = 云端那份也不该再画在工具表里
        cloudFetchedAt.delete(hostUid);
        deps.saveStore(setBorrowRevoked(deps.loadStore(), hostUid, reason));
        changed();
        log(`好友撤销了代理授权：${hostUid}（${reason}）`);
      },
      log,
    });
    guests.set(hostUid, { mcp: coord.mcp, isReady: () => coord.connection.isReady(), close: coord.close });
  }

  return {
    async proxyCreateInvite(friendUid, allow, ttlMs = PROXY_INVITE_TTL_MS) {
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
      openHost(friendUid, inv.channelId, inv, ttlMs);
      pendingInvites.set(friendUid, inv.createdTs + ttlMs);
      changed();
      deps.onGrantsChanged?.();
      log(`代理邀请码已生成并监听：好友 ${friendUid}，频道 ${inv.channelId.slice(0, 8)}…`);
      return { ok: true, value: { invite: encodeProxyInvite(inv) } };
    },

    async proxyAcceptInvite(invite, ttlMs = PROXY_INVITE_TTL_MS) {
      const uid = deps.currentUid();
      if (!uid) return { ok: false, message: "还没登录——好友代理要先登录" };
      const inv = decodeProxyInvite(invite);
      if (!inv) return { ok: false, message: "邀请码不对——不是合法的代理邀请码（要 otto-proxy 开头的一串）" };
      if (proxyInviteExpired(inv, now(), ttlMs)) {
        // 分享带来的那种活 24 小时，手动粘贴那种活 10 分钟——话得说对，
        // 不然用户按着「才刚发的啊」的印象去找原因
        const window = ttlMs >= 60 * 60_000 ? `${Math.round(ttlMs / 3_600_000)} 小时` : `${Math.round(ttlMs / 60_000)} 分钟`;
        return { ok: false, message: `邀请码过期了（${window}有效）——让对方重新生成一个` };
      }
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
      refreshCloudBorrow(inv.hostUid); // 云端清单预热：通道日后断了，刀还在
      changed();
      // **等到握手真的完成再回答**（issue #788）：openGuest 是异步起跑的，
      // 立刻回 ok 的话「A 重启过（secret 作废）/ A 不在线」这两种失败都被
      // 报成成功——分享卡照着它把对话导进去，用户以为接上了，工具表却永远
      // 是空的，水獭找不到刀就自作主张在本地配一台。台账刚才已落盘：
      // 失败不回滚——同一个好友复用同一个频道，A 重发邀请后这条台账直接可用
      const waitMs = deps.acceptWaitMs ?? 12_000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (guests.get(inv.hostUid)?.isReady()) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!guests.get(inv.hostUid)?.isReady()) {
        return {
          ok: false,
          message:
            "频道开了但没握上手——对方现在不在线，或分享之后重启过 app（邀请码一次性，重启即作废）。确认 TA 开着 app，或让 TA 重新分享/重发一张邀请码",
        };
      }
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
      deps.onGrantsChanged?.();
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
      pendingInvites.delete(friendUid);
      changed();
      // 撤销级联的前半（ADR-0197）：本地白名单已清，云端那份由同步层跟进
      // ——最后一条授权撤掉时整箱 DELETE，凭证与授权即刻从 edge 消失
      deps.onGrantsChanged?.();
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
          // 云端授权清单也预热一份（issue #798）：A 不在线时通道永远握不上，
          // 这份缓存就是 B 工具表的唯一来源
          refreshCloudBorrow(b.hostUid);
        }
        if (guests.size > 0) log(`代理：已恢复 ${guests.size} 条借来的通道`);
      }
      changed();
    },

    refreshGrants() {
      for (const h of hosts.values()) h.pushGrant();
    },

    activeProxies() {
      // 台账（usableBorrows）是底本，不再只列活着的通道（issue #798）：
      // 「配过、此刻没连上」的借用正是云借用要接住的那种——A 关机了，
      // 但托管在云端的刀还在。每条的 mcp 是一把会自己选路的刀
      const paired = usableBorrows(deps.loadStore());
      const pairedUids = new Set(paired.map((b) => b.hostUid));
      // 工作区连接器的 host 并进来（Task 10，ADR-0198 切片 3）：这些 host 从没
      // 走过配对握手，天生没有通道——routedBorrowMcp 对无通道 host 本来就直接
      // 落 cloudView/云 call（issue #798 的机器），这里零改动直接复用。
      // 按 hostUid 去重、配对借用优先：同一个人既配对借用又是工作区 host 时，
      // 配对那条带着「断线可恢复」的通道语义，不该被工作区那条覆盖
      const wsOnly = (deps.workspaceHosts?.() ?? []).filter((u) => !pairedUids.has(u));
      return [
        ...paired.map((b) => ({ friendUid: b.hostUid, label: deps.friendLabel(b.hostUid), mcp: routedBorrowMcp(b.hostUid) })),
        ...wsOnly.map((u) => ({ friendUid: u, label: deps.friendLabel(u), mcp: routedBorrowMcp(u) })),
      ];
    },

    borrowStatus() {
      // 台账是底本，活着的通道往上贴状态：断线的那条**仍然要在列表里**——
      // 用户得看得见「配过、但现在没连上」，而不是它凭空消失。
      // 用 allBorrows 不用 usableBorrows：被撤销的那条**更**要看得见（带着理由），
      // 它只是不该再自动连回去（issue #680）
      return allBorrows(deps.loadStore()).map((b) => {
        const g = guests.get(b.hostUid);
        const connected = g?.isReady() ?? false;
        return {
          hostUid: b.hostUid,
          label: deps.friendLabel(b.hostUid),
          connected,
          // 此刻可用的刀数：通道在按通道算，不在按云端缓存算（issue #798）——
          // 「断线但云端可用」的那条不该显示成 0 把刀
          serverCount: connected ? (g?.mcp.servers().length ?? 0) : (cloudServers.get(b.hostUid)?.length ?? 0),
          ...(b.revokedReason !== undefined ? { revokedReason: b.revokedReason } : {}),
        };
      });
    },

    hostStatus() {
      const cur = deps.loadStore();
      // 同 borrowStatus 的口径：**授权台账是底本**，活着的通道往上贴状态。
      // 反过来（列举活着的通道）的话，好友没上线的那些授权在界面上就不存在了——
      // 而「授出去了但对方没连」恰恰是 A 最该看见的一格
      const hostedIds = deps.cloudHostedServerIds?.() ?? null;
      return cur.grants.map((g) => {
        const h = hosts.get(g.friendUid);
        // 最近一次被调用：审计是新→旧排的，第一条命中的就是最近的（含被拒的——
        // 「有人在拿被拒的请求敲门」同样是 A 该看见的活动）
        const last = cur.audits.find((a) => a.friendUid === g.friendUid);
        // 三档的判据全在已有数据里（issue #682）：
        //   有 pin                       = 配对成立，之后重连都走 pin，不再需要邀请码
        //   无 pin + 房间开着 + 邀请没过期 = 就等对方粘码
        //   其余                          = 那张邀请已经没用了（过期，或 app 重启把
        //                                   只在内存里的 secret 带走了）→ 重发一张
        const pinned = pinnedIdentities(cur, g.friendUid).length > 0;
        const inviteLive = (pendingInvites.get(g.friendUid) ?? 0) > now();
        return {
          friendUid: g.friendUid,
          label: deps.friendLabel(g.friendUid),
          connected: h?.isReady() ?? false,
          inflight: h?.inflight() ?? 0,
          lastCallAt: last?.ts ?? null,
          cloudReady: hostedIds !== null && g.allow.some((a) => hostedIds.includes(a.serverId)),
          pairing: pinned ? "paired" as const
            : hosts.has(g.friendUid) && inviteLive ? "waiting" as const
            : "needsInvite" as const,
        };
      });
    },

    async proxyDisconnect(hostUid) {
      guests.get(hostUid)?.close();
      guests.delete(hostUid);
      cloudServers.delete(hostUid);
      cloudFetchedAt.delete(hostUid);
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
      // 登出连云端缓存一起清：换账号后上一个人借来的刀不该还画在表里
      cloudServers.clear();
      cloudFetchedAt.clear();
      // 登出时也走这里（issue #680）：界面得当场变成「都没连上」，
      // 而不是留着一排看起来还连着的绿点
      changed();
    },
  };
}
