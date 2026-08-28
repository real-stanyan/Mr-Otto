import { describe, expect, it } from "vitest";
import {
  auditLine, borrowStatusLine, buildAllow, describeAllow, hostStatusLine,
  isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool,
  type ProxySelection,
} from "../../src/renderer/src/lib/proxyShare.js";

const TOOLS = ["get_orders", "create_order", "refund"];

describe("proxyShare（圈白名单的纯逻辑，issue #657）", () => {
  it("勾整个服务 = all；取消 = 整条移除", () => {
    let sel: ProxySelection = {};
    sel = toggleServer(sel, "shopify", true);
    expect(sel).toEqual({ shopify: "all" });
    expect(isServerOn(sel, "shopify")).toBe(true);
    expect(isToolOn(sel, "shopify", "refund")).toBe(true);
    sel = toggleServer(sel, "shopify", false);
    expect(sel).toEqual({});
    expect(isServerOn(sel, "shopify")).toBe(false);
  });

  it("从 all 里取消一个工具 → 摊成明确清单（除了这一个）", () => {
    let sel: ProxySelection = { shopify: "all" };
    sel = toggleTool(sel, "shopify", "refund", TOOLS);
    expect(sel).toEqual({ shopify: ["get_orders", "create_order"] });
    expect(isToolOn(sel, "shopify", "refund")).toBe(false);
    expect(isToolOn(sel, "shopify", "get_orders")).toBe(true);
  });

  it("勾满所有工具 → 收回成 all（以后新装的工具跟着放行）", () => {
    let sel: ProxySelection = { shopify: ["get_orders", "create_order"] };
    sel = toggleTool(sel, "shopify", "refund", TOOLS);
    expect(sel).toEqual({ shopify: "all" });
  });

  it("把工具减到一个不剩 = 这个服务没授权，**不是**空数组", () => {
    // 线上 tools: [] 表示「整服务放行」，减到空绝不能编码成它——这是本层存在的理由
    let sel: ProxySelection = { shopify: ["get_orders"] };
    sel = toggleTool(sel, "shopify", "get_orders", TOOLS);
    expect(sel).toEqual({});
    expect(buildAllow(sel)).toEqual([]);
  });

  it("buildAllow：all → tools:[]，明确清单原样带出，空清单不进", () => {
    const sel: ProxySelection = { shopify: "all", ads: ["a", "b"], dead: [] };
    expect(buildAllow(sel)).toEqual([
      { serverId: "shopify", tools: [] },
      { serverId: "ads", tools: ["a", "b"] },
    ]);
  });

  it("selectionFromAllow 是 buildAllow 的逆（回填已有授权）", () => {
    const allow = [{ serverId: "shopify", tools: [] }, { serverId: "ads", tools: ["a"] }];
    const sel = selectionFromAllow(allow);
    expect(sel).toEqual({ shopify: "all", ads: ["a"] });
    expect(buildAllow(sel)).toEqual(allow);
  });

  it("describeAllow 说人话", () => {
    expect(describeAllow([])).toBe("没有授权");
    expect(describeAllow(
      [{ serverId: "shopify", tools: [] }, { serverId: "ads", tools: ["a", "b"] }],
      (id) => (id === "shopify" ? "Shopify" : id)
    )).toBe("Shopify（全部工具）、ads（2 个工具）");
  });

  it("auditLine：拒绝/出错带原因，执行成功就一句话", () => {
    const ts = new Date(2026, 7, 28, 9, 5).getTime();
    expect(auditLine({ ts, serverId: "shopify", tool: "refund", decision: "denied", outcome: "denied", detail: "白名单里没有" }))
      .toEqual({ time: "8月28日 09:05", target: "shopify / refund", verdict: "已拒绝（白名单里没有）", args: "" });
    expect(auditLine({ ts, serverId: "shopify", tool: "get_orders", decision: "executed", outcome: "ok" }).verdict)
      .toBe("已执行");
    expect(auditLine({ ts, serverId: "shopify", tool: "get_orders", decision: "executed", outcome: "error", detail: "429" }).verdict)
      .toBe("出错了（429）");
  });

  it("auditLine 带出参数摘要——白名单内的写操作全自动，事后只有它答得上「动了什么」", () => {
    const ts = new Date(2026, 7, 28, 9, 5).getTime();
    const base = { ts, serverId: "shopify", tool: "refund", decision: "executed", outcome: "ok" };
    expect(auditLine({ ...base, argsSummary: '{"orderId":"1234","amount":99}' }).args)
      .toBe('{"orderId":"1234","amount":99}');
    // 「没给参数」的两种写法都不占那一行
    expect(auditLine({ ...base, argsSummary: "{}" }).args).toBe("");
    expect(auditLine({ ...base, argsSummary: "null" }).args).toBe("");
    expect(auditLine(base).args).toBe("");
  });
});

// ─── 状态行：四档对应四种不同的下一步动作（issue #680）──────────────────
describe("hostStatusLine / borrowStatusLine", () => {
  it("A 侧：正在跑压倒一切——那是唯一一次能在当下看见它", () => {
    // 白名单内是全自动的：事情发生的那一刻不显示，之后就只剩翻账了
    expect(hostStatusLine({ connected: true, inflight: 3, lastCallAt: 0 }))
      .toEqual({ dot: "live", text: "正在调用 · 3 笔" });
  });

  it("A 侧：连着但闲着 / 没连上，都带上「最近一次」", () => {
    expect(hostStatusLine({ connected: true, inflight: 0, lastCallAt: null }))
      .toEqual({ dot: "on", text: "已连上 · 还没用过" });
    expect(hostStatusLine({ connected: false, inflight: 0, lastCallAt: null }))
      .toEqual({ dot: "off", text: "没连上 · 还没用过" });
  });

  it("A 侧：配对没成立时不能说「没连上」——那句话暗示等一等就好（issue #682）", () => {
    // 邀请失效是个死锁：等到天荒地老也不会连上，出路只有重发一张
    expect(hostStatusLine({ connected: false, inflight: 0, lastCallAt: null, pairing: "needsInvite" }))
      .toEqual({ dot: "dead", text: "邀请已失效 · 重发一张" });
    expect(hostStatusLine({ connected: false, inflight: 0, lastCallAt: null, pairing: "waiting" }))
      .toEqual({ dot: "off", text: "等对方接受邀请" });
    // 配对成立之后才轮到「连没连」
    expect(hostStatusLine({ connected: false, inflight: 0, lastCallAt: null, pairing: "paired" }))
      .toEqual({ dot: "off", text: "没连上 · 还没用过" });
  });

  it("B 侧：「被撤销」和「没连上」不是一句话——一个别等了，一个等着就行", () => {
    expect(borrowStatusLine({ connected: false, serverCount: 0, revokedReason: "对方撤销了" }))
      .toEqual({ dot: "dead", text: "对方撤销了" });
    expect(borrowStatusLine({ connected: false, serverCount: 0 }))
      .toEqual({ dot: "off", text: "没连上" });
  });

  it("B 侧：「连上了但对方一个都没授」也不是「没连上」", () => {
    expect(borrowStatusLine({ connected: true, serverCount: 0 }))
      .toEqual({ dot: "on", text: "已连上 · 等对方推授权" });
    expect(borrowStatusLine({ connected: true, serverCount: 2 }))
      .toEqual({ dot: "on", text: "2 个服务" });
  });
});
