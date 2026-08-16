import { describe, expect, it } from "vitest";
import { diffLines } from "../../src/shared/diff.js";

describe("diffLines", () => {
  it("完全相同 → 全 same", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("新文件（旧内容为空串）→ 空行对齐后其余全 add", () => {
    const lines = diffLines("", "x\ny")!;
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["x", "y"]);
    expect(lines.some((l) => l.kind === "del")).toBe(false);
  });

  it("中段替换：先删后加，两侧上下文保持 same", () => {
    expect(diffLines("a\nold\nz", "a\nnew\nz")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      { kind: "same", text: "z" },
    ]);
  });

  it("同一变更块内多删多加也是删聚一起、加聚一起（人读 diff 的顺序）", () => {
    const lines = diffLines("a\nx1\nx2\nz", "a\ny1\ny2\nz")!;
    expect(lines.map((l) => l.kind)).toEqual(["same", "del", "del", "add", "add", "same"]);
  });

  it("纯删除 / 纯新增", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
    ]);
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("超过 DP 规模上限 → null（调用方退回不展示 diff）", () => {
    const big = Array.from({ length: 2100 }, (_, i) => `行${i}`).join("\n");
    expect(diffLines(big, big + "\n尾巴")).toBeNull();
  });
});
