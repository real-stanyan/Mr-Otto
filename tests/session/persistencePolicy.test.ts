// 持久化策略（issue #339）：durable/transient 的单点决策。
// 这组测试锁三件事：
// ① 每个 SessionEvent 类型都被判为 durable（日志行为不变）
// ② 每个瞬态推送类型都被判为 transient（delta 类永不落盘，issue #340 的一半）
// ③ EventStore.append 用策略把门：transient 类型运行时被拒
//
// 穷尽性本身由 tsc 保证（persistencePolicy 的 switch + assertNever）：
// 新增事件类型不表态 = 编译红，测试跑不起来——这正是验收条件。

import { describe, expect, it } from "vitest";
import { shouldPersist, type EmittedKind, type TransientPushKind } from "../../src/session/persistencePolicy.js";
import type { SessionEvent } from "../../src/session/events.js";
import { EventStore, type NewSessionEvent } from "../../src/session/store.js";

// 类型级穷尽检查：这两个数组必须恰好覆盖各自的 union——多了少了 tsc 都红。
// （satisfies 挡"写错的成员"，Exclude 检查挡"漏写的成员"。）
const DURABLE: SessionEvent["type"][] = [
  "session_created",
  "user_message",
  "assistant_message",
  "approval_decision",
  "tool_result",
  "model_changed",
  "session_archived",
  "session_renamed",
  "context_compacted",
  "tool_execution_started",
  "turn_ended",
  "skill_invoked",
  "image_described",
  "section_classified",
  "suggestions_generated",
  "subagent_spawned",
  "subagent_briefed",
  "memory_loaded",
  "memory_user_edit",
  "memory_nudge",
  "micro_compacted",
  "session_autotitled",
] satisfies SessionEvent["type"][];
type MissingDurable = Exclude<SessionEvent["type"], (typeof DURABLE)[number]>;
// union 有类型不在数组里时,这行赋值编译红
const durableCovered: MissingDurable extends never ? true : never = true;
void durableCovered;

const TRANSIENT: TransientPushKind[] = [
  "assistant_delta",
  "tool_output",
  "approval_request",
  "ask_user_request",
  "turn_status",
] satisfies TransientPushKind[];
type MissingTransient = Exclude<TransientPushKind, (typeof TRANSIENT)[number]>;
const transientCovered: MissingTransient extends never ? true : never = true;
void transientCovered;

describe("persistencePolicy.shouldPersist", () => {
  it("每个 SessionEvent 类型都判 durable（现有日志行为不变）", () => {
    for (const t of DURABLE) expect(shouldPersist(t), t).toBe(true);
  });

  it("每个瞬态推送类型都判 transient（delta 类永不落盘）", () => {
    for (const t of TRANSIENT) expect(shouldPersist(t), t).toBe(false);
  });

  it("durable + transient 恰好覆盖 EmittedKind（无第三态）", () => {
    // 类型级检查:两个数组并起来 = EmittedKind。漏了哪边这行编译红
    type Missing = Exclude<EmittedKind, (typeof DURABLE)[number] | (typeof TRANSIENT)[number]>;
    const covered: Missing extends never ? true : never = true;
    expect(covered).toBe(true);
  });
});

describe("EventStore.append 的策略闸", () => {
  it("transient 类型混进 union 后落盘会被运行时拒绝", () => {
    const store = new EventStore(":memory:");
    try {
      // 类型系统本挡得住;绕过它模拟"有人把瞬态类型加进 SessionEvent 却判成 transient"
      const rogue = {
        sessionId: "s1",
        ts: 1,
        type: "assistant_delta",
        text: "半成品",
      } as unknown as NewSessionEvent;
      expect(() => store.append(rogue)).toThrow(/transient/);
    } finally {
      store.close();
    }
  });

  it("durable 类型照常落盘（把门不误伤）", () => {
    const store = new EventStore(":memory:");
    try {
      const e = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "hi" });
      expect(e.seq).toBe(0);
      expect(store.load("s1")).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
