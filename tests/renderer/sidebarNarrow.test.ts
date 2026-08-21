import { describe, it, expect } from "vitest";
import { AUTO_COLLAPSE_WIDTH, isNarrowWidth } from "../../src/renderer/src/lib/sidebarNarrow.js";

describe("isNarrowWidth", () => {
  it("低于阈值判窄", () => {
    expect(isNarrowWidth(AUTO_COLLAPSE_WIDTH - 1)).toBe(true);
    expect(isNarrowWidth(0)).toBe(true);
  });

  it("达到或超过阈值不判窄", () => {
    expect(isNarrowWidth(AUTO_COLLAPSE_WIDTH)).toBe(false);
    expect(isNarrowWidth(AUTO_COLLAPSE_WIDTH + 1)).toBe(false);
  });
});
