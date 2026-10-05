// groupSeatsView —— 手机画座位制的群（#1682，ADR-0376）：管理员补进快照、@ 怎么认、名单那一行、点头卡那一行。
// 时间线上的接线（chatRows / liveRows 认 seat:<uid>）也钉在这里：它们靠的就是 withSeats 补进去的那几只。

import { describe, expect, it } from "vitest";
import { agentFaceIfKnown } from "../../src/shared/agentAvatar.js";
import { seatAgentId, seatCardsOf, type GroupSeat } from "../../src/shared/groupSeats.js";
import {
  knownSeats, seatCardView, seatHandleOf, seatMentionCandidates, seatMentionEntries, seatNotesOf, seatRosterLineParts, seatWorkerTag,
  withSeats, WORKER_PREVIEW_MAX, workerFoldText, workerPreview,
} from "../../src/shared/groupSeatsView.js";
import { chatRows, liveRows } from "../../src/shared/mobileChat.js";
import { parseMemberMentions, parseMentions } from "../../src/shared/remote/agentMention.js";
import type { ChatRosterChangedEvent, SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [], agents: [],
};
const SEATS: GroupSeat[] = [
  { uid: "me", name: "Stan", agentName: "管理员" },
  { uid: "u2", name: "继爸", agentName: "雨姐" },
  { uid: "u3", name: "阿峰", agentName: "管理员", policy: "open" },
];
const DAY = new Date(2026, 9, 5, 10, 0).getTime();
let seq = 0;
const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "g1", ts: DAY, ...o }) as unknown as SessionEvent;
const roster = (o: Partial<ChatRosterChangedEvent>): ChatRosterChangedEvent =>
  ({ seq: seq++, sessionId: "g1", ts: DAY, type: "chat_roster_changed", agents: [], ignorable: true, ...o }) as ChatRosterChangedEvent;

describe("withSeats", () => {
  it("每个座位补成一只智能体：id seat:<uid>、名字「雨姐（继爸的管理员）」，有脸（与人的首字头像分得开）", () => {
    const ws = withSeats(WS, SEATS);
    expect(ws.agents.map((a) => [a.agentId, a.name])).toEqual([
      ["seat:me", "管理员（Stan的管理员）"],
      ["seat:u2", "雨姐（继爸的管理员）"],
      ["seat:u3", "管理员（阿峰的管理员）"],
    ]);
    expect(agentFaceIfKnown(ws, "seat:u2")).not.toBeNull();
    expect(withSeats(WS, [])).toBe(WS);
  });
});

describe("knownSeats", () => {
  it("此刻的座位在前；走了的人从名单事件 / 点头卡里补回来——老回话的名字还画得出", () => {
    seq = 0;
    const events = [
      e({ type: "seat_request", requestId: "r0", seatUid: "u9", ownerName: "老王", agentName: "小助", fromUid: "me", fromName: "Stan", ask: "", summary: "", expiresTs: 0, ignorable: true }),
      roster({ seats: [...SEATS, { uid: "u4", name: "小红", agentName: "红管" }] }),
      roster({ seats: SEATS }),
    ];
    expect(knownSeats(events, SEATS).map((s) => s.uid)).toEqual(["me", "u2", "u3", "u9", "u4"]);
    expect(knownSeats([], null)).toEqual([]);
  });
});

describe("@ 座位", () => {
  it("handle 撞名带上主人；两种写法都指向 seat:<uid>；「继爸的管理员」不把继爸本人也算进提醒", () => {
    const cands = seatMentionCandidates(SEATS);
    expect(cands).toContainEqual({ agentId: "seat:u2", name: "雨姐" });
    expect(cands).toContainEqual({ agentId: "seat:u3", name: "管理员·阿峰" });
    expect(cands).toContainEqual({ agentId: "seat:u2", name: "继爸的管理员" });
    expect(parseMentions("@管理员·阿峰 帮我查下 @雨姐", cands)).toEqual(["seat:u3", "seat:u2"]);
    const people = [{ agentId: "u2", name: "继爸" }, { agentId: "u3", name: "阿峰" }];
    expect(parseMentions("@继爸的管理员 看下", cands)).toEqual(["seat:u2"]);
    expect(parseMemberMentions("@继爸的管理员 看下", cands, people)).toEqual([]);
    expect(parseMemberMentions("@继爸 你看下", cands, people)).toEqual(["u2"]);
  });
  it("选人抽屉：插 handle，旁边写是谁的管理员，自己的写「我的管理员」", () => {
    expect(seatMentionEntries(SEATS, "me")).toEqual([
      { uid: "me", agentId: "seat:me", handle: "管理员·Stan", tag: "我的管理员" },
      { uid: "u2", agentId: "seat:u2", handle: "雨姐", tag: "继爸的管理员" },
      { uid: "u3", agentId: "seat:u3", handle: "管理员·阿峰", tag: "阿峰的管理员" },
    ]);
  });
  it("长按头像：在座的给 handle；人走了、不是座位 id 回 null", () => {
    expect(seatHandleOf(seatAgentId("u2"), SEATS)).toBe("雨姐");
    expect(seatHandleOf(seatAgentId("u9"), SEATS)).toBeNull();
    expect(seatHandleOf("admin", SEATS)).toBeNull();
  });
});

describe("seatRosterLineParts", () => {
  const text = (p: { text: string }[] | null): string | null => (p === null ? null : p.map((x) => x.text).join(""));
  it("拉人 / 移人按座位比；第一条（没有前一条）与旧群升级那一条不画；只改策略不画", () => {
    seq = 0;
    const a = roster({ seats: SEATS.slice(0, 2) });
    const b = roster({ seats: SEATS, byUid: "u2", byName: "继爸" });
    expect(text(seatRosterLineParts(null, a, "me", "me"))).toBeNull();
    expect(text(seatRosterLineParts(roster({ humans: [{ uid: "u2", name: "继爸" }] }), a, "me", "me"))).toBeNull();
    expect(text(seatRosterLineParts(a, b, "me", "me"))).toBe("继爸把阿峰拉进了群聊");
    expect(text(seatRosterLineParts(b, roster({ seats: SEATS.slice(0, 2), byUid: "me" }), "me", "me"))).toBe("你把阿峰移出了群聊");
    expect(text(seatRosterLineParts(b, roster({ seats: SEATS.map((s) => ({ ...s, policy: "open" as const })), byUid: "u2" }), "me", "me"))).toBeNull();
  });
  it("自己退群单独说；群主退群 = 退出了 + 谁成了群主（humans 那一份会把这一下读成「把新群主移出了」）", () => {
    seq = 0;
    const before = roster({ seats: SEATS });
    const after = roster({ seats: SEATS.slice(1), groupOwnerUid: "u2", byUid: "me" });
    expect(text(seatRosterLineParts(before, after, "u3", "me"))).toBe("Stan退出了群聊，继爸成了群主");
    expect(text(seatRosterLineParts(before, after, "u2", "me"))).toBe("Stan退出了群聊，你成了群主");
    expect(text(seatRosterLineParts(before, after, "me", "me"))).toBe("你退出了群聊，继爸成了群主");
  });
});

describe("点头卡", () => {
  const req = (o: Record<string, unknown> = {}): SessionEvent =>
    e({
      type: "seat_request", requestId: "r1", seatUid: "u2", ownerName: "继爸", agentName: "雨姐", fromUid: "me", fromName: "Stan",
      ask: "帮我把周报发给老板", summary: "用邮件发周报给老板", expiresTs: DAY + 600_000, ignorable: true, ...o,
    });
  it("seatCardView：主人看到按钮，别人看到等谁点头；结局三档", () => {
    seq = 0;
    const card = seatCardsOf([req()]).get("r1")!;
    expect(seatCardView(card, "pending", "u2")).toEqual({ headline: "Stan 想让雨姐动手：用邮件发周报给老板", ask: "帮我把周报发给老板", status: null, canDecide: true, note: null });
    expect(seatCardView(card, "pending", "me")).toMatchObject({ headline: "你 想让雨姐动手：用邮件发周报给老板", status: "等 继爸 点头", canDecide: false });
    expect(seatCardView(card, "accepted", "u2")).toMatchObject({ status: "已接", canDecide: false });
    expect(seatCardView(card, "declined", "me").status).toBe("没同意");
    expect(seatCardView(card, "expired", "me").status).toBe("没回");
  });
  it("seatCardView：附言定了才画，人人看得见；主人自己看写「你」；空白 / 还开着不画", () => {
    seq = 0;
    const card = seatCardsOf([req()]).get("r1")!;
    expect(seatCardView(card, "declined", "me", " 只告诉他周五 ").note).toBe("继爸：「只告诉他周五」");
    expect(seatCardView(card, "accepted", "u2", "只告诉他周五").note).toBe("你：「只告诉他周五」");
    expect(seatCardView(card, "accepted", "me", "  ").note).toBeNull();
    expect(seatCardView(card, "accepted", "me").note).toBeNull();
    expect(seatCardView(card, "pending", "me", "只告诉他周五").note).toBeNull();
  });
  it("seatNotesOf：只认定了那张卡的第一条结局；没附 / 请求不在窗口里的不进表", () => {
    seq = 0;
    const dec = (o: Record<string, unknown>): SessionEvent => e({ type: "seat_decision", seatUid: "u2", byUid: "u2", ignorable: true, ...o });
    const notes = seatNotesOf([
      dec({ requestId: "r0", decision: "accepted", note: "窗口外" }),
      req(),
      req({ requestId: "r2" }),
      dec({ requestId: "r1", decision: "declined", note: " 那天我上班 " }),
      dec({ requestId: "r1", decision: "accepted", note: "后来的不算" }),
      dec({ requestId: "r2", decision: "accepted" }),
    ]);
    expect([...notes]).toEqual([["r1", "那天我上班"]]);
  });
  it("chatRows：一张卡一行在请求的位置，结局只改状态不占行；过了点按过期画、按钮收起", () => {
    seq = 0;
    const ws = withSeats(WS, SEATS);
    const open = chatRows({ events: [req()], ws, selfUid: "u2", now: DAY }).filter((r) => r.kind !== "time");
    expect(open).toEqual([expect.objectContaining({ kind: "seat_card", requestId: "r1", state: "pending", canDecide: true, status: null })]);
    seq = 0;
    const decided = chatRows({
      events: [req(), e({ type: "seat_decision", requestId: "r1", seatUid: "u2", decision: "accepted", byUid: "u2", ignorable: true })],
      ws, selfUid: "me", now: DAY,
    }).filter((r) => r.kind !== "time");
    expect(decided).toEqual([expect.objectContaining({ kind: "seat_card", state: "accepted", status: "已接" })]);
    seq = 0;
    const late = chatRows({ events: [req()], ws, selfUid: "u2", now: DAY + 600_001 }).filter((r) => r.kind !== "time");
    expect(late).toEqual([expect.objectContaining({ kind: "seat_card", state: "expired", canDecide: false, status: "没回" })]);
  });
  it("chatRows：主人附的一句画在卡上（结局那条仍不占行）", () => {
    seq = 0;
    const ws = withSeats(WS, SEATS);
    const rows = chatRows({
      events: [req(), e({ type: "seat_decision", requestId: "r1", seatUid: "u2", decision: "declined", byUid: "u2", note: "告诉她我那天上班", ignorable: true })],
      ws, selfUid: "me", now: DAY,
    }).filter((r) => r.kind !== "time");
    expect(rows).toEqual([expect.objectContaining({ kind: "seat_card", state: "declined", status: "没同意", note: "继爸：「告诉她我那天上班」" })]);
  });
});

describe("时间线认 seat:<uid>", () => {
  it("管理员的回话与流式那一段都画成「雨姐（继爸的管理员）」，不丢、不画成一串 id", () => {
    seq = 0;
    const ws = withSeats(WS, SEATS);
    const rows = chatRows({
      events: [e({ type: "assistant_message", content: "我看看。", model: "m", agentId: "seat:u2" })],
      ws, selfUid: "me", now: DAY,
    }).filter((r) => r.kind !== "time");
    expect(rows).toEqual([expect.objectContaining({ kind: "agent", agentId: "seat:u2", name: "雨姐（继爸的管理员）" })]);
    expect(liveRows({ streaming: { "seat:u3": "在查" }, ws, now: DAY })).toEqual([
      expect.objectContaining({ kind: "agent", agentId: "seat:u3", name: "管理员（阿峰的管理员）", paragraphs: ["在查"] }),
    ]);
  });
  it("座位制的名单事件走座位那一份（群主换手不读成「移出」）", () => {
    seq = 0;
    const rows = chatRows({
      events: [roster({ seats: SEATS, humans: [{ uid: "u2", name: "继爸" }, { uid: "u3", name: "阿峰" }] }), roster({ seats: SEATS.slice(1), humans: [{ uid: "u3", name: "阿峰" }], groupOwnerUid: "u2", byUid: "me" })],
      ws: withSeats(WS, SEATS), selfUid: "u3", now: DAY, ownerUid: "me",
    }).filter((r) => r.kind === "roster");
    expect(rows.map((r) => (r.kind === "roster" ? r.parts.map((p) => p.text).join("") : ""))).toEqual(["Stan退出了群聊，继爸成了群主"]);
  });
});

describe("专员（L1）的话（#1682）", () => {
  const worker = (agentId: string, name: string, content: string, o: Record<string, unknown> = {}): SessionEvent =>
    e({ type: "assistant_message", content, model: "m", agentId, worker: { agentId: `a_${name}`, name }, ...o });
  const admin = (agentId: string, content: string): SessionEvent => e({ type: "assistant_message", content, model: "m", agentId });
  const ws = withSeats(WS, SEATS);
  const rowsOf = (events: SessionEvent[], selfUid = "me", seats: GroupSeat[] | undefined = SEATS) =>
    chatRows({ events, ws, selfUid, now: DAY, ...(seats !== undefined ? { seats } : {}) }).filter((r) => r.kind !== "time");

  it("折成一行小字，不画成那家管理员的气泡；署名「Nomad（继爸的专员）· 第一行」，全文点开看", () => {
    seq = 0;
    const rows = rowsOf([worker("seat:u2", "Nomad", "先查航班\n再订酒店")]);
    expect(rows).toEqual([{
      kind: "worker", key: "worker-0", ts: DAY, seatAgentId: "seat:u2", tag: "继爸的专员",
      summary: "Nomad（继爸的专员）· 先查航班", lines: [{ name: "Nomad", text: "先查航班\n再订酒店" }],
    }]);
    expect(rows.some((r) => r.kind === "agent")).toBe(false);
  });

  it("同一家连着说的并成一行（中间夹不画的事件也算连着），key 不随后来的几句变；管理员开口 / 换一家就断开", () => {
    seq = 0;
    const rows = rowsOf([
      worker("seat:u2", "Nomad", "第一句"),
      e({ type: "tool_result", toolCallId: "c1", status: "ok", content: "" }),
      worker("seat:u2", "Nomad", "第二句"),
      worker("seat:u2", "Nomad", "第三句"),
      admin("seat:u2", "办好了。"),
      worker("seat:u2", "Nomad", "收尾"),
      worker("seat:u3", "Scout", "我这边也查了"),
    ]);
    expect(rows.map((r) => [r.kind, r.key, r.kind === "worker" ? r.summary : ""])).toEqual([
      ["worker", "worker-0", "Nomad（继爸的专员）说了 3 句"],
      ["agent", "e4", ""],
      ["worker", "worker-5", "Nomad（继爸的专员）· 收尾"],
      ["worker", "worker-6", "Scout（阿峰的专员）· 我这边也查了"],
    ]);
    expect(rows[0]!.kind === "worker" ? rows[0]!.lines.map((l) => l.text) : []).toEqual(["第一句", "第二句", "第三句"]);
  });

  it("几只专员轮着说：写「继爸的专员说了 N 句」，每句是谁点开看", () => {
    seq = 0;
    const rows = rowsOf([worker("seat:u2", "Nomad", "查航班"), worker("seat:u2", "Atlas", "查酒店")]);
    expect(rows).toEqual([expect.objectContaining({ summary: "继爸的专员说了 2 句", lines: [{ name: "Nomad", text: "查航班" }, { name: "Atlas", text: "查酒店" }] })]);
  });

  it("中间步骤（要了工具 / 空正文）不画；我家的写「我的专员」；没给座位从日志现折，查不到只写「专员」", () => {
    seq = 0;
    expect(rowsOf([
      worker("seat:u2", "Nomad", "我先跑一下", { toolCalls: [{ id: "c1", name: "bash", args: {} }] }),
      worker("seat:u2", "Nomad", "  "),
    ])).toEqual([]);
    seq = 0;
    expect(rowsOf([worker("seat:me", "Nomad", "好")])).toEqual([expect.objectContaining({ tag: "我的专员", summary: "Nomad（我的专员）· 好" })]);
    seq = 0;
    expect(rowsOf([roster({ seats: SEATS }), worker("seat:u3", "Scout", "好")], "me", undefined).filter((r) => r.kind === "worker"))
      .toEqual([expect.objectContaining({ tag: "阿峰的专员" })]);
    seq = 0;
    expect(rowsOf([worker("seat:u9", "Scout", "好")], "me", undefined)).toEqual([expect.objectContaining({ tag: "专员", summary: "Scout（专员）· 好" })]);
  });

  it("seatWorkerTag / workerPreview / workerFoldText", () => {
    expect(seatWorkerTag("seat:u2", SEATS, "me")).toBe("继爸的专员");
    expect(seatWorkerTag("seat:me", SEATS, "me")).toBe("我的专员");
    expect(seatWorkerTag("a_1", SEATS, "me")).toBe("专员");
    expect(workerPreview("\n  先查   航班 \n再订")).toBe("先查 航班");
    const long = "查".repeat(WORKER_PREVIEW_MAX + 5);
    expect(Array.from(workerPreview(long))).toHaveLength(WORKER_PREVIEW_MAX);
    expect(workerPreview(long).endsWith("…")).toBe(true);
    expect(Array.from(workerPreview("😀".repeat(WORKER_PREVIEW_MAX + 1)))).toHaveLength(WORKER_PREVIEW_MAX);
    expect(workerFoldText([], "专员")).toBe("");
  });
});
