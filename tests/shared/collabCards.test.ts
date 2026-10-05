// 镜像卡与「管理员之间」折叠页的投影（#1605 第 1 期 c）。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { adminsLaneRows, collabCardsOf } from "../../src/shared/collabCards.js";

let seq = 0;
const ev = (e: Record<string, unknown>): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: 1000 + seq, ...e }) as unknown as SessionEvent;
const request = (id: string) => ev({ type: "collab_request", requestId: id, taskId: "t", title: "看营业额", fromUid: "u_a", fromAgentName: "雨姐", quote: { ownerName: "继爸", ownerLine: "带上 Stan 的管理员", note: "只要总数" }, result: "$78,807", expiresTs: 1000 + seq + 10, byAgentId: "admin", ignorable: true });

describe("collabCardsOf", () => {
  it("一条请求一张卡：原话 / 说明 / 结果；决定对回去；接了之后我的管理员的回复计数；过了 expiresTs 没决定 = 过期", () => {
    seq = 0;
    const events = [
      request("r1"),
      ev({ type: "collab_decision", requestId: "r1", decision: "accepted", byUid: "owner", ignorable: true }),
      ev({ type: "assistant_message", agentId: "admin", content: "对得上", model: "m" }),
      ev({ type: "assistant_message", agentId: "admin", content: "嗯", model: "m", ack: true }),
      request("r2"),
      request("r2"),
    ];
    const cards = collabCardsOf(events, 1000);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ requestId: "r1", title: "看营业额", fromOwnerName: "继爸", fromAgentName: "雨姐", ownerLine: "带上 Stan 的管理员", note: "只要总数", result: "$78,807", state: "accepted", replies: 1 });
    expect(cards[1]).toMatchObject({ requestId: "r2", state: "pending" });
    expect(collabCardsOf(events, 10_000)[1]!.state).toBe("expired");
  });
});

describe("adminsLaneRows", () => {
  it("请求 / 决定是系统行；接力进来的是对面那一侧（名字取 [前缀]）；我的管理员的回复是我这一侧；应承不画", () => {
    seq = 0;
    const rows = adminsLaneRows([
      request("r1"),
      ev({ type: "collab_decision", requestId: "r1", decision: "accepted", byUid: "owner", ignorable: true }),
      ev({ type: "user_message", content: "[雨姐]: 9 月对得上吗", fromUid: "u_a", mentions: ["admin"], relay: { fromAgentId: "admin", depth: 1 } }),
      ev({ type: "assistant_message", agentId: "admin", content: "嗯", model: "m", ack: true }),
      ev({ type: "assistant_message", agentId: "admin", content: "对得上", model: "m" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["system", "system", "peer", "mine"]);
    expect(rows[0]).toMatchObject({ text: "继爸 的管理员「雨姐」找你的管理员配合「看营业额」" });
    expect(rows[1]).toMatchObject({ text: "「看营业额」：你接了" });
    expect(rows[2]).toMatchObject({ name: "雨姐", text: "9 月对得上吗" });
  });
});
