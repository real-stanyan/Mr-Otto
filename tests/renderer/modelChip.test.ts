import { describe, expect, it } from "vitest";

import { modelChipLabel } from "../../src/renderer/src/lib/modelChip.js";

describe("modelChipLabel", () => {
  it("普通型号：拼上厂商", () => {
    expect(modelChipLabel("deepseek", "deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  });

  it("id 里已经有厂商前缀就不再加一遍 —— 曾经显示成 ollama/ollama/qwen3.8:27b", () => {
    expect(modelChipLabel("ollama", "ollama/qwen3.8:27b")).toBe("ollama/qwen3.8:27b");
  });

  it("别家命名空间照拼 —— 谁在转发、转发的是谁，是两件事", () => {
    expect(modelChipLabel("openrouter", "anthropic/claude-sonnet-5")).toBe(
      "openrouter/anthropic/claude-sonnet-5"
    );
  });
});
