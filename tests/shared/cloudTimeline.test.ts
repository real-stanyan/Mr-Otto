import { describe, it, expect } from "vitest";
import { chatRosterLineParts, dispatchLineText, hiddenFromCloudTimeline, type RosterLinePart } from "../../src/shared/cloudTimeline.js";
import type { ChatRosterChangedEvent, SessionEvent, UserMessageEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

describe("hiddenFromCloudTimeline 第 ⑧ 条（#1213）", () => {
  it("自动命名藏起来——「会话被起了个名字」人不能据此行动，是机器的内务", () => {
    const e = { seq: 1, sessionId: "s", ts: 0, type: "session_autotitled", title: "x", model: "m" } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(true);
  });

  it("人说的话照旧画", () => {
    const e = { seq: 2, sessionId: "s", ts: 0, type: "chat_message", fromUid: "u1", label: "L", content: "hi", mention: false } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(false);
  });
});

// 名单那一行（#1280 A4）。这一条事件画不画**要看前一条**，所以它不在
// hiddenFromCloudTimeline 里（那是逐事件的纯谓词）——同渲染循环里 prevVoiceCall
// 那张表的手法。
describe("chatRosterLineParts（#1280）", () => {
  const ev = (seq: number, ids: [string, string][], byUid?: string) =>
    ({
      sessionId: "s", seq, ts: seq, type: "chat_roster_changed", ignorable: true,
      agents: ids.map(([agentId, name]) => ({ agentId, name })),
      ...(byUid === undefined ? {} : { byUid }),
    }) as ChatRosterChangedEvent;
  const text = (parts: RosterLinePart[] | null) => parts?.map((p) => p.text).join("") ?? null;

  it("建聊天那一条不画：它说的就是头部那排头像", () => {
    expect(chatRosterLineParts(null, ev(1, [["admin", "管理员"]]), "me")).toBeNull();
  });

  it("名单没变也不画（服务端只在真变了时才落，这是第二道）", () => {
    const a = ev(1, [["admin", "管理员"]]);
    expect(chatRosterLineParts(a, ev(2, [["admin", "管理员"]], "me"), "me")).toBeNull();
  });

  it("自己拉人 / 移人用第二人称；名字那一段带 agentId（头像插在它左边）", () => {
    const a = ev(1, [["admin", "管理员"]]);
    const b = ev(2, [["admin", "管理员"], ["a_1", "投放"]], "me");
    const parts = chatRosterLineParts(a, b, "me")!;
    expect(text(parts)).toBe("你把「投放」拉进了群聊");
    expect(parts.find((p) => p.agentId === "a_1")!.text).toBe("「投放」");
    expect(text(chatRosterLineParts(b, ev(3, [["admin", "管理员"]], "me"), "me")))
      .toBe("你把「投放」移出了群聊");
  });

  it("一次进几只、同时有进有出：一行说完", () => {
    const a = ev(1, [["admin", "管理员"], ["a_1", "运营"]]);
    const b = ev(2, [["admin", "管理员"], ["a_2", "开发"], ["a_3", "投放"]], "me");
    expect(text(chatRosterLineParts(a, b, "me")))
      .toBe("你把「开发」「投放」拉进了群聊，把「运营」移出了群聊");
  });

  // 名字取**旧名单里那一份**：这只可能已经被删了，新名单里查不到
  it("移出的那只用旧名单里的名字", () => {
    expect(text(chatRosterLineParts(ev(1, [["a_9", "已删的那只"]]), ev(2, [], "me"), "me")))
      .toBe("你把「已删的那只」移出了群聊");
  });

  // 个人主场里只有一个人，所以这一支只可能是旧日志或者一条不该存在的团队聊天。
  // 「有人」是「说不出是谁」时的老实话——编一个名字出来更坏
  it("不是我干的：退回「有人」，不编一个名字", () => {
    const a = ev(1, [["admin", "管理员"]]);
    expect(text(chatRosterLineParts(a, ev(2, [["admin", "管理员"], ["a_1", "投放"]], "别人"), "me")))
      .toBe("有人把「投放」拉进了群聊");
    expect(text(chatRosterLineParts(a, ev(2, [["admin", "管理员"], ["a_1", "投放"]]), "me")))
      .toBe("有人把「投放」拉进了群聊");
  });

  // A3 把它塞进那个谓词是为了「此刻一行都画不出来」；现在画得出来了，它必须出来，
  // 否则时间线上永远没有这一行——而且是安静地没有
  it("不在 hiddenFromCloudTimeline 里", () => {
    expect(hiddenFromCloudTimeline(ev(2, [["admin", "管理员"]], "me"))).toBe(false);
  });
});

// 派活那一句（#1356 A3，spec §5.6）：人没 @ 谁、runtime 按职责挑了谁接（ADR-0270），从 user_message.dispatch 投影
describe("dispatchLineText（#1356 A3）", () => {
  const agent = (agentId: string, name: string) => ({
    agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
  });
  const WS = {
    id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
    members: [], connectors: [], sessions: [],
    agents: [agent("admin", "管理员"), agent("a_000000000002", "运维"), agent("a_000000000003", "设计")],
  } as unknown as WorkspaceSnapshot;
  const um = (o: Record<string, unknown>) =>
    ({ seq: 1, sessionId: "s", ts: 0, type: "user_message", content: "[Stan]: 这版谁先发", fromUid: "me", ...o }) as UserMessageEvent;

  it("派出去了：「没 @ 谁 —— 运维接了」；几只一起接就顿号连起来", () => {
    expect(dispatchLineText(um({ mentions: ["a_000000000002"], dispatch: "auto" }), WS)).toBe("没 @ 谁 —— 运维接了");
    expect(dispatchLineText(um({ mentions: ["a_000000000002", "a_000000000003"], dispatch: "auto" }), WS))
      .toBe("没 @ 谁 —— 运维、设计接了");
  });
  it("人亲手 @ 的 / 没派出去（名单空）/ 旧日志没有这一格：不画", () => {
    expect(dispatchLineText(um({ mentions: ["a_000000000002"] }), WS)).toBeNull();
    expect(dispatchLineText(um({ mentions: [], dispatch: "auto" }), WS)).toBeNull();
    expect(dispatchLineText(um({}), WS)).toBeNull();
  });
  it("那只已经被删了：回 id（旧的一行上还得有个把手，同接力线）", () => {
    expect(dispatchLineText(um({ mentions: ["a_999999999999"], dispatch: "auto" }), WS)).toBe("没 @ 谁 —— a_999999999999接了");
  });
});
