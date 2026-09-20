// 花名册的纯逻辑（#1280）：第三栏画什么、按什么顺序、此刻进不进得去。
// 组件只管画，判据全在这里——同 workspaceAccess / billingView 的纪律。

import { describe, expect, it } from "vitest";
import { groupRows, homeOf, rosterGate, rosterRows, teamsOf } from "../../src/renderer/src/lib/agentRoster.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { CloudSessionListRow } from "../../src/renderer/src/lib/workspaceView.js";

const agent = (agentId: string, name: string) => ({
  agentId, name, description: `${name}的职责`, instructions: "", models: [], tools: [],
  createdBy: "me", updatedTs: 0, avatarSlot: null,
});

const ws = (id: string, kind: WorkspaceSnapshot["kind"], agents = [agent("admin", "管理员")]): WorkspaceSnapshot =>
  ({ id, name: id, ownerUid: "me", members: [], connectors: [], sessions: [], agents, sandboxApproval: null, kind }) as WorkspaceSnapshot;

const chat = (
  id: string,
  chatKind: CloudSessionListRow["chatKind"],
  agentIds: string[],
  updatedTs = 1,
  title = "",
): CloudSessionListRow => ({ id, title, publisherUid: "me", archived: false, updatedTs, participantUids: [], chatKind, agentIds });

describe("homeOf / teamsOf", () => {
  it("主场只认 kind === 'home'；读不到（null）与缺席都留在团队那一边，不许被藏起来", () => {
    const groups = [ws("t", "team"), ws("h", "home"), ws("x", null), ws("y", undefined)];
    expect(homeOf(groups)?.id).toBe("h");
    expect(teamsOf(groups).map((g) => g.id)).toEqual(["t", "x", "y"]);
  });

  it("一个主场都没有：null，团队原样列", () => {
    const groups = [ws("t", "team")];
    expect(homeOf(groups)).toBeNull();
    expect(teamsOf(groups).map((g) => g.id)).toEqual(["t"]);
  });
});

describe("rosterRows", () => {
  const home = ws("h", "home", [agent("admin", "管理员"), agent("a_1", "运营"), agent("a_2", "开发")]);

  it("顺序跟名册走（管理员恒在最上），不按最近活动排", () => {
    const rows = rosterRows(home, [chat("s2", "dm", ["a_2"], 99), chat("s1", "dm", ["a_1"], 5)]);
    expect(rows.map((r) => r.agentId)).toEqual(["admin", "a_1", "a_2"]);
    expect(rows.map((r) => r.sessionId)).toEqual([null, "s1", "s2"]);
    expect(rows[0]).toMatchObject({ isAdmin: true, description: "管理员的职责" });
  });

  it("没聊过的那只 sessionId 是 null、updatedTs 是 0（行上那格时间不画）", () => {
    expect(rosterRows(home, [])).toEqual([
      { agentId: "admin", name: "管理员", description: "管理员的职责", isAdmin: true, sessionId: null, updatedTs: 0 },
      { agentId: "a_1", name: "运营", description: "运营的职责", isAdmin: false, sessionId: null, updatedTs: 0 },
      { agentId: "a_2", name: "开发", description: "开发的职责", isAdmin: false, sessionId: null, updatedTs: 0 },
    ]);
  });

  it("团队会话与群聊不会被认成谁的私聊", () => {
    const rows = rosterRows(home, [chat("g", "group", ["a_1", "a_2"]), chat("t", null, [])]);
    expect(rows.every((r) => r.sessionId === null)).toBe(true);
  });

  it("名单里多于一只的「私聊」不认（库里那条唯一索引拦得住，这里是第二道）", () => {
    expect(rosterRows(home, [chat("weird", "dm", ["a_1", "a_2"])]).every((r) => r.sessionId === null)).toBe(true);
  });
});

describe("groupRows", () => {
  const home = ws("h", "home", [agent("admin", "管理员"), agent("a_1", "运营")]);

  it("群名取 title；名单与现存智能体求交集（删智能体断在半路时的兜底）；新的在前", () => {
    const rows = groupRows(home, [
      chat("g1", "group", ["a_1", "a_dead"], 1, "老群"),
      chat("g2", "group", ["admin", "a_1"], 9, "新群"),
    ]);
    expect(rows).toEqual([
      { sessionId: "g2", name: "新群", agentIds: ["admin", "a_1"], updatedTs: 9 },
      { sessionId: "g1", name: "老群", agentIds: ["a_1"], updatedTs: 1 },
    ]);
  });

  it("没起名的群用成员名顶上", () => {
    expect(groupRows(home, [chat("g", "group", ["admin", "a_1"])])[0]!.name).toBe("管理员、运营");
  });

  it("名单顺序跟名册走，不跟那一列的顺序走——同一个群在两台设备上不该是两个名字", () => {
    expect(groupRows(home, [chat("g", "group", ["a_1", "admin"])])[0]!.agentIds).toEqual(["admin", "a_1"]);
  });

  it("私聊与团队会话不进群列表", () => {
    expect(groupRows(home, [chat("d", "dm", ["a_1"]), chat("t", null, [])])).toEqual([]);
  });
});

describe("rosterGate", () => {
  const home = ws("h", "home");

  it.each([
    ["unknown", null, "idle", "unknown"],
    ["signed_out", null, "idle", "signed_out"],
    ["no_subscription", null, "idle", "no_subscription"],
    ["plan_too_low", null, "idle", "plan_too_low"],
    ["allowed", null, "idle", "ensuring"],
    ["allowed", null, "ensuring", "ensuring"],
    ["allowed", null, "failed", "failed"],
    ["allowed", home, "idle", "ready"],
  ] as const)("access=%s home=%s ensure=%s → %s", (access, h, ensure, want) => {
    expect(rosterGate({ access, home: h, ensure })).toBe(want);
  });

  it("已经有主场的人降了档：照样进得去（闸卡在建主场那一侧，不卡参与）", () => {
    expect(rosterGate({ access: "plan_too_low", home, ensure: "idle" })).toBe("ready");
    expect(rosterGate({ access: "no_subscription", home, ensure: "idle" })).toBe("ready");
  });

  it("还没查到订阅时不去建：unknown 不是「可以建」", () => {
    expect(rosterGate({ access: "unknown", home: null, ensure: "idle" })).toBe("unknown");
  });
});
