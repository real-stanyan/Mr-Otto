// 通话里的应承（#1623）：够换花样、不重复上一句。
import { describe, expect, it } from "vitest";
import { CALL_ACKS, pickCallAck } from "../../src/shared/callAck.js";

describe("callAck", () => {
  it("至少八句；不和上一句一样；rand 落在边界也不越界", () => {
    expect(CALL_ACKS.length).toBeGreaterThanOrEqual(8);
    const first = pickCallAck(null, () => 0);
    expect(pickCallAck(first, () => 0)).not.toBe(first);
    expect(CALL_ACKS).toContain(pickCallAck(null, () => 0.999999));
    expect(CALL_ACKS).toContain(pickCallAck(null, () => 1));
    let prev: string | null = null;
    for (let i = 0; i < 50; i++) { const s = pickCallAck(prev); expect(s).not.toBe(prev); prev = s; }
  });
});
