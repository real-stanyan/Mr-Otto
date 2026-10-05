// update_settings（#1621）：找对象、写、复述、落系统行；available 跟注入的走；不过审批门。
import { describe, expect, it } from "vitest";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { createSettingsTool } from "../../services/runtime/src/settingsTool.js";
import { createInMemoryOwnerSettings } from "../../services/runtime/src/ownerSettingsStore.js";

const world = {} as ExecutionWorld;
function rig(o: Parameters<typeof createInMemoryOwnerSettings>[0] = {}, available = true) {
  const store = createInMemoryOwnerSettings({ friends: [{ uid: "u-stan", name: "Stan Yan" }, { uid: "u-ci", name: "慈" }], agents: [{ agentId: "admin", name: "雨姐" }, { agentId: "a_1", name: "店铺管家" }], ...o });
  const lines: string[] = [];
  const tool = createSettingsTool({ workspaceId: "w1", ownerUid: "owner", store, available: () => available, announce: (l) => lines.push(l) });
  return { store, tool, lines };
}

describe("update_settings", () => {
  it("不过审批门；available 跟注入的走；说明里列了九个键", () => {
    const r = rig({}, false);
    expect(r.tool.requiresApproval).toBe(false);
    expect(r.tool.available?.()).toBe(false);
    for (const k of ["quiet_hours", "report", "friend_tier", "lane_facing", "public_agent", "agent", "profile_name"]) expect(r.tool.def.description).toContain(k);
  });
  it("免打扰 / 汇报 / 时区 / 推送：写 notify 那一行，前三样清认领指针；回执「已改」+ 系统行", async () => {
    const r = rig();
    const out = await r.tool.run({ setting: "quiet_hours", value: { start: "22:00", end: "08:00" } }, world);
    expect(out).toContain("已改：免打扰设成");
    expect(r.store.notify.get("owner")).toMatchObject({ quiet: { start: "22:00", end: "08:00" }, reportNextAt: null });
    await r.tool.run({ setting: "push", value: { friends: false } }, world);
    expect(r.store.notify.get("owner")!.push.friends).toBe(false);
    expect(r.store.notify.get("owner")!.quiet).toEqual({ start: "22:00", end: "08:00" }); // 推送开关不抹免打扰
    await r.tool.run({ setting: "tz", value: "Australia/Brisbane" }, world);
    expect(r.store.notify.get("owner")!.tz).toBe("Australia/Brisbane");
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]!.startsWith("已改：")).toBe(true);
  });
  it("好友档位 / 车道朝向：按名字找人（找不到 / 重名问主人）；朝向被拒原样抛", async () => {
    const r = rig();
    expect(await r.tool.run({ setting: "friend_tier", friend: "Stan Yan", value: "full" }, world)).toContain("给 Stan Yan 的权限设成「全部开放」");
    expect(r.store.tiers.get("u-stan")).toBe("full");
    await expect(r.tool.run({ setting: "friend_tier", friend: "小明", value: "full" }, world)).rejects.toThrow("没有叫「小明」的");
    expect(await r.tool.run({ setting: "lane_facing", friend: "慈", value: "both" }, world)).toContain("公开给 TA 了");
    expect(r.store.facings).toEqual([{ friendUid: "u-ci", facing: "both" }]);
    const refused = rig({ refuseFacing: "你们已经不是朋友了，公开不了" });
    await expect(refused.tool.run({ setting: "lane_facing", friend: "慈", value: "both" }, world)).rejects.toThrow("不是朋友");
    expect(refused.lines).toEqual([]);
  });
  it("公开智能体 / 改一只 / 改显示名：按名字找那只；清掉传 null", async () => {
    const r = rig();
    expect(await r.tool.run({ setting: "public_agent", value: "雨姐" }, world)).toContain("公开智能体设成「雨姐」");
    expect(r.store.publicAgent.get("owner")).toBe("admin");
    await r.tool.run({ setting: "public_agent", value: null }, world);
    expect(r.store.publicAgent.get("owner")).toBeNull();
    expect(await r.tool.run({ setting: "agent", agent: "店铺管家", value: { description: "管后台" } }, world)).toContain("「店铺管家」职责改了");
    expect(r.store.agentPatches).toEqual([{ agentId: "a_1", patch: { description: "管后台" } }]);
    await expect(r.tool.run({ setting: "agent", agent: "没有的", value: { name: "x" } }, world)).rejects.toThrow("没有叫「没有的」");
    expect(await r.tool.run({ setting: "profile_name", value: "继爸" }, world)).toContain("显示名改成「继爸」");
    expect(r.store.names.get("owner")).toBe("继爸");
  });
});
