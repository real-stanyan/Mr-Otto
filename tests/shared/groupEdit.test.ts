// groupEdit —— 建群的勾选与群名、群设置里加 / 移之后的名单（#1356 A3，spec §5.6）。
// 手机建群页 / 群设置与桌面 NewGroupDialog / AddAgentPopover 共用这一份。

import { describe, expect, it } from "vitest";
import { CHAT_NAME_MAX } from "../../src/shared/chatRoster.js";
import {
  addChoice, clampChatName, groupNameFor, groupPick, pickLocked, rosterOrder, togglePick, withAgent, withoutAgent,
} from "../../src/shared/groupEdit.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const ws = (agents: WorkspaceAgentRow[]): WorkspaceSnapshot => ({
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [], connectors: [], sessions: [], agents,
});
const A1 = "a_000000000001";
const A2 = "a_000000000002";
const A3 = "a_000000000003";
const A4 = "a_000000000004";
const A5 = "a_000000000005";
const A6 = "a_000000000006";
const GONE = "a_999999999999";
const WS = ws([
  agent("admin", "管理员"), agent(A1, "开发"), agent(A2, "运维"), agent(A3, "设计"),
  agent(A4, "客服"), agent(A5, "财务"), agent(A6, "法务"),
]);

describe("rosterOrder", () => {
  it("顺序跟名册走、去重、名册里没有的丢掉", () => {
    expect(rosterOrder(WS, [A3, "admin", A3, GONE, A1])).toEqual(["admin", A1, A3]);
  });
});

describe("groupPick / pickLocked / togglePick", () => {
  it("不到两只「建」按不动；两只起按得动，名单按名册顺序", () => {
    expect(groupPick(WS, [A1]).enough).toBe(false);
    expect(groupPick(WS, [A2, A1])).toEqual({ ids: [A1, A2], full: false, enough: true });
  });
  it("满六只：没勾的那几只锁住，勾上的照样点得动（取消勾选永远开着）", () => {
    const six = ["admin", A1, A2, A3, A4, A5];
    const pick = groupPick(WS, six);
    expect(pick.full).toBe(true);
    expect(pickLocked(pick, A6)).toBe(true);
    expect(pickLocked(pick, A5)).toBe(false);
    expect(togglePick(WS, six, A6)).toEqual(six);
    expect(togglePick(WS, six, A5)).toEqual(["admin", A1, A2, A3, A4]);
  });
  it("没满时谁都点得动；勾上的按名册顺序排，不按点的先后", () => {
    expect(pickLocked(groupPick(WS, [A1]), A6)).toBe(false);
    expect(togglePick(WS, [A3], A1)).toEqual([A1, A3]);
    expect(togglePick(WS, [A1, A3], A1)).toEqual([A3]);
  });
});

describe("clampChatName", () => {
  it("上限以内原样", () => {
    const s = "字".repeat(CHAT_NAME_MAX);
    expect(clampChatName(s)).toBe(s);
  });
  it("超了：截到上限以内、末尾一个省略号", () => {
    const out = clampChatName("字".repeat(CHAT_NAME_MAX + 5));
    expect(out.length).toBe(CHAT_NAME_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
  it("按码点截：emoji（两个码元）不会被劈成半个代理对", () => {
    const smile = "\u{1F600}";
    expect(clampChatName("a".repeat(CHAT_NAME_MAX - 2) + smile + smile)).toBe(`${"a".repeat(CHAT_NAME_MAX - 2)}…`);
  });
});

describe("groupNameFor", () => {
  it("填了用填的（去掉首尾空白）", () => {
    expect(groupNameFor(WS, [A1, A2], "  发版组  ")).toBe("发版组");
  });
  it("没填用成员名按名册顺序拼（不按勾选顺序）", () => {
    expect(groupNameFor(WS, [A2, A1], "   ")).toBe("开发、运维");
  });
  it("拼出来超过协议上限：截到上限以内（超长的 create 帧会被整帧拒掉、白等 15 秒）", () => {
    const long = ws([
      agent(A1, "负责对账的财务专员一号"), agent(A2, "负责对账的财务专员二号"), agent(A3, "负责对账的财务专员三号"),
      agent(A4, "负责对账的财务专员四号"), agent(A5, "负责对账的财务专员五号"), agent(A6, "负责对账的财务专员六号"),
    ]);
    const out = groupNameFor(long, [A1, A2, A3, A4, A5, A6], "");
    expect(out.length).toBeLessThanOrEqual(CHAT_NAME_MAX);
    expect(out.startsWith("负责对账的财务专员一号、负责对账的财务专员二号")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("addChoice", () => {
  it("只列不在群里的（名册顺序）；还能加几只", () => {
    const c = addChoice(WS, [A2, "admin"]);
    expect(c.candidates.map((a) => a.agentId)).toEqual([A1, A3, A4, A5, A6]);
    expect(c.room).toBe(4);
    expect(c.reason).toBeNull();
  });
  it("满六只：说「群里已经有六只了」", () => {
    const c = addChoice(WS, ["admin", A1, A2, A3, A4, A5]);
    expect(c.room).toBe(0);
    expect(c.reason).toBe("群里已经有六只了");
  });
  it("名册里的都在群里了：说这一句（不是「满了」）", () => {
    const small = ws([agent("admin", "管理员"), agent(A1, "开发")]);
    expect(addChoice(small, ["admin", A1]).reason).toBe("名册里的智能体都在群里了");
  });
  it("名单里有已经被删的 id：不占名额（发出去的名单里也不会有它）", () => {
    expect(addChoice(WS, ["admin", GONE]).room).toBe(5);
  });
});

describe("withAgent / withoutAgent", () => {
  it("加一只 = 变动之后的完整名单、名册顺序（chat_update 收名单，不收「加了谁」）", () => {
    expect(withAgent(WS, [A3, "admin"], A1)).toEqual(["admin", A1, A3]);
  });
  it("移出一只；可以移到空（空群合法）", () => {
    expect(withoutAgent(WS, [A1, A3], A1)).toEqual([A3]);
    expect(withoutAgent(WS, [A3], A3)).toEqual([]);
  });
  it("顺手把已经被删的 id 清掉", () => {
    expect(withoutAgent(WS, [A1, GONE, A3], A1)).toEqual([A3]);
  });
});
