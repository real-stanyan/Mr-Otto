import { describe, expect, it } from "vitest";

import {
  MICRO_COMPACT_HINT,
  compactedCardMeta,
  describeThreshold,
  microCompactedHeadline,
} from "../../src/renderer/src/lib/autoCompactCopy.js";
import type { AutoCompactSettings } from "../../src/shared/autoCompact.js";

describe("describeThreshold", () => {
  it("未覆盖：走默认档，标「默认」", () => {
    const settings: AutoCompactSettings = { enabled: true };
    expect(describeThreshold(settings, 1_000_000)).toBe("50%（默认）");
    expect(describeThreshold(settings, 128_000)).toBe("75%（默认）");
  });

  it("用户覆盖了 threshold：标「自定义」，且按覆盖值算", () => {
    const settings: AutoCompactSettings = { enabled: true, threshold: 0.6 };
    expect(describeThreshold(settings, 1_000_000)).toBe("60%（自定义）");
  });

  it("窗口未知（型号不在目录里/还没选型号）：如实说不知道，不瞎猜百分比", () => {
    const settings: AutoCompactSettings = { enabled: true };
    expect(describeThreshold(settings, undefined)).toBe("未知上下文窗口，暂不生效");
    expect(describeThreshold(settings, 0)).toBe("未知上下文窗口，暂不生效");
  });
});

// compactedHeadline 的测试随函数一起删（#128）：审计行换成摘要卡，
// auto/manual 区分移入 compactedCardMeta 的 trigger 前缀（同 PR 产品变更，ADR-0020 L2）

describe("compactedCardMeta", () => {
  it("有 usage：模型 + 这次压缩烧的 token 总数", () => {
    expect(
      compactedCardMeta("deepseek-v4-pro", { promptTokens: 8000, completionTokens: 421 }),
    ).toBe("deepseek-v4-pro · 耗 8,421 tokens");
  });

  it("旧日志没有 usage：只印模型，不炸也不留悬空分隔符", () => {
    expect(compactedCardMeta("deepseek-v4-pro", undefined)).toBe("deepseek-v4-pro");
  });

  it("auto 触发：meta 前缀「自动压缩」——原审计行的 auto/manual 区分不因换卡而丢", () => {
    expect(
      compactedCardMeta("m", { promptTokens: 100, completionTokens: 1 }, "auto"),
    ).toBe("自动压缩 · m · 耗 101 tokens");
    expect(compactedCardMeta("m", undefined, "manual")).toBe("m");
    expect(compactedCardMeta("m", undefined, undefined)).toBe("m");
  });
});

describe("微压缩文案", () => {
  it("开关说明逐字对齐 spec", () => {
    expect(MICRO_COMPACT_HINT).toBe("每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。");
  });

  it("时间线行带摘要体积", () => {
    expect(microCompactedHeadline(321)).toBe("一段对话并入摘要（摘要约 321 tokens）");
  });
});
