// 一场通话折成一张卡的**判据**（#1233，ADR-0288）。
//
// 这个文件钉的是「哪几条进卡、哪几条留在时间线上」——ADR-0288 决策 1 的全部内容。
// 卡长什么样在 tests/renderer/voiceCallCard.test.tsx（真渲染一遍）。
//
// 最要紧的一条：**判据不是 seq 区间**。按区间吞是零 schema 改动的纯投影，但云会话
// 是群聊，通话期间没在通话里的人打的字会被吞进一张他没参与的通话卡——而这条 issue
// 修的正是「不该进时间线的东西进了时间线」。下面那条「旁人打的字留在时间线上」就是
// 这个决定的可执行版：把 `voice` 那道判据换成区间判据，它当场翻红。

import { describe, expect, it } from "vitest";

import { callDurationText, callOffsetText, voiceCallCards } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "" },
    { uid: "u2", role: "member", label: "旁人", avatarUrl: "" },
  ],
};

const S = { sessionId: "s" } as const;
const call = (seq: number, ts: number, ids: string[], byUid = "u1"): SessionEvent => ({
  ...S, seq, ts, type: "voice_call_changed", ignorable: true, byUid,
  participants: ids.map((id) => ({ agentId: id, name: `快照${id}` })),
});
const said = (seq: number, ts: number, text: string, opts: { voice?: true; uid?: string } = {}): SessionEvent => ({
  ...S, seq, ts, type: "user_message", content: `[名]: ${text}`, fromUid: opts.uid ?? "u1", mentions: ["a_1"],
  ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
});
const chat = (seq: number, ts: number, text: string, opts: { voice?: true } = {}): SessionEvent => ({
  ...S, seq, ts, type: "chat_message", fromUid: "u1", label: "Stan", content: text, mention: false,
  ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
});
const said2 = (seq: number, ts: number, text: string, agentId: string): SessionEvent => ({
  ...S, seq, ts, type: "assistant_message", content: text, agentId, model: "m",
});
const step = (seq: number, ts: number, agentId: string): SessionEvent => ({
  ...S, seq, ts, type: "assistant_message", content: "", agentId, model: "m",
  toolCalls: [{ id: "c1", name: "bash", args: {} }],
});

const fold = (events: SessionEvent[], selfUid = "u1") => voiceCallCards(events, ws, selfUid);
const texts = (events: SessionEvent[]): string[] =>
  [...fold(events).cards.values()].flatMap((c) => c.lines.filter((l) => l.parts === null).map((l) => l.text));

describe("哪几条进卡（#1233 决策 1）", () => {
  it("说出来的话进卡：判据是 voice 记号，不是「在通话期间」", () => {
    const events = [call(1, 0, ["a_1"]), said(2, 1_000, "说出来的", { voice: true }), call(3, 2_000, [])];
    expect(texts(events)).toEqual(["说出来的"]);
    expect([...fold(events).folded]).toEqual([2, 3]);
  });

  it("**通话期间打字的留在时间线上**——哪怕打字的人就是通话发起人", () => {
    const events = [call(1, 0, ["a_1"]), said(2, 1_000, "手打的"), call(3, 2_000, [])];
    expect(texts(events)).toEqual([]);
    expect(fold(events).folded.has(2)).toBe(false);
  });

  it("旁人打的字更不该被吞：那张卡他压根没参与", () => {
    const events = [
      call(1, 0, ["a_1"]),
      said(2, 1_000, "我在通话里说的", { voice: true }),
      said(3, 1_500, "旁人手打的一句", { uid: "u2" }),
      call(4, 2_000, []),
    ];
    expect(texts(events)).toEqual(["我在通话里说的"]);
    expect(fold(events).folded.has(3)).toBe(false);
  });

  it("chat_message 也认这一格：被限速 / 名单降级那几种边角走的是它", () => {
    const events = [call(1, 0, ["a_1"]), chat(2, 1_000, "没人接的一句", { voice: true }), call(3, 2_000, [])];
    expect(texts(events)).toEqual(["没人接的一句"]);
  });

  it("通话里那几只 agent 的回复进卡（不用第二个字段：它们的话会被读出来）", () => {
    const events = [call(1, 0, ["a_1"]), said2(2, 1_000, "我是通话里的", "a_1"), call(3, 2_000, [])];
    expect(texts(events)).toEqual(["我是通话里的"]);
  });

  it("通话**外**那只 agent 的回复留在时间线上", () => {
    const events = [call(1, 0, ["a_1"]), said2(2, 1_000, "我不在通话里", "a_2"), call(3, 2_000, [])];
    expect(texts(events)).toEqual([]);
    expect(fold(events).folded.has(2)).toBe(false);
  });

  it("中间步骤照旧整段不画（#1055）：卡里也不该有「它跑了个工具」", () => {
    const events = [call(1, 0, ["a_1"]), step(2, 1_000, "a_1"), call(3, 2_000, [])];
    expect(fold(events).cards.get(1)!.utterances).toBe(0);
    expect(fold(events).folded.has(2)).toBe(false);
  });

  it("通话结束之后说的话不进任何卡", () => {
    const events = [call(1, 0, ["a_1"]), call(2, 1_000, []), said(3, 2_000, "结束后打的")];
    expect(texts(events)).toEqual([]);
    expect(fold(events).folded.has(3)).toBe(false);
  });
});

describe("一场通话一张卡（#1233）", () => {
  it("中途拉人 / 移出折进卡里的分隔线，不在时间线上另起一行", () => {
    const events = [call(1, 0, ["a_1"]), call(2, 5_000, ["a_1", "a_2"]), call(3, 9_000, [])];
    const card = fold(events).cards.get(1)!;
    expect(card.lines.filter((l) => l.parts !== null)).toHaveLength(2); // 拉人 + 结束
    expect(fold(events).folded.has(2)).toBe(true);
    // 开场那一条**留在时间线上**：卡就画在它的位置
    expect(fold(events).folded.has(1)).toBe(false);
    expect(card.lines.find((l) => l.parts !== null)!.parts!.map((p) => p.text).join("")).toBe("Stan 把广告拉进了通话");
  });

  it("两场通话两张卡，各自按自己那条开场事件索引", () => {
    const events = [
      call(1, 0, ["a_1"]), said(2, 1_000, "第一场", { voice: true }), call(3, 2_000, []),
      call(4, 100_000, ["a_2"]), said(5, 101_000, "第二场", { voice: true }), call(6, 102_000, []),
    ];
    const { cards } = fold(events);
    expect([...cards.keys()]).toEqual([1, 4]);
    expect(cards.get(4)!.lines[0]!.text).toBe("第二场");
  });

  it("句数不含名单变更那几行：一场只拉了两次人的通话报 0 句", () => {
    const events = [call(1, 0, ["a_1"]), call(2, 5_000, ["a_1", "a_2"]), call(3, 9_000, ["a_1"]), call(4, 12_000, [])];
    expect(fold(events).cards.get(1)!.utterances).toBe(0);
  });

  it("参与者是整场的并集：中途被移出的那只照旧算参与过", () => {
    const events = [call(1, 0, ["a_1"]), call(2, 5_000, ["a_1", "a_2"]), call(3, 9_000, ["a_1"]), call(4, 12_000, [])];
    expect(fold(events).cards.get(1)!.parties.map((p) => p.name)).toEqual(["运营", "广告", "Stan"]);
  });

  it("还开着的那场：endedTs 是 null，不装作它结束了", () => {
    const events = [call(1, 0, ["a_1"]), said(2, 1_000, "还在说", { voice: true })];
    expect(fold(events).cards.get(1)!.endedTs).toBeNull();
  });

  it("结束了的那场带上结束时刻——收起时那句「6 分 12 秒」由它减开始算", () => {
    const events = [call(1, 1_000, ["a_1"]), call(2, 373_000, [])];
    const card = fold(events).cards.get(1)!;
    expect(callDurationText(card.endedTs! - card.sinceTs)).toBe("6 分 12 秒");
  });

  it("空名单开场（旧日志的怪形状）不开卡：那条事件说不出任何一句真话", () => {
    expect(fold([call(1, 0, [])]).cards.size).toBe(0);
  });

  it("mine 按 fromUid 判不按名字比对：同名两个人也分得开", () => {
    const events = [call(1, 0, ["a_1"]), said(2, 1_000, "我说的", { voice: true, uid: "u1" }), said(3, 1_500, "他说的", { voice: true, uid: "u2" })];
    const lines = fold(events).cards.get(1)!.lines;
    expect(lines.map((l) => l.mine)).toEqual([true, false]);
  });
});

describe("时长与时刻的文案（#1233）", () => {
  it("不足一分钟只报秒——「48 秒」比「0 分 48 秒」像人话", () => {
    expect(callDurationText(48_000)).toBe("48 秒");
    expect(callDurationText(0)).toBe("0 秒");
  });

  it("一分钟以上报分与秒", () => {
    expect(callDurationText(372_000)).toBe("6 分 12 秒");
    expect(callDurationText(60_000)).toBe("1 分 0 秒");
  });

  it("一小时以上报「小时 + 分」不再报秒——daemon 崩在通话中时那张卡会一直「通话中」", () => {
    // 没有这一档它会写成「1483577 分 34 秒」（真机 harness 上第一次就撞见了）
    expect(callDurationText(4_320_000)).toBe("1 小时 12 分");
    expect(callDurationText(3_600_000)).toBe("1 小时 0 分");
  });

  it("卡里每行的时刻是 mm:ss；超过一小时展开成 h:mm:ss，不把 61 分钟写成 01:00", () => {
    expect(callOffsetText(2_000)).toBe("00:02");
    expect(callOffsetText(92_000)).toBe("01:32");
    expect(callOffsetText(3_660_000)).toBe("1:01:00");
  });
});
