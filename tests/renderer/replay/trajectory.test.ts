import { describe, it, expect } from "vitest";
import {
  buildTrajectory,
  rowMatches,
  rowExtent,
  rowSpans,
  toolDurationMs,
  formatMs,
} from "../../../src/renderer/src/replay/trajectory.js";
import type { SessionEvent } from "../../../src/session/events.js";

// 两个 turn：写文件（审批 + 执行），bash 报错，turn 暴死
const log: SessionEvent[] = [
  { seq: 0, sessionId: "s", ts: 1000, type: "session_created", workspace: "/proj/x" },
  { seq: 1, sessionId: "s", ts: 1001, type: "model_changed", provider: "glm", model: "glm-4.5-flash" },
  { seq: 2, sessionId: "s", ts: 2000, type: "user_message", content: "写个文件" },
  {
    seq: 3, sessionId: "s", ts: 3000, type: "assistant_message", content: "", model: "glm-4.5-flash",
    toolCalls: [{ id: "c1", name: "write_file", args: { path: "a.txt", content: "hi" } }],
  },
  { seq: 4, sessionId: "s", ts: 3500, type: "approval_decision", toolCallId: "c1", decision: "approved" },
  { seq: 5, sessionId: "s", ts: 4000, type: "tool_execution_started", toolCallId: "c1" },
  { seq: 6, sessionId: "s", ts: 4800, type: "tool_result", toolCallId: "c1", status: "ok", output: "已写入" },
  { seq: 7, sessionId: "s", ts: 5000, type: "assistant_message", content: "写好了", model: "glm-4.5-flash" },
  { seq: 8, sessionId: "s", ts: 5001, type: "turn_ended", outcome: "completed" },
  { seq: 9, sessionId: "s", ts: 6000, type: "user_message", content: "跑一下" },
  {
    seq: 10, sessionId: "s", ts: 7000, type: "assistant_message", content: "", model: "glm-4.5-flash",
    toolCalls: [{ id: "c2", name: "bash", args: { command: "boom" } }],
  },
  { seq: 11, sessionId: "s", ts: 7900, type: "tool_result", toolCallId: "c2", status: "error", output: "炸了" },
  { seq: 12, sessionId: "s", ts: 8000, type: "turn_ended", outcome: "error", error: "后来炸了" },
  { seq: 13, sessionId: "s", ts: 8001, type: "section_classified", title: "x", model: "m", usage: { promptTokens: 1, completionTokens: 1 } },
];

const traj = buildTrajectory(log);

describe("buildTrajectory：一步一行，工具调用合成一行", () => {
  it("工具请求展开成独立行，approval/started/result 并入，不单独占行", () => {
    const kinds = traj.rows.map((r) => r.kind);
    expect(kinds).toEqual([
      "system", "system",          // turn 0
      "user", "assistant", "tool", "assistant", "system",
      "user", "assistant", "tool", "system",
    ]);
    const c1 = traj.rows.find((r) => r.key === "c1")!;
    expect(c1.approval?.decision).toBe("approved");
    expect(c1.started?.seq).toBe(5);
    expect(c1.result?.output).toBe("已写入");
  });

  it("turn 从第一条 user_message 起计，之前的是 turn 0；step 在 turn 内从 1 起", () => {
    expect(traj.turns).toBe(2);
    expect(traj.rows[0]).toMatchObject({ turn: 0, step: 1 });
    expect(traj.rows[2]).toMatchObject({ turn: 1, step: 1, kind: "user" });
    expect(traj.rows[4]).toMatchObject({ turn: 1, step: 3, kind: "tool" });
    expect(traj.rows[7]).toMatchObject({ turn: 2, step: 1 });
  });

  it("摘要：工具行 = 名字 + 参数 → 输出首行；纯工具调用的回复标 (tool call only)", () => {
    expect(traj.rows[4]!.summary).toBe('write_file {"path":"a.txt","content":"hi"} → 已写入');
    expect(traj.rows[3]!.summary).toBe("(tool call only)");
  });

  it("出错的工具 / turn 暴死标红，其余不标", () => {
    expect(traj.rows.find((r) => r.key === "c2")!.deny).toBe(true);
    expect(traj.rows.find((r) => r.key === "c1")!.deny).toBe(false);
    expect(traj.rows[10]!.deny).toBe(true);
    expect(traj.rows[6]!.deny).toBe(false);
  });

  it("给人看的目录事件不占行；时间轴端点取首尾事件 ts", () => {
    expect(traj.rows.some((r) => r.ev.type === "section_classified")).toBe(false);
    expect(traj.startTs).toBe(1000);
    expect(traj.endTs).toBe(8001);
  });

  it("泳道：用户/系统 → input，回复 → model，工具 → tools", () => {
    expect(traj.rows[2]!.lane).toBe("input");
    expect(traj.rows[0]!.lane).toBe("input");
    expect(traj.rows[3]!.lane).toBe("model");
    expect(traj.rows[4]!.lane).toBe("tools");
  });
});

describe("toolDurationMs：真执行耗时 = result − started，审批等待不计", () => {
  it("有 started 就算", () => {
    expect(toolDurationMs(traj.rows.find((r) => r.key === "c1")!)).toBe(800);
  });
  it("旧日志没有 started → null，不编", () => {
    expect(toolDurationMs(traj.rows.find((r) => r.key === "c2")!)).toBeNull();
  });
});

describe("rowSpans：三道互斥接续，一行的起点 = 上一行的终点", () => {
  const spans = rowSpans(traj);
  it("user 行从上一行终点到自己的 ts", () => {
    expect(spans[2]).toEqual({ start: 1001, end: 2000 });
  });
  it("assistant 行 = 上一行终点 → 消息落盘时刻（生成期间）", () => {
    expect(spans[3]).toEqual({ start: 2000, end: 3000 });
  });
  it("tool 行 = started → result；审批等待算在前面", () => {
    expect(spans[4]).toEqual({ start: 4000, end: 4800 });
  });
  it("旧日志没有 started 的 tool：从上一行终点起，到 result", () => {
    expect(spans[9]).toEqual({ start: 7000, end: 7900 });
  });
  it("区间单调不回头", () => {
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
  });
});

describe("rowExtent：三种刻度", () => {
  const spans = rowSpans(traj);
  it("duration 按墙钟区间等比", () => {
    const [a, b] = rowExtent(traj.rows[4]!, traj, "duration", 4, spans);
    expect(a).toBeCloseTo(3000 / 7001);
    expect(b).toBeCloseTo(3800 / 7001);
  });
  it("calls 按行序均分，首尾贴边", () => {
    expect(rowExtent(traj.rows[0]!, traj, "calls", 0, spans)[0]).toBe(0);
    expect(rowExtent(traj.rows[10]!, traj, "calls", 10, spans)[1]).toBe(1);
  });
  it("turns 每个 turn 等宽，turn 2 的行落在最后三分之一", () => {
    const [a, b] = rowExtent(traj.rows[7]!, traj, "turns", 7, spans);
    expect(a).toBeGreaterThanOrEqual(2 / 3);
    expect(b).toBeLessThanOrEqual(1);
  });
  it("单行日志不除零", () => {
    const one = buildTrajectory([log[0]!]);
    expect(rowExtent(one.rows[0]!, one, "duration", 0, rowSpans(one))).toEqual([0, 1]);
  });
});

describe("rowMatches：搜索命中摘要 / 参数 / 输出", () => {
  const c1 = traj.rows.find((r) => r.key === "c1")!;
  it("空查询全命中", () => expect(rowMatches(c1, "  ")).toBe(true));
  it("命中参数里的文件名（大小写不敏感）", () => expect(rowMatches(c1, "A.TXT")).toBe(true));
  it("命中输出", () => expect(rowMatches(c1, "已写入")).toBe(true));
  it("不命中", () => expect(rowMatches(c1, "nope")).toBe(false));
});

describe("formatMs", () => {
  it("毫秒 / 秒 / 分", () => {
    expect(formatMs(350)).toBe("350 ms");
    expect(formatMs(2350)).toBe("2.35 s");
    expect(formatMs(125_000)).toBe("2 min 5 s");
  });
});

describe("branch_checked_out 的轨迹摘要（issue #411）", () => {
  const at = (e: Partial<SessionEvent>): SessionEvent =>
    ({ seq: 1, sessionId: "s", ts: 1000, type: "branch_checked_out", repoDir: "/proj/x", ...e }) as SessionEvent;

  it("知道从哪来就写成 a → b —— 只写落点的话读的人得自己往上翻", () => {
    const t = buildTrajectory([at({ branch: "feature/x", from: "main" })]);
    expect(t.rows[0]!.summary).toBe("branch main → feature/x");
  });

  it("detached HEAD（from 缺席）只写落点，不编一个来处", () => {
    const t = buildTrajectory([at({ branch: "feature/x" })]);
    expect(t.rows[0]!.summary).toBe("branch → feature/x");
  });
});

// ADR-0122 D8：用户必须知道是谁把说明书塞进上下文的。这件事在聊天区成立
// （skillCardLabel），在轨迹视图里也得成立——AGENTS.md 把轨迹视图列为一个真实界面
describe("skill 的启用/停用在轨迹里怎么写（ADR-0122 D8）", () => {
  const at = (e: Partial<SessionEvent>): SessionEvent =>
    ({ seq: 1, sessionId: "s", ts: 1000, ...e }) as SessionEvent;

  it("模型自取的标出来源，不再伪装成用户敲的 $tdd", () => {
    const t = buildTrajectory([
      at({ type: "skill_invoked", name: "tdd", content: "先写测试", source: "model" }),
    ]);
    expect(t.rows[0]!.summary).toBe("Otto 启用了 skill「tdd」 先写测试");
    expect(t.rows[0]!.summary.startsWith("$")).toBe(false);
  });

  it("用户 $ 启用的（旧日志无 source 字段）写「已启用」，args 带出来", () => {
    const t = buildTrajectory([
      at({ type: "skill_invoked", name: "caveman", content: "少说话", args: "ultra" }),
    ]);
    expect(t.rows[0]!.summary).toBe("已启用 skill「caveman」（参数：ultra） 少说话");
  });

  it("停用占一行，且说得出停的是哪一把——落 default 的话只有光秃秃的事件类型名", () => {
    const t = buildTrajectory([at({ type: "skill_released", name: "tdd" })]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.summary).toBe("已停用 skill「tdd」");
  });

  // R1 修复：skill_released 事件只带 { type, name }，没有 source 字段，
  // 任何投影都无法归因于谁发起的停用——"system" 是唯一诚实的 kind。
  // "user" 会让 TrajectoryView 给它挂绿色 USER 徽章，在唯一回答「agent 做了什么」
  // 的视图里，把模型自己发起的 release 说成是用户干的
  it("停用行不是 kind: user——没有 source 字段就不能栽给用户", () => {
    const t = buildTrajectory([at({ type: "skill_released", name: "tdd" })]);
    expect(t.rows[0]!.kind).not.toBe("user");
    expect(t.rows[0]!.kind).toBe("system");
  });
});
