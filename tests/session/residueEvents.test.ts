import { describe, it, expect } from "vitest";
import { pendingResidue } from "../../src/session/residueProjection.js";
import type { SessionEvent } from "../../src/session/events.js";

const item = (id: string) => ({
  detector: "simulators" as const,
  id,
  label: id,
  confidence: "suspected" as const,
  cleanupHint: `simctl shutdown ${id}`,
});
const base = { sessionId: "s1", ts: 0 };

describe("pendingResidue", () => {
  it("detected 减 cleaned = 差集；重复 detected 不重复计", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA"), item("BBB")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: true }, ignorable: true },
      { ...base, seq: 3, type: "residue_detected", items: [item("BBB")], ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events).map((i) => i.id)).toEqual(["BBB"]);
  });

  it("清理失败但已消失（kind:'gone'）也算清掉——别永远挂着", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, kind: "gone", note: "已消失" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });

  // issue #759 review C1d：这一条是 Critical 的核心——清理失败的进程组仍在运行，
  // 差集把它删掉 = 它永远不会被重放，用户再也看不到那个还在烧 CPU 的组
  it("kind:'failed'（信号发了、进程还活着）**不算清**，条目留在表里", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      {
        ...base, seq: 2, type: "residue_cleaned", item: item("AAA"),
        result: { id: "AAA", ok: false, kind: "failed", note: "已发送 SIGTERM/SIGKILL，进程组仍存活" },
        ignorable: true,
      },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events).map((i) => i.id)).toEqual(["AAA"]);
  });

  it("kind:'skipped'（仅展示，明确不清）算了结——不再挂在清单上", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, kind: "skipped", note: "仅展示，不提供清理" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });

  it("旧日志的 residue_cleaned 没有 kind 字段——向后兼容按已清对待", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      // 老版本落的那条：只有 ok/note，没有 kind
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, note: "已消失" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });

  it("failed 之后又来一条 cleaned——最终按 cleaned 摘掉（事件顺序消费）", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, kind: "failed" }, ignorable: true },
      { ...base, seq: 3, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: true, kind: "cleaned" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });
});
