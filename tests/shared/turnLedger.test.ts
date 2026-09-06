import { describe, it, expect } from "vitest";
import { openTurns, type OpenTurn } from "../../src/shared/turnLedger.js";
import type { SessionEvent } from "../../src/session/events.js";
import { generateLog } from "../helpers/relayLog.js";

const base = { sessionId: "s1", ts: 0 };
let seq = 0;
const ev = <T extends Omit<SessionEvent, "seq" | "sessionId" | "ts">>(e: T) =>
  ({ ...base, seq: seq++, ...e }) as unknown as SessionEvent;

describe("openTurns（#932 坑 ②：排队中/正在回复是日志的投影）", () => {
  it("点了名、还没人动 —— queued", () => {
    seq = 0;
    const events = [ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] })];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("那只 agent 之后有动静（request_envelope/assistant_message 任一）—— running", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops", toolCalls: [{ id: "c", name: "bash", args: "{}" }] }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "running" }]);
  });

  it("turn_ended{agentId} 收口 —— 不再出现", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "好", model: "m", agentId: "ops" }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("两只：一只跑着一只排着，各算各的", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 @广告 一起", fromUid: "u1", mentions: ["ops", "ads"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" } as SessionEvent),
    ];
    expect(openTurns(events)).toEqual([
      { seq: 0, fromUid: "u1", agentId: "ops", state: "running" },
      { seq: 0, fromUid: "u1", agentId: "ads", state: "queued" },
    ]);
  });

  it("别只的 turn_ended 不算数；旧日志（没 mentions）一条都不出", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: 在吗" }),
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ads" }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 1, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("turn 跑到一半才到的那条点名，不随这轮的 turn_ended 收口（#932 终审 Blocking ①）", () => {
    // T1 在 U1（seq 0）上起跑，readUpToSeq=0 —— U2（seq 2）是它开跑之后才到
    // 的，这一轮从头到尾没看见过它（unseenUserTail 对带 mentions 的消息不
    // 重采样），它有自己的 job 排在后面。收了它的口 = 界面上那行提前消失，
    // 且这个窗口里 daemon 一重启就再也没人答它
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 0 }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 2, fromUid: "u2", agentId: "ops", state: "queued" }]);
  });

  it("同一条 turn_ended，readUpToSeq 够大就收口 —— 那一轮开跑时它已经在日志里了", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 2 }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("没有 readUpToSeq 的旧日志：老规则不变，任意 turn_ended 都收口", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("去重命中排队中的那个 job：两条都在它开跑前落盘，一条 turn_ended 收两条的口", () => {
    // U1、U2 连着来，第二条去重命中 U1 那只还排在队里的 job（turnCoordinator
    // 的约定），那一轮开跑时读的是整份日志、两句话都在里面 → readUpToSeq=1
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "一起答", model: "m", agentId: "ops" }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 1 }),
    ];
    expect(openTurns(events)).toEqual([]);
  });
});

// ── #958：单遍重写与旧实现对拍 ────────────────────────────────────────────
//
// **这份 oracle 是改动前的 openTurns 逐字复制，别顺手"整理"它**。单遍重写的
// 验收标准是「对任意输入逐字节同结果」，而这一层没有第二个独立事实来源——把
// 改动前那份代码留在测试里对拍，是唯一不靠人眼读代码的判据。它慢（O(n²)）正是
// 它该有的样子：慢的那份是被替换掉的那份。
function openTurnsOracle(events: readonly SessionEvent[]): OpenTurn[] {
  const out: OpenTurn[] = [];
  for (let i = 0; i < events.length; i++) {
    const u = events[i]!;
    if (u.type !== "user_message" || !u.mentions || u.mentions.length === 0) continue;
    for (const agentId of u.mentions) {
      let state: OpenTurn["state"] | "done" = "queued";
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        const owner = "agentId" in e ? e.agentId : undefined;
        if (owner !== agentId) continue;
        if (e.type === "turn_ended") {
          if (e.readUpToSeq === undefined || e.readUpToSeq >= u.seq) { state = "done"; break; }
          continue;
        }
        state = "running";
      }
      if (state !== "done") out.push({ seq: u.seq, fromUid: u.fromUid ?? null, agentId, state });
    }
  }
  return out;
}

describe("openTurns 单遍重写（#958）", () => {
  it("语料里真的有「双身份事件」（带 agentId 又带 mentions 的 user_message）", () => {
    // 这条按住的是**生成器头注那句话的真假**（复审 Minor ④）：第一版声称随机对拍
    // 覆盖了这个形状，实测 200 个 seed 一条都没有——覆盖度悄悄归零而所有用例照绿。
    // 没有它，下面那条 200 seed 的对拍看起来在验顺序，其实只有再下面那条手写用例在验
    let dual = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const e of generateLog(seed)) {
        if (e.type === "user_message" && "agentId" in e && e.agentId !== undefined && e.mentions && e.mentions.length > 0) dual++;
      }
    }
    expect(dual).toBeGreaterThan(0);
  });

  it("200 份伪随机日志逐份与旧实现深等于（顺序也一样）", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const events = generateLog(seed);
      expect(openTurns(events), `seed=${seed}`).toEqual(openTurnsOracle(events));
    }
  });

  it("同一条事件既是新点名、又是某只 agent 的动静时，先当动静再当点名", () => {
    // 护栏私话（origin=loop_guard）是一条**带 agentId 的 user_message**。旧实现的
    // 内层循环从 i+1 起步 → 它不影响自己那几格，但影响更早的那些。单遍要是把
    // 「建新格子」排在「刷旧格子」前面，这条私话就会把它自己刚建的格子刷成
    // running——只有这种同时具备两种身份的事件能暴露它
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 一", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "user_message", content: "[系统] 打转", origin: "loop_guard", agentId: "ops", mentions: ["ops"], fromUid: "u1" }),
    ];
    expect(openTurns(events)).toEqual(openTurnsOracle(events));
    expect(openTurns(events)).toEqual([
      { seq: 0, fromUid: "u1", agentId: "ops", state: "running" },
      { seq: 1, fromUid: "u1", agentId: "ops", state: "queued" },
    ]);
  });
});
