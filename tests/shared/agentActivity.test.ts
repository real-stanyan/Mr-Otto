// agentActivity —— 一只智能体此刻在干嘛（#1282，spec §1）。
// 逐档造日志断言状态；「欠不欠、在不在跑」在 200 份伪随机日志的每个前缀上与 openTurns 对拍。
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_ORDER, activityBadge, activityFace, activityFoldOf, activityOf, emptyActivityFold, foldActivity,
  isAgentActivity, knownAgents, mostUrgent, toolKind, turnStateOf,
} from "../../src/shared/agentActivity.js";
import { openTurns } from "../../src/shared/turnLedger.js";
import type { SessionEvent } from "../../src/session/events.js";
import { GEN_AGENTS, generateLog } from "../helpers/relayLog.js";

let seq = 0;
beforeEach(() => {
  seq = 0;
});
const ev = (e: Record<string, unknown>): SessionEvent => ({ sessionId: "s1", ts: seq, seq: seq++, ...e }) as unknown as SessionEvent;
const mention = (agentId: string) => ev({ type: "user_message", content: "[Stan]: 看下", fromUid: "me", mentions: [agentId] });
const envelope = (agentId: string) => ev({ type: "request_envelope", agentId });
const ask = (agentId: string, calls: [string, string][]) =>
  ev({ type: "assistant_message", content: "", model: "m", agentId, toolCalls: calls.map(([id, name]) => ({ id, name, args: {} })) });
const say = (agentId: string) => ev({ type: "assistant_message", content: "好了", model: "m", agentId });
const result = (toolCallId: string) => ev({ type: "tool_result", toolCallId, status: "ok", output: "" });
const end = (agentId: string, extra: Record<string, unknown> = {}) => ev({ type: "turn_ended", outcome: "completed", agentId, ...extra });
const state = (events: SessionEvent[], agentId: string, streaming = false) => activityOf(activityFoldOf(events), agentId, streaming);

describe("activityOf：逐档（spec §1.1）", () => {
  it("点了名还没动静 = 排队中；这只有任何一条动静 = 思考中；收口 = 闲着", () => {
    const events = [mention("ops")];
    expect(state(events, "ops")).toBe("queued");
    events.push(envelope("ops"));
    expect(state(events, "ops")).toBe("composing");
    events.push(say("ops"), end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("要了只读的刀 = 检索中；要了别的刀 = 执行中；混着要 = 执行中；认不出的刀 = 执行中", () => {
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"]])], "ops")).toBe("searching");
    expect(state([mention("ops"), ask("ops", [["c1", "wiki_read"]])], "ops")).toBe("searching");
    expect(state([mention("ops"), ask("ops", [["c1", "bash"]])], "ops")).toBe("working");
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"], ["c2", "git_push"]])], "ops")).toBe("working");
    expect(state([mention("ops"), ask("ops", [["c1", "px_shopify_orders"]])], "ops")).toBe("working");
  });
  it("刀的结果回来 = 回到思考中；只回来一把时按剩下的那把算", () => {
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"]]), result("c1")], "ops")).toBe("composing");
    expect(state([mention("ops"), ask("ops", [["c1", "bash"], ["c2", "read_file"]]), result("c1")], "ops")).toBe("searching");
  });
  it("在吐字 = 作答中，压过手上的刀；审批没批 = 等你处理，压过吐字；批了回到手上的刀", () => {
    const events = [mention("ops"), ask("ops", [["c1", "bash"]])];
    expect(state(events, "ops", true)).toBe("solving");
    events.push(ev({ type: "approval_request", callId: "c1", toolName: "bash", argsSummary: "", initiatorUid: "me", expiresTs: 0, agentId: "ops" }));
    expect(state(events, "ops", true)).toBe("waiting");
    events.push(ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }));
    expect(state(events, "ops")).toBe("working");
  });
  it("收口：error = 出错；error + reroute = 额度用完；按停止（aborted）与 interrupted 都不算出错", () => {
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x" })], "ops")).toBe("failed");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x", errorClass: "reroute" })], "ops")).toBe("limited");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "aborted" })], "ops")).toBe("idle");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "interrupted" })], "ops")).toBe("idle");
  });
  it("出错一直挂着，直到又欠它一轮：新的点名 = 排队中；跑完 = 闲着", () => {
    const events = [mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x" }), say("ads")];
    expect(state(events, "ops")).toBe("failed");
    events.push(mention("ops"));
    expect(state(events, "ops")).toBe("queued");
    events.push(envelope("ops"));
    expect(state(events, "ops")).toBe("composing");
    events.push(end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("跑到一半才到的点名不随这一轮收口（readUpToSeq）：收口后仍是排队中", () => {
    // seq 0 点名、seq 1 动静、seq 2 又点名、seq 3 收口（这一轮开跑时只看到 seq 1）
    const events = [mention("ops"), envelope("ops"), mention("ops"), end("ops", { readUpToSeq: 1 })];
    expect(state(events, "ops")).toBe("queued");
  });
  it("收口顺手清掉手上的刀与审批；别只的收口不算数", () => {
    const events = [mention("ops"), ask("ops", [["c1", "bash"]]), end("ads")];
    expect(state(events, "ops")).toBe("working");
    events.push(end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("没见过的智能体 = 闲着；knownAgents 列出点过名或有过动静的", () => {
    const fold = activityFoldOf([mention("ops"), say("ads")]);
    expect(activityOf(fold, "nobody", false)).toBe("idle");
    expect(knownAgents(fold).sort()).toEqual(["ads", "ops"]);
  });
});

describe("次序与画法", () => {
  it("mostUrgent：等你处理 > 作答 > 执行 > 检索 > 思考 > 排队 > 额度用完 > 出错 > 闲着；空 = null", () => {
    expect(ACTIVITY_ORDER).toEqual(["waiting", "solving", "working", "searching", "composing", "queued", "limited", "failed", "idle"]);
    expect(mostUrgent(["idle", "failed", "queued"])).toBe("queued");
    expect(mostUrgent(["composing", "waiting"])).toBe("waiting");
    expect(mostUrgent([])).toBeNull();
  });
  it("activityFace：不知道 = plain；闲着按调用方给；其余同名", () => {
    expect(activityFace(null)).toBe("plain");
    expect(activityFace("idle")).toBe("plain");
    expect(activityFace("idle", "alive")).toBe("alive");
    expect(activityFace("working")).toBe("working");
    expect(activityFace("limited")).toBe("limited");
  });
  it("activityBadge：不知道 / 闲着不画；排队灰、干活蓝、等你与额度琥珀、出错红", () => {
    expect(activityBadge(null)).toBeNull();
    expect(activityBadge("idle")).toBeNull();
    expect(activityBadge("queued")).toBe("mute");
    expect(activityBadge("solving")).toBe("work");
    expect(activityBadge("waiting")).toBe("need");
    expect(activityBadge("limited")).toBe("need");
    expect(activityBadge("failed")).toBe("bad");
  });
  it("isAgentActivity / toolKind", () => {
    expect(isAgentActivity("working")).toBe(true);
    expect(isAgentActivity("speaking")).toBe(false);
    expect(toolKind("read_file")).toBe("search");
    expect(toolKind("whatever")).toBe("work");
  });
});

describe("与 openTurns 对拍（spec §1.5）", () => {
  it("200 份伪随机日志的每一个前缀上，「欠不欠、在不在跑」逐只相同", () => {
    for (let s = 1; s <= 200; s++) {
      const log = generateLog(s);
      const fold = emptyActivityFold();
      for (let i = 0; i <= log.length; i++) {
        if (i > 0) foldActivity(fold, log[i - 1]!);
        const turns = openTurns(log.slice(0, i));
        for (const a of GEN_AGENTS) {
          const mine = turns.filter((t) => t.agentId === a);
          const want = mine.some((t) => t.state === "running") ? "running" : mine.length > 0 ? "queued" : "none";
          expect(turnStateOf(fold, a), `seed=${s} i=${i} agent=${a}`).toBe(want);
        }
      }
    }
  });
});
