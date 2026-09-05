// workspaceView 纯逻辑单测（Task 12，ADR-0198 切片 3；cloudState 三态化——
// 审查 round 1，措辞纪律同 px：拿不到清单说「未知」不说「不可用」）：
// snapshot → 三个 tab 的行模型。钉住 brief 点名的三条易错规则：
// cloudState 四种局面（自己贡献+云端在=ready/自己贡献+云端不在=off/
// 自己贡献+清单拿不到=unknown/别人贡献恒 ready）、
// canKick（owner 且不是自己）、toolsSummary（[] → 全部工具）。

import { describe, expect, it } from "vitest";
import { connectorBatchErrorText, connectorRows, memberRows, sessionRows } from "../../src/renderer/src/lib/workspaceView.js";
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
  agents: [],
  relayMaxDepth: 6,
};

describe("connectorRows", () => {
  it("cloudState：自己贡献的行 + hostedServerIds 含该 serverId → ready", () => {
    const rows = connectorRows(WS, "owner-uid", ["shopify"]);
    const mine = rows.find((r) => r.serverId === "shopify")!;
    expect(mine.mine).toBe(true);
    expect(mine.cloudState).toBe("ready");
  });

  it("cloudState：自己贡献的行 + hostedServerIds 不含该 serverId（非 null）→ off", () => {
    const notHosted = connectorRows(WS, "owner-uid", []).find((r) => r.serverId === "shopify")!;
    expect(notHosted.cloudState).toBe("off");
  });

  it("cloudState：自己贡献的行 + hostedServerIds === null（拿不到清单）→ unknown，不是 off", () => {
    // 拿不到清单 ≠ 不可用——同 px 一节的措辞纪律（hostStatusLine 的
    // "断线但箱在说云端可用不说没连上"），这里不能把"不知道"塌成"不可用"
    const unknown = connectorRows(WS, "owner-uid", null).find((r) => r.serverId === "shopify")!;
    expect(unknown.cloudState).toBe("unknown");
  });

  it("cloudState：别人贡献的行恒 ready（B 侧无从探箱）", () => {
    const rows = connectorRows(WS, "owner-uid", null);
    const theirs = rows.find((r) => r.serverId === "notion")!;
    expect(theirs.mine).toBe(false);
    expect(theirs.cloudState).toBe("ready");
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

describe("connectorBatchErrorText（#957 C-C1）", () => {
  it("两边都空 → null", () => {
    expect(connectorBatchErrorText([], [])).toBeNull();
  });

  it("只有贡献失败 → 一句「贡献失败」，注明已成功的已生效", () => {
    expect(connectorBatchErrorText(["shopify", "notion"], [])).toBe(
      "贡献失败：shopify、notion（已成功的已生效）"
    );
  });

  it("只有撤回失败 → 一句「撤回失败」，说清仍然共享给全体成员", () => {
    expect(connectorBatchErrorText([], ["stale-server"])).toBe(
      "撤回失败：stale-server——这台仍然共享给全体成员"
    );
  });

  it("两边都失败 → 两句分开，贡献在前撤回在后，不合并成一句", () => {
    expect(connectorBatchErrorText(["a"], ["b"])).toBe(
      "贡献失败：a（已成功的已生效）\n撤回失败：b——这台仍然共享给全体成员"
    );
  });
});
