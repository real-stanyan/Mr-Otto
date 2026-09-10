import { describe, it, expect } from "vitest";
import {
  composeQuotedMessage,
  quoteChipLines,
  toBlockquote,
} from "../../src/renderer/src/lib/quote.js";

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

describe("quoteChipLines", () => {
  it("名字取首行、副行报行数", () => {
    expect(quoteChipLines("改这里")).toEqual({ name: "改这里", meta: "引用 · 1 行" });
  });

  it("首行是空的时候取第一行有字的——刷选常从行尾开始", () => {
    expect(quoteChipLines("\n\n  真正的第一行\n第二行")).toEqual({
      name: "真正的第一行",
      meta: "引用 · 2 行",
    });
  });

  it("行数按剪掉首尾空白之后算,中间的空行照数", () => {
    expect(quoteChipLines("上\n\n下\n")).toEqual({ name: "上", meta: "引用 · 3 行" });
  });

  it("全是空白给空名字——调用方本来就不该造出这样一条", () => {
    expect(quoteChipLines("  \n ")).toEqual({ name: "", meta: "引用 · 0 行" });
  });
});

describe("composeQuotedMessage", () => {
  it("没有引用时正文逐字不变(包括空串)", () => {
    expect(composeQuotedMessage([], "改这里")).toBe("改这里");
    expect(composeQuotedMessage([], "")).toBe("");
  });

  it("引用在正文之前,空行隔开", () => {
    expect(composeQuotedMessage([{ text: "老代码" }], "改成异步的")).toBe(
      "> 老代码\n\n改成异步的"
    );
  });

  it("多条引用按加入顺序各成一块", () => {
    expect(composeQuotedMessage([{ text: "甲" }, { text: "乙" }], "一起改")).toBe(
      "> 甲\n\n> 乙\n\n一起改"
    );
  });

  it("只有引用没打字也发得出去:附件那条口径", () => {
    expect(composeQuotedMessage([{ text: "这段" }], "")).toBe("> 这段");
  });

  it("剪完是空的那条不留一个空引用块", () => {
    expect(composeQuotedMessage([{ text: "  \n " }, { text: "有字" }], "")).toBe("> 有字");
  });

  it("每条引用整段折成引用块,不是只折第一行", () => {
    expect(composeQuotedMessage([{ text: "一\n二" }], "改")).toBe("> 一\n> 二\n\n改");
  });
});
