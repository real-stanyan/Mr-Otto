import { describe, expect, it } from "vitest";
import { AGENT_AVATARS, agentAvatarSrc, avatarPreviewSrc } from "../../src/renderer/src/lib/agentAvatar.js";
import { agentAvatarSlot } from "../../src/renderer/src/lib/agentAvatarSlot.js";
import type { WorkspaceSnapshot, WorkspaceAgentRow } from "../../src/shared/workspaces.js";

function agent(agentId: string, avatarSlot: number | null): WorkspaceAgentRow {
  return {
    agentId, name: agentId, description: "", instructions: "",
    models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot,
  };
}
const ws = (agents: WorkspaceAgentRow[]): WorkspaceSnapshot =>
  ({ agents } as unknown as WorkspaceSnapshot);

describe("agentAvatarSrc（#1007：自己挑过的优先）", () => {
  it("挑过就用挑的那张", () => {
    expect(agentAvatarSrc(ws([agent("a_1", 3)]), "a_1")).toBe(AGENT_AVATARS[3]);
  });

  it("没挑过（null）走派生 —— 存量 agent 的脸一张都不变", () => {
    const roster = ["a_1", "a_2"];
    const snap = ws([agent("a_1", null), agent("a_2", null)]);
    expect(agentAvatarSrc(snap, "a_1")).toBe(AGENT_AVATARS[agentAvatarSlot("a_1", roster)]);
  });

  it("坑位越界退回派生，**不取模** —— 取模会安静映射到另一张脸，看起来像「他挑了这张」", () => {
    const snap = ws([agent("a_1", 999)]);
    expect(agentAvatarSrc(snap, "a_1")).toBe(AGENT_AVATARS[agentAvatarSlot("a_1", ["a_1"])]);
    // 取模的话会落在 999 % 13 = 11 那张上
    expect(agentAvatarSrc(snap, "a_1")).not.toBe(AGENT_AVATARS[999 % AGENT_AVATARS.length]);
  });

  it("负数同样退回派生（DB 约束挡得住，旧脏数据挡不住）", () => {
    expect(agentAvatarSrc(ws([agent("a_1", -1)]), "a_1")).toBe(AGENT_AVATARS[agentAvatarSlot("a_1", ["a_1"])]);
  });

  it("名单里没有这只（被删的 agent 在旧消息上还得有张脸）走派生，不炸", () => {
    expect(agentAvatarSrc(ws([agent("a_1", 3)]), "gone")).toBe(AGENT_AVATARS[agentAvatarSlot("gone", ["a_1"])]);
  });

  it("显式挑的那张不参与派生的顺延避让 —— 撞脸是用户自己挑的结果", () => {
    const derived = agentAvatarSlot("a_2", ["a_1", "a_2"]);
    const snap = ws([agent("a_1", derived), agent("a_2", null)]);
    expect(agentAvatarSrc(snap, "a_1")).toBe(agentAvatarSrc(snap, "a_2"));
  });
});

describe("avatarPreviewSrc（#1013：编辑弹窗那一格）", () => {
  it("挑过就画挑的那张（哪怕库里存的是别的——预览跟着手走，不跟着库走）", () => {
    const snap = ws([agent("a_1", 0)]);
    expect(avatarPreviewSrc(snap, "a_1", 5)).toBe(AGENT_AVATARS[5]);
  });

  it("编辑中没挑：画派生的那张", () => {
    const snap = ws([agent("a_1", null)]);
    expect(avatarPreviewSrc(snap, "a_1", null)).toBe(AGENT_AVATARS[agentAvatarSlot("a_1", ["a_1"])]);
  });

  it("新建且没挑：回 null —— agentId 还没铸出来，派生不出脸，随便挑一张顶上是撒谎", () => {
    expect(avatarPreviewSrc(ws([]), null, null)).toBeNull();
  });

  it("新建但挑过：照样画得出来（这一格不依赖 agentId）", () => {
    expect(avatarPreviewSrc(ws([]), null, 2)).toBe(AGENT_AVATARS[2]);
  });

  it("越界的 slot 走回派生 / null，不取模", () => {
    expect(avatarPreviewSrc(ws([agent("a_1", null)]), "a_1", 999))
      .toBe(AGENT_AVATARS[agentAvatarSlot("a_1", ["a_1"])]);
    expect(avatarPreviewSrc(ws([]), null, 999)).toBeNull();
  });
});
