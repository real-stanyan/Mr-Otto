import { describe, expect, it } from "vitest";
import { layoutFlow } from "../../src/renderer/src/lib/flowLayout.js";

const n = (id: string, column = 0, row = 0) => ({
  id,
  label: id,
  column,
  row,
  state: "pending" as const,
});

describe("layoutFlow", () => {
  it("列按最长路:a→b→c 与 a→c 同在,c 排第 2 列而不是模型说的第 1 列", () => {
    const laid = layoutFlow(
      [n("a"), n("b", 1), n("c", 1, 1)],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
      ]
    );
    expect(laid.map((x) => [x.id, x.column])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("同列按前驱行号排,行号从 0 连续", () => {
    const laid = layoutFlow(
      [n("a", 0, 0), n("b", 0, 1), n("x", 1, 5), n("y", 1, 3)],
      [
        { from: "b", to: "x" },
        { from: "a", to: "y" },
      ]
    );
    const rows = Object.fromEntries(laid.map((x) => [x.id, x.row]));
    expect(rows).toEqual({ a: 0, b: 1, y: 0, x: 1 });
  });

  it("环上的节点退回模型给的 column,不死循环", () => {
    const laid = layoutFlow(
      [n("a", 0), n("b", 3)],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]
    );
    expect(laid.map((x) => x.column)).toEqual([0, 3]);
  });

  it("悬空边 / 自环忽略", () => {
    expect(() =>
      layoutFlow([n("a")], [
        { from: "a", to: "zz" },
        { from: "a", to: "a" },
      ])
    ).not.toThrow();
  });
});
