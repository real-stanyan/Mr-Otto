import { describe, expect, it } from "vitest";
import { createProxyManager } from "../../src/main/proxyManager.js";
import {
  channelFor, emptyProxyStore, pinnedIdentities, type ProxyStoreData,
} from "../../src/main/proxyStore.js";
import { decodeProxyInvite, encodeProxyInvite } from "../../src/shared/remote/proxyInvite.js";
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
  type Side = { msg: ((p: string) => void) | null; peers: (() => void)[]; closed: boolean };
  const rooms = new Map<string, { host: Side | null; guest: Side | null }>();

  function open(channelId: string, role: "host" | "guest"): ProxyWireTransport {
    const room = rooms.get(channelId) ?? { host: null, guest: null };
    rooms.set(channelId, room);
    const me: Side = { msg: null, peers: [], closed: false };
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
      close: () => { me.closed = true; room[role] = null; },
    };
  }
  return { open };
}

/** 一台机器：自己的身份 + 自己的台账 + 接同一个假 relay 的 manager */
function machine(relay: ReturnType<typeof fakeRelay>, uid: string, servers: McpServerHandle[] = []) {
  const identity = p.generateEd25519();
  let store: ProxyStoreData = emptyProxyStore();
  const manager = createProxyManager({
    crypto: p,
    identity,
    deviceId: uid,
    mcp: fakeMcp(servers),
    currentUid: () => uid,
    openWireTransport: (channelId, role) => relay.open(channelId, role),
    loadStore: () => store,
    saveStore: (d) => { store = d; },
  });
  return { identity, manager, store: () => store };
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
    expect(took.ok).toBe(true); // 本地这一步只是「连上去」，认不认是 A 说了算
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
    a.manager.resumeHosts();
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

    a.manager.closeAll();
    b.manager.closeAll();
  });
});
