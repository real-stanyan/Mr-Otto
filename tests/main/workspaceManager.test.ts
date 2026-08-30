import { describe, expect, it } from "vitest";
import { createWorkspaceManager, type WorkspaceManagerDeps } from "../../src/main/workspaceManager.js";
import type { ProxyStoreData } from "../../src/main/proxyStore.js";
import { emptyProxyStore } from "../../src/main/proxyStore.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { WorkspaceListRow } from "../../src/main/supabaseWorkspacesApi.js";

// workspaceManager 编排测试（Task 8，ADR-0198 切片 2）：api/client 全假货，
// 只钉编排顺序与本地台账的合并/清理语义——真查询逻辑已经在 supabaseWorkspacesApi
// 与 proxyStore 各自的单测里钉过，这里不重复。

function harness(over: Partial<WorkspaceManagerDeps> = {}) {
  const calls: string[] = [];
  let store: ProxyStoreData = emptyProxyStore();
  let signedIn = true;
  const snapshots: WorkspaceSnapshot[] = [];
  const rows: WorkspaceListRow[] = [];
  const fakeClient = { fake: "client" } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const deps: WorkspaceManagerDeps = {
    createWorkspace: async (_client, name, selfUid) => {
      calls.push("createWorkspace");
      return { id: "ws-new", name, owner_uid: selfUid, created_at: "2026-01-01T00:00:00Z" };
    },
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return rows;
    },
    fetchWorkspace: async (_client, id) => {
      calls.push("fetchWorkspace");
      const found = snapshots.find((s) => s.id === id);
      if (!found) throw new Error("not found: " + id);
      return found;
    },
    addMember: async () => {
      calls.push("addMember");
    },
    removeMember: async () => {
      calls.push("removeMember");
    },
    leave: async () => {
      calls.push("api.leave");
    },
    deleteWorkspace: async () => {
      calls.push("deleteWorkspace");
    },
    upsertConnectorRow: async () => {
      calls.push("upsertConnectorRow");
    },
    deleteConnectorRow: async () => {
      calls.push("deleteConnectorRow");
    },
    client: () => (signedIn ? fakeClient : null),
    selfUid: () => (signedIn ? "self-uid" : null),
    loadStore: () => store,
    saveStore: (d) => {
      calls.push("saveStore");
      store = d;
    },
    resyncEscrow: () => {
      calls.push("resyncEscrow");
    },
    serverLabel: (serverId) => `label:${serverId}`,
    ...over,
  };

  return {
    manager: createWorkspaceManager(deps),
    calls,
    getStore: () => store,
    setStore: (d: ProxyStoreData) => { store = d; },
    signOut: () => { signedIn = false; },
    snapshots,
    rows,
  };
}

describe("workspaceManager（Task 8，ADR-0198 切片 2）", () => {
  it("contributeConnector：箱先于目录——saveStore + resyncEscrow 在 upsertConnectorRow 之前，且合并授权", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "old-server", tools: ["a"] }] }],
    });

    const res = await h.manager.contributeConnector("ws-1", "new-server", ["read", "write"]);

    expect(res).toEqual({ ok: true, value: null });
    // 顺序：saveStore、resyncEscrow 必须先于 upsertConnectorRow
    const saveIdx = h.calls.indexOf("saveStore");
    const resyncIdx = h.calls.indexOf("resyncEscrow");
    const upsertIdx = h.calls.indexOf("upsertConnectorRow");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(resyncIdx).toBeGreaterThan(saveIdx);
    expect(upsertIdx).toBeGreaterThan(resyncIdx);

    // 合并语义：旧条目还在，新条目加进去
    const grant = h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1");
    expect(grant?.allow).toEqual([
      { serverId: "old-server", tools: ["a"] },
      { serverId: "new-server", tools: ["read", "write"] },
    ]);
  });

  it("contributeConnector：替换同 serverId 的旧条目而不是重复添加", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "srv", tools: ["old"] }] }],
    });

    await h.manager.contributeConnector("ws-1", "srv", ["new"]);

    const grant = h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1");
    expect(grant?.allow).toEqual([{ serverId: "srv", tools: ["new"] }]);
  });

  it("withdrawConnector：删该 serverId 条目，箱先于目录；allow 删空则整条 grant 消失", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "only-one", tools: [] }] }],
    });

    const res = await h.manager.withdrawConnector("ws-1", "only-one");

    expect(res).toEqual({ ok: true, value: null });
    const saveIdx = h.calls.indexOf("saveStore");
    const resyncIdx = h.calls.indexOf("resyncEscrow");
    const deleteIdx = h.calls.indexOf("deleteConnectorRow");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(resyncIdx).toBeGreaterThan(saveIdx);
    expect(deleteIdx).toBeGreaterThan(resyncIdx);

    // allow 删空 → 整条 workspaceGrant 不见了（removeWorkspaceGrant），不是留一条空 allow
    expect(h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1")).toBeUndefined();
  });

  it("withdrawConnector：删了一个但还剩别的条目——grant 保留，只少那一条", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{
        workspaceId: "ws-1",
        allow: [{ serverId: "keep", tools: ["x"] }, { serverId: "drop", tools: ["y"] }],
      }],
    });

    await h.manager.withdrawConnector("ws-1", "drop");

    const grant = h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1");
    expect(grant?.allow).toEqual([{ serverId: "keep", tools: ["x"] }]);
  });

  it("remove：先 Supabase 删群成功，再清本地 grant + resync（顺序不能反）", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "s", tools: [] }] }],
    });

    const res = await h.manager.remove("ws-1");

    expect(res).toEqual({ ok: true, value: null });
    const deleteIdx = h.calls.indexOf("deleteWorkspace");
    const saveIdx = h.calls.indexOf("saveStore");
    const resyncIdx = h.calls.indexOf("resyncEscrow");
    expect(deleteIdx).toBe(0); // Supabase 动作最先
    expect(saveIdx).toBeGreaterThan(deleteIdx);
    expect(resyncIdx).toBeGreaterThan(saveIdx);
    expect(h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1")).toBeUndefined();
  });

  it("remove：Supabase 动作失败——本地 grant 不清，不 resync", async () => {
    const h = harness({
      deleteWorkspace: async () => {
        throw new Error("网络错了");
      },
    });
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "s", tools: [] }] }],
    });

    const res = await h.manager.remove("ws-1");

    expect(res).toEqual({ ok: false, message: "网络错了" });
    expect(h.calls).not.toContain("saveStore");
    expect(h.calls).not.toContain("resyncEscrow");
    expect(h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1")).toBeDefined();
  });

  it("leave：先退群成功，再清自己的本地 grant + resync", async () => {
    const h = harness();
    h.setStore({
      ...emptyProxyStore(),
      workspaceGrants: [{ workspaceId: "ws-1", allow: [{ serverId: "s", tools: [] }] }],
    });

    const res = await h.manager.leave("ws-1");

    expect(res).toEqual({ ok: true, value: null });
    const leaveIdx = h.calls.indexOf("api.leave");
    const saveIdx = h.calls.indexOf("saveStore");
    expect(leaveIdx).toBe(0);
    expect(saveIdx).toBeGreaterThan(leaveIdx);
    expect(h.calls.indexOf("resyncEscrow")).toBeGreaterThan(saveIdx);
    expect(h.getStore().workspaceGrants.find((g) => g.workspaceId === "ws-1")).toBeUndefined();
  });

  it("hostUids：list() 后按 connectors[].hostUid 去重、排除 selfUid()；list() 之前是空的", async () => {
    const h = harness();
    expect(h.manager.hostUids()).toEqual([]);

    h.rows.push({ id: "ws-1", name: "w1", owner_uid: "self-uid", created_at: "2026-01-01T00:00:00Z" });
    h.snapshots.push({
      id: "ws-1",
      name: "w1",
      ownerUid: "self-uid",
      members: [],
      connectors: [
        { workspaceId: "ws-1", hostUid: "friend-a", serverId: "s1", label: "L1", tools: [] },
        { workspaceId: "ws-1", hostUid: "friend-a", serverId: "s2", label: "L2", tools: [] },
        { workspaceId: "ws-1", hostUid: "self-uid", serverId: "s3", label: "L3", tools: [] },
        { workspaceId: "ws-1", hostUid: "friend-b", serverId: "s4", label: "L4", tools: [] },
      ],
      sessions: [],
    });

    const res = await h.manager.list();
    expect(res.ok).toBe(true);
    expect(h.manager.hostUids().slice().sort()).toEqual(["friend-a", "friend-b"]);
  });

  it("未登录早退：client() 为 null 时全部动作回 还没登录，不碰任何依赖", async () => {
    const h = harness();
    h.signOut();

    const res = await h.manager.create("新工作区");

    expect(res).toEqual({ ok: false, message: "还没登录" });
    expect(h.calls).toEqual([]);
  });
});
