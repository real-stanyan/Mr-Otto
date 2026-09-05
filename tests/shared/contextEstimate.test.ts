import { describe, expect, it } from "vitest";
import {
  contextBreakdown,
  contextUsed,
  estimateTokens,
  estimateToolTokens,
} from "../../src/shared/contextEstimate.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("estimateTokens", () => {
  it("纯 ASCII ≈ 4 字符/token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("纯中文 ≈ 0.6 token/字", () => {
    expect(estimateTokens("好".repeat(100))).toBe(60);
  });

  it("空串 = 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("contextUsed（校准版：账单锚点 + 未计费尾巴）", () => {
  it("锚点是最后一条：占用 = 纯账单，无估算成分", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "问题" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
    ];
    expect(contextUsed(events)).toBe(1200);
  });

  it("锚点之后落了大 tool_result：占用立即上浮（不再冻结到下次账单）", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "big.txt" } }],
        usage: { promptTokens: 1000, completionTokens: 50 },
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "x".repeat(4000) },
    ];
    // 1050（账单）+ 1000（4000 ASCII 字符 ÷ 4）
    expect(contextUsed(events)).toBe(2050);
  });

  it("human-only 事件（审批/turn_ended）不计入——投影会丢弃它们", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 100, completionTokens: 10 },
      },
      { ...env(), type: "approval_decision", toolCallId: "c1", decision: "denied" },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];
    expect(contextUsed(events)).toBe(110);
  });

  it("compact 锚点 = 摘要体积，之后的新 turn 事件照常追加估算", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "旧",
        model: "m",
        usage: { promptTokens: 90_000, completionTokens: 500 },
      },
      {
        ...env(),
        type: "context_compacted",
        summary: "摘要",
        model: "m",
        usage: { promptTokens: 90_500, completionTokens: 300 },
      },
      { ...env(), type: "user_message", content: "z".repeat(400) },
    ];
    // 300（摘要）+ 100（新问题估算）；compact 前的 9 万不再计
    expect(contextUsed(events)).toBe(400);
  });

  it("compact 没回 usage（摘要模型没报账单）：锚点仍是这次 compact，值取摘要估算——不能穿透回 compact 前那笔更大的账单", () => {
    const summary = "摘".repeat(50); // 中文估算：50 * 0.6 = 30
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "旧",
        model: "m",
        usage: { promptTokens: 90_000, completionTokens: 500 },
      },
      {
        ...env(),
        type: "context_compacted",
        summary,
        model: "m",
        // 无 usage
      },
    ];
    // 若锚点误穿透回上一条账单（90500），圆环会虚高回压缩前的水位，
    // 触发第二次不必要的 compact（livelock）。正确答案只是摘要估算
    expect(contextUsed(events)).toBe(estimateTokens(summary));
    expect(contextUsed(events)).not.toBe(90_500);
  });

  it("skill_invoked 计入尾巴：它投影成 user 消息进上下文", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
      { ...env(), type: "skill_invoked", name: "tdd", content: "a".repeat(400) },
    ];
    expect(contextUsed(events)).toBe(1300);
  });

  it("subagent_briefed 计入尾巴：整份说明书投影成子会话的第一条 user 消息", () => {
    // 子会话的圆环少算的正是这一整篇 instructions（含内置前言）——
    // 圆环和真实 prompt 必须用同一把尺子（review I5）
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
      {
        ...env(),
        type: "subagent_briefed",
        agent: "searcher",
        instructions: "a".repeat(400),
        tools: ["read_file"],
        model: "m",
      },
    ];
    expect(contextUsed(events)).toBe(1300);
  });

  it("workspace_memory_loaded 故意不计——本文件只服务本机圆环，云会话页不读它（#949 review finding 3）", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
      {
        ...env(),
        type: "workspace_memory_loaded",
        agentId: "ops",
        agentName: "运营",
        shared: "a".repeat(400),
        own: "b".repeat(400),
      },
    ];
    expect(contextUsed(events)).toBe(1200);
  });

  it("从无账单（第一条消息还没发出去）：纯估算起步", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "y".repeat(40) },
    ];
    expect(contextUsed(events)).toBe(10);
  });
});

describe("contextBreakdown（按来源拆四份）", () => {
  const tools = [
    { name: "read_file", description: "读取一个文本文件的完整内容", parameters: { type: "object" } },
  ];

  it("四段之和 === 总量：对话消息取差额，不与账单双记", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "问题" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 5000, completionTokens: 200 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.total).toBe(5200); // 与 contextUsed 同源
    expect(b.total).toBe(contextUsed(events));
    expect(b.system + b.tools + b.instructions + b.messages).toBe(b.total);
    expect(b.system).toBeGreaterThan(0);
    expect(b.tools).toBeGreaterThan(0);
  });

  it("还没有任何账单：系统提示词 + 工具是显式底噪，不会谎报占用 0", () => {
    const events: SessionEvent[] = [{ ...env(), type: "session_created", workspace: "/w" }];
    const b = contextBreakdown(events, tools);
    expect(b.messages).toBe(0);
    expect(b.total).toBe(b.system + b.tools);
    expect(b.total).toBeGreaterThan(0);
    // 圆环（contextUsed）此刻仍读 0——它只认账单口径，底噪由弹窗补
    expect(contextUsed(events)).toBe(0);
  });

  it("项目指令自己占一栏：从对话消息里分出来，四段之和不变（issue #524）", () => {
    const segments = [{ path: "/w/AGENTS.md", content: "x".repeat(4000) }];
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "project_instructions", segments },
      { ...env(), type: "user_message", content: "问题" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 5000, completionTokens: 200 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.instructions).toBeGreaterThan(900); // 4000 个 ASCII ≈ 1000 token
    expect(b.system + b.tools + b.instructions + b.messages).toBe(b.total);
    expect(b.total).toBe(5200); // 账单口径不动：项目指令本来就在这笔账里
  });

  it("compact 之后照旧计项目指令：它焊在 system 里，清场扫不掉（ADR-0131）", () => {
    const segments = [{ path: "/w/AGENTS.md", content: "x".repeat(4000) }];
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "project_instructions", segments },
      { ...env(), type: "context_compacted", summary: "摘要", model: "m" },
    ];
    expect(contextBreakdown(events, tools).instructions).toBeGreaterThan(900);
  });

  it("第一次账单之前也算项目指令：圆环不会漏掉一整份 AGENTS.md（issue #525）", () => {
    const segments = [{ path: "/w/AGENTS.md", content: "x".repeat(4000) }];
    const bare: SessionEvent[] = [{ ...env(), type: "session_created", workspace: "/w" }];
    const withIns: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "project_instructions", segments },
    ];
    // 圆环也跟着涨：项目指令是"会进下一次 prompt"的事件，pendingAfter 计它
    expect(contextUsed(bare)).toBe(0);
    expect(contextUsed(withIns)).toBeGreaterThan(900);
    const b = contextBreakdown(withIns, tools);
    expect(b.total).toBe(contextBreakdown(bare, tools).total + b.instructions);
    expect(b.messages).toBe(0); // 全归项目指令，不掉进对话消息
  });

  it("拿不到工具表：该项 0，其余照常（不瞎猜一个数）", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 100 },
      },
    ];
    const b = contextBreakdown(events);
    expect(b.tools).toBe(0);
    expect(b.system + b.messages).toBe(1100);
  });

  it("老日志没有 workspace：系统提示词 0（投影也不会有那条 system 消息）", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 800, completionTokens: 50 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.system).toBe(0);
    expect(b.messages).toBe(850 - b.tools);
  });

  it("固定开销大于账单总量时对话消息钳到 0，三段仍不超总量", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        usage: { promptTokens: 5, completionTokens: 1 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.messages).toBe(0);
    expect(b.total).toBe(6);
  });

  it("工具估算按发出去的线格式：多一个工具就多一截", () => {
    expect(estimateToolTokens([])).toBe(0);
    const one = estimateToolTokens(tools);
    const two = estimateToolTokens([...tools, { name: "bash", description: "跑命令", parameters: {} }]);
    expect(two).toBeGreaterThan(one);
  });

  it("memory_loaded 的正文计入 system 占用", () => {
    const without = contextBreakdown([{ ...env(), type: "session_created", workspace: "/w" }]);
    const withMem = contextBreakdown([
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "memory_loaded", memory: "x".repeat(400), user: "" },
    ]);
    expect(withMem.system).toBeGreaterThan(without.system + 50);
  });
});

describe("微压缩后的估算（真实会话：吸收区落在账单锚点之前）", () => {
  // 真实会话里，微压缩吸收的从来是"锚点之前"那一段——锚点是最近一次带账单的
  // assistant_message，它的 promptTokens 那次请求本来就已经包含了这段原文。
  // 不扣掉的话，micro_compacted 一落盘 contextUsed 反而会"涨"（只加了摘要，
  // 没扣被替代的原文），直到下一次账单才自我修正——这里验证不必等那一轮。
  function fixture(): SessionEvent[] {
    return [
      { ...env(), type: "user_message", content: "u0" },
      {
        ...env(),
        type: "assistant_message",
        content: "a0",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 100 },
      },
      { ...env(), type: "user_message", content: "u1" },
      {
        ...env(),
        type: "assistant_message",
        content: "a1",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "x".repeat(8000) },
      {
        ...env(),
        type: "assistant_message",
        content: "a1b",
        model: "m",
        usage: { promptTokens: 3000, completionTokens: 50 },
      },
      { ...env(), type: "turn_ended", outcome: "completed" },
      { ...env(), type: "user_message", content: "u2" },
      {
        ...env(),
        type: "assistant_message",
        content: "a2",
        model: "m",
        usage: { promptTokens: 3200, completionTokens: 60 },
      },
      { ...env(), type: "turn_ended", outcome: "completed" },
      { ...env(), type: "user_message", content: "u3" },
    ];
  }

  it("micro 落在锚点之后（吸收区在锚点之前的 u1 那笔交换）：从 pending 里扣掉原文，摘要只加一次，钳到 ≥ 0", () => {
    const events = fixture();
    const end1 = events[6]!; // u1 交换的 turn_ended
    const before = contextUsed(events);
    const after = contextUsed([
      ...events,
      { ...env(), type: "micro_compacted", summary: "短摘要", coversUpTo: end1.seq, model: "cheap" },
    ]);
    // 8000 字符的 tool_result（≈2000 token）被摘要替掉，扣减应远超 1500
    expect(after).toBeLessThan(before - 1500);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it("micro 落在锚点之前（锚点是 micro 之后新产生的一笔账单）：吸收区不重复扣减，摘要也不重复计入——账单已经反映了压缩后的投影", () => {
    const events = fixture();
    const end1 = events[6]!; // u1 交换的 turn_ended
    const before = contextUsed(events); // 不含 micro 的基线：锚点仍是 a2
    const withEarlyMicro = [
      ...events.slice(0, 7), // ... a1b, turn_ended（u1 交换结束）
      { ...env(), type: "micro_compacted", summary: "短摘要", coversUpTo: end1.seq, model: "cheap" } as SessionEvent,
      ...events.slice(7), // u2, a2(usage), turn_ended, u3 —— a2 仍是最新账单锚点，在 micro 之后
    ];
    const after = contextUsed(withEarlyMicro);
    // 账单（a2 那次请求）本来就是压在 micro 投影之后打的，不需要也不应该再扣一次；
    // 摘要本身的 token 也不该被加进 pending（micro 的下标 ≤ 锚点下标，不进循环）
    expect(after).toBe(before);
  });
});

describe("微压缩稳态：两条 micro 夹着账单锚点", () => {
  const big = (n: number) => "x".repeat(n);
  function turn(label: string, usage?: { promptTokens: number; completionTokens: number }): SessionEvent[] {
    return [
      { ...env(), type: "user_message", content: `u${label}` },
      {
        ...env(),
        type: "assistant_message",
        content: `a${label}` + big(2000),
        model: "m",
        ...(usage ? { usage } : {}),
      },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];
  }
  const est = (e: SessionEvent) =>
    e.type === "assistant_message" ? estimateTokens(e.content) + estimateTokens(JSON.stringify(e.toolCalls ?? [])) : 0;

  it("只扣新折进去的那段 + 被顶掉的旧摘要，不把更早已折的段再扣一遍", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      ...turn("1"), ...turn("2"), ...turn("3"),
    ];
    const end2 = events[6]!.seq; // u2 交换的 turn_ended
    events.push({ ...env(), type: "micro_compacted", summary: "S1", coversUpTo: end2, model: "cheap" });
    events.push(...turn("4", { promptTokens: 4400, completionTokens: 2000 })); // 锚点
    const base = contextUsed(events);
    expect(base).toBe(6400);
    const end3 = events[9]!.seq; // u3 交换的 turn_ended
    const a3 = events[8]!;
    const S2 = "S2 长一点的摘要";
    const after = contextUsed([
      ...events,
      { ...env(), type: "micro_compacted", summary: S2, coversUpTo: end3, model: "cheap" },
    ]);
    // 锚点 prompt 里：u2 段已是 S1，u3 段还是原文。新 micro 顶掉 S1、折掉 a3、加上 S2
    expect(after).toBe(6400 - est(a3) - estimateTokens("S1") + estimateTokens(S2));
  });

  // issue #197：latestMicroCompacted 拒绝 coversUpTo ≤ 最新 compact seq 的
  // "迟到的旧摘要"，microAtAnchor 也必须用同一条有效性规则——
  // 一条被投影拒绝的 micro，它在或不在日志里，圆环读数不能有区别
  it("被投影拒绝的过期 micro（coversUpTo 指向 compact 之前）不影响读数", () => {
    seq = 0;
    const preCompact: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      ...turn("0", { promptTokens: 900, completionTokens: 100 }),
    ];
    const staleCovers = preCompact.at(-1)!.seq; // compact 之前的历史
    const rest: SessionEvent[] = [
      { ...env(), type: "context_compacted", summary: "C", model: "m" },
      ...turn("1"), ...turn("2"),
      ...turn("3", { promptTokens: 4400, completionTokens: 2000 }), // 锚点
    ];
    const stale: SessionEvent = {
      ...env(), type: "micro_compacted", summary: big(4000), coversUpTo: staleCovers, model: "cheap",
    };
    const end2 = rest[6]!.seq; // u2 交换的 turn_ended（compact 后第二个 exchange）
    const fresh: SessionEvent = {
      ...env(), type: "micro_compacted", summary: "S 新", coversUpTo: end2, model: "cheap",
    };
    // stale 插在 compact 之后、锚点之前；fresh 落在锚点之后
    const withStale = [...preCompact, rest[0]!, stale, ...rest.slice(1), fresh];
    const withoutStale = [...preCompact, ...rest, fresh];
    expect(contextUsed(withStale)).toBe(contextUsed(withoutStale));
  });

  it("micro/账单交替 6 轮：读数始终贴着最新账单，不会一路探底到 0", () => {
    seq = 0;
    const events: SessionEvent[] = [{ ...env(), type: "session_created", workspace: "/w" }, ...turn("0")];
    let lastBill = 0;
    for (let k = 1; k <= 6; k++) {
      events.push(...turn(String(k), { promptTokens: 5000, completionTokens: 500 }));
      lastBill = 5500;
      // 折掉最老的未折 exchange（k-1 段）：倒数第 4 个事件是上一轮的 turn_ended（k=2）或上一条 micro（k≥3），seq 都落在 te_{k-1} 与 u_k 之间，刚好整段吸收
      const end = events[events.length - 4]!.seq;
      if (k >= 2) events.push({ ...env(), type: "micro_compacted", summary: `S${k}`, coversUpTo: end, model: "cheap" });
      const used = contextUsed(events);
      expect(used).toBeGreaterThan(lastBill - 1200); // 最多扣掉一段原文（≈500 token）+ 一条短摘要
      expect(used).toBeLessThanOrEqual(lastBill + 50);
    }
  });
});
