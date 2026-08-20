import { describe, it, expect } from "vitest";
import { sessionGrants, grantLabel } from "../../src/shared/permissionGrants.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const ev = (e: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent =>
  ({ seq: seq++, sessionId: "s1", ts: 1000 + seq, ...e }) as SessionEvent;

const called = (id: string, name: string): SessionEvent =>
  ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id, name, args: {} }] });

describe("sessionGrants", () => {
  it("空日志 = 什么都没授过", () => {
    expect(sessionGrants([])).toEqual(new Set());
  });

  it("批准 + grant 才算授权;只批这一次不算", () => {
    const events = [
      called("c1", "write_file"),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("批准 + grant:session → 该工具进名单", () => {
    const events = [
      called("c1", "write_file"),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set(["write_file"]));
  });

  it("授的是工具,不是那一次调用 —— 同一个工具的别的调用也算数", () => {
    const events = [
      called("c1", "bash"),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "always" }),
    ];
    expect(sessionGrants(events).has("bash")).toBe(true);
  });

  it("拒绝就算带着 grant 也不算数 —— 日志是外部输入,不赌形状", () => {
    const events = [
      called("c1", "write_file"),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", grant: "always" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("对不上号的决定不算授权 —— 不知道是哪个工具就不能放行", () => {
    const events = [
      ev({ type: "approval_decision", toolCallId: "不存在", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set());
  });

  it("多个工具各授各的", () => {
    const events = [
      called("c1", "write_file"),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved", grant: "session" }),
      called("c2", "bash"),
      ev({ type: "approval_decision", toolCallId: "c2", decision: "approved", grant: "session" }),
    ];
    expect(sessionGrants(events)).toEqual(new Set(["write_file", "bash"]));
  });
});

describe("grantLabel", () => {
  it("档位有中文名 —— 日志 reason 里那句话得自解释", () => {
    expect(grantLabel("session")).toBe("本次会话");
    expect(grantLabel("always")).toBe("永久");
  });
});
