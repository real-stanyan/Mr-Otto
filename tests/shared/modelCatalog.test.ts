import { describe, expect, it } from "vitest";

import {
  describeModel,
  describeModelWith,
  ollamaChoiceFrom,
  type OllamaCaps,
} from "../../src/shared/modelCatalog.js";

/** 本机实测的两款：qwen3:30b 会思考、256k 窗；cogito:8b 不思考、128k */
const PROBED: Record<string, OllamaCaps> = {
  "qwen3:30b": { tag: "qwen3:30b", contextLength: 262_144, vision: false, thinking: true },
  "cogito:8b": { tag: "cogito:8b", contextLength: 131_072, vision: false, thinking: false },
};
const probe = (tag: string) => PROBED[tag];

describe("describeModelWith —— 本机 Ollama 的能力以探测为准", () => {
  it("上下文窗用探到的真值：查目录只会拿到兜底常量，圆环会按假数报占用", () => {
    expect(describeModel("ollama/qwen3:30b")?.contextWindow).toBe(32_768); // 没出处的兜底
    expect(describeModelWith("ollama/qwen3:30b", probe)?.contextWindow).toBe(262_144);
  });

  it("thinking 也以探测为准：/api/show 说会思考才给挡位表", () => {
    expect(describeModelWith("ollama/qwen3:30b", probe)?.thinking.modes.length).toBeGreaterThan(1);
    expect(describeModelWith("ollama/cogito:8b", probe)?.thinking.modes).toEqual([]);
  });

  it("Ollama 用 reasoning_effort 方言（原生那个 think 布尔在 /v1 上不生效）", () => {
    expect(describeModelWith("ollama/qwen3:30b", probe)?.thinking.wire).toBe("effort");
  });

  it("探不到就退回兜底形态，不是消失 —— Ollama 没开着照样能重放旧日志", () => {
    const c = describeModelWith("ollama/没探到:latest", probe);
    expect(c?.wireModel).toBe("没探到:latest");
    expect(c?.contextWindow).toBe(32_768);
  });

  it("非 Ollama 的型号不受探测影响", () => {
    expect(describeModelWith("glm-4.6", probe)).toEqual(describeModel("glm-4.6"));
  });

  it("目录外的 id 仍然是 undefined —— 不替陌生型号编能力", () => {
    expect(describeModelWith("某个没见过的型号", probe)).toBeUndefined();
  });
});

describe("ollamaChoiceFrom", () => {
  it("日志 id 带前缀、发线上的是裸 tag（两个 id 分家的那次教训）", () => {
    const c = ollamaChoiceFrom(PROBED["qwen3:30b"]!);
    expect(c.model).toBe("ollama/qwen3:30b");
    expect(c.wireModel).toBe("qwen3:30b");
  });
});
