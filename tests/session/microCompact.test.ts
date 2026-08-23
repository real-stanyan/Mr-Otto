import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  absorbedIndexes,
  latestMicroCompacted,
  nextMicroExchange,
} from "../../src/session/microCompact.js";

let seq = 0;
const base = () => ({ seq: seq++, sessionId: "s", ts: seq });
const user = (content: string): SessionEvent => ({ ...base(), type: "user_message", content });
const assistant = (content: string, toolCalls?: { id: string; name: string; args: unknown }[]): SessionEvent => ({
  ...base(), type: "assistant_message", content, model: "m", ...(toolCalls ? { toolCalls } : {}),
});
const tool = (id: string, output: string): SessionEvent => ({
  ...base(), type: "tool_result", toolCallId: id, status: "ok", output,
});
const ended = (): SessionEvent => ({ ...base(), type: "turn_ended", outcome: "completed" });
const micro = (summary: string, coversUpTo: number): SessionEvent => ({
  ...base(), type: "micro_compacted", summary, coversUpTo, model: "cheap",
});
const compacted = (summary: string): SessionEvent => ({
  ...base(), type: "context_compacted", summary, model: "m", trigger: "manual",
});

/** 5 个 exchange：u0 a0 | u1 a1 t1 | u2 a2 | u3 a3 | u4 a4 */
function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "t1"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}

describe("nextMicroExchange", () => {
  it("跳过第一个 exchange（保护区），选第二个；尾部 keepRecentTurns 个 turn 不碰", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2);
    expect(pick).not.toBeNull();
    expect(events[pick!.start]).toMatchObject({ type: "user_message", content: "u1" });
    expect(events[pick!.end]).toMatchObject({ type: "turn_ended" });
    expect(pick!.coversUpTo).toBe(events[pick!.end]!.seq);
    expect(pick!.runningSummary).toBe("");
  });

  it("已有 micro：从 coversUpTo 之后接着选，带上 running summary", () => {
    const events = fiveTurns();
    const first = nextMicroExchange(events, 2)!;
    events.push(micro("S1", first.coversUpTo));
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u2" });
    expect(pick.runningSummary).toBe("S1");
  });

  it("只剩保护区和保真区：返回 null", () => {
    const events = fiveTurns();
    // u1、u2 已吸收；剩 u3、u4 是最近 2 turn → 没得选
    const u2End = events.findIndex((e) => e.type === "user_message" && e.content === "u3") - 1;
    events.push(micro("S", events[u2End]!.seq));
    expect(nextMicroExchange(events, 2)).toBeNull();
    // 短会话：只有 3 个 turn（第 1 个保护，后 2 个保真）
    const short = fiveTurns().slice(0, 12);
    expect(nextMicroExchange(short, 2)).toBeNull();
  });

  it("没有 assistant/tool 可吸收的 exchange 跳过，并入下一个的 coversUpTo 范围", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"), ended(), // 空 turn（比如被中断、什么也没产出）
      user("u2"), assistant("a2"), ended(),
      user("u3"), assistant("a3"), ended(),
      user("u4"), assistant("a4"), ended(),
    ];
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u2" });
  });

  it("context_compacted 之后重新计数：其后第一个 exchange 是新的保护区，旧 micro 作废", () => {
    const events = fiveTurns();
    events.push(micro("old", events[7]!.seq));
    events.push(compacted("C"));
    seq = events.length;
    events.push(user("v0"), assistant("b0"), ended());
    events.push(user("v1"), assistant("b1"), ended());
    events.push(user("v2"), assistant("b2"), ended());
    events.push(user("v3"), assistant("b3"), ended());
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "v1" });
    expect(pick.runningSummary).toBe("");
  });
});

describe("latestMicroCompacted / absorbedIndexes", () => {
  it("无事件 → null；投影集合只含 assistant/tool，user 与 turn_ended 不在内", () => {
    const events = fiveTurns();
    expect(latestMicroCompacted(events)).toBeNull();
    expect(absorbedIndexes(events)).toBeNull();
    const first = nextMicroExchange(events, 2)!;
    events.push(micro("S1", first.coversUpTo));
    const got = absorbedIndexes(events)!;
    const types = [...got.absorbed].map((i) => events[i]!.type);
    expect(types.sort()).toEqual(["assistant_message", "tool_result"]);
    // 只吸收 u1 那一段：a0 在保护区不在集合里
    expect(got.absorbed.has(2)).toBe(false);
    expect(got.summaryAt).toBe(first.end + 1);
  });

  it("只认最新一条；最新一条在 context_compacted 之前则作废", () => {
    const events = fiveTurns();
    events.push(micro("S1", events[7]!.seq));
    events.push(micro("S2", events[10]!.seq));
    expect(latestMicroCompacted(events)!.summary).toBe("S2");
    expect(absorbedIndexes(events)!.absorbed.size).toBe(3); // a1 t1 a2
    events.push(compacted("C"));
    expect(latestMicroCompacted(events)).toBeNull();
    expect(absorbedIndexes(events)).toBeNull();
  });
});
