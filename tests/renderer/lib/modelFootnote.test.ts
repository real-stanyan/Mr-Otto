// 上下文浮层末尾那一行（#1071）。它是订阅用户那条路上替掉整段花费的那一行，
// 而这一行的全部难点是**300px 里放不下两个完整标签** —— 下面钉的就是那条取舍：
// 单位词省掉、型号名留全，以及「没量到 cache 就整半句不出现」。

import { describe, expect, it } from "vitest";
import { modelFootnoteView, MAX_MARKS } from "../../../src/renderer/src/lib/modelFootnote.js";
import type { ModelUsage } from "../../../src/session/deriveUsage.js";

const row = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  model: "deepseek-v4-plus", route: "hosted", promptTokens: 373_500, completionTokens: 5_900, cachedTokens: 0, ...over,
});

describe("modelFootnoteView", () => {
  it("一次模型都没调过 → null（不占地方）", () => {
    expect(modelFootnoteView([], null)).toBeNull();
  });

  it("一款型号：左边写全名，右边写 token 数 + cache 命中率", () => {
    const v = modelFootnoteView([row()], { cachedTokens: 311_300, measuredPromptTokens: 373_500 })!;
    expect(v.label).toBe("deepseek-v4-plus");
    expect(v.stat).toBe("379K · cache 83%");
    expect(v.marks).toEqual(["deepseek-v4-plus"]);
  });

  it("**正文里不写 tokens 这个词**：写全的那份进 title —— 300px 装不下两个完整标签", () => {
    const v = modelFootnoteView([row()], { cachedTokens: 311_300, measuredPromptTokens: 373_500 })!;
    expect(v.stat).not.toContain("tokens");
    expect(v.title).toBe("deepseek-v4-plus · 379K tokens，cache 命中 83%");
  });

  it("没量到 cache（一次调用都没报过）→ **整半句不出现**，不是写 0%", () => {
    // 一行永远 0% 的指标读起来是「缓存全废」，而事实只是这家 API 不报数
    const v = modelFootnoteView([row()], null)!;
    expect(v.stat).toBe("379K");
    expect(v.title).toBe("deepseek-v4-plus · 379K tokens");
  });

  it("分母是 0（有 cache 快照但一次都没量到）也当没量到", () => {
    const v = modelFootnoteView([row()], { cachedTokens: 0, measuredPromptTokens: 0 })!;
    expect(v.stat).toBe("379K");
  });

  it("多款型号：左边写「N 款型号」，token 是和，title 列全名", () => {
    const v = modelFootnoteView(
      [row(), row({ model: "glm-4.6-air", promptTokens: 41_200, completionTokens: 1_800 })],
      null,
    )!;
    expect(v.label).toBe("2 款型号");
    expect(v.stat).toBe("422K");
    expect(v.title).toBe("deepseek-v4-plus、glm-4.6-air · 422K tokens");
  });

  it("标最多画三枚：再多就把右边那串挤没了", () => {
    const rows = ["a", "b", "c", "d", "e"].map((m) => row({ model: m }));
    const v = modelFootnoteView(rows, null)!;
    expect(v.marks).toHaveLength(MAX_MARKS);
    expect(v.label).toBe("5 款型号");
  });
});
