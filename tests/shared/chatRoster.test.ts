import { describe, expect, it } from "vitest";
import type { ChatRosterChangedEvent, SessionEvent } from "../../src/session/events.js";
import {
  applyChatRosterEvent,
  chatRosterDiff,
  chatRosterOf,
  narrowRoster,
  normalizeChatAgentIds,
} from "../../src/shared/chatRoster.js";

let seq = 0;
const rosterEvent = (ids: string[]): ChatRosterChangedEvent => ({
  sessionId: "s",
  seq: seq++,
  ts: 1,
  type: "chat_roster_changed",
  agents: ids.map((id) => ({ agentId: id, name: id.toUpperCase() })),
  ignorable: true,
});
const chatter = (): SessionEvent =>
  ({ sessionId: "s", seq: seq++, ts: 1, type: "chat_message", fromUid: "u", text: "hi" }) as unknown as SessionEvent;

describe("chatRosterOf", () => {
  it("没有名单事件 = null（团队会话 / 存量日志：不收窄）", () => {
    expect(chatRosterOf([chatter(), chatter()])).toBeNull();
  });
  it("最新一条胜出，不是并集", () => {
    expect(
      chatRosterOf([rosterEvent(["admin", "a_000000000001"]), chatter(), rosterEvent(["a_000000000001"])]),
    ).toEqual(["a_000000000001"]);
  });
  it("空名单是一份真名单，不退回 null", () => {
    expect(chatRosterOf([rosterEvent(["admin"]), rosterEvent([])])).toEqual([]);
  });
  it("applyChatRosterEvent 对别的事件原样交回同一个引用", () => {
    const state = ["admin"] as const;
    expect(applyChatRosterEvent(state, chatter())).toBe(state);
  });
});

describe("narrowRoster", () => {
  const team = [
    { agentId: "admin", n: 0 },
    { agentId: "a_000000000001", n: 1 },
    { agentId: "a_000000000002", n: 2 },
  ];
  it("null = 整份名单，且交回的是一份拷贝", () => {
    const out = narrowRoster(team, null);
    expect(out).toEqual(team);
    expect(out).not.toBe(team);
  });
  it("按团队名单的顺序，不按聊天名单的顺序", () => {
    expect(narrowRoster(team, ["a_000000000002", "admin"]).map((a) => a.agentId)).toEqual([
      "admin",
      "a_000000000002",
    ]);
  });
  it("名单里已经不存在的 id 直接掉出去（删智能体断在半路时的兜底）", () => {
    expect(narrowRoster(team, ["a_00000000dead", "a_000000000001"]).map((a) => a.agentId)).toEqual([
      "a_000000000001",
    ]);
  });
});

describe("chatRosterDiff", () => {
  const e = (id: string) => ({ agentId: id, name: id.toUpperCase() });
  it("第一条（prev = null）两边都空：建聊天那一条不画", () => {
    expect(chatRosterDiff(null, [e("admin")])).toEqual({ joined: [], left: [] });
  });
  it("进来的取新名单里的名字，出去的取旧名单里的名字", () => {
    expect(chatRosterDiff([e("admin"), e("a_000000000001")], [e("admin"), e("a_000000000002")])).toEqual({
      joined: [e("a_000000000002")],
      left: [e("a_000000000001")],
    });
  });
});

describe("normalizeChatAgentIds", () => {
  it("去重、保序", () => {
    expect(normalizeChatAgentIds(["admin", "a_0123456789ab", "admin"], 1)).toEqual(["admin", "a_0123456789ab"]);
  });
  // 下限由调用方给（#1280 A4）：建聊天 ≥1、改名单 ≥0。空数组在两边是两个答案，
  // 这正是它不许有默认值的理由——默认值会让 chat_update 安静地继承 create 的下限
  it("空名单：建聊天拒、改名单收（移出最后一只）", () => {
    expect(normalizeChatAgentIds([], 1)).toBeNull();
    expect(normalizeChatAgentIds([], 0)).toEqual([]);
  });
  it("上限两边一样：第七只一律拒", () => {
    const seven = ["admin", "a_0123456789ab", "a_0123456789ac", "a_0123456789ad", "a_0123456789ae", "a_0123456789af", "a_0123456789b0"];
    expect(normalizeChatAgentIds(seven, 0)).toBeNull();
  });
  it.each([
    [null],
    ["admin"],
    [[]],
    [["ADMIN"]],
    [["a_123"]],
    [[1]],
    [
      [
        "a_0123456789ab",
        "a_0123456789ac",
        "a_0123456789ad",
        "a_0123456789ae",
        "a_0123456789af",
        "a_0123456789b0",
        "a_0123456789b1",
      ],
    ],
  ])("形状不对一律 null：%j", (raw) => {
    expect(normalizeChatAgentIds(raw, 1)).toBeNull();
  });
});
