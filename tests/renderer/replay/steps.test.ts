import { describe, it, expect } from "vitest";
import { toStep, hl } from "../../../src/renderer/src/replay/steps.js";
import type { SessionEvent } from "../../../src/session/events.js";

// 一段覆盖全部事件类型的真实形状日志（写文件被批准 + 一次 bash 报错）
const log: SessionEvent[] = [
  { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/proj/x" },
  { seq: 1, sessionId: "s", ts: 2, type: "model_changed", provider: "glm", model: "glm-4.5-flash" },
  { seq: 2, sessionId: "s", ts: 3, type: "user_message", content: "写个文件" },
  {
    seq: 3, sessionId: "s", ts: 4, type: "assistant_message", content: "", model: "glm-4.5-flash",
    toolCalls: [{ id: "c1", name: "write_file", args: { path: "a.txt", content: "hi" } }],
  },
  { seq: 4, sessionId: "s", ts: 5, type: "approval_decision", toolCallId: "c1", decision: "approved" },
  { seq: 5, sessionId: "s", ts: 6, type: "tool_result", toolCallId: "c1", status: "ok", output: "已写入" },
  {
    seq: 6, sessionId: "s", ts: 7, type: "assistant_message", content: "写好了", model: "glm-4.5-flash",
    toolCalls: [{ id: "c2", name: "bash", args: { command: "boom" } }],
  },
  { seq: 7, sessionId: "s", ts: 8, type: "tool_result", toolCallId: "c2", status: "error", output: "炸了" },
  { seq: 8, sessionId: "s", ts: 9, type: "assistant_message", content: "收尾", model: "glm-4.5-flash" },
  {
    seq: 9, sessionId: "s", ts: 10, type: "context_compacted",
    summary: "写了文件，bash 炸过一次", model: "glm-4.5-flash",
    usage: { promptTokens: 500, completionTokens: 60 },
  },
  { seq: 10, sessionId: "s", ts: 11, type: "session_archived" },
];

const steps = log.map((e, i) => toStep(e, i, log));
/** 测试数据是写死的，索引必中——用断言器收窄 noUncheckedIndexedAccess */
const at = (i: number) => steps[i]!;
const ev = (i: number) => log[i]!;

describe("toStep：事件 → 画布高亮 + 函数轨迹", () => {
  it("每种事件都映射出节点、轨迹，且以 EventStore.append 落盘", () => {
    for (const s of steps) {
      expect(s.nodes.length, s.title).toBeGreaterThan(0);
      expect(s.fns.length, s.title).toBeGreaterThan(0);
      expect(s.fns.some((f) => f.n === "EventStore.append()"), s.title).toBe(true);
    }
  });

  it("链条有头有尾：每步都有输入卡，最后一格函数必带 out（末端输出卡）", () => {
    for (const s of steps) {
      expect(s.input, s.title).toBeTruthy();
      expect(s.fns.at(-1)!.out, s.title).toBeTruthy();
    }
  });

  it("tool_result ok：从日志找回 toolCall，工具文件与 world 调用对上号", () => {
    const s = at(5);
    expect(s.deny).toBe(false);
    expect(s.nodes).toContain("n-world");
    expect(s.fns.some((f) => f.f === "tools/writeFile.ts")).toBe(true);
    expect(s.fns.some((f) => f.n.includes("world.fs.write"))).toBe(true);
    // c1 走过审批 → 门的说法是 approved 放行，不是免审直通
    expect(s.fns[0]!.io).toContain("approved");
  });

  it("tool_result error：免审工具直通 + catch 兜错，红色系", () => {
    const s = at(7);
    expect(s.deny).toBe(true);
    expect(s.badge).toBe("error");
    // c2（bash）日志里没有 approval_decision → 门的说法是免审直通
    expect(s.fns[0]!.io).toContain("requiresApproval = false");
    expect(s.fns.some((f) => f.n.includes("catch"))).toBe(true);
  });

  it("tool_result denied：执行链整段 skip，世界没被碰", () => {
    const deniedLog: SessionEvent[] = [
      ev(3),
      { seq: 4, sessionId: "s", ts: 5, type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "别写" },
      { seq: 5, sessionId: "s", ts: 6, type: "tool_result", toolCallId: "c1", status: "denied", output: "用户拒绝" },
    ];
    const s = toStep(deniedLog[2]!, 2, deniedLog);
    expect(s.deny).toBe(true);
    expect(s.nodes).not.toContain("n-tool");
    expect(s.nodes).not.toContain("n-world");
    const skipped = s.fns.filter((f) => f.skip);
    expect(skipped.length).toBeGreaterThanOrEqual(4);
    expect(skipped.some((f) => f.f === "tools/writeFile.ts")).toBe(true);
  });

  it("assistant_message：带 toolCalls = 要调工具，不带 = 收口", () => {
    expect(at(3).badge).toBe("要调工具");
    expect(at(8).badge).toBe("收口");
    // 数据卡里能看到真实调用参数
    expect(at(3).fns.map((f) => f.out).join()).toContain("write_file");
  });

  it("context_compacted：/compact 走 引擎 → adapter → 落盘，token 账单可见", () => {
    const s = at(9);
    expect(s.badge).toBe("压缩");
    expect(s.input).toContain("/compact");
    expect(s.nodes).toContain("n-adapter"); // 真实模型调用
    expect(s.fns.some((f) => f.n.includes("adapter.chat"))).toBe(true);
    expect(s.fns.map((f) => f.out).join()).toContain("560 tokens"); // 500 + 60
  });

  it("approval_decision denied 红色系；approved 绿色系", () => {
    expect(at(4).deny).toBe(false);
    const denied = toStep(
      { seq: 4, sessionId: "s", ts: 5, type: "approval_decision", toolCallId: "c1", decision: "denied" },
      0,
      log
    );
    expect(denied.deny).toBe(true);
  });
});

describe("hl：数据卡迷你高亮器", () => {
  it("key（后跟冒号）与普通字符串分开着色", () => {
    const toks = hl('{ "path": "a.txt" }');
    expect(toks.find((t) => t.text === '"path"')?.cls).toBe("hk");
    expect(toks.find((t) => t.text === '"a.txt"')?.cls).toBe("hs");
  });

  it("数字 / 关键字 / 标识符各归各类，素色文字原样保留", () => {
    const toks = hl("seq = 42 → return foo");
    expect(toks.find((t) => t.text === "42")?.cls).toBe("hd");
    expect(toks.find((t) => t.text === "return")?.cls).toBe("hw");
    expect(toks.find((t) => t.text === "foo")?.cls).toBe("hv");
    // 拼回去 = 原文（一个字都不丢——高亮器只染色不改内容）
    expect(toks.map((t) => t.text).join("")).toBe("seq = 42 → return foo");
  });
});
