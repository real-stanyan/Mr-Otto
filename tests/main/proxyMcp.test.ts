import { describe, expect, it } from "vitest";
import { createProxyMcp, type ProxyTransport } from "../../src/main/proxyMcp.js";
import { encodeProxyFrame, PROXY_FRAME_VERSION, type ProxyResult } from "../../src/shared/remote/proxyProtocol.js";
import type { McpServerHandle } from "../../src/world/executionWorld.js";

/** 假代理传输：录得 B 发了什么帧，测试可手动「让 A 回一帧」 */
function fakeTransport(connected = true) {
  const sent: string[] = [];
  let frameCb: ((j: string) => void) | null = null;
  const transport: ProxyTransport = {
    send: (j) => { sent.push(j); return true; },
    onFrame: (cb) => { frameCb = cb; return () => { frameCb = null; }; },
    isPeerConnected: () => connected,
  };
  return {
    transport,
    sent,
    /** 模拟 A 回一个结果帧 */
    respond(res: Omit<ProxyResult, "kind" | "v">) {
      frameCb?.(encodeProxyFrame({ kind: "proxy_res", v: PROXY_FRAME_VERSION, ...res }));
    },
  };
}

function server(id: string, live = true): McpServerHandle {
  return { id, name: id, status: "connected", live, tools: [], resources: [], prompts: [] };
}

const DEPS = { fromUid: "b-uid-123", grantedServers: [server("shopify")] };

describe("proxyMcp（B 侧代理 McpCapability，issue #622 PR-C2）", () => {
  it("callTool：发出 proxy_req，A 回 ok 后返回 content", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r1" });
    const p = mcp.callTool("shopify", "get_orders", { limit: 5 });
    // B 发出了 proxy_req 帧
    expect(t.sent).toHaveLength(1);
    const req = JSON.parse(t.sent[0]!);
    expect(req).toMatchObject({ kind: "proxy_req", reqId: "r1", fromUid: "b-uid-123", serverId: "shopify", tool: "get_orders" });
    // A 回 ok
    t.respond({ reqId: "r1", ok: true, content: [{ kind: "text", text: "订单列表" }] });
    const content = await p;
    expect(content).toEqual([{ kind: "text", text: "订单列表" }]);
  });

  it("A 回 ok:false → callTool 抛错带原因", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r2" });
    const p = mcp.callTool("shopify", "delete_product", {});
    t.respond({ reqId: "r2", ok: false, error: "白名单外：server shopify 没授权给好友" });
    await expect(p).rejects.toThrow(/白名单外/);
  });

  it("A 离线（peer 不连）→ 立即失败，不发帧", async () => {
    const t = fakeTransport(false); // 不连
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport });
    await expect(mcp.callTool("shopify", "get_orders", {})).rejects.toThrow(/不在线/);
    expect(t.sent).toHaveLength(0);
  });

  it("超时 → 抛错", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r3", timeoutMs: 20 });
    await expect(mcp.callTool("shopify", "get_orders", {})).rejects.toThrow(/超时/);
  });

  it("迟到的 reqId（没人等）→ 安静丢弃，不影响后续", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r4" });
    // A 回一个没人等的 reqId——不该崩
    t.respond({ reqId: "ghost", ok: true, content: [] });
    // 后续正常调用不受影响
    const p = mcp.callTool("shopify", "get_orders", {});
    t.respond({ reqId: "r4", ok: true, content: [{ kind: "text", text: "ok" }] });
    await expect(p).resolves.toEqual([{ kind: "text", text: "ok" }]);
  });

  it("servers() 只报 A 授权的，不暴露 A 的全部服务", () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport });
    expect(mcp.servers().map((s) => s.id)).toEqual(["shopify"]);
  });

  it("configure/authorize/readResource/getPrompt/configOf 在 B 侧禁用或空", () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport });
    // 这几个是同步抛错（不是 async 返回 rejected promise）——它们不该被 await
    expect(() => mcp.configure("x", null)).toThrow(/A.*那边/);
    expect(() => mcp.authorize("x")).toThrow(/A.*那边/);
    expect(() => mcp.readResource("s", "u")).toThrow(/不支持/);
    expect(() => mcp.getPrompt("s", "n", {})).toThrow(/不支持/);
    expect(mcp.configOf("shopify")).toBeUndefined(); // B 不持有 A 的配置（含凭据）
  });
});

// ─── 取消要发到线上（issue #668，ADR-0151 §4）────────────────────────────
//
// 本地 reject 只让 B 这一侧停下来。A 那边还捏着 **A 自己的凭证** 在跑——
// 写工具（下单/退款）尤其要紧：B 以为取消了，钱可能已经动了。

describe("proxyMcp 的取消（issue #668）", () => {
  it("abort → 先发 proxy_cancel 再本地 reject", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r9" });
    const ctl = new AbortController();
    const p = mcp.callTool("shopify", "refund", { id: 1 }, ctl.signal);
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ kind: "proxy_req", reqId: "r9" });

    ctl.abort();
    await expect(p).rejects.toThrow(/被取消/);
    expect(JSON.parse(t.sent[1]!)).toEqual({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "r9" });
  });

  it("超时 → 同样发 proxy_cancel（B 不等了 = A 该停手，起因不同而已）", async () => {
    const t = fakeTransport();
    const mcp = createProxyMcp({ ...DEPS, transport: t.transport, nextReqId: () => "r10", timeoutMs: 5 });
    const p = mcp.callTool("shopify", "get_orders", {});
    await expect(p).rejects.toThrow(/超时/);
    expect(JSON.parse(t.sent[1]!)).toEqual({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "r10" });
  });
});

// ─── 帧发不出去（issue #674）────────────────────────────────────────────
describe("proxyMcp：帧发不出去就当场失败（issue #674）", () => {
  it("请求发不出去（多半是参数太大）→ 立刻 reject，不挂在 pending 里等满超时", async () => {
    let cb: ((j: string) => void) | null = null;
    const transport: ProxyTransport = {
      send: () => false, // proxyConnection 判定超过单帧上限
      onFrame: (c) => { cb = c; return () => { cb = null; }; },
      isPeerConnected: () => true,
    };
    const mcp = createProxyMcp({ ...DEPS, transport, nextReqId: () => "r1", timeoutMs: 60_000 });
    await expect(mcp.callTool("shopify", "get_orders", { blob: "x" })).rejects.toThrow(/发不出去/);
    expect(cb).not.toBeNull(); // 连接还在，只是这一笔没发出去
  });
});
