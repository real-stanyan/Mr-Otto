import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  absorbedIndexes,
  latestMicroCompacted,
  nextMicroExchange,
} from "../../src/session/microCompact.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

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
    const short = fiveTurns().slice(0, 11);
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

  it("迟到的旧摘要作废：位置在 compact 之后，但 coversUpTo 指向 compact 之前那段历史", () => {
    const events = fiveTurns();
    const preCompactSeq = events[7]!.seq; // u1 那一段的收口，compact 会把它折叠掉
    const c = compacted("C");
    events.push(c);
    // 微压缩跑在 turn 锁外：它读的是 compact 之前的日志，收口却排在 compact 后面。
    // 位置检查（下标 > floor）放它过关，只有 coversUpTo 能识破
    events.push(micro("旧摘要", preCompactSeq));
    expect(events[events.length - 1]!.seq).toBeGreaterThan(c.seq); // 确实排在 compact 之后
    expect(latestMicroCompacted(events)).toBeNull();
    expect(absorbedIndexes(events)).toBeNull();
    // 下一次微压缩从零起跑：不能把这条作废的摘要当 running summary 接着往上堆
    expect(nextMicroExchange(events, 2)?.runningSummary ?? "").toBe("");
  });
});

describe("fix round 1", () => {
  it("空跑(barren)的首发不占保护区名额：真正的第一次发送才是保护区", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("TASK"), // 空跑：下面直接 aborted，模型压根没读到过
      { ...base(), type: "turn_ended", outcome: "aborted" },
      user("TASK"), // 重试：这次真的跑了——它才是保护区
      assistant("a0"), ended(),
      user("u1"), assistant("a1"), ended(),
      user("u2"), assistant("a2"), ended(),
      user("u3"), assistant("a3"), ended(),
    ];
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u1" });

    events.push(micro("S", pick.coversUpTo));
    const got = absorbedIndexes(events)!;
    const a0Idx = events.findIndex((e) => e.type === "assistant_message" && e.content === "a0");
    expect(got.absorbed.has(a0Idx)).toBe(false); // a0 在（真正的）保护区里，不能被吸收
  });

  it("end 不吞下一轮的前导事件（skill_invoked/image_described 是为下一条 user_message 生成的）", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"), assistant("a1"), ended(),
      { ...base(), type: "skill_invoked", name: "foo", content: "..." }, // 下一条 user 的前导
      user("u2"), assistant("a2"), ended(),
      user("u3"), assistant("a3"), ended(),
    ];
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u1" });
    expect(events[pick.end]).toMatchObject({ type: "turn_ended" });
    expect(pick.coversUpTo).toBe(events[pick.end]!.seq);
  });

  it("absorbedIndexes 防孤儿：最后吸收的是带 toolCalls 的 assistant_message，" +
    "但它的 tool_result 落在 coversUpTo 之外时要把它踢出去，其余已吸收的不受影响", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"), assistant("a1"), ended(),
      user("u2"), assistant("a2", [{ id: "c2", name: "bash", args: {} }]), tool("c2", "out2"), ended(),
      user("u3"), assistant("a3"), ended(),
    ];
    const a1Idx = events.findIndex((e) => e.type === "assistant_message" && e.content === "a1");
    const a2Idx = events.findIndex((e) => e.type === "assistant_message" && e.content === "a2");
    // 手写 coversUpTo = a2 自己的 seq——它的 tool_result（seq 更大）落在范围外
    events.push(micro("S", events[a2Idx]!.seq));
    const got = absorbedIndexes(events)!;
    expect(got.absorbed.has(a1Idx)).toBe(true); // a1 没有 toolCalls，正常吸收
    expect(got.absorbed.has(a2Idx)).toBe(false); // a2 的 tool_result 没跟上，整条踢掉
    // 摘要退到剩余集合（只剩 a1）里最大下标 + 1，不是退到被踢掉的 a2 自己的下标——
    // a2 所在的整条 exchange（u2 开始）都不算覆盖完整，摘要边界不能停在它内部
    // （旧实现退到 a2Idx 会把摘要夹在 u2 的 user 消息和 a2 的 assistant 回复之间，
    // 读起来像是摘要在描述一段还没答完的对话）
    expect(got.summaryAt).toBe(a1Idx + 1);
    expect(got.summary).toBe("S");
  });

  it("absorbedIndexes 防孤儿（整组去留）：并行 toolCalls 里只要有一个没跟上覆盖范围，" +
    "assistant 连同它已吸收的另一个 tool_result 要一起踢出去——投影里不会剩一条断头 tool 消息", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"),
      assistant("a1", [
        { id: "c1", name: "bash", args: {} },
        { id: "c2", name: "bash", args: {} },
      ]),
      tool("c1", "out1"),
      tool("c2", "out2"),
      ended(),
      user("u2"), assistant("a2"), ended(),
    ];
    const a1Idx = events.findIndex((e) => e.type === "assistant_message" && e.content === "a1");
    const c1Idx = events.findIndex((e) => e.type === "tool_result" && e.toolCallId === "c1");
    const c2Idx = events.findIndex((e) => e.type === "tool_result" && e.toolCallId === "c2");
    // 手写 coversUpTo = tool_result c1 自己的 seq——并行的 c2 落在覆盖范围外
    events.push(micro("S", events[c1Idx]!.seq));

    const got = absorbedIndexes(events);
    // 旧实现只查"下标最大的那条"：这里下标最大的是 c1（tool_result），不是 a1，
    // 旧的单点检查根本不会触发，会把 a1 和 c1 都错误地吸收掉，留下断头的 a1
    // （toolCalls 里的 c2 从没得到回应）。新实现整组一起验，a1/c1/c2 全部踢出
    expect(got === null || !got.absorbed.has(a1Idx)).toBe(true);
    expect(got === null || !got.absorbed.has(c1Idx)).toBe(true);
    expect(got === null || !got.absorbed.has(c2Idx)).toBe(true);

    // 投影层验证：任何一条 tool 消息，前面都必须有一条 assistant 消息、
    // 它的 tool_calls 里含这个 tool_call_id——不能有断头的 tool 消息
    const msgs = deriveMessages(events);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role !== "tool") continue;
      const hasCaller = msgs
        .slice(0, i)
        .some((p) => p.role === "assistant" && p.tool_calls?.some((tc) => tc.id === m.tool_call_id));
      expect(hasCaller).toBe(true);
    }
  });

  it("keepRecentTurns=0：仍然不吃最后一个 exchange（next undefined 分支，不是保真区分支）", () => {
    let cur = fiveTurns();
    let pick = nextMicroExchange(cur, 0)!;
    expect(cur[pick.start]).toMatchObject({ content: "u1" });
    cur = [...cur, micro("m1", pick.coversUpTo)];

    pick = nextMicroExchange(cur, 0)!;
    expect(cur[pick.start]).toMatchObject({ content: "u2" });
    cur = [...cur, micro("m2", pick.coversUpTo)];

    pick = nextMicroExchange(cur, 0)!;
    expect(cur[pick.start]).toMatchObject({ content: "u3" });
    cur = [...cur, micro("m3", pick.coversUpTo)];

    // 只剩最后一个 exchange u4：没有 next，永远不选它——即使 K=0 没有保真区
    expect(nextMicroExchange(cur, 0)).toBeNull();
  });

  it("三个函数都不修改传入的 events（纯函数，不能有副作用）", () => {
    const events = fiveTurns();
    const before = JSON.stringify(events);
    nextMicroExchange(events, 2);
    latestMicroCompacted(events);
    absorbedIndexes(events);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("保真区名额不算空跑", () => {
  it("尾部 真/空跑/真：倒数第 2 轮真实对话仍在保真区，不可吸收", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"), assistant("a1"), ended(),
      user("u2"), assistant("a2"), ended(),
      user("u3-barren"), { ...base(), type: "turn_ended", outcome: "aborted" },
      user("u4"), assistant("a4"), ended(),
    ];
    const pick = nextMicroExchange(events, 2);
    // 能吸收的只有 u1（u0 保护区；u2、u4 是最近两轮真实对话）
    expect(pick).not.toBeNull();
    expect(events[pick!.start]).toMatchObject({ content: "u1" });
    events.push(micro("S", pick!.coversUpTo));
    expect(nextMicroExchange(events, 2)).toBeNull();
  });
});
