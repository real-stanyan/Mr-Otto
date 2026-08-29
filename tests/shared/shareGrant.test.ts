import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { serversUsedInSession, shareAllow, type ShareGrantServer } from "../../src/shared/shareGrant.js";
import { assignMcpToolNames, mcpToolName } from "../../src/shared/mcp.js";

// 「这个会话用到了哪几台服务」的反查（issue #694，ADR-0177）。
// 它决定分享确认框里摆几行 —— 也就决定了默认授权的爆炸半径，所以这份反查
// 错在哪都不行：多算一台 = 把无关服务借出去，少算一台 = 对方接了也用不了。

let ts = 0;
function ev(e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  return { seq: -1, sessionId: "s", ts: ++ts, ...e } as unknown as SessionEvent;
}

function calls(...names: string[]): SessionEvent {
  return ev({
    type: "assistant_message",
    content: "",
    model: "m",
    toolCalls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })),
  });
}

const SHOPIFY: ShareGrantServer = { id: "shopify", live: true, tools: [{ name: "create_order" }, { name: "list" }] };
const ADS: ShareGrantServer = { id: "google-ads", live: true, tools: [{ name: "spend" }] };

describe("serversUsedInSession", () => {
  it("只回这个会话真调用过的那几台", () => {
    const events = [
      ev({ type: "session_created", title: "t", workspace: "/w" }),
      calls(mcpToolName("shopify", "create_order")),
      ev({ type: "tool_result", toolCallId: "c0", status: "ok", output: "" }),
    ];
    expect(serversUsedInSession(events, [SHOPIFY, ADS])).toEqual(["shopify"]);
  });

  it("一台都没用到就回空 —— 调用方据此决定「一步都不多走，直接分享」", () => {
    const events = [calls("write_file", "bash")];
    expect(serversUsedInSession(events, [SHOPIFY, ADS])).toEqual([]);
    expect(serversUsedInSession([], [SHOPIFY, ADS])).toEqual([]);
  });

  it("没连上的服务不进结果：给了对方也调不动，摆上去只会误导", () => {
    const offline: ShareGrantServer = { ...SHOPIFY, live: false };
    expect(serversUsedInSession([calls(mcpToolName("shopify", "create_order"))], [offline])).toEqual([]);
  });

  it("行序跟随 servers，不跟随调用先后 —— 勾选表的行不该跳来跳去", () => {
    const events = [calls(mcpToolName("google-ads", "spend")), calls(mcpToolName("shopify", "list"))];
    expect(serversUsedInSession(events, [SHOPIFY, ADS])).toEqual(["shopify", "google-ads"]);
  });

  it("同一台调了多次只算一台", () => {
    const events = [
      calls(mcpToolName("shopify", "create_order"), mcpToolName("shopify", "list")),
      calls(mcpToolName("shopify", "list")),
    ];
    expect(serversUsedInSession(events, [SHOPIFY, ADS])).toEqual(["shopify"]);
  });

  it("净化/截断后带指纹的工具名也反查得对，且两台近似的服务不串台", () => {
    // id 里的非 ASCII 会被 safe() 换成下划线，两台服务因此塌成同一串前缀，
    // 靠尾部指纹（输入是 `server\0tool`）才分得开 —— 反查必须用同一个函数重算，
    // 而不是按 `mcp__<id>__<tool>` 的形状去拼字符串
    const a: ShareGrantServer = { id: "店铺", live: true, tools: [{ name: "t" }] };
    const b: ShareGrantServer = { id: "店鋪", live: true, tools: [{ name: "t" }] };
    const [nameA, nameB] = assignMcpToolNames([
      { server: a.id, tool: "t" },
      { server: b.id, tool: "t" },
    ]);
    expect(nameA).not.toBe(nameB); // 前提：这两台确实分得开（靠指纹，不靠可读部分）

    expect(serversUsedInSession([calls(nameA!)], [a, b])).toEqual(["店铺"]);
    expect(serversUsedInSession([calls(nameB!)], [a, b])).toEqual(["店鋪"]);
    // 形状对但指纹不对的名字不该命中任何一台
    expect(serversUsedInSession([calls("mcp______t_0000")], [a, b])).toEqual([]);
  });

  it("名字分配跑在全体上：没连上的服务参与分配，只是不进结果", () => {
    // 这一条钉的是实现里那句「先按全体算名字、再滤 live」。真正的加盐重试要靠
    // 16 位指纹撞车才触发，手写构造不出来；能钉住的是它的可观察后果——
    // 表里多一台没连上的服务，不会让已连上那台的工具名跟着变
    const off: ShareGrantServer = { id: "offline", live: false, tools: [{ name: "t" }] };
    const name = mcpToolName("shopify", "create_order");
    expect(serversUsedInSession([calls(name)], [off, SHOPIFY])).toEqual(["shopify"]);
    expect(serversUsedInSession([calls(name)], [SHOPIFY])).toEqual(["shopify"]);
  });

  it("空工具表 / 没有 toolCalls 的助手消息都不炸", () => {
    const bare: ShareGrantServer = { id: "empty", live: true, tools: [] };
    const events = [ev({ type: "assistant_message", content: "只说话", model: "m" })];
    expect(serversUsedInSession(events, [bare])).toEqual([]);
  });
});

describe("shareAllow", () => {
  it("整服务放行 —— 线上白名单里 tools:[] 就是那个意思", () => {
    expect(shareAllow(["shopify", "google-ads"])).toEqual([
      { serverId: "shopify", tools: [] },
      { serverId: "google-ads", tools: [] },
    ]);
  });

  it("空选择 = 空白名单（调用方据此走「只分享对话」）", () => {
    expect(shareAllow([])).toEqual([]);
  });
});
