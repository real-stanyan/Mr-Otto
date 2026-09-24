// agentAdmin —— 改 / 删一只智能体的编排（#1356 A1，spec §3.2）。桌面主进程与手机端共用：
// 桌面那份经 workspaceManager 的集成测试（tests/main/workspaceManager.test.ts）照旧覆盖，
// 这份钉编排本身——手机端没有主进程那一层，直接调它。

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ADMIN_CANNOT_DELETE, DUPLICATE_AGENT_NAME, assertAgentNameFree, deleteAgentEverywhere, updateAgentChecked,
  type AgentDeleteDeps, type AgentUpdateDeps,
} from "../../src/shared/agentAdmin.js";

const client = {} as SupabaseClient;

function updateDeps(names: { agentId: string; name: string }[]): AgentUpdateDeps & { updateAgentRow: ReturnType<typeof vi.fn> } {
  return {
    listAgentNames: vi.fn(async () => names),
    updateAgentRow: vi.fn(async () => undefined),
  };
}

describe("assertAgentNameFree", () => {
  it("精确同名报「已有同名的智能体」（不报前缀那句，与 23505 那条路同一句话）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营", null)).rejects.toThrow(DUPLICATE_AGENT_NAME);
  });
  it("前缀冲突两个方向都拒", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营助理", null)).rejects.toThrow(/冲突/);
    const deps2 = updateDeps([{ agentId: "a1", name: "运营助理" }]);
    await expect(assertAgentNameFree(deps2, client, "w", "运营", null)).rejects.toThrow(/冲突/);
  });
  it("名单里是全角旧名字时，半角同名照样拒（已有名字也要归一化）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "Ａｄｓ" }]);
    await expect(assertAgentNameFree(deps, client, "w", "Ads", null)).rejects.toThrow(DUPLICATE_AGENT_NAME);
  });
  it("改成自己现在的名字不算冲突（名单里排掉正在改的那只）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营", "a1")).resolves.toBeUndefined();
  });
});

describe("updateAgentChecked", () => {
  it("只带在场的字段：没传的字段不补默认值（补了就是把它清空）", async () => {
    const deps = updateDeps([]);
    await updateAgentChecked(deps, client, "w", "a1", { description: "管店铺" });
    expect(deps.updateAgentRow).toHaveBeenCalledWith(client, "w", "a1", { description: "管店铺" });
    expect(deps.listAgentNames).not.toHaveBeenCalled(); // 不改名不查名单
  });
  it("改名先归一化再查重、再落库", async () => {
    const deps = updateDeps([{ agentId: "a2", name: "设计" }]);
    await updateAgentChecked(deps, client, "w", "a1", { name: " Ａｄｓ " });
    expect(deps.updateAgentRow).toHaveBeenCalledWith(client, "w", "a1", { name: "Ads" });
  });
  it("description 带换行 → 拒绝，不打网络", async () => {
    const deps = updateDeps([]);
    await expect(updateAgentChecked(deps, client, "w", "a1", { description: "第一行\n第二行" })).rejects.toThrow(/换行/);
    expect(deps.updateAgentRow).not.toHaveBeenCalled();
  });
  it("avatarSlot：省略 = 不动这一格；null = 清回派生；越界 = null", async () => {
    const deps = updateDeps([]);
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: 3 });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: 3 });
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: null });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: null });
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: -2 });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: null });
  });
  it("23505 翻成「已有同名的智能体」，别的错误原样抛", async () => {
    const deps = updateDeps([]);
    deps.updateAgentRow.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(updateAgentChecked(deps, client, "w", "a1", { name: "运营" })).rejects.toThrow(DUPLICATE_AGENT_NAME);
    deps.updateAgentRow.mockRejectedValueOnce(new Error("行不存在或无权修改"));
    await expect(updateAgentChecked(deps, client, "w", "a1", { description: "x" })).rejects.toThrow("行不存在或无权修改");
  });
});

function deleteDeps(chats: { dmSessionId: string | null; groups: { sessionId: string; agentIds: string[] }[] }) {
  const calls: string[] = [];
  const deps: AgentDeleteDeps = {
    listAgentChats: vi.fn(async () => chats),
    removeCloudSession: vi.fn(async (_w: string, sid: string) => { calls.push(`remove:${sid}`); return { ok: true as const, value: null }; }),
    updateChatRoster: vi.fn(async (_w: string, sid: string, ids: string[]) => { calls.push(`roster:${sid}:${ids.join(",")}`); return { ok: true as const, value: null }; }),
    deleteAgentRow: vi.fn(async () => { calls.push("row"); }),
    removeAgentPage: vi.fn(async () => { calls.push("page"); }),
  };
  return { deps, calls };
}

describe("deleteAgentEverywhere", () => {
  it("管理员在本层就拒，不打网络", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [] });
    await expect(deleteAgentEverywhere(deps, client, "w", "admin")).rejects.toThrow(ADMIN_CANNOT_DELETE);
    expect(calls).toEqual([]);
    expect(deps.listAgentChats).not.toHaveBeenCalled();
  });
  it("倒着排的四步：私聊 → 各群摘掉（发变动之后的完整名单）→ 那一行 → 记忆页", async () => {
    const { deps, calls } = deleteDeps({
      dmSessionId: "dm1",
      groups: [{ sessionId: "g1", agentIds: ["admin", "a1", "a2"] }, { sessionId: "g2", agentIds: ["a1"] }],
    });
    await deleteAgentEverywhere(deps, client, "w", "a1");
    expect(calls).toEqual(["remove:dm1", "roster:g1:admin,a2", "roster:g2:", "row", "page"]);
  });
  it("私聊删不掉 → 整件事停下、智能体留着（断在半路留下的是「智能体还在、聊天没了」的反面就糟了）", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: "dm1", groups: [{ sessionId: "g1", agentIds: ["a1"] }] });
    vi.mocked(deps.removeCloudSession).mockResolvedValueOnce({ ok: false, message: "云端无响应" });
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).rejects.toThrow("它的聊天记录没删掉（云端无响应），所以这只智能体也先留着。稍后再试。");
    expect(calls).toEqual([]);
  });
  it("摘群失败同样停下", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [{ sessionId: "g1", agentIds: ["a1", "a2"] }] });
    vi.mocked(deps.updateChatRoster).mockResolvedValueOnce({ ok: false, message: "限速" });
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).rejects.toThrow("没能把它从群聊里摘掉（限速），所以这只智能体也先留着。稍后再试。");
    expect(calls).toEqual([]);
  });
  it("记忆页删不掉不拦删除", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [] });
    vi.mocked(deps.removeAgentPage).mockRejectedValueOnce(new Error("容器没起来"));
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).resolves.toBeUndefined();
    expect(calls).toEqual(["row"]);
  });
});
