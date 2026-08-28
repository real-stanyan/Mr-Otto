import { describe, expect, it } from "vitest";
import { startProxyHost, type HostTransport, type ProxyAuditEntry } from "../../src/main/proxyHost.js";
import { encodeProxyFrame, PROXY_FRAME_VERSION, type ProxyGrant, type ProxyRequest } from "../../src/shared/remote/proxyProtocol.js";
import type { McpCapability } from "../../src/world/executionWorld.js";

function fakeTransport() {
  const sent: string[] = [];
  let cb: ((j: string) => void) | null = null;
  const transport: HostTransport = {
    send: (j) => { sent.push(j); return true; },
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
    startProxyHost({ transport: t.transport, mcp: fakeMcp(), friendUid: "b1", friendUids: () => ["b1"], getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
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
    startProxyHost({ transport: t.transport, mcp, friendUid: "b1", friendUids: () => ["b1"], getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
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
    startProxyHost({ transport: t.transport, mcp, friendUid: "b1", friendUids: () => ["b1"], getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1 });
    t.incoming({ reqId: "r3", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    const res = JSON.parse(t.sent[0]!);
    expect(res).toMatchObject({ kind: "proxy_res", reqId: "r3", ok: false });
    expect(res.error).toMatch(/Shopify API 500/);
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "error", error: "Shopify API 500" });
  });

  it("非 proxy_req 帧（proxy_res/proxy_cancel/坏帧）→ 不响应", async () => {
    const t = fakeTransport();
    startProxyHost({ transport: t.transport, mcp: fakeMcp(), friendUid: "b1", friendUids: () => ["b1"], getGrants: () => grants, audit: () => {}, now: () => 1 });
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

// ─── 白名单之前那两道闸（issue #665）──────────────────────────────────
//
// 都是同一类错误的两面：**自称的东西不能当授权依据**。
// 第一道钉的是「你是谁」（帧里的 fromUid 只能核对，不能拿去查授权），
// 第二道钉的是「你还算不算数」（ADR-0151：删好友 = 代理权限跟着死）。

const twoFriends: ProxyGrant[] = [
  { friendUid: "b1", allow: [{ serverId: "shopify", tools: ["get_orders"] }] },
  // c1 被授了整个 shopify —— b1 若能自选身份，就能吃到这一份
  { friendUid: "c1", allow: [{ serverId: "shopify", tools: [] }] },
];

describe("proxyHost 的身份闸与关系闸（issue #665）", () => {
  it("B 把 fromUid 填成另一个好友 → 拒，绝不落到那个人的白名单上", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    let called = false;
    const mcp = fakeMcp(async () => { called = true; return []; });
    startProxyHost({
      transport: t.transport, mcp,
      friendUid: "b1", friendUids: () => ["b1", "c1"],
      getGrants: () => twoFriends, audit: (e) => audits.push(e), now: () => 1,
    });
    // b1 的通道，冒充 c1 调 c1 才有的工具
    t.incoming({ reqId: "r1", fromUid: "c1", serverId: "shopify", tool: "delete_product", args: {} });
    await flush();
    expect(called).toBe(false);
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ ok: false });
    // 审计记的是**绑定**的那个身份，不是自称的 —— 台账要能当证据用
    expect(audits[0]).toMatchObject({ decision: "denied", fromUid: "b1" });
    expect(audits[0]?.denyReason).toMatch(/不是给这个身份开的/);
  });

  it("已经不是好友 → 拒，哪怕白名单还留着", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    let called = false;
    const mcp = fakeMcp(async () => { called = true; return []; });
    startProxyHost({
      transport: t.transport, mcp,
      friendUid: "b1", friendUids: () => ["c1"], // b1 被删了，grants 里那条还在
      getGrants: () => twoFriends, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r2", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    expect(called).toBe(false);
    expect(audits[0]?.denyReason).toMatch(/不是好友/);
  });

  it("好友名单还没同步好（null）→ 拒，但说的是「稍后再试」不是「不是好友」", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    startProxyHost({
      transport: t.transport, mcp: fakeMcp(),
      friendUid: "b1", friendUids: () => null,
      getGrants: () => twoFriends, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r3", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ ok: false });
    expect(audits[0]?.denyReason).toMatch(/还没同步好/);
    // 这两句对 B 是两件事：一件是等一等，一件是别等了
    expect(audits[0]?.denyReason).not.toMatch(/不是好友/);
  });

  it("身份对、关系在、白名单里 → 照常执行（三道闸不是把路堵死）", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    startProxyHost({
      transport: t.transport, mcp: fakeMcp(),
      friendUid: "b1", friendUids: () => ["b1", "c1"],
      getGrants: () => twoFriends, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r4", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ ok: true });
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "ok", fromUid: "b1" });
  });
});

// ─── 取消（issue #668，ADR-0151 §4）──────────────────────────────────────
describe("proxyHost 的取消（issue #668）", () => {
  /** 一个能被外部叫停的假工具：signal 一 abort 就抛，模拟 SDK 的行为 */
  function hangingMcp(): { mcp: McpCapability; started: Promise<void> } {
    let markStarted = (): void => {};
    const started = new Promise<void>((r) => { markStarted = () => r(); });
    const mcp = {
      callTool: (_id: string, _tool: string, _args: unknown, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          markStarted();
          signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        }),
    } as unknown as McpCapability;
    return { mcp, started };
  }

  it("收到 proxy_cancel → 把那笔在跑的调用 abort 掉", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    const { mcp, started } = hangingMcp();
    startProxyHost({
      transport: t.transport, mcp, friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r1", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await started;
    t.incomingRaw(encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "r1" }));
    await flush();

    // **取消照样记账**：帧到达时工具可能已经把单下了，抹掉这一笔等于让审计账
    // 在最需要它的那一次恰好是空的
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "error" });
    expect(audits[0]?.error).toMatch(/可能已经动过/);
    // 不回结果帧：B 那边发 cancel 时就把 pending 删了
    expect(t.sent).toHaveLength(0);
  });

  it("取消一个认不出的 reqId → 静默忽略（迟到的取消不是错误）", async () => {
    const t = fakeTransport();
    startProxyHost({
      transport: t.transport, mcp: fakeMcp(), friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: () => {}, now: () => 1,
    });
    t.incomingRaw(encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "从没见过" }));
    await flush();
    expect(t.sent).toHaveLength(0);
  });

  it("退订（通道断了）→ 还在跑的调用一并 abort，不留着替一个不在线的人动 A 的账号", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    const { mcp, started } = hangingMcp();
    const host = startProxyHost({
      transport: t.transport, mcp, friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r2", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await started;
    expect(host.inflight()).toBe(1);
    host.stop();
    await flush();
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "error" });
  });
});

// ─── 单帧上限与限流（issue #674）────────────────────────────────────────
describe("proxyHost 的单帧上限与限流（issue #674）", () => {
  /** 传输拒收（模拟 proxyConnection 判定超过 relay 单帧上限） */
  function pickyTransport(reject: (frameJson: string) => boolean) {
    const sent: string[] = [];
    let cb: ((j: string) => void) | null = null;
    const transport: HostTransport = {
      send: (j) => { if (reject(j)) return false; sent.push(j); return true; },
      onFrame: (c) => { cb = c; return () => { cb = null; }; },
      isPeerConnected: () => true,
    };
    return {
      transport, sent,
      incoming(req: Omit<ProxyRequest, "kind" | "v">) {
        cb?.(encodeProxyFrame({ kind: "proxy_req", v: PROXY_FRAME_VERSION, ...req }));
      },
    };
  }

  it("结果太大传不回去 → 回一条小错误帧，且按 executed/error 记账（副作用已经发生了）", async () => {
    const audits: ProxyAuditEntry[] = [];
    // 只拒 ok:true 那一帧（大结果），小的错误帧照收
    const t = pickyTransport((j) => JSON.parse(j).ok === true);
    startProxyHost({
      transport: t.transport, mcp: fakeMcp(), friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1,
    });
    t.incoming({ reqId: "r1", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();

    // 工具已经执行了——不能当没发生过
    expect(audits[0]).toMatchObject({ decision: "executed", outcome: "error" });
    expect(audits[0]?.error).toMatch(/结果太大/);
    // 好友那边当场知道原因，而不是等满超时
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ reqId: "r1", ok: false });
    expect(JSON.parse(t.sent[0]!).error).toMatch(/结果太大/);
  });

  it("并发上限：在跑的塞满了 → 后来的当场拒，不落到 A 的凭证上", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    let calls = 0;
    const mcp = fakeMcp(() => { calls += 1; return new Promise(() => {}); }); // 永远不结束
    startProxyHost({
      transport: t.transport, mcp, friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: (e) => audits.push(e), now: () => 1,
      maxInflight: 2, ratePerMinute: 1000, rateBurst: 1000,
    });
    for (const id of ["a", "b", "c", "d"]) {
      t.incoming({ reqId: id, fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    }
    await flush();

    expect(calls).toBe(2); // 只有两笔真跑起来
    expect(t.sent).toHaveLength(2); // 另外两笔各回一条拒绝
    expect(JSON.parse(t.sent[0]!).error).toMatch(/太多了/);
    // 限流**不逐条记账**：一个限流时段只留一笔，否则刷请求就能把真记录挤出去
    expect(audits.filter((a) => a.denyReason?.includes("太多了"))).toHaveLength(1);
  });

  it("令牌桶：突发用完就拒；时间往前走，桶回血又能用", async () => {
    const t = fakeTransport();
    const audits: ProxyAuditEntry[] = [];
    let clock = 0;
    startProxyHost({
      transport: t.transport, mcp: fakeMcp(), friendUid: "b1", friendUids: () => ["b1"],
      getGrants: () => grants, audit: (e) => audits.push(e), now: () => clock,
      maxInflight: 99, ratePerMinute: 60, rateBurst: 2,
    });
    for (const id of ["a", "b", "c"]) {
      t.incoming({ reqId: id, fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    }
    await flush();
    expect(audits.filter((a) => a.decision === "executed")).toHaveLength(2);
    expect(audits.filter((a) => a.denyReason?.includes("太频繁"))).toHaveLength(1);

    clock += 60_000; // 一分钟后桶回满
    t.incoming({ reqId: "d", fromUid: "b1", serverId: "shopify", tool: "get_orders", args: {} });
    await flush();
    expect(audits.filter((a) => a.decision === "executed")).toHaveLength(3);
  });
});
