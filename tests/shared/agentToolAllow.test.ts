import { describe, expect, it } from "vitest";
import { filterGrantedByAllow, normalizeAgentTools, sameAgentTools } from "../../src/shared/agentToolAllow.js";

const granted = [
  { hostUid: "h1", serverId: "shopify", toolDefs: [{ name: "list_orders" }, { name: "cancel_order" }] },
  { hostUid: "h1", serverId: "ads", toolDefs: [{ name: "report" }] },
  { hostUid: "h2", serverId: "shopify", toolDefs: [{ name: "list_orders" }] },
];

describe("normalizeAgentTools（jsonb → 白名单）", () => {
  it("合法形状原样落地，tools 里的非字符串项让整份回 []", () => {
    expect(normalizeAgentTools([{ serverId: "shopify", tools: ["a"] }, { serverId: "ads", tools: [] }]))
      .toEqual([{ serverId: "shopify", tools: ["a"] }, { serverId: "ads", tools: [] }]);
    expect(normalizeAgentTools([{ serverId: "shopify", tools: ["a", 1] }])).toEqual([]);
  });
  it("不是数组 / 条目缺 serverId / tools 不是数组 → []（形状不对 = 当没配，同 connectors.tools）", () => {
    expect(normalizeAgentTools(null)).toEqual([]);
    expect(normalizeAgentTools("nope")).toEqual([]);
    expect(normalizeAgentTools([{ tools: [] }])).toEqual([]);
    expect(normalizeAgentTools([{ serverId: "x", tools: "all" }])).toEqual([]);
  });
});

describe("filterGrantedByAllow", () => {
  it("[] = 整池放行，原样回", () => {
    expect(filterGrantedByAllow(granted, [])).toEqual(granted);
  });
  it("只留白名单里的 serverId；条目 tools:[] = 该服务全部工具；**两个 host 的同名 server 都放行**", () => {
    expect(filterGrantedByAllow(granted, [{ serverId: "shopify", tools: [] }])).toEqual([granted[0], granted[2]]);
  });
  it("条目点了工具名就按名字过滤；过滤后一个都不剩的服务不进结果", () => {
    expect(filterGrantedByAllow(granted, [{ serverId: "shopify", tools: ["cancel_order"] }, { serverId: "ads", tools: ["nope"] }]))
      .toEqual([{ hostUid: "h1", serverId: "shopify", toolDefs: [{ name: "cancel_order" }] }]);
  });
});

describe("sameAgentTools", () => {
  it("顺序无关、内容相同才算同", () => {
    expect(sameAgentTools([{ serverId: "a", tools: ["x", "y"] }], [{ serverId: "a", tools: ["y", "x"] }])).toBe(true);
    expect(sameAgentTools([{ serverId: "a", tools: [] }], [{ serverId: "a", tools: ["x"] }])).toBe(false);
    expect(sameAgentTools([], [{ serverId: "a", tools: [] }])).toBe(false);
  });
});
