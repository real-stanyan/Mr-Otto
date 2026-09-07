// assembleSnapshot 纯逻辑单测：三条断言钉住行数据 → snapshot 的转换规则
// （tools 形状不对回 []、label 缺席回 uid 截断 + avatarUrl 缺席回空串、updated_at ISO → ms）+
// relay_max_depth 形状不对回默认（#950 Task 9，同 normalizeRelayMaxDepth 口径）。

import { describe, expect, it } from "vitest";
import { assembleSnapshot } from "../../src/shared/workspaces.js";

const WS = { id: "ws-1", name: "测试工作区", owner_uid: "owner-uid-12345678", relay_max_depth: 6, sandbox_approval: "ask" };

describe("assembleSnapshot", () => {
  it("组装成员/连接器/会话三张表 + label 查得到时原样用", () => {
    const snapshot = assembleSnapshot(
      WS,
      [{ uid: "owner-uid-12345678", role: "owner" }],
      [{
        workspace_id: "ws-1", host_uid: "owner-uid-12345678", server_id: "srv-1",
        label: "Shopify", tools: ["orders.read"],
      }],
      [{
        id: "sess-1", workspace_id: "ws-1", publisher_uid: "owner-uid-12345678",
        pkg_id: "pkg-1", title: "会话标题", updated_at: "2026-08-30T12:00:00.000Z",
      }],
      [],
      (uid) => (uid === "owner-uid-12345678" ? { name: "Stan", avatarUrl: "data:image/webp;base64,AAA" } : null),
    );

    expect(snapshot).toEqual({
      id: "ws-1", name: "测试工作区", ownerUid: "owner-uid-12345678",
      members: [{ uid: "owner-uid-12345678", role: "owner", label: "Stan", avatarUrl: "data:image/webp;base64,AAA" }],
      connectors: [{
        workspaceId: "ws-1", hostUid: "owner-uid-12345678", serverId: "srv-1",
        label: "Shopify", tools: ["orders.read"],
      }],
      sessions: [{
        id: "sess-1", workspaceId: "ws-1", publisherUid: "owner-uid-12345678",
        pkgId: "pkg-1", title: "会话标题", updatedTs: Date.parse("2026-08-30T12:00:00.000Z"),
      }],
      agents: [],
      sandboxApproval: "ask",
    });
  });

  it("label 缺席（profiles 查不到）回 uid 前 8 位，avatarUrl 回空串", () => {
    const snapshot = assembleSnapshot(
      WS,
      [{ uid: "no-profile-uid-999", role: "member" }],
      [], [], [],
      () => null,
    );
    expect(snapshot.members).toEqual([
      { uid: "no-profile-uid-999", role: "member", label: "no-profi", avatarUrl: "" },
    ]);
  });

  it("profiles 行在但 name 是空串（没起过名）：label 同样退回 uid 前 8 位，头像照用", () => {
    const snapshot = assembleSnapshot(
      WS,
      [{ uid: "unnamed-uid-12345", role: "member" }],
      [], [], [],
      () => ({ name: "", avatarUrl: "https://x/a.png" }),
    );
    expect(snapshot.members).toEqual([
      { uid: "unnamed-uid-12345", role: "member", label: "unnamed-", avatarUrl: "https://x/a.png" },
    ]);
  });

  it("tools 形状不对（非数组，或含非字符串项）回 []", () => {
    const snapshot = assembleSnapshot(
      WS, [],
      [
        { workspace_id: "ws-1", host_uid: "h1", server_id: "s1", label: "A", tools: "not-an-array" },
        { workspace_id: "ws-1", host_uid: "h2", server_id: "s2", label: "B", tools: ["ok", 123] },
        { workspace_id: "ws-1", host_uid: "h3", server_id: "s3", label: "C", tools: null },
      ],
      [], [],
      () => null,
    );
    expect(snapshot.connectors.map((c) => c.tools)).toEqual([[], [], []]);
  });

  it("updated_at 解析不出时间（NaN）回 0", () => {
    const snapshot = assembleSnapshot(
      WS, [], [],
      [{
        id: "sess-1", workspace_id: "ws-1", publisher_uid: "p1",
        pkg_id: "pkg-1", title: "t", updated_at: "not-a-date",
      }],
      [],
      () => null,
    );
    expect(snapshot.sessions[0]!.updatedTs).toBe(0);
  });

  it("agents：models/tools 形状不对回 []，updated_at → ms，created_by 原样", () => {
    const snapshot = assembleSnapshot(
      WS, [], [], [],
      [
        { agent_id: "admin", name: "管理员", description: "", instructions: "", models: ["deepseek-v4"], tools: [{ serverId: "shopify", tools: [] }], created_by: "owner-uid-12345678", updated_at: "2026-09-01T00:00:00.000Z" },
        { agent_id: "a1", name: "运营", description: "管店铺", instructions: "你管运营", models: "nope", tools: "garbage", created_by: "u2", updated_at: "bad" },
      ],
      () => null,
    );
    expect(snapshot.agents).toEqual([
      { agentId: "admin", name: "管理员", description: "", instructions: "", models: ["deepseek-v4"], tools: [{ serverId: "shopify", tools: [] }], createdBy: "owner-uid-12345678", updatedTs: Date.parse("2026-09-01T00:00:00.000Z"), avatarSlot: null },
      { agentId: "a1", name: "运营", description: "管店铺", instructions: "你管运营", models: [], tools: [], createdBy: "u2", updatedTs: 0, avatarSlot: null },
    ]);
  });

  it("avatar_slot：非负整数原样带出；缺列 / null / 负数 / 小数一律 null（= 按 agentId 派生，#1007）", () => {
    const agentRow = (avatar_slot: unknown) => ({
      agent_id: "a1", name: "运营", description: "", instructions: "",
      models: [], tools: [], created_by: "u2", updated_at: "1970-01-01T00:00:00.000Z",
      avatar_slot,
    });
    const slotOf = (v: unknown) =>
      assembleSnapshot(WS, [], [], [], [agentRow(v)], () => null).agents[0]!.avatarSlot;
    expect(slotOf(0)).toBe(0);   // 0 是合法坑位，不能被当成假值吞掉
    expect(slotOf(7)).toBe(7);
    expect(slotOf(undefined)).toBeNull();  // 0027 还没跑：列不存在与「没挑过」同义
    expect(slotOf(null)).toBeNull();
    expect(slotOf(-1)).toBeNull();
    expect(slotOf(1.5)).toBeNull();
    expect(slotOf("3")).toBeNull();
  });

  it("sandbox_approval：只认 'auto'，其余（缺列 undefined / null / 别的串）一律回 'ask'——往严的一边倒（#977）", () => {
    expect(assembleSnapshot({ ...WS, sandbox_approval: "auto" }, [], [], [], [], () => null).sandboxApproval).toBe("auto");
    expect(assembleSnapshot({ ...WS, sandbox_approval: "ask" }, [], [], [], [], () => null).sandboxApproval).toBe("ask");
    expect(assembleSnapshot({ ...WS, sandbox_approval: undefined }, [], [], [], [], () => null).sandboxApproval).toBe("ask");
    expect(assembleSnapshot({ ...WS, sandbox_approval: null }, [], [], [], [], () => null).sandboxApproval).toBe("ask");
    expect(assembleSnapshot({ ...WS, sandbox_approval: "AUTO" }, [], [], [], [], () => null).sandboxApproval).toBe("ask");
  });
});
