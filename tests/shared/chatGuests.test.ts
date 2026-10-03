// chatGuests —— 群里的客人（#1393，ADR-0325）：投影表查回来之后的纯拼装。
// 钉的是：客人那一侧拼出来的快照只够这一条群用、而且说「这是群主的主场」（审批只认群主）；
// 查不到的名字不编；最后一句那三格解析不出就当没有；群主那一侧把客人补进成员表只对这一条群有效。

import { describe, expect, it } from "vitest";
import {
  assembleGuestChat, guestAgentRow, guestsBySession, mixedGroupName, othersInGroup, parseSessionLast, personName, withGuests,
} from "../../src/shared/chatGuests.js";
import { isHomeWorkspace, type WorkspaceAgentRow, type WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const OWNER = "00000000-0000-4000-8000-0000000000ff";
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: OWNER, updatedTs: 0, avatarSlot: null,
});
const HOME: WorkspaceSnapshot = {
  id: "home", name: "我的智能体", ownerUid: OWNER, kind: "home", sandboxApproval: "ask",
  members: [{ uid: OWNER, role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "文案")],
};

describe("名字与投影行", () => {
  it("没起名 / 查不到：写 uid 前 8 位，不编名字", () => {
    expect(personName(U1, { name: "  小红 ", avatarUrl: "" })).toBe("小红");
    expect(personName(U1, { name: "", avatarUrl: "" })).toBe("00000000");
    expect(personName(U1, undefined)).toBe("00000000");
  });

  it("guestsBySession：按会话分、按加入先后、同一个人不站两次、形状不对的行丢掉", () => {
    const profiles = new Map([[U1, { name: "小红", avatarUrl: "data:x" }]]);
    const m = guestsBySession(
      [
        { session_id: "s1", uid: U1 },
        { session_id: "s1", uid: U2 },
        { session_id: "s1", uid: U1 },
        { session_id: "s2", uid: U2 },
        { session_id: 7, uid: U1 },
        { session_id: "s3", uid: null },
      ],
      profiles,
    );
    expect(m.get("s1")).toEqual([
      { uid: U1, name: "小红", avatarUrl: "data:x" },
      { uid: U2, name: "00000000", avatarUrl: "" },
    ]);
    expect(m.get("s2")).toEqual([{ uid: U2, name: "00000000", avatarUrl: "" }]);
    expect(m.has("s3")).toBe(false);
  });

  it("parseSessionLast：last_ts 空 / 解析不出 = 没有", () => {
    expect(parseSessionLast({ last_ts: "2026-09-28T01:02:03Z", last_excerpt: "好", last_from: `human:${U1}` })).toEqual({
      ts: Date.parse("2026-09-28T01:02:03Z"), excerpt: "好", from: `human:${U1}`,
    });
    expect(parseSessionLast({ last_ts: null })).toBeNull();
    expect(parseSessionLast({ last_ts: "不是时间" })).toBeNull();
  });

  it("guestAgentRow：只有四格是真的，提示词 / 型号 / 连接器一格都没有；头像坑位认不出就当没挑过", () => {
    expect(guestAgentRow({ agent_id: "a_1", name: "文案", description: "写稿", avatar_slot: 3 }, OWNER)).toEqual({
      agentId: "a_1", name: "文案", description: "写稿", instructions: "", models: [], tools: [], createdBy: OWNER, updatedTs: 0, avatarSlot: 3,
    });
    expect(guestAgentRow({ agent_id: "a_1", name: "文案", description: null, avatar_slot: -1 }, OWNER)?.avatarSlot).toBeNull();
    expect(guestAgentRow({ agent_id: 1, name: "文案", description: "", avatar_slot: null }, OWNER)).toBeNull();
  });
});

describe("assembleGuestChat（客人那一侧的一条群）", () => {
  const chat = assembleGuestChat({
    row: {
      id: "s1", workspace_id: "home-of-owner", publisher_uid: OWNER, title: "周末露营", archived: false,
      updated_at: "2026-09-28T00:00:00Z", agent_ids: ["a_1", "a_gone", "admin"],
      last_ts: "2026-09-28T01:00:00Z", last_excerpt: "几点出发", last_from: `human:${OWNER}`,
    },
    agents: [agent("admin", "管理员"), agent("a_1", "文案")],
    humans: [{ uid: U1, name: "小红", avatarUrl: "" }, { uid: U2, name: "小明", avatarUrl: "" }],
    owner: { uid: OWNER, name: "Stan", avatarUrl: "data:o" },
  });

  it("chat_kind = outreach 的行带 outreach 记号（#1441），普通群不带", () => {
    const mk = (kind?: string) => assembleGuestChat({
      row: { id: "s9", workspace_id: "w", publisher_uid: OWNER, title: "", archived: false, updated_at: "2026-09-28T00:00:00Z", agent_ids: ["a_1"], ...(kind !== undefined ? { chat_kind: kind } : {}) },
      agents: [agent("a_1", "文案")], humans: [{ uid: U1, name: "小红", avatarUrl: "" }], owner: { uid: OWNER, name: "Stan", avatarUrl: "" },
    });
    expect(mk("outreach").outreach).toBe(true);
    expect(mk("group").outreach).toBeUndefined();
    expect("outreach" in mk()).toBe(false);
  });

  it("快照说的是群主的主场：审批只有群主批得了（mobileChat 的 ownerOnly 读 kind）", () => {
    expect(isHomeWorkspace(chat.ws)).toBe(true);
    expect(chat.ws.ownerUid).toBe(OWNER);
    expect(chat.ws.id).toBe("home-of-owner");
  });

  it("成员 = 群主 + 客人；智能体 = 这条群里还在的那几只（名单里删掉了的不进来），顺序跟 RPC 的建的先后", () => {
    expect(chat.ws.members.map((m) => [m.uid, m.role, m.label])).toEqual([
      [OWNER, "owner", "Stan"],
      [U1, "member", "小红"],
      [U2, "member", "小明"],
    ]);
    expect(chat.session.agentIds).toEqual(["admin", "a_1"]);
    expect(chat.session.chatKind).toBe("group");
    expect(chat.session.humans?.map((h) => h.uid)).toEqual([U1, U2]);
    expect(chat.last?.excerpt).toBe("几点出发");
  });

  it("群主不会因为也在客人名单里而站两次", () => {
    const again = assembleGuestChat({
      row: { id: "s1", workspace_id: "w", publisher_uid: OWNER, title: "", archived: false, updated_at: "x" },
      agents: [],
      humans: [{ uid: OWNER, name: "Stan", avatarUrl: "" }, { uid: U1, name: "小红", avatarUrl: "" }],
      owner: { uid: OWNER, name: "Stan", avatarUrl: "" },
    });
    expect(again.ws.members.map((m) => m.uid)).toEqual([OWNER, U1]);
    expect(again.session.updatedTs).toBe(0);
  });

  it("othersInGroup：客人那一侧 = 群主 + 别的客人（不含我）", () => {
    expect(othersInGroup({ ws: chat.ws, humans: chat.session.humans ?? [], selfUid: U1, guestView: true }).map((p) => p.uid)).toEqual([OWNER, U2]);
  });
});

describe("群主那一侧", () => {
  it("withGuests：把客人补进这一条群用的成员表；没有客人时原样交回（同一个对象）", () => {
    const g = withGuests(HOME, [{ uid: U1, name: "小红", avatarUrl: "data:x" }]);
    expect(g.members.map((m) => [m.uid, m.label, m.avatarUrl])).toEqual([[OWNER, "Stan", ""], [U1, "小红", "data:x"]]);
    expect(HOME.members).toHaveLength(1);
    expect(withGuests(HOME, [])).toBe(HOME);
  });

  it("othersInGroup：群主那一侧 = 客人（不含我）", () => {
    expect(othersInGroup({ ws: HOME, humans: [{ uid: U1, name: "小红", avatarUrl: "" }], selfUid: OWNER, guestView: false }).map((p) => p.uid)).toEqual([U1]);
  });

  it("mixedGroupName：打了字用打的；没打按智能体（名册顺序）再朋友拼；只有朋友也拼得出", () => {
    expect(mixedGroupName(HOME, ["a_000000000001", "admin"], [{ name: "小红" }], "")).toBe("管理员、文案、小红");
    expect(mixedGroupName(HOME, [], [{ name: "小红" }, { name: "小明" }], "  ")).toBe("小红、小明");
    expect(mixedGroupName(HOME, ["admin"], [{ name: "小红" }], " 周末 ")).toBe("周末");
    expect(mixedGroupName(HOME, [], Array.from({ length: 30 }, (_, i) => ({ name: `朋友${i}` })), "").length).toBeLessThanOrEqual(60);
  });
});
