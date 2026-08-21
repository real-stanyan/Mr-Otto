import { describe, it, expect } from "vitest";
import { composeInjectedText } from "../../src/renderer/src/lib/composerInject.js";

// F2 / issue #158：这段逻辑从前长在 App.tsx 的一个 effect 里，测不动——
// 把 append 从 true 改回 false，CI 抓不到，用户敲了一半的话被展开结果冲掉。
describe("composeInjectedText", () => {
  it("追加：原文在前，空行隔开，注入的在后", () => {
    expect(composeInjectedText("帮我看看", "展开的 prompt", true)).toBe("帮我看看\n\n展开的 prompt");
  });

  it("原文是空的 = 注入的就是全部（不留头部空行）", () => {
    expect(composeInjectedText("", "展开的 prompt", true)).toBe("展开的 prompt");
  });

  it("原文只有空白也算空 —— 那不是「用户写了东西」", () => {
    expect(composeInjectedText("  \n \n ", "正文", true)).toBe("正文");
  });

  it("原文尾部已有换行时不叠加空行（注入几次不该多出一片空白）", () => {
    expect(composeInjectedText("半句话\n\n\n", "正文", true)).toBe("半句话\n\n正文");
    expect(composeInjectedText(
      composeInjectedText("半句话", "第一段", true), "第二段", true
    )).toBe("半句话\n\n第一段\n\n第二段");
  });

  it("覆盖档：整体替换，原文丢掉（append: false 的语义，仍然存在但不是默认）", () => {
    expect(composeInjectedText("半句话", "正文", false)).toBe("正文");
  });

  it("原文内部的换行原样保留，削的只是尾部", () => {
    expect(composeInjectedText("第一行\n第二行", "正文", true)).toBe("第一行\n第二行\n\n正文");
  });
});
