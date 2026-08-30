import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  describeModel,
  describeModelWith,
  findModel,
  ollamaChoiceFrom,
  resolveModel,
  type OllamaCaps,
} from "../../src/shared/modelCatalog.js";
import { DEFAULT_HELPER_MODEL } from "../../src/shared/helperModel.js";
import { DEFAULT_VISION_MODEL } from "../../src/shared/visionModel.js";

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
    expect(describeModelWith("glm-5.3", probe)).toEqual(describeModel("glm-5.3"));
  });

  it("目录外的 id 仍然是 undefined —— 不替陌生型号编能力", () => {
    expect(describeModelWith("某个没见过的型号", probe)).toBeUndefined();
  });
});

describe("contextWindowKnown —— 未探测的窗口不能冒充真值参与自动压缩判断", () => {
  it("目录条目：true", () => {
    expect(findModel("glm-5.3")?.contextWindowKnown).toBe(true);
  });

  it("未探测的本机 Ollama tag（走目录兜底常量）：false", () => {
    expect(describeModel("ollama/没探到:latest")?.contextWindowKnown).toBe(false);
  });

  it("探测到的本机 Ollama tag：true", () => {
    expect(describeModelWith("ollama/qwen3:30b", probe)?.contextWindowKnown).toBe(true);
  });

  it("目录外的 id（resolveModel 兜底成 DeepSeek 方言）：false——它是猜的窗口", () => {
    expect(resolveModel("某个没见过的型号").contextWindowKnown).toBe(false);
  });
});

describe("ollamaChoiceFrom", () => {
  it("日志 id 带前缀、发线上的是裸 tag（两个 id 分家的那次教训）", () => {
    const c = ollamaChoiceFrom(PROBED["qwen3:30b"]!);
    expect(c.model).toBe("ollama/qwen3:30b");
    expect(c.wireModel).toBe("qwen3:30b");
  });

  it("会思考的本机模型给 Ollama 那套档位 —— 比别家多一个 max", () => {
    const c = ollamaChoiceFrom(PROBED["qwen3:30b"]!);
    expect(c.thinking.modes).toEqual(["off", "low", "medium", "high", "max"]);
  });
});

// 目录会随上游换代整批重写（2026-08-30 那次换掉了 8 家）。删一款没人用的型号不会出事，
// 删到某个出厂默认头上则**一声不响**：normalise* 只保证"用户存的值"能退回默认，
// 没人保证默认自己还在目录里。默认落空的后果各不相同，但都不报错——
// createCheapAdapter 查不到型号直接返回 null（三个 turn 外挂集体静默失效），
// vision-bridge 的代读员查不到则是整个带图 turn 失败。这三行是那一刀的护栏
describe("三个出厂默认必须在目录里", () => {
  it("开箱型号", () => {
    expect(findModel(DEFAULT_MODEL), DEFAULT_MODEL).toBeDefined();
  });

  it("后台小模型（分区/建议/微压缩共用的那款）", () => {
    expect(findModel(DEFAULT_HELPER_MODEL), DEFAULT_HELPER_MODEL).toBeDefined();
  });

  it("看图代读员——还得真有眼睛，没眼睛的代读员会让所有带图消息集体失败", () => {
    expect(findModel(DEFAULT_VISION_MODEL)?.supportsVision, DEFAULT_VISION_MODEL).toBe(true);
  });
});
