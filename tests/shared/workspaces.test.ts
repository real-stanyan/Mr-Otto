// assembleSnapshot 纯逻辑单测：三条断言钉住行数据 → snapshot 的转换规则
// （tools 形状不对回 []、label 缺席回 uid 截断、updated_at ISO → ms）。

import { describe, expect, it } from "vitest";
import { assembleSnapshot } from "../../src/shared/workspaces.js";

const WS = { id: "ws-1", name: "测试工作区", owner_uid: "owner-uid-12345678" };

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
      (uid) => (uid === "owner-uid-12345678" ? "Stan" : null),
    );

    expect(snapshot).toEqual({
      id: "ws-1", name: "测试工作区", ownerUid: "owner-uid-12345678",
      members: [{ uid: "owner-uid-12345678", role: "owner", label: "Stan" }],
      connectors: [{
        workspaceId: "ws-1", hostUid: "owner-uid-12345678", serverId: "srv-1",
        label: "Shopify", tools: ["orders.read"],
      }],
      sessions: [{
        id: "sess-1", workspaceId: "ws-1", publisherUid: "owner-uid-12345678",
        pkgId: "pkg-1", title: "会话标题", updatedTs: Date.parse("2026-08-30T12:00:00.000Z"),
      }],
      agents: [],
    });
  });

  it("label 缺席（profiles 查不到）回 uid 前 8 位", () => {
    const snapshot = assembleSnapshot(
      WS,
      [{ uid: "no-profile-uid-999", role: "member" }],
      [], [], [],
      () => null,
    );
    expect(snapshot.members).toEqual([
      { uid: "no-profile-uid-999", role: "member", label: "no-profi" },
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
      { agentId: "admin", name: "管理员", description: "", instructions: "", models: ["deepseek-v4"], tools: [{ serverId: "shopify", tools: [] }], createdBy: "owner-uid-12345678", updatedTs: Date.parse("2026-09-01T00:00:00.000Z") },
      { agentId: "a1", name: "运营", description: "管店铺", instructions: "你管运营", models: [], tools: [], createdBy: "u2", updatedTs: 0 },
    ]);
  });
});
