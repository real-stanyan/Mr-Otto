import { describe, it, expect } from "vitest";
import {
  buildTrajectory,
  rowMatches,
  rowPosition,
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

describe("rowPosition：三种刻度", () => {
  it("duration 按墙钟等比", () => {
    expect(rowPosition(traj.rows[0]!, traj, "duration", 0)).toBe(0);
    expect(rowPosition(traj.rows[10]!, traj, "duration", 10)).toBeCloseTo(7000 / 7001);
  });
  it("calls 按行序均分", () => {
    expect(rowPosition(traj.rows[0]!, traj, "calls", 0)).toBe(0);
    expect(rowPosition(traj.rows[10]!, traj, "calls", 10)).toBe(1);
  });
  it("turns 每个 turn 等宽，turn 2 的行落在最后三分之一", () => {
    const p = rowPosition(traj.rows[7]!, traj, "turns", 7);
    expect(p).toBeGreaterThan(2 / 3);
    expect(p).toBeLessThan(1);
  });
  it("单行日志不除零", () => {
    const one = buildTrajectory([log[0]!]);
    expect(rowPosition(one.rows[0]!, one, "duration", 0)).toBe(0);
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
