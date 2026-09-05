import { describe, it, expect } from "vitest";
import { memoryDocs } from "../../src/renderer/src/lib/workspaceMemoryView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws = {
  id: "w1", name: "店", ownerUid: "o", members: [], connectors: [], sessions: [],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "o", updatedTs: 0 },
    { agentId: "ops", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "o", updatedTs: 0 },
  ],
} as unknown as WorkspaceSnapshot;

describe("memoryDocs（#949）", () => {
  it("共享档第一、名单顺序其次、已删 agent 的残留行最后标 stale；没行的 agent 也出一份空档", () => {
    const docs = memoryDocs(ws, [
      { agentId: "ops", content: "a\n§\nb", updatedTs: 1 },
      { agentId: "gone", content: "x", updatedTs: 1 },
      { agentId: "", content: "[运营] 口径", updatedTs: 1 },
    ]);
    expect(docs.map((d) => [d.agentId, d.title, d.tier, d.stale])).toEqual([
      ["", "共享档", "shared", false],
      ["admin", "管理员", "own", false],
      ["ops", "运营", "own", false],
      ["gone", "已删除的智能体 gone", "own", true],
    ]);
    expect(docs[0]).toMatchObject({ limit: 2200, used: 7 });
    expect(docs[2]).toMatchObject({ limit: 1100, used: 5, content: "a\n§\nb" });
    expect(docs[1]).toMatchObject({ content: "", used: 0 });
  });
});
