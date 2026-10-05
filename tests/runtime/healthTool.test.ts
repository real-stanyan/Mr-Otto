// read_health（#1656）：资格判据（谁的哪一轮能读）与工具本身（现选 cid、失败抛给模型、成功给文本）。
import { describe, expect, it } from "vitest";
import { createReadHealthTool, healthTurnEligible, type HealthGateway } from "../../services/runtime/src/healthTool.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;
const base = { approveAll: true, ownerUid: "owner", initiator: "owner", depth: 0, routine: false, report: false, rerun: false };

describe("healthTurnEligible", () => {
  it("主场：主人亲口的那一轮可以", () => expect(healthTurnEligible(base)).toBe(true));
  it.each([
    ["主场里客人 / 朋友那一轮", { initiator: "friend" }],
    ["接力棒", { depth: 1 }],
    ["定时任务", { routine: true }],
    ["汇报轮", { report: true }],
    ["重启补跑", { rerun: true }],
    ["没有发起人", { initiator: null }],
    ["系统", { initiator: "system" }],
  ])("不行：%s", (_n, patch) => {
    expect(healthTurnEligible({ ...base, ...patch })).toBe(false);
  });
  it("团队会话：哪位成员亲口都行（读的是他自己的手机）", () => {
    expect(healthTurnEligible({ ...base, approveAll: false, initiator: "member" })).toBe(true);
  });
});

describe("read_health", () => {
  const OK = { ok: true as const, days: [{ date: "2026-10-04", steps: 8231 }], workouts: [] };
  function gw(cid: string | null, result = OK as Awaited<ReturnType<HealthGateway["request"]>>) {
    const asked: { cid: string; q: unknown }[] = [];
    const gateway: HealthGateway = {
      cidOf: (uid) => (uid === "owner" ? cid : null),
      request: async (c, q) => { asked.push({ cid: c, q }); return result; },
    };
    return { gateway, asked };
  }
  it("不过审批门、名字固定", () => {
    const t = createReadHealthTool({ gateway: gw("c1").gateway, initiator: () => "owner" });
    expect(t.def.name).toBe("read_health");
    expect(t.requiresApproval).toBe(false);
  });
  it("调用时按发起人现选 cid，回给模型的文本", async () => {
    const { gateway, asked } = gw("c1");
    const t = createReadHealthTool({ gateway, initiator: () => "owner" });
    const out = await t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world, { toolCallId: "x" });
    expect(asked).toEqual([{ cid: "c1", q: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } }]);
    expect(out).toBe("Apple 健康 · 2026-10-04 至 2026-10-04（用户手机本地日历，按天汇总）\n2026-10-04：步数 8231");
  });
  it("手机不在线：抛人话", async () => {
    const t = createReadHealthTool({ gateway: gw(null).gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world)).rejects.toThrow("手机现在没连着");
  });
  it("参数不对：抛错并说清规则", async () => {
    const t = createReadHealthTool({ gateway: gw("c1").gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["mood"], from: "x", to: "y" }, world)).rejects.toThrow("YYYY-MM-DD");
  });
  it("手机回 ok:false：把 error 抛给模型", async () => {
    const t = createReadHealthTool({ gateway: gw("c1", { ok: false, error: "手机 30 秒没回" }).gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world)).rejects.toThrow("手机 30 秒没回");
  });
});
