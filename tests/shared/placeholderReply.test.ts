// 占位回话（#1683 模拟：「（无输出）」「（无补充）」）认得出；正常的话里带括号不误伤
import { describe, expect, it } from "vitest";
import { isPlaceholderReply } from "../../src/shared/placeholderReply.js";

describe("isPlaceholderReply", () => {
  it("整句只是括号里的占位", () => {
    for (const s of ["（无输出）", "（无补充）", "（没接话）", "(no reply)", "(No output)", " [nothing to add] ", "（暂无）"]) expect(isPlaceholderReply(s)).toBe(true);
  });
  it("正常的话、带括号的正文不算", () => {
    for (const s of ["好的（已改到 7:45）", "（附件见上）请查收", "Done (no changes needed to the dates)", "", "无"]) expect(isPlaceholderReply(s)).toBe(false);
  });
});
