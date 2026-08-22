import { describe, expect, it } from "vitest";

import { modelHandoff, modelSideLabel } from "../../src/renderer/src/lib/modelHandoff.js";
import type { SessionEvent } from "../../src/session/events.js";

function sw(seq: number, provider: string, model: string): SessionEvent {
  return { sessionId: "s", seq, ts: seq * 1000, type: "model_changed", provider, model };
}

const noise: SessionEvent = {
  sessionId: "s",
  seq: 2,
  ts: 2000,
  type: "user_message",
  content: "喂",
};

describe("modelHandoff —— 一条 model_changed 的两端", () => {
  it("开局就切、一条回复都没有：没有来处，不编一个默认模型", () => {
    const h = modelHandoff([sw(1, "deepseek", "deepseek-chat")], 1);
    expect(h).toEqual({ to: { provider: "deepseek", model: "deepseek-chat" }, settled: false });
    expect(h?.from).toBeUndefined();
  });

  it("第一次切换的来处 = 之前最后一条回复的 model（事实），厂商从目录反查", () => {
    const reply = { sessionId: "s", type: "assistant_message", content: "在", model: "glm-4.5-flash", seq: 2, ts: 0 } as SessionEvent;
    const h = modelHandoff([reply, sw(3, "glm", "glm-4.6v-flash")], 3);
    expect(h?.from).toEqual({ provider: "glm", model: "glm-4.5-flash" });
  });

  it("目录里没有、也没带厂商前缀的型号认不出来处 → 不画", () => {
    const reply = { sessionId: "s", type: "assistant_message", content: "在", model: "mystery-9000", seq: 2, ts: 0 } as SessionEvent;
    expect(modelHandoff([reply, sw(3, "glm", "glm-4.6")], 3)?.from).toBeUndefined();
  });

  it("来处 = 上一条 model_changed，中间隔着别的事件也认得出", () => {
    const events = [sw(1, "deepseek", "deepseek-chat"), noise, sw(3, "glm", "glm-4.6")];
    expect(modelHandoff(events, 3)).toEqual({
      from: { provider: "deepseek", model: "deepseek-chat" },
      to: { provider: "glm", model: "glm-4.6" },
      settled: false,
    });
  });

  it("被后来的切换覆盖掉的那几条是 settled，最后一条不是（现在跑的就是它）", () => {
    const events = [sw(1, "deepseek", "deepseek-chat"), sw(3, "glm", "glm-4.6"), sw(5, "anthropic", "claude-opus-5")];
    expect(modelHandoff(events, 1)?.settled).toBe(true);
    expect(modelHandoff(events, 3)?.settled).toBe(true);
    expect(modelHandoff(events, 5)?.settled).toBe(false);
  });

  it("seq 不是一条 model_changed（或压根不在日志里）→ null，不猜", () => {
    const events = [sw(1, "glm", "glm-4.6"), noise];
    expect(modelHandoff(events, 2)).toBeNull();
    expect(modelHandoff(events, 99)).toBeNull();
  });
});

describe("modelSideLabel —— chip 上的型号名", () => {
  it("脱掉自家厂商前缀：厂商由旁边那枚标记说，不用写两遍", () => {
    expect(modelSideLabel({ provider: "glm", model: "glm-4.5-flash" })).toBe("glm-4.5-flash");
    expect(modelSideLabel({ provider: "ollama", model: "ollama/qwen3:8b" })).toBe("qwen3:8b");
  });

  it("别家的命名空间留着 —— 那两截说的是两件事（谁转发、转发的是谁）", () => {
    expect(modelSideLabel({ provider: "openrouter", model: "anthropic/claude-sonnet-5" })).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});
