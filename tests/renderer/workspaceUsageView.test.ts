import { describe, expect, it } from "vitest";
import {
  usageEmptyText, usageHeadline, usageRows, usageScale, usageScaleNote, usageWindowText, workspaceTotalMicro,
} from "../../src/renderer/src/lib/workspaceUsageView.js";
import type { WorkspaceSnapshot, WorkspaceAgentRow } from "../../src/shared/workspaces.js";
import type { WorkspaceUsage } from "../../src/shared/billing.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "owner", updatedTs: 0, avatarSlot: null,
});
const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [], members: [],
  agents: [agent("admin", "管理员"), agent("a_ops", "运营")],
  sandboxApproval: "ask",
};
/** 合计 200_000 micro = 20 credit；周额度 2_000_000 → 工作区吃掉 10.0% */
const usage: WorkspaceUsage = {
  workspaceId: "w", ownerUid: "owner",
  weekStartAt: Date.UTC(2026, 8, 1, 12), weekEndAt: Date.UTC(2026, 8, 8, 12),
  weekLimitMicro: 2_000_000,
  rows: [
    { agentId: "a_ops", costMicro: 120_000, calls: 3, promptTokens: 1200, cachedTokens: 200, completionTokens: 300 },
    { agentId: "a_gone", costMicro: 60_000, calls: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 5 },
    { agentId: "", costMicro: 20_000, calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
  ],
};

describe("usageRows", () => {
  it("名字现查名单：查得到用名字，被删的回 id，空串 = 未归因", () => {
    expect(usageRows(ws, usage).map((r) => r.name)).toEqual(["运营", "a_gone", "未归因"]);
  });

  it("百分比是**占所有者本周额度**，一个 credit 都不出现（#1120）", () => {
    expect(usageRows(ws, usage).map((r) => r.percent)).toEqual(["6.0%", "3.0%", "1.0%"]);
  });

  it("向下取整一位小数：0.04% 不许写成 0.1%（同 remainingPercent 的理由）", () => {
    const tiny: WorkspaceUsage = { ...usage, rows: [{ agentId: "a_ops", costMicro: 800, calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 }] };
    expect(usageRows(ws, tiny)[0]!.percent).toBe("0.0%");
  });

  it("条按**本工作区合计**归一化，各行加起来正好是 1——不按最大值归一化（那样最大那只常年满格）", () => {
    const shares = usageRows(ws, usage).map((r) => r.share);
    expect(shares).toEqual([0.6, 0.3, 0.1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("名单里查不到就没有脸：派生一张出来等于宣称它还在名册里", () => {
    const rows = usageRows(ws, usage);
    expect(rows[0]!.avatarSrc).toBeTypeOf("string");   // 在名单里
    expect(rows[1]!.avatarSrc).toBeNull();             // 已删除
    expect(rows[2]!.avatarSrc).toBeNull();             // 未归因
  });

  it("token 列不把 cached 数第二遍（它是 prompt 的子集）", () => {
    expect(usageRows(ws, usage)[0]!.tokens).toBe("1.5k");
  });

  it("合计为 0 时 share 全 0，不产生 NaN", () => {
    const empty: WorkspaceUsage = { ...usage, rows: [{ agentId: "a_ops", costMicro: 0, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }] };
    expect(usageRows(ws, empty)[0]!.share).toBe(0);
  });
});

describe("分母缺席时的退路（没订阅 / 旧 edge）", () => {
  const noLimit: WorkspaceUsage = { ...usage, weekLimitMicro: null };

  it("usageScale 退到本工作区合计，标签跟着换——两个分母算出来是两个意思完全不同的数", () => {
    expect(usageScale(usage)).toEqual({ kind: "window", limitMicro: 2_000_000 });
    expect(usageScale(noLimit)).toEqual({ kind: "workspace", totalMicro: 200_000 });
    expect(usageScaleNote(usageScale(usage))).toContain("额度窗口");
    expect(usageScaleNote(usageScale(noLimit))).toContain("本工作区本周合计");
  });

  it("退路上百分比按工作区合计算，加起来是 100%——**绝不回落到 credit**", () => {
    const rows = usageRows(ws, noLimit);
    expect(rows.map((r) => r.percent)).toEqual(["60.0%", "30.0%", "10.0%"]);
    expect(rows.every((r) => !r.percent.includes("credit") && !r.percent.includes("$"))).toBe(true);
  });

  it("页顶那格：分母缺席时不报百分比，只报调用次数（拿工作区合计当分母硬报 100% 什么都没说）", () => {
    expect(usageHeadline(usage)).toEqual({ percent: "10.0%", fill: 0.1, calls: 5 });
    expect(usageHeadline(noLimit)).toEqual({ percent: null, fill: null, calls: 5 });
  });
});

describe("窗口与空态", () => {
  it("窗口文案", () => {
    expect(usageWindowText(usage)).toMatch(/9月1日.*9月8日/);
    expect(workspaceTotalMicro(usage)).toBe(200_000);
  });
  it("blocked：说清楚是所有者的订阅 / 额度挡住了，不是「没花」（ADR-0233 之后没有自带 key 那档）", () => {
    expect(usageEmptyText({ kind: "blocked" })).toMatch(/订阅/);
  });
  it("hosted / null：沿用旧的空态文案", () => {
    expect(usageEmptyText({ kind: "hosted", model: "deepseek-v4" })).toBe("这一周还没有托管路由的花费。");
    expect(usageEmptyText(null)).toBe("这一周还没有托管路由的花费。");
  });
});
