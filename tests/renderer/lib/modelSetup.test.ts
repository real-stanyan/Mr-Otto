// 新用户「配第一个大模型」引导弹窗的该不该弹（issue #328）。
//
// 口径与 keyStatus 一致：遮罩空串 = 没配。keyless（Ollama）不算"配过"——
// 它装没装过与 keyStatus 无关，引导的目的是让用户至少主动接一家。

import { describe, expect, it } from "vitest";
import { needsModelSetup } from "../../../src/renderer/src/lib/modelSetup.js";

describe("needsModelSetup", () => {
  it("没盖章且一把 key 都没配 → 弹", () => {
    expect(needsModelSetup({}, false)).toBe(true);
    expect(needsModelSetup({ DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "" }, false)).toBe(true);
  });

  it("任何一家配了 key → 不弹（用户已经会配了，不用引导）", () => {
    expect(needsModelSetup({ DEEPSEEK_API_KEY: "sk-…abcd", OPENAI_API_KEY: "" }, false)).toBe(false);
  });

  it("盖过章 → 不弹，哪怕还是一把 key 都没有（以后再说=只弹一次）", () => {
    expect(needsModelSetup({}, true)).toBe(false);
    expect(needsModelSetup({ DEEPSEEK_API_KEY: "sk-…abcd" }, true)).toBe(false);
  });
});
