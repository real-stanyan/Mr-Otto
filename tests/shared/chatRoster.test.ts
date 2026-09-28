import { describe, expect, it } from "vitest";
import type { ChatRosterChangedEvent, SessionEvent } from "../../src/session/events.js";
import {
  applyChatRosterEvent,
  CHAT_HUMANS_MAX,
  chatHumansNow,
  chatHumansOf,
  humanRosterChangeProblem,
  normalizeChatHumanUids,
  chatRosterDiff,
  chatRosterNow,
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

// #1302：头部那排名字原来读 welcome 那份快照，改完名单一直是旧的
describe("chatRosterNow", () => {
  it("日志里有名单事件就它说了算，不看 welcome 那份快照", () => {
    const events = [chatter(), rosterEvent(["admin"]), chatter()];
    expect(chatRosterNow(events, ["admin", "a_0123456789ab"])).toEqual(["admin"]);
  });

  it("最后一条胜出（一条聊天里改了两次名单）", () => {
    const events = [rosterEvent(["admin", "a_0123456789ab"]), rosterEvent(["admin"]), rosterEvent(["admin", "a_0123456789ac"])];
    expect(chatRosterNow(events, ["admin"])).toEqual(["admin", "a_0123456789ac"]);
  });

  it("这一页一条名单事件都没有：退回快照，**不是** null", () => {
    // 进房只拉尾巴（A6），聊了半年的线上名单事件多半落在窗口外面。
    // 退回 null 的话 narrowRoster 不收窄 = 把一条私聊画成团队会话
    expect(chatRosterNow([chatter(), chatter()], ["a_0123456789ab"])).toEqual(["a_0123456789ab"]);
  });

  it("团队会话：两边都没有名单这回事 = null", () => {
    expect(chatRosterNow([chatter()], null)).toBeNull();
  });

  it("移空之后是空名单，不被当成「没改过」退回快照", () => {
    // `[] ?? fallback` 是 `[]`——这条用例钉的是这个区别：空群是合法终局（0037 的
    // CHECK 写的是 cardinality 0..6），退回快照会让最后一只永远摘不掉
    expect(chatRosterNow([rosterEvent([])], ["admin"])).toEqual([]);
  });
});

describe("群里的真人（#1393）", () => {
  const U1 = "00000000-0000-4000-8000-000000000001";
  const U2 = "00000000-0000-4000-8000-000000000002";
  const OWNER = "00000000-0000-4000-8000-0000000000ff";
  const withHumans = (humans?: { uid: string; name: string }[]): ChatRosterChangedEvent => ({
    ...rosterEvent(["admin"]),
    ...(humans ? { humans } : {}),
  });

  it("chatHumansOf：没有名单事件 = null；事件上缺席 = 没有别人；最新一条胜出", () => {
    expect(chatHumansOf([chatter()])).toBeNull();
    expect(chatHumansOf([withHumans()])).toEqual([]);
    expect(chatHumansOf([withHumans([{ uid: U1, name: "小红" }]), withHumans([{ uid: U2, name: "小明" }])])).toEqual([
      { uid: U2, name: "小明" },
    ]);
    // 「缺席」只有一个意思（没有别人），不是「这一条没改人」：之后每一条都带齐两份名单
    expect(chatHumansOf([withHumans([{ uid: U1, name: "小红" }]), withHumans()])).toEqual([]);
  });

  it("chatHumansNow：日志里一条名单事件都没加载到时退回快照（尾巴分页）", () => {
    expect(chatHumansNow([chatter()], [{ uid: U1, name: "小红" }])).toEqual([{ uid: U1, name: "小红" }]);
    expect(chatHumansNow([withHumans([])], [{ uid: U1, name: "小红" }])).toEqual([]);
  });

  it("normalizeChatHumanUids：去重保序、收成小写；形状不对 / 超上限一律 null", () => {
    expect(normalizeChatHumanUids([U1, U1.toUpperCase(), U2])).toEqual([U1, U2]);
    expect(normalizeChatHumanUids([])).toEqual([]);
    expect(normalizeChatHumanUids("x")).toBeNull();
    expect(normalizeChatHumanUids([U1, "not-a-uid"])).toBeNull();
    const many = Array.from({ length: CHAT_HUMANS_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(normalizeChatHumanUids(many)).toBeNull();
    expect(normalizeChatHumanUids(many.slice(0, CHAT_HUMANS_MAX))).toHaveLength(CHAT_HUMANS_MAX);
  });

  describe("humanRosterChangeProblem", () => {
    const base = { ownerUid: OWNER, friendsOfActor: new Set([U1, U2]) };
    it("群主：拉自己的朋友、移谁都行", () => {
      expect(humanRosterChangeProblem({ ...base, actorUid: OWNER, actorIsOwner: true, before: [U1], after: [U2] })).toBeNull();
    });
    it("拉进来的必须是动手那个人的朋友", () => {
      expect(
        humanRosterChangeProblem({ ...base, friendsOfActor: new Set(), actorUid: OWNER, actorIsOwner: true, before: [], after: [U1] }),
      ).toBe("只能拉你的朋友进群。");
    });
    it("群主不在客人名单里（他本来就在群里）", () => {
      expect(humanRosterChangeProblem({ ...base, actorUid: OWNER, actorIsOwner: true, before: [], after: [OWNER] })).toBe(
        "群主本来就在群里。",
      );
    });
    it("客人：能拉自己的朋友、能退出，移不走别人", () => {
      expect(
        humanRosterChangeProblem({ ...base, friendsOfActor: new Set([U2]), actorUid: U1, actorIsOwner: false, before: [U1], after: [U1, U2] }),
      ).toBeNull();
      expect(humanRosterChangeProblem({ ...base, actorUid: U1, actorIsOwner: false, before: [U1], after: [] })).toBeNull();
      expect(humanRosterChangeProblem({ ...base, actorUid: U1, actorIsOwner: false, before: [U1, U2], after: [U1] })).toBe(
        "只有群主能把别人移出群聊。",
      );
    });
    it("客人拉的人要是**他自己**的朋友（群主的朋友不算）", () => {
      expect(
        humanRosterChangeProblem({ ...base, friendsOfActor: new Set(), actorUid: U1, actorIsOwner: false, before: [U1], after: [U1, U2] }),
      ).toBe("只能拉你的朋友进群。");
    });
  });
});
