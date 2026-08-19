import { describe, it, expect } from "vitest";
import { toBlockquote } from "../../src/renderer/src/lib/quote.js";

describe("toBlockquote", () => {
  it("单行加前缀", () => {
    expect(toBlockquote("改这里")).toBe("> 改这里");
  });

  it("每一行都加前缀——只加第一行的话粘进去就不是引用块了", () => {
    expect(toBlockquote("第一行\n第二行")).toBe("> 第一行\n> 第二行");
  });

  it("空行也要有前缀,否则 markdown 会把引用块切成两段", () => {
    expect(toBlockquote("上\n\n下")).toBe("> 上\n>\n> 下");
  });

  it("首尾空白先剪掉:刷选很容易多带一个换行", () => {
    expect(toBlockquote("  改这里\n\n")).toBe("> 改这里");
  });

  it("全是空白给空串——调用方据此不弹浮钮", () => {
    expect(toBlockquote("   \n  ")).toBe("");
  });

  it("行尾空白也剪:引用里拖一串空格没意义", () => {
    expect(toBlockquote("一   \n二")).toBe("> 一\n> 二");
  });
});
