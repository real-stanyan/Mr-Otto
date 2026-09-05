// workspaceView 的云会话列表行模型单测（Task 13，ADR-0199）：cloudSessionRows
// 钉住 brief 点名的三条易错规则——creatorLabel 回退（labelOf 同款 uid 前 8 位）、
// archived 沉底、非归档内部按 updatedTs 降序。同 workspaceView.test.ts 的写法，
// 拆成独立文件是这个任务自己的 Test 交付物，不与 Task 12 的用例混在一起。

import { describe, expect, it } from "vitest";
import { cloudSessionRows, type CloudSessionListRow } from "../../src/renderer/src/lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS: WorkspaceSnapshot = {
  id: "ws-1",
  name: "测试工作区",
  ownerUid: "owner-uid",
  members: [
    { uid: "owner-uid", role: "owner", label: "Stan" },
    { uid: "member-uid", role: "member", label: "小明" },
  ],
  connectors: [],
  sessions: [],
  agents: [],
  relayMaxDepth: 6,
};

const ROWS: CloudSessionListRow[] = [
  { id: "cs-1", title: "会话一", publisherUid: "owner-uid", archived: false, updatedTs: 1000 },
  { id: "cs-2", title: "会话二", publisherUid: "member-uid", archived: false, updatedTs: 3000 },
  { id: "cs-3", title: "已归档但更新过", publisherUid: "owner-uid", archived: true, updatedTs: 9000 },
  { id: "cs-4", title: "陌生发起人", publisherUid: "left-the-group-uid", archived: false, updatedTs: 2000 },
];

describe("cloudSessionRows", () => {
  it("creatorLabel 从成员表查（查得到用label）", () => {
    const rows = cloudSessionRows(ROWS, WS);
    expect(rows.find((r) => r.id === "cs-1")!.creatorLabel).toBe("Stan");
    expect(rows.find((r) => r.id === "cs-2")!.creatorLabel).toBe("小明");
  });

  it("creatorLabel 查不到（已退群/从没入过群）回 uid 前 8 位——labelOf 同款回退", () => {
    const row = cloudSessionRows(ROWS, WS).find((r) => r.id === "cs-4")!;
    expect(row.creatorLabel).toBe("left-the");
  });

  it("archived 沉底：即使 updatedTs 更大，归档行也排在全部非归档行之后", () => {
    const ids = cloudSessionRows(ROWS, WS).map((r) => r.id);
    expect(ids.indexOf("cs-3")).toBe(ids.length - 1);
  });

  it("非归档内部按 updatedTs 降序", () => {
    const nonArchived = cloudSessionRows(ROWS, WS)
      .filter((r) => !r.archived)
      .map((r) => r.id);
    expect(nonArchived).toEqual(["cs-2", "cs-4", "cs-1"]);
  });

  it("字段原样透传（id/title/archived/updatedTs）", () => {
    const rows = cloudSessionRows([ROWS[0]!], WS);
    expect(rows).toEqual([
      { id: "cs-1", title: "会话一", creatorLabel: "Stan", archived: false, updatedTs: 1000 },
    ]);
  });

  it("空清单回空数组", () => {
    expect(cloudSessionRows([], WS)).toEqual([]);
  });
});
