import { describe, expect, it } from "vitest";
import {
  assertReplayable,
  KNOWN_EVENT_TYPES,
  UnknownSessionEventError,
  type SessionEvent,
} from "../../src/session/events.js";

// 向前兼容拒读（issue #383，dsh ignorable 对照）：旧代码读新版本写的日志——
// 未知且未标 ignorable 的事件类型必须拒绝重建，不许静默跳过。

const base = { sessionId: "s1", ts: 1 };

describe("assertReplayable（issue #383）", () => {
  it("全部已知类型：放行", () => {
    const log: SessionEvent[] = [
      { ...base, seq: 0, type: "session_created", workspace: "/w" },
      { ...base, seq: 1, type: "user_message", content: "你好" },
    ];
    expect(() => assertReplayable(log)).not.toThrow();
  });

  it("未知类型且无 ignorable：拒读，话术指向升级而不是修库", () => {
    const log = [
      { ...base, seq: 0, type: "session_created", workspace: "/w" },
      { ...base, seq: 1, type: "quantum_entangled", payload: "?" },
    ] as unknown as SessionEvent[];
    expect(() => assertReplayable(log)).toThrow(UnknownSessionEventError);
    try {
      assertReplayable(log);
    } catch (e) {
      const err = e as UnknownSessionEventError;
      expect(err.eventType).toBe("quantum_entangled");
      expect(err.seq).toBe(1);
      expect(err.message).toContain("升级");
    }
  });

  it("未知类型但标了 ignorable：放行（新版本声明了'跳过安全'）", () => {
    const log = [
      { ...base, seq: 0, type: "session_created", workspace: "/w" },
      { ...base, seq: 1, type: "quantum_entangled", ignorable: true },
    ] as unknown as SessionEvent[];
    expect(() => assertReplayable(log)).not.toThrow();
  });

  it("KNOWN_EVENT_TYPES 与 union 同步（编译期由 Record 键约束保证，这里钉住基数下限）", () => {
    // 撞见这条红：新加的事件类型忘了进 KNOWN_EVENT_TYPES_MAP（tsc 应该先红——
    // 这里是防 map 被改成宽类型的最后一道绳）
    expect(KNOWN_EVENT_TYPES.size).toBeGreaterThanOrEqual(25);
    expect(KNOWN_EVENT_TYPES.has("request_envelope")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("user_message")).toBe(true);
  });
});
