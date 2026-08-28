import { describe, expect, it } from "vitest";
import {
  startProxyGuestCoordinator,
  startProxyHostCoordinator,
  type ProxyWireTransport,
} from "../../src/main/proxyCoordinator.js";
import { emptyProxyStore, setGrant, type ProxyStoreData } from "../../src/main/proxyStore.js";
import type { McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";

// 协调器端到端：A(host) 和 B(guest) 各起一个协调器，中间一根直连管道互喂。
// B 的 proxyMcp.callTool → 帧走连接 → A 收 → 白名单 → A 的 MCP 执行 → 回 B → A 记审计。
// 用真实 noble crypto（不经过 relay）。

function server(id: string): McpServerHandle {
  return { id, name: id, status: "connected", live: true, tools: [], resources: [], prompts: [] };
}

function fakeMcp(result: string): McpCapability & { calls: { serverId: string; tool: string }[] } {
  const calls: { serverId: string; tool: string }[] = [];
  return {
    calls,
    ready: async () => {},
    servers: () => [],
    callTool: async (serverId: string, tool: string) => {
      calls.push({ serverId, tool });
      return [{ kind: "text", text: result }];
    },
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    configure: async () => {},
    authorize: async () => ({ ok: true }),
    configOf: () => undefined,
  } as unknown as McpCapability & { calls: { serverId: string; tool: string }[] };
}

/** 一对直连 transport：host.send→guest.onMessage，guest.send→host.onMessage */
function linkedWire() {
  let hostCb: ((p: string) => void) | null = null;
  let guestCb: ((p: string) => void) | null = null;
  const hostWire: ProxyWireTransport = {
    send: (p) => guestCb?.(p),
    onMessage: (cb) => { hostCb = cb; },
    close: () => {},
  };
  const guestWire: ProxyWireTransport = {
    send: (p) => hostCb?.(p),
    onMessage: (cb) => { guestCb = cb; },
    close: () => {},
  };
  return { hostWire, guestWire };
}

describe("proxyCoordinator（A/B 协调器端到端，issue #622 PR-D2）", () => {
  it("B 调工具 → A 用 A 的 MCP 执行 → 结果回 B → A 记审计", async () => {
    const p = nodeRemoteCrypto();
    const aId = p.generateEd25519();
    const bId = p.generateEd25519();
    const { hostWire, guestWire } = linkedWire();

    // A 侧：存储里有给 b-uid 的白名单（shopify.get_orders）
    let store: ProxyStoreData = setGrant(emptyProxyStore(), {
      friendUid: "b-uid", allow: [{ serverId: "shopify", tools: ["get_orders"] }],
    });
    const aMcp = fakeMcp("orders-data");
    const host = startProxyHostCoordinator({
      crypto: p, identity: aId, deviceId: "A",
      transport: hostWire, mcp: aMcp,
      peerIdentityPub: () => [bId.publicKey],
      friendUid: "b-uid",
      loadStore: () => store, saveStore: (d) => { store = d; },
    });

    // B 侧
    const guest = startProxyGuestCoordinator({
      crypto: p, identity: bId, deviceId: "B", fromUid: "b-uid",
      transport: guestWire,
      peerIdentityPub: () => [aId.publicKey],
      grantedServers: [server("shopify")],
    });

    // 双方握手
    host.connection.start();
    guest.connection.start();
    expect(host.connection.isReady()).toBe(true);
    expect(guest.connection.isReady()).toBe(true);

    // B 调 Shopify 工具
    const out = await guest.mcp.callTool("shopify", "get_orders", { limit: 5 });
    expect(out).toEqual([{ kind: "text", text: "orders-data" }]);
    // A 的 MCP 真被执行了
    expect(aMcp.calls).toEqual([{ serverId: "shopify", tool: "get_orders" }]);
    // A 记了审计
    const audits = store.audits;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ friendUid: "b-uid", serverId: "shopify", tool: "get_orders", decision: "executed", outcome: "ok" });

    host.close();
    guest.close();
  });

  it("白名单外的工具 → A 不执行，B 收到拒绝，A 记 denied 审计", async () => {
    const p = nodeRemoteCrypto();
    const aId = p.generateEd25519();
    const bId = p.generateEd25519();
    const { hostWire, guestWire } = linkedWire();
    let store: ProxyStoreData = setGrant(emptyProxyStore(), {
      friendUid: "b-uid", allow: [{ serverId: "shopify", tools: ["get_orders"] }],
    });
    const aMcp = fakeMcp("x");
    const host = startProxyHostCoordinator({
      crypto: p, identity: aId, deviceId: "A", transport: hostWire, mcp: aMcp,
      peerIdentityPub: () => [bId.publicKey],
      friendUid: "b-uid",
      loadStore: () => store, saveStore: (d) => { store = d; },
    });
    const guest = startProxyGuestCoordinator({
      crypto: p, identity: bId, deviceId: "B", fromUid: "b-uid", transport: guestWire,
      peerIdentityPub: () => [aId.publicKey], grantedServers: [server("shopify")],
    });
    host.connection.start();
    guest.connection.start();

    // 调白名单外的 delete_product
    await expect(guest.mcp.callTool("shopify", "delete_product", {})).rejects.toThrow();
    expect(aMcp.calls).toEqual([]); // A 没执行
    expect(store.audits[0]).toMatchObject({ decision: "denied", outcome: "denied" });

    host.close();
    guest.close();
  });

  it("A 撤销授权后，B 的下一笔调用被拒", async () => {
    const p = nodeRemoteCrypto();
    const aId = p.generateEd25519();
    const bId = p.generateEd25519();
    const { hostWire, guestWire } = linkedWire();
    let store: ProxyStoreData = setGrant(emptyProxyStore(), {
      friendUid: "b-uid", allow: [{ serverId: "shopify", tools: [] }],
    });
    const aMcp = fakeMcp("x");
    const host = startProxyHostCoordinator({
      crypto: p, identity: aId, deviceId: "A", transport: hostWire, mcp: aMcp,
      peerIdentityPub: () => [bId.publicKey],
      friendUid: "b-uid",
      loadStore: () => store, saveStore: (d) => { store = d; },
    });
    const guest = startProxyGuestCoordinator({
      crypto: p, identity: bId, deviceId: "B", fromUid: "b-uid", transport: guestWire,
      peerIdentityPub: () => [aId.publicKey], grantedServers: [server("shopify")],
    });
    host.connection.start();
    guest.connection.start();

    await guest.mcp.callTool("shopify", "get_orders", {}); // 第一笔放行
    expect(aMcp.calls).toHaveLength(1);

    // A 撤销（清空该好友的授权）
    store = { ...store, grants: [] };
    await expect(guest.mcp.callTool("shopify", "get_orders", {})).rejects.toThrow();
    expect(aMcp.calls).toHaveLength(1); // 没再执行

    host.close();
    guest.close();
  });
});
