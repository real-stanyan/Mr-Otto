import { describe, it, expect } from "vitest";
import {
  filterMentionRows,
  memberShadowedBy,
  mentionRows,
  MENTION_KIND_LABEL,
} from "../../src/renderer/src/lib/workspaceMentionItems.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

function agent(agentId: string, name: string, description = ""): WorkspaceSnapshot["agents"][number] {
  return {
    agentId, name, description, instructions: "", models: [], tools: [],
    createdBy: "u-owner", updatedTs: 0, avatarSlot: null,
  };
}
function member(uid: string, label: string, avatarUrl = ""): WorkspaceSnapshot["members"][number] {
  return { uid, role: "member", label, avatarUrl };
}
function ws(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: "w1", name: "群", ownerUid: "u-owner",
    members: [], connectors: [], sessions: [], agents: [], sandboxApproval: "ask",
    ...over,
  };
}

describe("mentionRows", () => {
  it("agent 在前、成员在后，各自保持快照顺序（默认高亮落在会接话的那一族）", () => {
    const rows = mentionRows(ws({
      agents: [agent("admin", "管理员"), agent("a2", "运营")],
      members: [member("u-1", "张三"), member("u-2", "李四")],
    }));
    expect(rows.map((r) => r.name)).toEqual(["管理员", "运营", "张三", "李四"]);
    expect(rows.map((r) => r.kind)).toEqual(["agent", "agent", "member", "member"]);
  });

  it("agent 带 agentId + 职责；成员带 avatarUrl，agentId 恒为 null（uid 永远不进 mentions）", () => {
    const rows = mentionRows(ws({
      agents: [agent("a2", "运营", "管店铺")],
      members: [member("u-1", "张三", "https://x/a.png")],
    }));
    expect(rows[0]).toMatchObject({ key: "agent:a2", agentId: "a2", detail: "管店铺", avatarUrl: "" });
    expect(rows[1]).toMatchObject({ key: "member:u-1", agentId: null, detail: "", avatarUrl: "https://x/a.png" });
  });

  it("成员被同名 agent 抢走时说出口 —— 不标的话点了写着「成员」的那行，回话的却是一只 agent", () => {
    const rows = mentionRows(ws({
      agents: [agent("a2", "运营")],
      members: [member("u-1", "运营"), member("u-2", "运营助理")],
    }));
    // 完全同名，以及"以 agent 名字开头"（parseMentions 最长匹配吃掉前缀就收工）
    expect(rows.find((r) => r.key === "member:u-1")?.detail).toBe("@ 会点到智能体「运营」");
    expect(rows.find((r) => r.key === "member:u-2")?.detail).toBe("@ 会点到智能体「运营」");
  });

  it("两个成员显示名一样 —— 补 uid 前缀，两行不再长得一模一样", () => {
    const a = "aaaaaaaa-1111", b = "bbbbbbbb-2222";
    const rows = mentionRows(ws({ members: [member(a, "张三"), member(b, "张三")] }));
    expect(rows.map((r) => r.detail)).toEqual([a.slice(0, 8), b.slice(0, 8)]);
    expect(rows[0]!.detail).not.toBe(rows[1]!.detail); // 这条才是这一格存在的理由
  });

  it("撞名优先于重名：会被抢走这件事更该占那一格", () => {
    const rows = mentionRows(ws({
      agents: [agent("a2", "运营")],
      members: [member("u-1", "运营"), member("u-2", "运营")],
    }));
    expect(rows.filter((r) => r.kind === "member").map((r) => r.detail)).toEqual([
      "@ 会点到智能体「运营」",
      "@ 会点到智能体「运营」",
    ]);
  });

  it("自己也在名单里 —— 一份名单一条判据（摘掉自己就要维护第二份，而 resolveSendMentions 那份必须含自己）", () => {
    const rows = mentionRows(ws({ ownerUid: "u-me", members: [member("u-me", "我")] }));
    expect(rows.map((r) => r.key)).toEqual(["member:u-me"]);
  });
});

describe("memberShadowedBy", () => {
  it("同名、以及以 agent 名字开头 —— 都会被抢走", () => {
    expect(memberShadowedBy("运营", ["运营"])).toBe("运营");
    expect(memberShadowedBy("运营助理", ["运营"])).toBe("运营");
  });
  it("反方向不成立：成员名字是 agent 名字的前缀时，那句 @ 谁都没点到（正常状态，不报警）", () => {
    expect(memberShadowedBy("运", ["运营"])).toBeNull();
  });
  it("空的 agent 名字不参与（防御 DB 脏值，否则 startsWith('') 恒真、人人都被标成撞名）", () => {
    expect(memberShadowedBy("张三", [""])).toBeNull();
  });
});

describe("filterMentionRows", () => {
  const rows = mentionRows(ws({
    agents: [agent("admin", "管理员"), agent("a2", "运营", "管店铺"), agent("a3", "Ads", "投放")],
    members: [member("u-1", "张三")],
  }));
  it("空串 = 全部（刚打完 @ 那一刻要看到全部候选）", () => {
    expect(filterMentionRows(rows, "")).toHaveLength(4);
  });
  it("名字或中间那格灰字命中即可，大小写不敏感", () => {
    expect(filterMentionRows(rows, "店").map((r) => r.name)).toEqual(["运营"]);
    expect(filterMentionRows(rows, "ads").map((r) => r.name)).toEqual(["Ads"]);
    expect(filterMentionRows(rows, "张").map((r) => r.name)).toEqual(["张三"]);
  });
  it("右边那格标注也搜得出来 —— 行上写着的字必须都认（同 friendMentionItems 那条纪律）", () => {
    expect(filterMentionRows(rows, MENTION_KIND_LABEL.member).map((r) => r.name)).toEqual(["张三"]);
    expect(filterMentionRows(rows, MENTION_KIND_LABEL.agent).map((r) => r.kind)).toEqual(["agent", "agent", "agent"]);
  });
});
