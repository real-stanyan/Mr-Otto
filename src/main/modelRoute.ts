// 能不能调这个模型 —— 一次纯判断,不碰网络不碰 env 读取(值由调用方喂)。
// 拎出来是因为这条规矩会被问很多遍:"我明明填了 key,为什么用不了?"
// 答案必须是一句能指着代码念的话,而不是散在 makeAdapter 里的三个 if。
//
// 历史:这里曾经有第三种出路 —— 走 otto-gateway 用官方赠额(ADR-0019/0021/0045)。
// ADR-0085 关掉了那条产品线,ADR-0129 删掉了它的实现。
//
// 现在（ADR-0176 决定二）有三种结局：有活跃订阅且额度没耗尽且网关供这款型号
// 就走托管（哪怕自己也配了 key——付费订阅下绕过用户买的东西去烧他自己的 key
// 才是意外，顺序与曾经的"自带 key 优先"相反）；否则有 key(或免 key 的本机
// Ollama)就直连；都没有就 blocked，措辞按缺的是哪一样分三种说法。

import type { ModelChoice } from "../shared/modelCatalog.js";
import type { ModelLane } from "../shared/modelLane.js";

export type ModelRoute =
  /** 托管：官方 key + 用户订阅额度（ADR-0176 决定二） */
  | { kind: "hosted"; baseUrl: string; apiKey: string }
  /** 直连上游:用户自带 key,自己付钱 */
  | { kind: "direct"; baseUrl: string; apiKey: string }
  /** 路不通,说清楚缺什么 */
  | { kind: "blocked"; reason: string };

/** 托管额度快照的路由投影（main/hostedQuota.ts 的 routeInput 产出）。
    只留路由判断真正要用的三元组 + 耗尽时的恢复时间——快照全貌是 HostedSnapshot,
    这里拎出来是为了 routeModel 保持"不碰网络不碰 env"的纯函数身份。 */
export interface HostedInput {
  subscribed: boolean;
  exhausted: boolean;
  supportsModel: boolean;
  resetAt?: number;
}

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
  /** 托管额度快照（main/hostedQuota.ts 的 routeInput）。缺席 = 没装配托管
      （测试/子会话/探针）——路由永远不会给出 hosted 这个结局 */
  hosted?: HostedInput;
  /** 网关 /llm/v1 前缀，与 hostedToken 一起才拼得出一次真请求 */
  hostedBaseUrl?: string;
  /** 当前 Supabase JWT；缺 = 没登录或拿不到，托管这条路走不了——
      不发一个空 Bearer 头给网关 */
  hostedToken?: string;
}

const fmtReset = (ms: number): string =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function routeModel(input: RouteInput): ModelRoute {
  const { choice, ownKey, ownBaseUrl, lane, hosted } = input;

  // 1. 有活跃订阅、额度没耗尽、网关供这款、拿得到 JWT → 走网关
  //    （付费订阅下托管优先，ADR-0176 决定二）
  if (hosted?.subscribed && !hosted.exhausted && hosted.supportsModel && input.hostedBaseUrl && input.hostedToken) {
    return { kind: "hosted", baseUrl: input.hostedBaseUrl, apiKey: input.hostedToken };
  }

  // 2. 自带 key → 直连（耗尽处置的第二条出路，或压根没走托管）
  if (ownKey) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: ownKey };
  }

  // 3. 免 key 的厂商（本机 Ollama）：能连上 11434 就是授权，没有第二道门。
  // apiKey 仍给一个占位串："ollama" 是官方文档里 OpenAI 兼容客户端的惯用值，
  // 服务端不校验，但空 Bearer 头在某些反代前面会被当成缺鉴权直接 401
  if (choice.keyless) {
    return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: "ollama" };
  }

  // 4. blocked：措辞分三种，得说清缺的是哪一样
  if (hosted?.subscribed && hosted.exhausted) {
    const when = hosted.resetAt ? `${fmtReset(hosted.resetAt)} 恢复` : "窗口重置后恢复";
    return {
      kind: "blocked",
      reason: `订阅额度已用完，${when}。等不及可以加购，或在设置里填自己的 ${choice.apiKeyEnv}。`,
    };
  }
  if (hosted?.subscribed && !hosted.supportsModel) {
    return {
      kind: "blocked",
      reason: `网关暂不供 ${choice.label}，换一款网关供的型号，或在设置里填自己的 ${choice.apiKeyEnv}。`,
    };
  }
  const grantGone = lane === "grant" ? "官方赠额已停止提供，" : "";
  return {
    kind: "blocked",
    reason: `${grantGone}用 ${choice.label} 有两条路：订阅 Mr Otto（设置 → 订阅），或在设置里填自己的 ${choice.apiKeyEnv}。`,
  };
}
