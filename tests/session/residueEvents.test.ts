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

  it("清理失败但已消失（ok:false + note）也算清掉——别永远挂着", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, note: "已消失" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });
});
