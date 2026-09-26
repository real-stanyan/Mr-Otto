// mobileChat —— 手机聊天页的纯逻辑（#1356 A1，spec §5.3）。藏哪些事件走桌面同一份
// hiddenFromCloudTimeline，这里只钉「留下来的那些画成哪一种行」。

import { describe, expect, it } from "vitest";
import { chatCentre, chatRows, clockLabel, liveRows, nowRowOf, resolveChatTarget } from "../../src/shared/mobileChat.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudSessionRow } from "../../src/shared/supabaseWorkspacesApi.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const WS: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "开发"), agent("a_000000000002", "运维")],
};
const DAY = new Date(2026, 8, 23, 10, 0).getTime();
let seq = 0;
const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "s1", ts: DAY, ...o }) as unknown as SessionEvent;

describe("chatRows", () => {
  it("我说的 / 它说的（按空行拆段）/ 日期分隔条", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "session_created" }),
        e({ type: "user_message", content: "[Stan]: 帮我看下排班", fromUid: "me", mentions: [] }),
        e({ type: "assistant_message", content: "国庆三个人两班倒。\n\n草表在 文件/排班.md", model: "m", agentId: "a_000000000001" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "mine", "agent"]);
    expect(rows[0]).toMatchObject({ kind: "day", label: "今天" });
    expect(rows[1]).toMatchObject({ kind: "mine", text: "帮我看下排班", ts: DAY });
    expect(rows[2]).toMatchObject({ kind: "agent", agentId: "a_000000000001", name: "开发", paragraphs: ["国庆三个人两班倒。", "草表在 文件/排班.md"] });
  });
  it("藏起来的一律不画：中间步骤、接力 / 招呼开场白、内务事件、压缩", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "assistant_message", content: "我先查一下", model: "m", agentId: "a_000000000001", toolCalls: [{ id: "c", name: "bash", args: {} }] }),
        e({ type: "user_message", content: "[系统]: …", fromUid: "me", relay: { depth: 1 } }),
        e({ type: "agent_briefed", agentId: "a_000000000001" }),
        e({ type: "context_compacted", agentId: "a_000000000001" }),
        e({ type: "turn_ended", outcome: "completed", agentId: "a_000000000001" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows).toEqual([]);
  });
  it("engine 旁白与系统发言画成旁白行；出错画成错误行（带原文）", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "chat_message", fromUid: "system", label: "系统", content: "没派出去（名单为空）", mention: false }),
        e({ type: "turn_ended", outcome: "error", error: "HTTP 500", agentId: "a_000000000002" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.slice(1)).toEqual([
      { kind: "note", key: "e0", ts: DAY, text: "没派出去（名单为空）", tone: "muted", detail: null },
      { kind: "note", key: "e1", ts: DAY, text: "「运维」这一轮出错", tone: "error", detail: "HTTP 500" },
    ]);
  });
  it("别人说的话（不是我）画成带名字的一行", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "chat_message", fromUid: "u2", label: "小红", content: "我也看看", mention: false })],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows[1]).toMatchObject({ kind: "human", name: "小红", text: "我也看看" });
  });
  it("跨天插分隔条，顺序跟日志走", () => {
    seq = 0;
    const yesterday = DAY - 24 * 3600 * 1000;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 昨天那句", fromUid: "me", ts: yesterday }),
        e({ type: "user_message", content: "[Stan]: 今天这句", fromUid: "me" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => (r.kind === "day" ? r.label : r.kind))).toEqual(["昨天", "mine", "今天", "mine"]);
  });
});

describe("liveRows", () => {
  it("正在写的那一段按空行拆、名字现查；空的不画", () => {
    const rows = liveRows({ streaming: { a_000000000001: "第一段\n\n第二段", a_000000000002: "  " }, ws: WS, now: DAY });
    expect(rows).toEqual([{ kind: "agent", key: "live-a_000000000001", ts: DAY, agentId: "a_000000000001", name: "开发", paragraphs: ["第一段", "第二段"] }]);
  });
});

describe("nowRowOf", () => {
  const opening = (agentId: string, s: number) =>
    ({ seq: s, sessionId: "s1", ts: DAY + s, type: "user_message", content: "[Stan]: 在吗", fromUid: "me", mentions: [agentId] }) as unknown as SessionEvent;
  const step = (agentId: string, s: number) =>
    ({ seq: s, sessionId: "s1", ts: DAY + s, type: "assistant_message", content: "", model: "m", agentId, toolCalls: [{ id: "c", name: "bash", args: {} }] }) as unknown as SessionEvent;

  it("没有欠着的回答 → null", () => {
    expect(nowRowOf({ events: [], streaming: {}, ws: WS })).toBeNull();
  });
  it("排队中：不能停；时间取开场白那条", () => {
    const now = nowRowOf({ events: [opening("a_000000000001", 3)], streaming: {}, ws: WS })!;
    expect(now).toMatchObject({ agentId: "a_000000000001", name: "开发", phase: "queued", face: "queued", canStop: false, ts: DAY + 3, seq: 3 });
  });
  it("在跑、一个字都还没有 = 执行中（能停）；正文在往下掉 = 作答中", () => {
    const events = [opening("a_000000000001", 3), step("a_000000000001", 4)];
    expect(nowRowOf({ events, streaming: {}, ws: WS })).toMatchObject({ phase: "working", face: "working", canStop: true });
    expect(nowRowOf({ events, streaming: { a_000000000001: "国庆" }, ws: WS })).toMatchObject({ phase: "solving", face: "solving", canStop: true });
  });
  it("好几只同时欠着：作答 > 执行 > 排队，同档取 seq 最小", () => {
    const events = [opening("a_000000000001", 3), opening("a_000000000002", 5), step("a_000000000002", 6)];
    // 运维在跑（执行中）压过开发的排队
    expect(nowRowOf({ events, streaming: {}, ws: WS })).toMatchObject({ agentId: "a_000000000002", phase: "working" });
    const both = [opening("a_000000000001", 3), step("a_000000000001", 4), opening("a_000000000002", 5), step("a_000000000002", 6)];
    expect(nowRowOf({ events: both, streaming: {}, ws: WS })).toMatchObject({ agentId: "a_000000000001", phase: "working" });
  });
});

describe("resolveChatTarget", () => {
  const chats: CloudSessionRow[] = [
    { id: "dm-dev", title: "", publisherUid: "me", archived: false, updatedTs: 1, participantUids: [], chatKind: "dm", agentIds: ["a_000000000001"] },
    { id: "g1", title: "", publisherUid: "me", archived: false, updatedTs: 1, participantUids: [], chatKind: "group", agentIds: ["a_000000000002", "a_000000000001", "a_gone00000000"] },
  ];
  it("单只：有私聊给 sessionId，没有给 null（草稿）", () => {
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_000000000001" })).toEqual({
      kind: "dm", sessionId: "dm-dev", agentIds: ["a_000000000001"], title: "开发", seed: { kind: "dm", agentIds: ["a_000000000001"] },
    });
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_000000000002" })).toMatchObject({ kind: "dm", sessionId: null, title: "运维" });
  });
  it("群：名单与现存名册求交集、顺序跟名册；没起名用成员名拼", () => {
    expect(resolveChatTarget(WS, chats, { kind: "group", sessionId: "g1" })).toEqual({
      kind: "group", sessionId: "g1", agentIds: ["a_000000000001", "a_000000000002"], title: "开发、运维",
      seed: { kind: "group", agentIds: ["a_000000000001", "a_000000000002"] },
    });
  });
  it("找不到（被删了）→ null", () => {
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_nope00000000" })).toBeNull();
    expect(resolveChatTarget(WS, chats, { kind: "group", sessionId: "nope" })).toBeNull();
  });
});

describe("clockLabel", () => {
  it("24 小时制、补零", () => {
    expect(clockLabel(new Date(2026, 8, 23, 9, 5).getTime())).toBe("09:05");
    expect(clockLabel(new Date(2026, 8, 23, 21, 40).getTime())).toBe("21:40");
  });
});

describe("chatCentre", () => {
  it.each<[string, Parameters<typeof chatCentre>[0], ReturnType<typeof chatCentre>]>([
    ["没有会话 + 私聊草稿 → 邀请开口", { session: null, draft: true, openFailed: false, rowCount: 0 }, "hello"],
    ["没有会话 + 进房失败（原因在底下那行）→ 什么都不画", { session: null, draft: false, openFailed: true, rowCount: 0 }, "blank"],
    ["没有会话、两样都没有 → 转圈", { session: null, draft: false, openFailed: false, rowCount: 0 }, "loading"],
    ["connecting、零事件 → 转圈", { session: { state: "connecting", eventCount: 0 }, draft: false, openFailed: false, rowCount: 0 }, "loading"],
    ["gone、零事件 → 转圈（还没拉到过就断了）", { session: { state: "gone", eventCount: 0 }, draft: false, openFailed: false, rowCount: 0 }, "loading"],
    ["ready、零事件、零行 → 邀请开口", { session: { state: "ready", eventCount: 0 }, draft: false, openFailed: false, rowCount: 0 }, "hello"],
    ["ready、有事件但全是藏起来的内务、零行 → 邀请开口", { session: { state: "ready", eventCount: 2 }, draft: false, openFailed: false, rowCount: 0 }, "hello"],
    ["ready、有画得出来的行 → 时间线", { session: { state: "ready", eventCount: 3 }, draft: false, openFailed: false, rowCount: 3 }, "timeline"],
    ["gone 但旧历史还在 → 时间线", { session: { state: "gone", eventCount: 3 }, draft: false, openFailed: false, rowCount: 3 }, "timeline"],
    ["denied、零事件 → 终态，中间不邀请开口", { session: { state: "denied", eventCount: 0 }, draft: false, openFailed: false, rowCount: 0 }, "blank"],
    ["denied、有内务事件但零行 → 仍是终态", { session: { state: "denied", eventCount: 2 }, draft: false, openFailed: false, rowCount: 0 }, "blank"],
    ["denied 但已有画得出来的历史 → 时间线", { session: { state: "denied", eventCount: 3 }, draft: false, openFailed: false, rowCount: 3 }, "timeline"],
  ])("%s", (_label, input, want) => {
    expect(chatCentre(input)).toBe(want);
  });
});

describe("群聊的两种行（#1356 A3，spec §5.6）", () => {
  const roster = (ids: [string, string][], byUid?: string): SessionEvent =>
    e({
      type: "chat_roster_changed", ignorable: true,
      agents: ids.map(([agentId, name]) => ({ agentId, name })),
      ...(byUid === undefined ? {} : { byUid }),
    });

  it("名单变了那一行：建群那一条不画，之后谁进谁出画成一行（名字那几格带 agentId，好画脸）", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        roster([["a_000000000001", "开发"], ["a_000000000002", "运维"]]),
        roster([["a_000000000001", "开发"]], "me"),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "roster"]);
    expect(rows[1]).toEqual({
      kind: "roster", key: "e1", ts: DAY,
      parts: [{ text: "你把" }, { text: "「运维」", agentId: "a_000000000002" }, { text: "移出了群聊" }],
    });
  });

  it("名单没变的那一条不画", () => {
    seq = 0;
    const rows = chatRows({
      events: [roster([["a_000000000001", "开发"]]), roster([["a_000000000001", "开发"]], "me")],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows).toEqual([]);
  });

  it("派活那一句排在那句话底下；人亲手 @ 的不画", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 这版谁先发", fromUid: "me", mentions: ["a_000000000002"], dispatch: "auto" }),
        e({ type: "user_message", content: "[Stan]: @开发 看下", fromUid: "me", mentions: ["a_000000000001"] }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.slice(1)).toEqual([
      { kind: "mine", key: "e0", ts: DAY, text: "这版谁先发" },
      { kind: "note", key: "dispatch-0", ts: DAY, text: "没 @ 谁 —— 运维接了", tone: "muted", detail: null },
      { kind: "mine", key: "e1", ts: DAY, text: "@开发 看下" },
    ]);
  });
});

describe("通话卡（#1356 A4，spec §5.7 / ADR-0288）", () => {
  const A = "a_000000000001";
  it("一场通话折成一张卡：卡在开场那条的位置，通话里说的话与它的回复不单独成行；第二行是我说的第一句", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 开电话之前", fromUid: "me", mentions: [] }),
        e({ type: "voice_call_changed", participants: [{ agentId: A, name: "开发" }], byUid: "me", ignorable: true }),
        e({ type: "user_message", content: "[Stan]: 帮我查下部署", fromUid: "me", voice: true }),
        e({ type: "assistant_message", content: "查好了，都是绿的。", model: "m", agentId: A }),
        e({ type: "voice_call_changed", participants: [], byUid: "me", ignorable: true }),
        e({ type: "user_message", content: "[Stan]: 挂了之后打的字", fromUid: "me", mentions: [] }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "mine", "call", "mine"]);
    const call = rows[2];
    expect(call).toMatchObject({ kind: "call", key: "call-1", topic: "帮我查下部署" });
    if (call?.kind !== "call") return;
    expect(call.card.utterances).toBe(2);
    expect(call.card.endedTs).toBe(DAY);
  });

  it("还开着的通话：卡照样画在开场的位置、endedTs 为 null", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "voice_call_changed", participants: [{ agentId: A, name: "开发" }], byUid: "me", ignorable: true }),
        e({ type: "assistant_message", content: "你好，我是开发。", model: "m", agentId: A }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "call"]);
    const call = rows[1];
    if (call?.kind !== "call") throw new Error("第二行应是通话卡");
    expect(call.card.endedTs).toBeNull();
    expect(call.topic).toBe("你好，我是开发。");
  });

  it("通话开着时，通话里那几只正在写的那一段不画（hide）——落下来就折进卡里，画了会一闪而过", () => {
    const rows = liveRows({ streaming: { a_000000000001: "正在说", a_000000000002: "别的" }, ws: WS, now: DAY, hide: new Set(["a_000000000001"]) });
    expect(rows.map((r) => r.key)).toEqual(["live-a_000000000002"]);
  });
});
