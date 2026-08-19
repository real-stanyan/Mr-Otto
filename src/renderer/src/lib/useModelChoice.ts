// 当前型号的**真实**能力 —— 目录 + 本机探测。
//
// 起因是上下文圆环：切到本机 Ollama 的 qwen3:30b 之后，环还按 32k 算占用，
// 实际那款有 256k。因为渲染层一直只查目录（describeModel），而目录对 Ollama
// 只有一份没出处的兜底常量——本机装了什么、窗多大、思不思考，只有那台机器答得上来。
//
// 探测结果早就在 store 里（ollamaModels），缺的只是"查表时把它叠上去"这一步。
// 叠加口径与主进程共用 describeModelWith：同一个型号不该在两边显示成两种能力。

import { useMemo } from "react";

import { describeModelWith, type ModelChoice } from "../../../shared/modelCatalog.js";
import { THINKING_NONE, type ThinkingSpec } from "../../../shared/thinking.js";
import { useChat } from "../store.js";

/** 型号 id → 目录形态（Ollama 的能力用本机探到的真值覆盖）。
    认不出来的 id 返回 undefined —— 调用方自己决定怎么降级，
    别在这里兜底成某一家的参数，那会给一个陌生型号亮出它并不具备的能力 */
export function useModelChoice(model: string): ModelChoice | undefined {
  const ollamaModels = useChat((s) => s.ollamaModels);
  return useMemo(
    () => describeModelWith(model, (tag) => ollamaModels.find((m) => m.tag === tag)),
    [model, ollamaModels]
  );
}

/** 挡位表。认不出的型号 = 没有请求级开关（下拉框灰着），
    不是"当成支持"——猜错的代价是发一个型号不认的参数 */
export function thinkingSpecOf(choice: ModelChoice | undefined): ThinkingSpec {
  return choice?.thinking ?? THINKING_NONE;
}
