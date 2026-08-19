import { describe, expect, it } from "vitest";

import { bridgeErrorMessage } from "../../src/renderer/src/lib/bridgeError.js";

describe("bridgeErrorMessage", () => {
  it("主进程没这个通道 = 两边版本对不上，给一句能执行的话", () => {
    // Electron 的原话，一字不改地抄进来当锚
    const raw = new Error(
      "Error invoking remote method 'otter:listOllamaModels': Error: No handler registered for 'otter:listOllamaModels'"
    );
    const msg = bridgeErrorMessage(raw);
    expect(msg).toContain("退出");
    expect(msg).not.toContain("No handler registered");
  });

  it("其他错误原样透出 —— 别把真正的故障也翻译掉", () => {
    expect(bridgeErrorMessage(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
    expect(bridgeErrorMessage("boom")).toBe("boom");
  });
});
