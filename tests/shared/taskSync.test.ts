import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type ExecutorChangedEvent, type SessionEvent } from "../../src/session/events.js";
import {
  attachmentRefsOf, currentExecutor, divergence, executorChangeFor, executorOfLog, HUMAN_EVENT_TYPES, holderId,
  holderKindOf, isTaskSessionCreated, lastUnanswered, PEN_VERDICTS, sameEvent, sliceBatches, TASK_EVENT_MAX_BYTES,
} from "../../src/shared/taskSync.js";

let seq = 0;
const ev = (e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent =>
  ({ seq: seq++, sessionId: "s", ts: 1, ...e }) as unknown as SessionEvent;
const reset = () => { seq = 0; };

describe("PEN_VERDICTS（#1223）", () => {
  it("每个已知事件类型都表过态；人话那批是且只是 spec §3.8 列的那 12 种", () => {
    expect([...Object.keys(PEN_VERDICTS)].sort()).toEqual([...KNOWN_EVENT_TYPES].sort());
    expect([...HUMAN_EVENT_TYPES].sort()).toEqual([
      "branch_checked_out", "image_model_changed", "memory_user_edit", "model_changed", "session_archived",
      "session_created", "session_renamed", "session_shared", "session_topic_set", "session_unarchived",
      "share_grant_note", "user_message",
    ]);
    expect(PEN_VERDICTS.assistant_message).toBe("executor");
    expect(PEN_VERDICTS.executor_changed).toBe("executor");
  });
});

describe("holder", () => {
  it("形状与反解", () => {
    expect(holderId("desktop", "abc")).toBe("desktop:abc");
    expect(holderId("cloud", "ignored")).toBe("cloud");
    expect(holderKindOf("desktop:abc")).toBe("desktop");
    expect(holderKindOf("cloud")).toBe("cloud");
    expect(holderKindOf("phone:x")).toBe("phone");
    expect(holderKindOf(null)).toBeNull();
    expect(holderKindOf("garbage")).toBeNull();
  });
});

describe("currentExecutor / executorOfLog", () => {
  it("一条都没有 = 桌面；最后一条胜出；label 跟着最后一条桌面事件", () => {
    reset();
    expect(currentExecutor(null)).toBe("desktop");
    const a = ev({ type: "executor_changed", executor: "cloud", ignorable: true });
    const b = ev({ type: "executor_changed", executor: "desktop", label: "MacBook", ignorable: true });
    expect(currentExecutor(a as never)).toBe("cloud");
    expect(executorOfLog([a])).toEqual({ kind: "cloud", label: null });
    expect(executorOfLog([a, b])).toEqual({ kind: "desktop", label: "MacBook" });
  });
});

describe("lastUnanswered", () => {
  it("最后一条人话之后没有 turn_ended = 没答；aborted 算答过；interrupted 算没答；后台回注不算人话", () => {
    reset();
    const created = ev({ type: "session_created", workspace: "/w" });
    const u1 = ev({ type: "user_message", content: "a" });
    expect(lastUnanswered([created, u1])).toMatchObject({ seq: 1 });
    const done = ev({ type: "turn_ended", outcome: "completed" });
    expect(lastUnanswered([created, u1, done])).toBeNull();
    const u2 = ev({ type: "user_message", content: "b" });
    const aborted = ev({ type: "turn_ended", outcome: "aborted" });
    expect(lastUnanswered([created, u1, done, u2, aborted])).toBeNull();
    const u3 = ev({ type: "user_message", content: "c" });
    const interrupted = ev({ type: "turn_ended", outcome: "interrupted" });
    expect(lastUnanswered([created, u1, done, u2, aborted, u3, interrupted])).toMatchObject({ seq: u3.seq });
    const bg = ev({ type: "user_message", content: "[后台任务]", origin: "background" });
    expect(lastUnanswered([created, u1, done, bg])).toBeNull();
  });
});

describe("divergence", () => {
  it("重叠段逐条相等 = none；第一处不同的 seq + 本地那截有没有 executor 类事件", () => {
    reset();
    const a = ev({ type: "user_message", content: "x" });
    const b = ev({ type: "assistant_message", content: "y", model: "m" });
    expect(divergence([a, b], [a])).toEqual({ kind: "none" });
    expect(divergence([a], [a, b])).toEqual({ kind: "none" });
    // 同 seq 不同内容
    const b2 = { ...b, content: "z" } as SessionEvent;
    expect(divergence([a, b], [a, b2])).toEqual({ kind: "has_executor", at: 1 });
    const rename = { ...b, type: "session_renamed", title: "t" } as unknown as SessionEvent;
    expect(divergence([a, rename], [a, b2])).toEqual({ kind: "human_only", at: 1 });
  });
  it("键顺序不同的同一条事件算相等", () => {
    const x = { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "a" } as SessionEvent;
    const y = { type: "user_message", content: "a", ts: 1, sessionId: "s", seq: 0 } as SessionEvent;
    expect(sameEvent(x, y)).toBe(true);
  });
});

describe("sliceBatches / attachmentRefsOf / isTaskSessionCreated", () => {
  it("按字节切批，单条超限也自成一批而不是丢掉", () => {
    reset();
    const small = ev({ type: "user_message", content: "hi" });
    const big = ev({ type: "tool_result", toolCallId: "c", ok: true, output: "x".repeat(TASK_EVENT_MAX_BYTES) });
    const batches = sliceBatches([small, big, small], TASK_EVENT_MAX_BYTES);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(sliceBatches([small, small], TASK_EVENT_MAX_BYTES)).toHaveLength(1);
  });
  it("按 UTF-8 字节切批，不按 UTF-16 code unit——中文内容差三倍（#1223 复审）", () => {
    reset();
    const zh1 = ev({ type: "user_message", content: "中".repeat(1500) });
    const zh2 = ev({ type: "user_message", content: "中".repeat(1500) });
    // UTF-16 code unit 数（旧的错误度量）在 4000 以内，但真实 UTF-8 字节数超过 4000
    expect(JSON.stringify(zh1).length).toBeLessThan(4000);
    expect(sliceBatches([zh1, zh2], 4000)).toHaveLength(2);
  });
  it("附件引用：user_message.attachments 与 tool_result.images 的 id", () => {
    reset();
    const ref = { id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 3 };
    expect(attachmentRefsOf(ev({ type: "user_message", content: "", attachments: [ref] }))).toEqual([ref.id]);
    expect(attachmentRefsOf(ev({ type: "tool_result", toolCallId: "c", ok: true, output: "", images: [ref] }))).toEqual([ref.id]);
    expect(attachmentRefsOf(ev({ type: "turn_ended", outcome: "completed" }))).toEqual([]);
  });
  it("任务会话 = workspaceKind default 且没有 spawnedBy", () => {
    reset();
    expect(isTaskSessionCreated(ev({ type: "session_created", workspaceKind: "default" }))).toBe(true);
    expect(isTaskSessionCreated(ev({ type: "session_created", workspaceKind: "default", spawnedBy: { sessionId: "p", toolCallId: "c", agent: "a" } }))).toBe(false);
    expect(isTaskSessionCreated(ev({ type: "session_created", workspace: "/repo" }))).toBe(false);
    expect(isTaskSessionCreated(undefined)).toBe(false);
  });
});

describe("executorChangeFor（#1223 终审 I1）", () => {
  const last = (executor: "desktop" | "cloud", label?: string): ExecutorChangedEvent =>
    ({ seq: 5, sessionId: "s", ts: 1, type: "executor_changed", executor, ignorable: true, ...(label ? { label } : {}) });
  it("一条都没有 + 刚新建了任务文件夹：落，且带 freshWorkspace", () => {
    // Mac B 第一次接手 Mac A 的会话就长这样：旧判据（last !== null）永远落不下第一条
    expect(executorChangeFor({ last: null, hostname: "B", fresh: true })).toEqual({ label: "B", freshWorkspace: true });
  });
  it("一条都没有 + 文件夹是接着用的：不落（存量日志逐字节不变）", () => {
    expect(executorChangeFor({ last: null, hostname: "A", fresh: false })).toBeNull();
  });
  it("上一条是云端：落，不带 fresh", () => {
    expect(executorChangeFor({ last: last("cloud"), hostname: "A", fresh: false })).toEqual({ label: "A" });
  });
  it("上一条是同一台桌面：不落", () => {
    expect(executorChangeFor({ last: last("desktop", "A"), hostname: "A", fresh: false })).toBeNull();
  });
  it("上一条是另一台桌面：落", () => {
    expect(executorChangeFor({ last: last("desktop", "A"), hostname: "B", fresh: false })).toEqual({ label: "B" });
  });
});
