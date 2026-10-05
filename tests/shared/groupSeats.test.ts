// 群座位制的共用纯逻辑（#1682，ADR-0376）
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  groupOwnerOf, groupSeatsNow, groupSeatsOf, lastMirroredSeq, mirrorLinesOf, nextGroupOwner, reseat, seatAgentId, seatCardsOf, seatCardStateAt, seatHandles,
  seatLabel, seatMentionsIn, seatUidOf, type GroupSeat,
} from "../../src/shared/groupSeats.js";

const ev = (e: Record<string, unknown> & { seq: number }): SessionEvent => ({ sessionId: "g", ts: e.seq, ...e }) as unknown as SessionEvent;
const S = (uid: string, name: string, agentName: string, policy?: "open"): GroupSeat => ({ uid, name, agentName, ...(policy ? { policy } : {}) });

describe("groupSeats", () => {
  it("座位 id 往返；不是座位的 id 回 null", () => {
    expect(seatUidOf(seatAgentId("u1"))).toBe("u1");
    expect(seatUidOf("admin")).toBeNull();
    expect(seatUidOf("seat:")).toBeNull();
  });
  it("名单折叠：最后一条带 seats 的胜出；没有 = null；群主缺席 = 回落", () => {
    const log = [ev({ seq: 1, type: "chat_roster_changed", agents: [], ignorable: true }), ev({ seq: 2, type: "chat_roster_changed", agents: [], seats: [S("a", "继爸", "雨姐")], groupOwnerUid: "a", ignorable: true })];
    expect(groupSeatsOf(log.slice(0, 1))).toBeNull();
    expect(groupSeatsOf(log)!.map((s) => s.uid)).toEqual(["a"]);
    expect(groupOwnerOf(log.slice(0, 1), "host")).toBe("host");
    expect(groupOwnerOf(log, "host")).toBe("a");
    expect(groupSeatsNow([], [S("b", "Stan", "峰哥")])!.map((s) => s.uid)).toEqual(["b"]);
    expect(groupSeatsNow([], undefined)).toBeNull();
  });
  it("@ 认 handle：撞名带主人名字；长的先认；「X的管理员」也认", () => {
    const seats = [S("a", "继爸", "管理员"), S("b", "Stan", "管理员"), S("c", "Edison", "小E")];
    expect(seatHandles(seats).get("a")).toBe("管理员·继爸");
    expect(seatMentionsIn("@管理员·Stan 你好 @小E", seats)).toEqual(["b", "c"]);
    expect(seatMentionsIn("@继爸的管理员 在吗", seats)).toEqual(["a"]);
    expect(seatMentionsIn("@管理员 在吗", seats)).toEqual([]);
    expect(seatLabel(seats[2]!)).toBe("小E（Edison的管理员）");
  });
  it("reseat 保留顺序与策略、新人排最后；群主走了转给最早的那位", () => {
    const prev = [S("a", "继爸", "雨姐"), S("b", "Stan", "峰哥", "open")];
    const next = reseat(prev, [{ uid: "c", name: "Edison", agentName: "小E" }, { uid: "b", name: "Stan Yan", agentName: "峰哥" }, { uid: "a", name: "继爸", agentName: "雨姐" }]);
    expect(next.map((s) => [s.uid, s.name, s.policy])).toEqual([["a", "继爸", undefined], ["b", "Stan Yan", "open"], ["c", "Edison", undefined]]);
    expect(nextGroupOwner(next, "a")).toBe("b");
    expect(nextGroupOwner([S("a", "x", "y")], "a")).toBeNull();
  });
  it("镜像：人话与别家管理员的回话进来；自家的、镜像行、ack、空话不进；座位里镜像到哪儿从日志推", () => {
    const seats = [S("a", "继爸", "雨姐"), S("b", "Stan", "峰哥")];
    const group = [
      ev({ seq: 1, type: "chat_message", fromUid: "a", label: "继爸", content: "hi", mention: false }),
      ev({ seq: 2, type: "assistant_message", agentId: seatAgentId("a"), content: "在", model: "m" }),
      ev({ seq: 3, type: "assistant_message", agentId: seatAgentId("b"), content: "到", model: "m" }),
      ev({ seq: 4, type: "assistant_message", agentId: seatAgentId("a"), content: "", model: "m" }),
      ev({ seq: 5, type: "assistant_message", agentId: seatAgentId("a"), content: "嗯", model: "m", ack: true }),
      ev({ seq: 6, type: "seat_request", requestId: "q", ignorable: true }),
    ];
    expect(mirrorLinesOf(group, "b", seats).map((l) => [l.seq, l.label, l.content])).toEqual([[1, "继爸", "hi"], [2, "雨姐（继爸的管理员）", "在"]]);
    const seat = [
      ev({ seq: 1, type: "chat_message", fromUid: "a", label: "继爸", content: "hi", mention: false, mirror: { seq: 1 } }),
      ev({ seq: 2, type: "user_message", fromUid: "a", content: "x", mirror: { seq: 7 } }),
    ];
    expect(lastMirroredSeq(seat)).toBe(7);
    expect(lastMirroredSeq([])).toBeNull();
  });
  it("点头卡折叠：请求 + 结局；先到的结局丢掉；过了点算过期", () => {
    const log = [
      ev({ seq: 1, type: "seat_decision", requestId: "q0", seatUid: "a", decision: "accepted", byUid: "a", ignorable: true }),
      ev({ seq: 2, type: "seat_request", requestId: "q1", seatUid: "a", ownerName: "继爸", agentName: "雨姐", fromUid: "b", fromName: "Stan", ask: "看营业额", summary: "读后台", expiresTs: 100, ignorable: true }),
      ev({ seq: 3, type: "seat_request", requestId: "q2", seatUid: "a", ownerName: "继爸", agentName: "雨姐", fromUid: "c", fromName: "Edison", ask: "x", summary: "y", expiresTs: 100, ignorable: true }),
      ev({ seq: 4, type: "seat_decision", requestId: "q1", seatUid: "a", decision: "declined", byUid: "a", ignorable: true }),
    ];
    const cards = seatCardsOf(log);
    expect([...cards.keys()]).toEqual(["q1", "q2"]);
    expect(cards.get("q1")!.state).toBe("declined");
    expect(seatCardStateAt(cards.get("q2")!, 50)).toBe("pending");
    expect(seatCardStateAt(cards.get("q2")!, 100)).toBe("expired");
  });
});
