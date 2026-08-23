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

  it("剥掉 Electron 的 IPC 外壳，只留主进程写给用户的那句话", () => {
    const raw = new Error(
      "Error invoking remote method 'otter:saveSubagent': Error: 这个 subagent 是只读的，改不了"
    );
    expect(bridgeErrorMessage(raw)).toBe("这个 subagent 是只读的，改不了");
  });

  it("外壳里裹的不是 Error 时也剥干净", () => {
    const raw = new Error("Error invoking remote method 'otter:boot': 数据库锁住了");
    expect(bridgeErrorMessage(raw)).toBe("数据库锁住了");
  });

  it("句子里出现同样的字眼不算外壳 —— 只认开头", () => {
    const raw = new Error("写盘失败：Error invoking remote method 'x': y");
    expect(bridgeErrorMessage(raw)).toBe("写盘失败：Error invoking remote method 'x': y");
  });

  it("其他错误原样透出 —— 别把真正的故障也翻译掉", () => {
    expect(bridgeErrorMessage(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
    expect(bridgeErrorMessage("boom")).toBe("boom");
  });
});
