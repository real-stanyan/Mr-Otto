// workspaceView 纯逻辑单测（Task 12，ADR-0198 切片 3）：
// snapshot → 三个 tab 的行模型。钉住 brief 点名的三条易错规则：
// cloudReady 三态（自己贡献+云端在/自己贡献+云端不在/别人贡献恒 true）、
// canKick（owner 且不是自己）、toolsSummary（[] → 全部工具）。

import { describe, expect, it } from "vitest";
import { connectorRows, memberRows, sessionRows } from "../../src/renderer/src/lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS: WorkspaceSnapshot = {
  id: "ws-1",
  name: "测试工作区",
  ownerUid: "owner-uid",
  members: [
    { uid: "owner-uid", role: "owner", label: "Stan" },
    { uid: "member-uid", role: "member", label: "小明" },
  ],
  connectors: [
    { workspaceId: "ws-1", hostUid: "owner-uid", serverId: "shopify", label: "Shopify", tools: [] },
    { workspaceId: "ws-1", hostUid: "member-uid", serverId: "notion", label: "Notion", tools: ["read", "write"] },
  ],
  sessions: [
    { id: "sess-1", workspaceId: "ws-1", publisherUid: "owner-uid", pkgId: "pkg-1", title: "会话标题", updatedTs: 1000 },
  ],
};

describe("connectorRows", () => {
  it("cloudReady 三态：自己贡献的行 = hostedServerIds 含该 serverId", () => {
    const rows = connectorRows(WS, "owner-uid", ["shopify"]);
    const mine = rows.find((r) => r.serverId === "shopify")!;
    expect(mine.mine).toBe(true);
    expect(mine.cloudReady).toBe(true);
  });

  it("cloudReady 三态：自己贡献但不在 hostedServerIds 里（含 null）→ false", () => {
    const notHosted = connectorRows(WS, "owner-uid", []).find((r) => r.serverId === "shopify")!;
    expect(notHosted.cloudReady).toBe(false);
    const nullHosted = connectorRows(WS, "owner-uid", null).find((r) => r.serverId === "shopify")!;
    expect(nullHosted.cloudReady).toBe(false);
  });

  it("cloudReady 三态：别人贡献的行恒 true（B 侧无从探箱）", () => {
    const rows = connectorRows(WS, "owner-uid", null);
    const theirs = rows.find((r) => r.serverId === "notion")!;
    expect(theirs.mine).toBe(false);
    expect(theirs.cloudReady).toBe(true);
  });

  it("toolsSummary：[] → 全部工具，否则 N 个工具", () => {
    const rows = connectorRows(WS, "owner-uid", null);
    expect(rows.find((r) => r.serverId === "shopify")!.toolsSummary).toBe("全部工具");
    expect(rows.find((r) => r.serverId === "notion")!.toolsSummary).toBe("2 个工具");
  });

  it("hostLabel 从成员表查（查不到回 uid 前 8 位）", () => {
    const orphan: WorkspaceSnapshot = {
      ...WS,
      connectors: [{ workspaceId: "ws-1", hostUid: "left-the-group-uid", serverId: "x", label: "X", tools: [] }],
    };
    const row = connectorRows(orphan, "owner-uid", null)[0]!;
    expect(row.hostLabel).toBe("left-the");
  });
});

describe("memberRows", () => {
  it("canKick：自己是 owner 且行不是自己 → true", () => {
    const rows = memberRows(WS, "owner-uid");
    expect(rows.find((r) => r.uid === "member-uid")!.canKick).toBe(true);
  });

  it("canKick：自己是 owner 但那一行就是自己 → false", () => {
    const rows = memberRows(WS, "owner-uid");
    expect(rows.find((r) => r.uid === "owner-uid")!.canKick).toBe(false);
  });

  it("canKick：自己不是 owner → 全员 false", () => {
    const rows = memberRows(WS, "member-uid");
    expect(rows.every((r) => !r.canKick)).toBe(true);
  });
});

describe("sessionRows", () => {
  it("publisherLabel 从成员表查，字段原样透传", () => {
    const rows = sessionRows(WS);
    expect(rows).toEqual([
      { id: "sess-1", title: "会话标题", publisherLabel: "Stan", updatedTs: 1000 },
    ]);
  });
});
