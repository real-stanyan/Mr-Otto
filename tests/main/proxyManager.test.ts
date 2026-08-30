import { describe, expect, it } from "vitest";
import { createProxyManager } from "../../src/main/proxyManager.js";
import {
  channelFor, emptyProxyStore, pinnedIdentities, type ProxyStoreData,
} from "../../src/main/proxyStore.js";
import {
  decodeProxyInvite, encodeProxyInvite, PROXY_SHARE_INVITE_TTL_MS,
} from "../../src/shared/remote/proxyInvite.js";
import type { ProxyWireTransport } from "../../src/main/proxyCoordinator.js";
import type { McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";

// proxyManager 的装配面：A 发邀请码 → B 输码 → 握手认人 → A 把 B 的公钥 pin 下来。
// 中间那根管子是一个假 relay：按 channelId 分房，两边都到齐时各发一次「对端在场」
// （真 relay 的 `:peer`），这正是握手的起跑枪。
//
// 这里钉死的是**信任根**（ADR-0162）：光知道 channelId 连不进来，
// 只有拿着那张邀请码的 B 才 pin 得上——否则任何拿到频道号的人都能用 A 的凭证。

const p = nodeRemoteCrypto();

function server(id: string): McpServerHandle {
  return {
    id, name: id, status: "connected", live: true,
    tools: [{ name: "get_orders", description: "", inputSchema: {} }],
    resources: [], prompts: [],
  } as unknown as McpServerHandle;
}

function fakeMcp(servers: McpServerHandle[]): McpCapability {
  return {
    ready: async () => {},
    servers: () => servers,
    callTool: async () => [{ kind: "text", text: "ok" }],
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    configure: async () => {},
    authorize: async () => ({ ok: true }),
    configOf: () => undefined,
  } as unknown as McpCapability;
}

/** 假 relay：按 channelId 分房，一房两角色，两边到齐就各喊一声「对端在场」 */
function fakeRelay() {
  type Side = { msg: ((p: string) => void) | null; peers: (() => void)[]; gone: (() => void)[]; closed: boolean };
  const rooms = new Map<string, { host: Side | null; guest: Side | null }>();

  function open(channelId: string, role: "host" | "guest"): ProxyWireTransport {
    const room = rooms.get(channelId) ?? { host: null, guest: null };
    rooms.set(channelId, room);
    const me: Side = { msg: null, peers: [], gone: [], closed: false };
    room[role] = me;
    const other = (): Side | null => (role === "host" ? room.guest : room.host);

    // 两边都在了 = 两边各收一条 `:peer`。晚到的那一方触发（真 relay 也是这个时机）
    const peer = other();
    if (peer && !peer.closed) {
      queueMicrotask(() => {
        for (const cb of me.peers) cb();
        for (const cb of peer.peers) cb();
      });
    }
    return {
      send: (payload) => { const o = other(); if (o && !o.closed) o.msg?.(payload); },
      onMessage: (cb) => { me.msg = cb; },
      onPeerPresent: (cb) => { me.peers.push(cb); },
      onPeerGone: (cb) => { me.gone.push(cb); },
      close: () => {
        me.closed = true;
        room[role] = null;
        // 真 relay 上一方断开，另一方会收到一条 `:gone`
        const o = other();
        if (o && !o.closed) for (const cb of o.gone) cb();
      },
    };
  }
  return { open };
}

/** 一台机器：自己的身份 + 自己的台账 + 接同一个假 relay 的 manager */
function machine(
  relay: ReturnType<typeof fakeRelay>,
  uid: string,
  servers: McpServerHandle[] = [],
  friends: readonly string[] = ["a-uid", "b-uid", "evil-uid"],
  onChange?: () => void,
  /** 「重启」用：沿用同一把身份密钥和同一份台账 */
  carry?: { identity: ReturnType<typeof p.generateEd25519>; store: ProxyStoreData }
) {
  const identity = carry?.identity ?? p.generateEd25519();
  let store: ProxyStoreData = carry?.store ?? emptyProxyStore();
  const manager = createProxyManager({
    crypto: p,
    identity,
    deviceId: uid,
    mcp: fakeMcp(servers),
    currentUid: () => uid,
    // 这台机器把对面当好友（关系闸在 proxyHost 层，那里单独测）
    friendUids: () => friends,
    friendLabel: (u) => (u === "a-uid" ? "小明" : ""),
    ...(onChange ? { onChange } : {}),
    openWireTransport: (channelId, role) => relay.open(channelId, role),
    loadStore: () => store,
    saveStore: (d) => { store = d; },
    // 测试里握手要么几个 microtask 内完成，要么永远不会完成——别等满默认 12s
    acceptWaitMs: 300,
  });
  return { identity, manager, store: () => store };
}

/** 同一台机器「重启」：同一把身份密钥 + 同一份台账，新的 manager */
function reopen(relay: ReturnType<typeof fakeRelay>, prev: ReturnType<typeof machine>, uid: string) {
  return machine(relay, uid, [], ["a-uid", "b-uid", "c-uid"], undefined, {
    identity: prev.identity, store: prev.store(),
  });
}

/** 假 relay 的「对端在场」走 microtask，等一拍让握手跑完 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("proxyManager（邀请码 → 握手认人 → pin，issue #657 / ADR-0162）", () => {
  it("B 输入真邀请码 → A 把 B 的公钥 pin 下来", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: ["get_orders"] }]);
    expect(made.ok).toBe(true);
    const invite = made.ok ? made.value.invite : "";

    const took = await b.manager.proxyAcceptInvite(invite);
    expect(took.ok).toBe(true);
    await settle();

    const pinned = pinnedIdentities(a.store(), "b-uid");
    expect(pinned.map((k) => Array.from(k))).toEqual([Array.from(b.identity.publicKey)]);

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("A 不在线（房间没 host）：accept 等不到握手，直说失败而不是假装接上（issue #788）", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    const invite = made.ok ? made.value.invite : "";
    a.manager.closeAll(); // A 退出 app：host 连接关掉，房间空了

    const b = machine(relay, "b-uid");
    const took = await b.manager.proxyAcceptInvite(invite);
    expect(took.ok).toBe(false);
    if (!took.ok) expect(took.message).toContain("没握上手");
    b.manager.closeAll();
  });

  it("只知道 channelId 的人连进同一个房间 → 握不上手，A 不 pin 它", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const attacker = machine(relay, "evil-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    const invite = made.ok ? made.value.invite : "";
    const real = decodeProxyInvite(invite)!;

    // 冒充者拿到了频道号和 A 的公钥（都在线上/日志里可见），但没有那把一次性 secret
    const forged = encodeProxyInvite({ ...real, secret: p.randomBytes(32) });
    const took = await attacker.manager.proxyAcceptInvite(forged);
    // guest 侧的 isReady 只证明「我这一半握完了」——A 拒了持有证明但 B 端不知道，
    // 所以这里仍是 ok:true。issue #788 的等待拦的是「房间根本没开」那一形态
    // （A 重启/不在线）；「A 在线但拒认」的告知另有 pin 缺席那条防线兜着
    expect(took.ok).toBe(true);
    await settle();

    expect(pinnedIdentities(a.store(), "b-uid")).toEqual([]);
    expect(a.store().pins).toEqual([]);

    a.manager.closeAll();
    attacker.manager.closeAll();
  });

  it("同一好友重发邀请码复用同一个频道（B 已连着的那条房间不被换掉）", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);

    const first = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    const chan1 = channelFor(a.store(), "b-uid");
    const second = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    expect(channelFor(a.store(), "b-uid")).toBe(chan1);

    const inv1 = decodeProxyInvite(first.ok ? first.value.invite : "")!;
    const inv2 = decodeProxyInvite(second.ok ? second.value.invite : "")!;
    expect(inv2.channelId).toBe(inv1.channelId);
    // secret 是新的：重发一张邀请 = 换一把一次性钥匙
    expect(Array.from(inv2.secret)).not.toEqual(Array.from(inv1.secret));

    a.manager.closeAll();
  });

  it("撤销后 pin / 频道 / 授权一起没，B 重连也进不来", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(pinnedIdentities(a.store(), "b-uid")).toHaveLength(1);

    await a.manager.proxyRevoke("b-uid");
    expect(a.store().grants).toEqual([]);
    expect(a.store().pins).toEqual([]);
    expect(channelFor(a.store(), "b-uid")).toBeNull();

    // 房间关了：A 重启也不会把它恢复起来
    a.manager.resume();
    expect(a.store().pins).toEqual([]);

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("没登录时输邀请码 → 说人话拒绝", async () => {
    const relay = fakeRelay();
    const identity = p.generateEd25519();
    let store: ProxyStoreData = emptyProxyStore();
    const manager = createProxyManager({
      crypto: p, identity, deviceId: "B", mcp: fakeMcp([]),
      currentUid: () => null,
      friendUids: () => [],
      friendLabel: () => "",
      openWireTransport: (c, r) => relay.open(c, r),
      loadStore: () => store, saveStore: (d) => { store = d; },
    });
    const r = await manager.proxyAcceptInvite("otto-proxy:1:c:AAA:BBB:1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("登录");
  });

  it("邀请码不是那串东西 / 过期 → 说人话拒绝", async () => {
    const relay = fakeRelay();
    const b = machine(relay, "b-uid");
    const bad = await b.manager.proxyAcceptInvite("随便一串字");
    expect(bad.ok === false && bad.message).toContain("邀请码不对");

    const a = machine(relay, "a-uid");
    const made = await a.manager.proxyCreateInvite("b-uid", []);
    const inv = decodeProxyInvite(made.ok ? made.value.invite : "")!;
    const stale = encodeProxyInvite({ ...inv, createdTs: inv.createdTs - 11 * 60_000 });
    const old = await b.manager.proxyAcceptInvite(stale);
    expect(old.ok === false && old.message).toContain("过期");
    expect(old.ok === false && old.message).toContain("10 分钟");

    a.manager.closeAll();
    b.manager.closeAll();
  });

  // ─── 随分享发出去的那种邀请活得久一点（issue #694，ADR-0177）─────
  it("传了 24 小时的有效期，11 分钟前那张就还认", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid");
    const b = machine(relay, "b-uid");
    const made = await a.manager.proxyCreateInvite("b-uid", [], PROXY_SHARE_INVITE_TTL_MS);
    const inv = decodeProxyInvite(made.ok ? made.value.invite : "")!;
    const elevenMinAgo = encodeProxyInvite({ ...inv, createdTs: inv.createdTs - 11 * 60_000 });

    // 默认那 10 分钟的口径下它早就过期了 —— 两次判定的差别只来自 ttlMs
    const asDefault = await b.manager.proxyAcceptInvite(elevenMinAgo);
    expect(asDefault.ok).toBe(false);

    const asShare = await b.manager.proxyAcceptInvite(elevenMinAgo, PROXY_SHARE_INVITE_TTL_MS);
    expect(asShare.ok).toBe(true);

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("超过 24 小时照样拒，且话里说的是 24 小时不是 10 分钟", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid");
    const b = machine(relay, "b-uid");
    const made = await a.manager.proxyCreateInvite("b-uid", [], PROXY_SHARE_INVITE_TTL_MS);
    const inv = decodeProxyInvite(made.ok ? made.value.invite : "")!;
    const yesterday = encodeProxyInvite({ ...inv, createdTs: inv.createdTs - 25 * 60 * 60_000 });

    const r = await b.manager.proxyAcceptInvite(yesterday, PROXY_SHARE_INVITE_TTL_MS);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("24 小时");

    a.manager.closeAll();
    b.manager.closeAll();
  });
});

// ─── B 侧的出口与好友闸（issue #670）────────────────────────────────────
describe("proxyManager 的 B 侧出口（issue #670）", () => {
  it("接上之后 activeProxies 报出这条通道——这是 proxyMcp 唯一的出口", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    expect(b.manager.activeProxies()).toEqual([]);
    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();

    const live = b.manager.activeProxies();
    expect(live).toHaveLength(1);
    expect(live[0]?.friendUid).toBe("a-uid");
    expect(live[0]?.label).toBe("小明"); // 人话名字来自注入的 friendLabel
    expect(typeof live[0]?.mcp.callTool).toBe("function");

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("邀请码的主人不在我的好友里 → 说人话拒绝，而不是连上了什么都没有", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const stranger = machine(relay, "b-uid", [], ["someone-else"]); // a-uid 不在它的好友里

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    const r = await stranger.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("不在你的好友里");
    expect(stranger.manager.activeProxies()).toEqual([]);

    a.manager.closeAll();
    stranger.manager.closeAll();
  });

  it("A 没登录 → 生成不了邀请码（码里要写进 A 自己的 uid）", async () => {
    const relay = fakeRelay();
    const identity = p.generateEd25519();
    let store: ProxyStoreData = emptyProxyStore();
    const manager = createProxyManager({
      crypto: p, identity, deviceId: "A", mcp: fakeMcp([]),
      currentUid: () => null,
      friendUids: () => ["b-uid"],
      friendLabel: () => "",
      openWireTransport: (c, r) => relay.open(c, r),
      loadStore: () => store, saveStore: (d) => { store = d; },
    });
    const r = await manager.proxyCreateInvite("b-uid", []);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("登录");
  });
});

// ─── A 那边发生的事，B 要感知得到（issue #672）──────────────────────────
describe("proxyManager：撤销与离场传到 B（issue #672）", () => {
  it("A 撤销 → 先推一帧空清单再关房间，B 的工具表当场清干净", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();

    const proxied = b.manager.activeProxies()[0]!;
    expect(proxied.mcp.servers().map((s) => s.id)).toEqual(["shopify"]); // A 推来的授权清单

    await a.manager.proxyRevoke("b-uid");
    await settle();
    // 不推空清单的话这几把刀会一直留在 B 的模型眼前，调起来还要等满超时才失败
    expect(proxied.mcp.servers()).toEqual([]);

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("A 关掉房间 → B 这边的通道退出就绪，调用当场失败而不是等满超时", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    const proxied = b.manager.activeProxies()[0]!;

    a.manager.closeAll(); // A 退出 app / 撤销
    await settle();

    // 「代理通道断了」是当场答的；不接 onPeerGone 的话这里会把帧发进虚空，
    // 然后等满 60 秒报「超时（A 没回）」——错的时机、错的原因
    await expect(proxied.mcp.callTool("shopify", "get_orders", {})).rejects.toThrow(/通道断了/);

    b.manager.closeAll();
  });
});

// ─── B 侧持久化与多好友（issue #676）────────────────────────────────────
describe("proxyManager 的 B 侧台账（issue #676）", () => {
  it("同时借两个好友的服务——合并层一直支持多条，之前卡在单条变量上", async () => {
    const relay = fakeRelay();
    const a1 = machine(relay, "a-uid", [server("shopify")]);
    const a2 = machine(relay, "c-uid", [server("ads")]);
    const b = machine(relay, "b-uid", [], ["a-uid", "c-uid"]);

    for (const [host, srv] of [[a1, "shopify"], [a2, "ads"]] as const) {
      const made = await host.manager.proxyCreateInvite("b-uid", [{ serverId: srv, tools: [] }]);
      await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    }
    await settle();

    expect(b.manager.activeProxies().map((c) => c.friendUid).sort()).toEqual(["a-uid", "c-uid"]);
    expect(b.manager.borrowStatus()).toHaveLength(2);
    expect(b.manager.borrowStatus().every((s) => s.connected)).toBe(true);

    a1.manager.closeAll(); a2.manager.closeAll(); b.manager.closeAll();
  });

  it("B 重启：靠落盘的 channelId + 对方公钥连回去，不用重发邀请码", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b1 = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b1.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(b1.store().borrows).toHaveLength(1);

    // 「重启」= 同一份台账、同一把身份密钥，重新造一个 manager
    b1.manager.closeAll();
    const b2 = reopen(relay, b1, "b-uid");
    b2.manager.resume();
    await settle();

    // secret 是一次性的、没落盘——这一轮走的是两边的 pin
    expect(b2.manager.activeProxies()).toHaveLength(1);
    expect(b2.manager.borrowStatus()[0]).toMatchObject({ hostUid: "a-uid", connected: true });

    a.manager.closeAll(); b2.manager.closeAll();
  });

  it("断开 = 关通道 + 从台账删掉，下次启动不再连回去", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();

    await b.manager.proxyDisconnect("a-uid");
    expect(b.manager.activeProxies()).toEqual([]);
    expect(b.store().borrows).toEqual([]);
    b.manager.resume();
    await settle();
    expect(b.manager.activeProxies()).toEqual([]);

    a.manager.closeAll(); b.manager.closeAll();
  });

  it("断线的那条仍然在列表里（「配过但没连上」不是「凭空消失」）", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(b.manager.borrowStatus()[0]?.connected).toBe(true);

    a.manager.closeAll(); // 对方下线
    await settle();
    const st = b.manager.borrowStatus();
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ hostUid: "a-uid", connected: false });

    b.manager.closeAll();
  });

  // ─── A 侧那块表 + 撤销说得清（issue #680）────────────────────────────
  it("A 看得见：对方连没连、最近一次什么时候被调用", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    // 还没连上时也要在表里：「授出去了但对方没连」正是 A 最该看见的一格
    expect(a.manager.hostStatus()).toMatchObject([
      { friendUid: "b-uid", connected: false, inflight: 0, lastCallAt: null },
    ]);

    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(a.manager.hostStatus()[0]).toMatchObject({ connected: true, inflight: 0, lastCallAt: null });

    // B 真调一笔 → A 那边记了审计 → 「最近一次」有值了
    await b.manager.activeProxies()[0]!.mcp.callTool("shopify", "get_orders", {});
    await settle();
    expect(a.manager.hostStatus()[0]!.lastCallAt).not.toBeNull();

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("A 发码后退出 app → 那条报「邀请已失效」，不是「没连上」（issue #682）", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);

    await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    // 码刚发出去、没人接：等着就行
    expect(a.manager.hostStatus()[0]!.pairing).toBe("waiting");

    // A 退出 app —— 一次性 secret 只活在内存里（ADR-0162），跟着没了
    a.manager.closeAll();
    const a2 = reopen(relay, a, "a-uid");
    a2.manager.resume();
    await settle();

    // 台账里那条 grant 还在，但那张邀请已经没用了：resume 因为没有 pin 跳过它，
    // 房间再也不开。这一档必须有自己的名字——报成「没连上」等于让用户干等
    expect(a2.manager.hostStatus()).toMatchObject([{ friendUid: "b-uid", pairing: "needsInvite" }]);

    a2.manager.closeAll();
  });

  it("重发一张 → 对方接上 → 转成 paired，A 重启后不再需要邀请码", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    // pin 落下来了 = 长期信任成立，之后重连都走 pin
    expect(a.manager.hostStatus()[0]!.pairing).toBe("paired");

    a.manager.closeAll();
    b.manager.closeAll();
    const a2 = reopen(relay, a, "a-uid");
    a2.manager.resume();
    await settle();
    expect(a2.manager.hostStatus()[0]!.pairing).toBe("paired");

    a2.manager.closeAll();
  });

  it("撤销 → B 收到的是一句「被撤销了」，不是一次静默断线；台账标记但不删除", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(b.manager.borrowStatus()[0]).toMatchObject({ connected: true });

    await a.manager.proxyRevoke("b-uid");
    await settle();

    // 那条**还在列表里**，只是配着一句理由 —— 直接删掉的话它长得和
    // 「对方今天没开机」一模一样，而这两件事该做的动作相反
    const st = b.manager.borrowStatus();
    expect(st).toHaveLength(1);
    expect(st[0]!.connected).toBe(false);
    expect(st[0]!.revokedReason).toMatch(/撤销/);

    // 而且不该再自动连回去：重启一次，被撤的那条不进 resume
    const b2 = reopen(relay, b, "b-uid");
    b2.manager.resume();
    await settle();
    expect(b2.manager.activeProxies()).toHaveLength(0);
    expect(b2.manager.borrowStatus()[0]!.revokedReason).toMatch(/撤销/);

    a.manager.closeAll();
    b.manager.closeAll();
    b2.manager.closeAll();
  });

  it("改授权不重发邀请码：频道不变，B 的工具表当场跟着变", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify"), server("ads")]);
    const b = machine(relay, "b-uid");

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    const chan = channelFor(a.store(), "b-uid");
    expect(b.manager.activeProxies()[0]!.mcp.servers()).toHaveLength(1);

    await a.manager.proxyUpdateGrant("b-uid", [
      { serverId: "shopify", tools: [] }, { serverId: "ads", tools: [] },
    ]);
    await settle();

    // 频道没换（没重新配对），但对面的工具表已经是新的
    expect(channelFor(a.store(), "b-uid")).toBe(chan);
    expect(b.manager.activeProxies()[0]!.mcp.servers()).toHaveLength(2);

    a.manager.closeAll();
    b.manager.closeAll();
  });

  it("状态变了会喊一声（UI 的唯一信号源）", async () => {
    const relay = fakeRelay();
    const a = machine(relay, "a-uid", [server("shopify")]);
    let beats = 0;
    const b = machine(relay, "b-uid", [], ["a-uid"], () => { beats += 1; });

    const made = await a.manager.proxyCreateInvite("b-uid", [{ serverId: "shopify", tools: [] }]);
    await b.manager.proxyAcceptInvite(made.ok ? made.value.invite : "");
    await settle();
    expect(beats).toBeGreaterThan(0); // 接受 + 握手完成 + 收到授权清单

    beats = 0;
    a.manager.closeAll(); // 对方下线也要喊
    await settle();
    expect(beats).toBeGreaterThan(0);

    b.manager.closeAll();
  });
});
