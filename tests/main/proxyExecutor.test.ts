import { describe, expect, it, vi } from "vitest";
import { handleProxyFrame, type ProxyAuditEntry } from "../../src/main/proxyExecutor.js";
import type { McpCapability } from "../../src/world/executionWorld.js";
import { encodeProxyFrame, PROXY_FRAME_VERSION, type ProxyGrant } from "../../src/shared/remote/proxyProtocol.js";

const GRANT: ProxyGrant = {
  friendUid: "uid-b",
  allow: [{ serverId: "shopify", tools: [] }],
};

function makeDeps(over: Partial<Parameters<typeof handleProxyFrame>[0]> = {}) {
  const audits: ProxyAuditEntry[] = [];
  const sent: string[] = [];
  const callTool = vi.fn(async () => [{ type: "text", text: "ok-result" }]);
  const mcp = { callTool } as unknown as McpCapability;
  const deps = {
    grantOf: () => GRANT,
    mcp,
    audit: (e: ProxyAuditEntry) => audits.push(e),
    send: (f: string) => sent.push(f),
    ...over,
  };
  return { deps, audits, sent, callTool };
}

function reqFrame(over: Record<string, unknown> = {}) {
  return encodeProxyFrame({
    kind: "proxy_req", v: PROXY_FRAME_VERSION, reqId: "r1",
    fromUid: "uid-b", serverId: "shopify", tool: "update_product", args: { id: 1, price: 9.9 },
    ...over,
  } as never);
}

/** 等 execute() 的异步链跑完（handleProxyFrame 不 await） */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** 取数组第 0 项并断言存在（strict 下 arr[0] 是 T|undefined） */
function head<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error("数组为空，测试前置未满足");
  return arr[0]!;
}

describe("A 侧代理执行器 handleProxyFrame", () => {
  it("非代理帧返回 false（走别的通道）", () => {
    const { deps } = makeDeps();
    expect(handleProxyFrame(deps, "not json")).toBe(false);
    expect(handleProxyFrame(deps, JSON.stringify({ kind: "other" }))).toBe(false);
  });

  it("白名单内：用 A 的 mcp 凭证执行，回 ok 帧 + 记审计", async () => {
    const { deps, audits, sent, callTool } = makeDeps();
    expect(handleProxyFrame(deps, reqFrame())).toBe(true);
    await flush();

    // 用了 A 的凭证（callTool 被调到 A 的 serverId/tool/args）
    expect(callTool).toHaveBeenCalledWith("shopify", "update_product", { id: 1, price: 9.9 });
    // 回传 ok 帧带结果
    expect(sent).toHaveLength(1);
    const res = JSON.parse(head(sent));
    expect(res).toMatchObject({ kind: "proxy_res", reqId: "r1", ok: true, content: [{ type: "text", text: "ok-result" }] });
    // 审计记了 executed/ok
    expect(audits).toHaveLength(1);
    expect(head(audits)).toMatchObject({ decision: "executed", outcome: "ok", serverId: "shopify", tool: "update_product" });
    expect(head(audits).args).toEqual({ id: 1, price: 9.9 }); // 审计要说清「他让工具干了什么」
  });

  it("白名单外：不执行，回拒绝帧 + 记 denied 审计", async () => {
    const { deps, audits, sent, callTool } = makeDeps();
    handleProxyFrame(deps, reqFrame({ serverId: "stripe", tool: "charge" }));
    await flush();

    expect(callTool).not.toHaveBeenCalled(); // 凭证根本没被碰
    const res = JSON.parse(head(sent));
    expect(res).toMatchObject({ kind: "proxy_res", ok: false });
    expect(String(res.error)).toContain("stripe");
    expect(head(audits)).toMatchObject({ decision: "denied", outcome: "denied" });
  });

  it("陌生好友：不执行，记 denied", async () => {
    const { deps, audits, callTool } = makeDeps({ grantOf: () => null });
    handleProxyFrame(deps, reqFrame({ fromUid: "uid-stranger" }));
    await flush();
    expect(callTool).not.toHaveBeenCalled();
    expect(head(audits).outcome).toBe("denied");
  });

  it("工具执行抛错：回 error 帧 + 记 error 审计", async () => {
    const callTool = vi.fn(async () => { throw new Error("Shopify 401"); });
    const { deps, audits, sent } = makeDeps({ mcp: { callTool } as unknown as McpCapability });
    handleProxyFrame(deps, reqFrame());
    await flush();
    const res = JSON.parse(head(sent));
    expect(res).toMatchObject({ ok: false, error: "Shopify 401" });
    expect(head(audits)).toMatchObject({ decision: "executed", outcome: "error", detail: "Shopify 401" });
  });

  it("取消帧认出但不报错（AbortController 在 PR-C 接）", () => {
    const { deps } = makeDeps();
    const cancel = encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "r1" } as never);
    expect(handleProxyFrame(deps, cancel)).toBe(true);
  });
});
