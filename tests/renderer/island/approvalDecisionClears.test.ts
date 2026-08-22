import { describe, it, expect } from "vitest";
import { clearApprovalOnDecision } from "../../../src/renderer/src/store.js";
import type { SessionEvent } from "../../../src/session/events.js";

const req = { sessionId: "s1", call: { id: "c1", name: "bash", args: {} }, toolDescription: "" };
const decision = (toolCallId: string): SessionEvent =>
  ({ seq: 1, sessionId: "s1", ts: 0, type: "approval_decision", toolCallId, decision: "approved" }) as SessionEvent;

describe("clearApprovalOnDecision(岛上点了,主窗那张卡也得收)", () => {
  it("同 toolCallId 的 approval_decision 收掉该会话的卡", () => {
    expect(clearApprovalOnDecision({ s1: req }, decision("c1"))).toEqual({});
  });
  it("id 对不上 / 非审批事件不动", () => {
    expect(clearApprovalOnDecision({ s1: req }, decision("zzz"))).toEqual({ s1: req });
  });
});
