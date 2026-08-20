import { describe, expect, it } from "vitest";

import { isNumericColumn } from "../../src/renderer/src/lib/tableColumns.js";

describe("isNumericColumn —— 哪一列配右对齐 + 等宽 + 窄宽度", () => {
  const col = (...cells: string[]) => cells.map((c) => [c]);

  it("整列都是数字 → 是", () => {
    expect(isNumericColumn(col("12", "3,400", "0.5"), 0)).toBe(true);
  });

  it("带货币号/正负号/百分号/K M 后缀也算", () => {
    expect(isNumericColumn(col("$1.25", "-3", "42%", "128K", "1.5M"), 0)).toBe(true);
  });

  it("有一格是话，整列就按正文排 —— 宁可少右对齐一列，也不能把一列话压成省略号", () => {
    expect(isNumericColumn(col("12", "极快（开发时基于浏览器原生 ESM）"), 0)).toBe(false);
  });

  it("空格子不表态", () => {
    expect(isNumericColumn(col("12", "", "34"), 0)).toBe(true);
  });

  it("一整列都是空的不算数字列 —— 没有依据就别改排版", () => {
    expect(isNumericColumn(col("", "  "), 0)).toBe(false);
  });

  it("越界的列下标不算数字列", () => {
    expect(isNumericColumn(col("12"), 5)).toBe(false);
  });
});
