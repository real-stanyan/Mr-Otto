// 能不能调这个模型 —— 一次纯判断,不碰网络不碰 env 读取(值由调用方喂)。
// 拎出来是因为这条规矩会被问很多遍:"我明明填了 key,为什么用不了?"
// 答案必须是一句能指着代码念的话,而不是散在 makeAdapter 里的三个 if。
//
// 历史:这里曾经有第三种出路 —— 走 otto-gateway 用官方赠额(ADR-0019/0021/0045)。
// ADR-0085 关掉了那条产品线,ADR-0129 删掉了它的实现。现在只剩两种结局:
// 有 key(或免 key 的本机 Ollama)就直连,否则 blocked。

import type { ModelChoice } from "../shared/modelCatalog.js";
import type { ModelLane } from "../shared/modelLane.js";

export type ModelRoute =
  /** 直连上游:用户自带 key,自己付钱 */
  | { kind: "direct"; baseUrl: string; apiKey: string }
  /** 路不通,说清楚缺什么 */
  | { kind: "blocked"; reason: string };

export interface RouteInput {
  choice: ModelChoice;
  /** 用户自己配的 key(keyVault → process.env[choice.apiKeyEnv]),没配则空串 */
  ownKey: string;
  /** 用户自己配的端点覆盖(process.env[choice.baseUrlEnv]),没配则 undefined */
  ownBaseUrl?: string | undefined;
  /** 老会话日志里选的是哪条路(ADR-0045)。赠额没了,但**旧日志必须永远可重放**
      (硬规则),所以 lane=grant 仍然是一个合法的输入值 —— 它现在的作用只剩
      让 blocked 的措辞说清楚"你当年选的那条路已经没了",而不是干巴巴一句没配 key */
  lane?: ModelLane;
}

export function routeModel(input: RouteInput): ModelRoute {
  const { choice, ownKey, ownBaseUrl, lane } = input;

  if (ownKey) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: ownKey };
  }

  // 免 key 的厂商（本机 Ollama）：能连上 11434 就是授权，没有第二道门。
  // apiKey 仍给一个占位串："ollama" 是官方文档里 OpenAI 兼容客户端的惯用值，
  // 服务端不校验，但空 Bearer 头在某些反代前面会被当成缺鉴权直接 401
  if (choice.keyless) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: "ollama" };
  }

  const grantGone = lane === "grant" ? "官方赠额已停止提供，" : "";
  return {
    kind: "blocked",
    reason: `${grantGone}还没配 key：在设置里填自己的 ${choice.apiKeyEnv} 即可使用 ${choice.label}。`,
  };
}
