import { describe, it, expect } from "vitest";
import { diffView } from "../../src/renderer/src/lib/diffView.js";

describe("diffView", () => {
  it("新文件:全是 added,删除计数为 0", () => {
    const v = diffView(null, "a\nb");
    expect(v).toEqual({
      lines: [
        { kind: "added", text: "a" },
        { kind: "added", text: "b" },
      ],
      additions: 2,
      deletions: 0,
    });
  });

  it("改一行:一删一加,计数各 1", () => {
    const v = diffView("a", "b");
    expect(v?.additions).toBe(1);
    expect(v?.deletions).toBe(1);
    expect(v?.lines.map((l) => l.kind)).toEqual(["removed", "added"]);
  });

  it("短的未变段原样留着 —— 折叠它反而更占地方", () => {
    // 5 行未变 = 上下文上限(2*2+1),不折
    const same = ["1", "2", "3", "4", "5"];
    const v = diffView(["x", ...same].join("\n"), ["y", ...same].join("\n"));
    expect(v?.lines.filter((l) => l.kind === "skip")).toHaveLength(0);
    expect(v?.lines.filter((l) => l.kind === "context")).toHaveLength(5);
  });

  it("长的未变段抽掉中间,首尾各留两行,中间换成一句计数", () => {
    const same = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const v = diffView(["x", ...same].join("\n"), ["y", ...same].join("\n"));
    const kinds = v!.lines.map((l) => l.kind);
    expect(kinds).toEqual([
      "removed",
      "added",
      "context",
      "context",
      "skip",
      "context",
      "context",
    ]);
    expect(v!.lines.find((l) => l.kind === "skip")?.text).toBe("… 6 行未变 …");
  });

  it("折叠行不进增删计数 —— 它是一句说明,不是一行改动", () => {
    const same = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const v = diffView(same.join("\n"), [...same, "new"].join("\n"));
    expect(v?.additions).toBe(1);
    expect(v?.deletions).toBe(0);
  });

  it("没改:全是 context,增删都是 0", () => {
    const v = diffView("a\nb", "a\nb");
    expect(v?.additions).toBe(0);
    expect(v?.deletions).toBe(0);
    expect(v?.lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("算不动的超大文件返回 null,调用方据此退回文本兜底", () => {
    const huge = Array.from({ length: 2100 }, (_, i) => String(i)).join("\n");
    const other = Array.from({ length: 2100 }, (_, i) => String(i * 2)).join("\n");
    expect(diffView(huge, other)).toBeNull();
  });
});
