import { describe, expect, it } from "vitest";
import { executorMarkerText } from "../../../src/renderer/src/lib/executorMarker.js";
import type { ExecutorChangedEvent } from "../../../src/session/events.js";

const ev = (executor: "desktop" | "cloud", label?: string): ExecutorChangedEvent => ({
  seq: 3, sessionId: "s", ts: 0, type: "executor_changed", executor, ignorable: true,
  ...(label !== undefined ? { label } : {}),
});

describe("executorMarkerText\uFF08#1223\uFF09", () => {
  it("云端\uFF1A说清是手机那头在续", () => {
    expect(executorMarkerText(ev("cloud"))).toBe("在云端继续\uFF08手机\uFF09");
  });
  it("回到电脑\uFF1A带设备名\uFF1B没有设备名就只说回到电脑", () => {
    expect(executorMarkerText(ev("desktop", "Stan 的 MacBook"))).toBe("回到电脑\uFF08Stan 的 MacBook\uFF09");
    expect(executorMarkerText(ev("desktop"))).toBe("回到电脑");
  });
});
