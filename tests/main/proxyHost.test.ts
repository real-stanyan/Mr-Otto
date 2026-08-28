import { describe, expect, it } from "vitest";
import { startProxyHost, type HostTransport, type ProxyAuditEntry } from "../../src/main/proxyHost.js";
import { encodeProxyFrame, PROXY_FRAME_VERSION, type ProxyGrant, type ProxyRequest } from "../../src/shared/remote/proxyProtocol.js";
import type { McpCapability } from "../../src/world/executionWorld.js";

function fakeTransport() {
  const sent: string[] = [];
  let cb: ((j: string) => void) | null = null;
  const transport: HostTransport = {
    send: (j) => { sent.push(j); },
    onFrame: (c) => { cb = c; return () => { cb = null; }; },
    isPeerConnected: () => true,
  };
  return {
    transport,
    sent,
    /** 模拟 B 发来一帧 proxy_req */
    incoming(req: Omit<ProxyRequest, "kind" | "v">) {
      cb?.(encodeProxyFrame({ kind: "proxy_req", v: PROXY_FRAME_VERSION, ...req }));
    },
    /** 模拟 B 发来任意一段帧文本（测非 req 帧/坏帧） */
    incomingRaw(j: string) {
      cb?.(j);
    },
  };
}

function fakeMcp(handler?: (serverId: string, tool: string, args: unknown) => Promise<unknown>): McpCapability {
  return {
    callTool: handler ?? (async () => [{ kind: "text", text: "结果" }]),
  } as unknown as McpCapability;
}

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const grants: ProxyGrant[] = [{ friendUid: "b1", allow: [{ serverId: "shopify", tools: ["get_orders"] }] }];

describe("proxyHost（A 侧代理接入，issue #622 PR-C2）", () => {
  it("白名单内：执行并回 ok + 记 executed 审计", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    startProxyHost({ transport: t.transport, mcp: fakeMcp(), getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
    t.incoming({ reqId: "r1", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: { limit: 5 } });
    await flush();
    const res = JSON.parse(t.sent[0]!);
    expect(res).toMatchObject({ kind: "proxy_res", reqId: "r1", ok: true, content: [{ kind: "text", text: "结果" }] });
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "ok", fromUid: "b1", tool: "get_orders" });
  });

  it("白名单外：不执行，回 ok:false + 记 denied 审计", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    let called = false;
    const mcp = fakeMcp(async () => { called = true; return []; });
    startProxyHost({ transport: t.transport, mcp, getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
    t.incoming({ reqId: "r2", fromUid: "b1", serverId: "shopify", tool: "delete_product", args: {} });
    await flush();
    expect(called).toBe(false);
    const res = JSON.parse(t.sent[0]!);
    expect(res).toMatchObject({ kind: "proxy_res", reqId: "r2", ok: false });
    expect(res.error).toMatch(/不含工具/);
    expect(audits[0]).toMatchObject({ decision: "denied" });
  });

  it("执行抛错 → 回 ok:false 带原因 + 记 error 审计", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    const mcp = fakeMcp(async () => { throw new Error("Shopify API 500"); });
    startProxyHost({ transport: t.transport, mcp, getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
    t.incoming({ reqId: "r3", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    const res = JSON.parse(t.sent[0]!);
    expect(res).toMatchObject({ kind: "proxy_res", reqId: "r3", ok: false });
    expect(res.error).toMatch(/Shopify API 500/);
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "error", error: "Shopify API 500" });
  });

  it("非 proxy_req 帧（proxy_res/proxy_cancel/坏帧）→ 不响应", async () => {
    const t = fakeTransport();
    startProxyHost({ transport: t.transport, mcp: fakeMcp(), getGrants: () => grants, audit: () => {}, now: () => 1 });
    // A 收到 proxy_res（它是执行方，不该收到结果帧）——不响应
    t.incomingRaw(encodeProxyFrame({ kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: "x", ok: true, content: [] }));
    // A 收到 proxy_cancel——第一期不处理取消，不响应
    t.incomingRaw(encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "x" }));
    // 坏帧——不崩、不响应
    t.incomingRaw("{not json");
    await flush();
    expect(t.sent).toHaveLength(0);
  });
});
