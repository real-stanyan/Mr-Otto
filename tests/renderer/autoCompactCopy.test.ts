import { describe, expect, it } from "vitest";

import {
  MICRO_COMPACT_HINT,
  compactedHeadline,
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

describe("compactedHeadline", () => {
  it("auto 触发：标「已自动压缩」", () => {
    expect(compactedHeadline("auto")).toBe("上下文已自动压缩");
  });

  it("manual 或缺省（旧事件）：标「已压缩」", () => {
    expect(compactedHeadline("manual")).toBe("上下文已压缩");
    expect(compactedHeadline(undefined)).toBe("上下文已压缩");
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
