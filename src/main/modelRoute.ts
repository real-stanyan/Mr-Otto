// 走网关还是直连 —— 一次纯判断,不碰网络不碰 env 读取(值由调用方喂)。
// 拎出来是因为这条规矩会被问很多遍:"我明明填了 key,为什么还在扣官方额度?"
// 答案必须是一句能指着代码念的话,而不是散在 makeAdapter 里的三个 if。

import type { ModelChoice } from "../shared/modelCatalog.js";

export type ModelRoute =
  /** 直连上游:用户自带 key,自己付钱 */
  | { kind: "direct"; baseUrl: string; apiKey: string }
  /** 走 otto-gateway:官方 key + 官方额度,凭 Supabase access token 进门 */
  | { kind: "gateway"; baseUrl: string; apiKey: string }
  /** 两条路都不通,说清楚缺什么 */
  | { kind: "blocked"; reason: string };

export interface RouteInput {
  choice: ModelChoice;
  /** 用户自己配的 key(keyVault → process.env[choice.apiKeyEnv]),没配则空串 */
  ownKey: string;
  /** 用户自己配的端点覆盖(process.env[choice.baseUrlEnv]),没配则 undefined */
  ownBaseUrl?: string | undefined;
  /** Supabase access token,未登录为 null */
  accessToken: string | null;
  gatewayBaseUrl: string;
}

export function routeModel(input: RouteInput): ModelRoute {
  const { choice, ownKey, ownBaseUrl, accessToken, gatewayBaseUrl } = input;

  // 自带 key 优先于官方额度。他自己付的钱,不该因为顺手登录了就被改成花官方的——
  // 反过来也一样:想省自己的钱,把 key 清掉即可,不用登出
  if (ownKey) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: ownKey };
  }

  // 免 key 的厂商（本机 Ollama）：能连上 11434 就是授权，没有第二道门。
  // 排在官方额度分支之前——它压根不该走网关，赠额也覆盖不到本机进程。
  // apiKey 仍给一个占位串："ollama" 是官方文档里 OpenAI 兼容客户端的惯用值，
  // 服务端不校验，但空 Bearer 头在某些反代前面会被当成缺鉴权直接 401
  if (choice.keyless) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: "ollama" };
  }

  // 官方额度只买了 DeepSeek。GLM 的型号 id 发给 DeepSeek 只会换回一个上游 400,
  // 与其让用户对着看不懂的上游错误发呆,不如在这里说清楚
  if (choice.provider !== "deepseek") {
    return {
      kind: "blocked",
      reason: `官方额度只覆盖 DeepSeek 型号，${choice.label} 需要在设置里填自己的 ${choice.apiKeyEnv}。`,
    };
  }

  if (accessToken) {
    return { kind: "gateway", baseUrl: gatewayBaseUrl, apiKey: accessToken };
  }

  return {
    kind: "blocked",
    reason: `还没法调用模型：登录即可用官方赠额，或在设置里填自己的 ${choice.apiKeyEnv}。`,
  };
}
