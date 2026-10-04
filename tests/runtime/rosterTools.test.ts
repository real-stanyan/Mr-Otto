// bring_agent / dismiss_agent 的四条判据（#1571，ADR-0367）：名字对不上 / 只能拉专员 / 管理员自己 / 已在场；apply 回错就抛。
import { describe, expect, it } from "vitest";
import { createRosterTools } from "../../services/runtime/src/rosterTools.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;
const TEAM = [
  { agentId: "admin", name: "管理员", tier: 0 as const, domain: "admin" },
  { agentId: "a_travel", name: "出行", tier: 1 as const, domain: "travel" },
  { agentId: "a_book", name: "订票员", tier: 2 as const, domain: "travel", parentAgentId: "a_travel" },
];

function harness(current: string[] = ["admin"], applyErr: string | null = null) {
  const applied: string[][] = [];
  const tools = createRosterTools({
    team: async () => TEAM,
    current: () => current,
    apply: async (ids) => { applied.push(ids); return applyErr; },
  });
  return { ...tools, applied };
}

describe("bring_agent", () => {
  it("拉专员：apply 收到 current + 它", async () => {
    const h = harness();
    expect(await h.bring.run({ name: "出行" }, world)).toContain("@出行");
    expect(h.applied).toEqual([["admin", "a_travel"]]);
  });
  it("不认识 / 子工 / 自己 / 已在场", async () => {
    const h = harness(["admin", "a_travel"]);
    await expect(h.bring.run({ name: "财务" }, world)).rejects.toThrow("没有叫「财务」");
    await expect(h.bring.run({ name: "订票员" }, world)).rejects.toThrow("子工");
    expect(await h.bring.run({ name: "管理员" }, world)).toContain("你自己");
    expect(await h.bring.run({ name: "出行" }, world)).toContain("已经在这条对话里");
    expect(h.applied).toEqual([]);
  });
  it("apply 回错：抛给模型", async () => {
    const h = harness(["admin"], "私聊的名单改不了");
    await expect(h.bring.run({ name: "出行" }, world)).rejects.toThrow("私聊的名单改不了");
  });
});

describe("dismiss_agent", () => {
  it("请出去：apply 收到去掉它的名单；不在场只回一句；管理员不能请自己", async () => {
    const h = harness(["admin", "a_travel"]);
    expect(await h.dismiss.run({ name: "出行" }, world)).toContain("请出");
    expect(h.applied).toEqual([["admin"]]);
    expect(await h.dismiss.run({ name: "订票员" }, world)).toContain("本来就不在");
    await expect(h.dismiss.run({ name: "管理员" }, world)).rejects.toThrow("不能把自己请出去");
  });
});
