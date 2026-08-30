import { describe, expect, it } from "vitest";
import {
  friendTag, mergeProxyMcp, parseProxyServerId, proxyServerId, proxyServerName,
  viewProxyServers, type ProxyChannelView,
} from "../../src/main/proxyNamespace.js";
import { createMcpTools } from "../../src/tools/mcpTool.js";
import type { McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";

const A_UID = "3f2a1b9c-1111-2222-3333-444455556666";

function handle(id: string, tools: string[]): McpServerHandle {
  return {
    id, name: id, status: "connected", live: true,
    tools: tools.map((name) => ({ name, description: `${name} 的说明`, inputSchema: {} })),
    resources: [], prompts: [],
  } as unknown as McpServerHandle;
}

/** 录下每一次调用落到了谁身上 —— 「这一刀本地跑还是打帧发走」正是要钉的那件事 */
function spyMcp(tag: string, servers: McpServerHandle[]) {
  const calls: string[] = [];
  const mcp = {
    ready: async () => {},
    servers: () => servers,
    callTool: async (id: string, tool: string) => { calls.push(`${tag}:${id}/${tool}`); return []; },
    readResource: async (id: string) => { calls.push(`${tag}:res:${id}`); return []; },
    getPrompt: async (id: string, name: string) => { calls.push(`${tag}:prompt:${id}/${name}`); return ""; },
    configure: async (id: string) => { calls.push(`${tag}:configure:${id}`); },
    authorize: async (id: string) => { calls.push(`${tag}:authorize:${id}`); },
    configOf: (id: string) => { calls.push(`${tag}:configOf:${id}`); return undefined; },
  } as unknown as McpCapability;
  return { mcp, calls };
}

describe("proxyNamespace（代理来的 MCP 按好友加前缀，issue #670）", () => {
  it("id 编解码往返；认不出前缀的原样是本地服务", () => {
    const id = proxyServerId(A_UID, "shopify");
    expect(id).toBe("proxy:3f2a1b9c:shopify");
    expect(parseProxyServerId(id)).toEqual({ tag: "3f2a1b9c", realServerId: "shopify" });
    expect(parseProxyServerId("shopify")).toBeNull();
    // 真 id 里带冒号也拆得回来（只在第一个冒号处切）
    expect(parseProxyServerId(proxyServerId(A_UID, "a:b"))?.realServerId).toBe("a:b");
  });

  it("前缀取 uid 的 ASCII 短标签——昵称过不了 safe()，而且会变", () => {
    expect(friendTag(A_UID)).toBe("3f2a1b9c");
    expect(friendTag("")).toBe("unknown");
    // 两个好友的短标签不同 = 工具名不会塌成一个
    expect(friendTag("aaaaaaaa-1111")).not.toBe(friendTag("bbbbbbbb-1111"));
  });

  it("代理服务的展示名带标签，工具描述说清「用谁的凭证」", () => {
    const ch: ProxyChannelView = { friendUid: A_UID, label: "小明", mcp: spyMcp("A", [handle("shopify", ["get_orders"])]).mcp };
    const [srv] = viewProxyServers(ch);
    expect(srv?.id).toBe("proxy:3f2a1b9c:shopify");
    expect(srv?.name).toBe(proxyServerName(A_UID, "shopify"));
    expect(srv?.name).toBe("shopify@3f2a1b9c");
    expect(srv?.tools[0]?.description).toContain("小明");
    expect(srv?.tools[0]?.description).toContain("凭证");
    // 原说明留着——模型还得知道这把刀是干嘛的
    expect(srv?.tools[0]?.description).toContain("get_orders 的说明");
  });

  it("名字为空时退回短标签（还没拿到好友资料）", () => {
    const ch: ProxyChannelView = { friendUid: A_UID, label: "", mcp: spyMcp("A", [handle("shopify", ["t"])]).mcp };
    expect(viewProxyServers(ch)[0]?.tools[0]?.description).toContain("3f2a1b9c");
  });

  it("合并：servers() 两边都在，同名服务不再塌成一把刀", () => {
    const own = spyMcp("own", [handle("shopify", ["get_orders"])]);
    const friend = spyMcp("A", [handle("shopify", ["get_orders"])]);
    const merged = mergeProxyMcp(own.mcp, () => [{ friendUid: A_UID, label: "小明", mcp: friend.mcp }]);

    expect(merged.servers().map((s) => s.id)).toEqual(["shopify", "proxy:3f2a1b9c:shopify"]);
    // 这一条才是重点：createMcpTools 按 server.name 分配模型可见名，
    // 同名同工具会被 assignMcpToolNames 规则 ① **静默丢掉一个**
    const names = createMcpTools(merged).map((t) => t.def.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("mcp__shopify__get_orders");
    expect(names.some((n) => n.includes("3f2a1b9c"))).toBe(true);
  });

  it("按前缀派发：本地的落本地，借来的落那条通道，且剥回真 id", async () => {
    const own = spyMcp("own", [handle("shopify", ["get_orders"])]);
    const friend = spyMcp("A", [handle("shopify", ["get_orders"])]);
    const merged = mergeProxyMcp(own.mcp, () => [{ friendUid: A_UID, label: "小明", mcp: friend.mcp }]);

    await merged.callTool("shopify", "get_orders", {});
    await merged.callTool(proxyServerId(A_UID, "shopify"), "get_orders", {});
    expect(own.calls).toEqual(["own:shopify/get_orders"]);
    expect(friend.calls).toEqual(["A:shopify/get_orders"]); // 剥掉前缀还原成 A 那边的真 id

    await merged.readResource(proxyServerId(A_UID, "shopify"), "u://1");
    await merged.getPrompt(proxyServerId(A_UID, "shopify"), "p", {});
    await merged.configure(proxyServerId(A_UID, "shopify"), null);
    await merged.authorize(proxyServerId(A_UID, "shopify"));
    merged.configOf(proxyServerId(A_UID, "shopify"));
    expect(friend.calls).toEqual([
      "A:shopify/get_orders", "A:res:shopify", "A:prompt:shopify/p",
      "A:configure:shopify", "A:authorize:shopify", "A:configOf:shopify",
    ]);
    expect(own.calls).toEqual(["own:shopify/get_orders"]); // 本地那份没被打扰
  });

  it("通道没了 → 抛错，**不回落到本地**", async () => {
    const own = spyMcp("own", [handle("shopify", ["get_orders"])]);
    const merged = mergeProxyMcp(own.mcp, () => []); // 好友的通道断了/被撤销了

    await expect(merged.callTool(proxyServerId(A_UID, "shopify"), "get_orders", {}))
      .rejects.toThrow(/通道已经不在了/);
    // 回落等于把「调小明的 shopify」悄悄执行成「调我自己的 shopify」
    expect(own.calls).toEqual([]);
    // configOf 是同步的，通道没了按「没有本地配置」答，不抛
    expect(merged.configOf(proxyServerId(A_UID, "shopify"))).toBeUndefined();
  });

  it("通道是现取的：好友中途连上，下一次 servers() 就看得见", () => {
    const own = spyMcp("own", [handle("local", ["t"])]);
    const friend = spyMcp("A", [handle("shopify", ["get_orders"])]);
    let live: ProxyChannelView[] = [];
    const merged = mergeProxyMcp(own.mcp, () => live);

    expect(merged.servers()).toHaveLength(1);
    live = [{ friendUid: A_UID, label: "小明", mcp: friend.mcp }];
    expect(merged.servers()).toHaveLength(2); // buildTools 每 turn 现算，下一轮就出现
  });
});

describe("shareGrantNoteText（issue #788）", () => {
  it("说清对应关系：历史名 → 本机前缀名，且劝阻本地重配", async () => {
    const { shareGrantNoteText } = await import("../../src/main/proxyNamespace.js");
    const t = shareGrantNoteText("Stan Yan", "32c6716a-2215-4fef-8865-7da11e0feab9", ["square"]);
    expect(t).toContain("mcp__square__*");           // 历史里的名字
    expect(t).toContain("mcp__square_32c6716a__");   // 本机借来的前缀（uid 短标签）
    expect(t).toContain("mcp_configure");            // 劝阻那句在
    expect(t).toContain("Stan Yan");
  });
});
