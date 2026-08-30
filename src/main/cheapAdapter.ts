// cheapAdapter — 三个 turn 后外挂（分区分类 / 跟进建议 / 微压缩）共用的便宜模型通道。
// 规矩一处写：型号从目录查、没配 key 就不出门（空 Bearer 是每 turn 一次必 401 的往返）、
// thinking 显式关（智谱那几款 flash 默认开，实测四个字烧 1452 个 completion token）、
// 带超时信号（openaiCompatible 走裸 fetch 没有任何超时，一条卡死的 TCP 会让 await 永远不回）。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import type { ModelAdapter } from "../model/adapter.js";
import { findModel } from "../shared/modelCatalog.js";

export function createCheapAdapter(
  modelId: string,
  timeoutMs: number
): { adapter: ModelAdapter; signal: AbortSignal } | null {
  const choice = findModel(modelId);
  if (!choice) return null;
  const apiKey = process.env[choice.apiKeyEnv] ?? "";
  if (apiKey === "") return null;
  const adapter = createOpenAICompatibleAdapter({
    baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
    apiKey,
    model: choice.model,
    vision: false,
    // 方言从目录里查，别自己拍一个（ADR-0031）
    thinking: { mode: "off", wire: choice.thinking.wire },
  });
  return { adapter, signal: AbortSignal.timeout(timeoutMs) };
}
