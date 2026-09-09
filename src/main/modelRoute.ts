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
//
// **有活跃订阅时 `direct` 整条路不存在**（#1051，维护者定的产品口径；ADR-0233 已经
// 对云会话这么定了，这里是同一条纪律落到本机）：订阅用户不许自带 key，所以订阅这一
// 侧只剩 hosted / blocked 两态。这不是界面题——只把选单里那几组藏起来的话，代读员、
// 子智能体、存量会话里选着的老型号照旧会走到用户自己的 key 上，而那正是 ADR-0233
// 点名不许的静默失败模式（"额度用完悄悄改烧你自己的账号"）。
// 判据挂在 `hosted.subscribed` 上，所以**没装配托管的那些装配**（探针 / 测试 / 裸装配，
// `hosted` 缺席）行为一字不变。

import { pickImageModel } from "../shared/imageModel.js";
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
  /** 当前档的多模态能力（plan.capabilities）。没订阅/没下发 = 全关 */
  capabilities?: { image: boolean; video: boolean };
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
  // 订阅用户没有"自带 key"这条出路（#1051）。缺席的 hosted = 没装配托管，不是"没订阅"
  const subscribed = hosted?.subscribed === true;
  // 订阅用户看到的每一条 blocked 都不许再让他"去填自己的 key"——那条路已经关了，
  // 一句无法执行的建议比不给建议更糟（#1040 那一族）
  const ownKeyHint = subscribed ? "" : `，或在设置里填自己的 ${choice.apiKeyEnv}`;

  // 0. 多模态门禁（#864，plan.capabilities）：hosted 这条路上，这款模型要的能力
  //    超出当前档的，不走托管——直连自己的 key 不受影响（自己的 key 什么都能调）。
  //    判据放在 hosted 分支**之前**：它不是「hosted 失败再退 direct」，是 hosted
  //    这条路对这个输入整个不通
  const caps = hosted?.capabilities ?? { image: false, video: false };
  const wantsVision = choice.supportsVision === true;
  // 订阅用户这一条**不再看 ownKey**：他没有"退回自己的 key"那条路，所以能力不够就是
  // 走不通，而不是"走不通除非你自己有 key"
  if (subscribed && wantsVision && !caps.image) {
    return {
      kind: "blocked",
      reason: `${choice.label} 要读图，当前订阅档没开多模态（升档${ownKeyHint}）。`,
    };
  }
  const hostedOk = subscribed && wantsVision ? caps.image : true;

  // 1. 有活跃订阅、额度没耗尽、网关供这款、拿得到 JWT → 走网关
  //    （付费订阅下托管优先，ADR-0176 决定二）
  if (hosted?.subscribed && hostedOk && !hosted.exhausted && hosted.supportsModel && input.hostedBaseUrl && input.hostedToken) {
    return { kind: "hosted", baseUrl: input.hostedBaseUrl, apiKey: input.hostedToken };
  }

  // 2. 自带 key → 直连（耗尽处置的第二条出路，或压根没走托管）。
  //    **订阅用户走不到这里**：这两条 return 是这条规矩唯一真正生效的地方，
  //    界面上藏掉那几组只是让人不去选，藏不住已经选好的和别处现取的
  if (!subscribed) {
    if (ownKey) {
      return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: ownKey };
    }

    // 3. 免 key 的厂商（本机 Ollama）：能连上 11434 就是授权，没有第二道门。
    // apiKey 仍给一个占位串："ollama" 是官方文档里 OpenAI 兼容客户端的惯用值，
    // 服务端不校验，但空 Bearer 头在某些反代前面会被当成缺鉴权直接 401。
    // **Ollama 也在订阅用户的射程内**：它不要 key、也不花钱，但留着它就等于留着
    // 一条"选单里没有、路由却通"的路，而这条规矩的全部意义是两边说同一句话
    if (choice.keyless) {
      return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: "ollama" };
    }
  }

  // 4. blocked：措辞分几种，得说清缺的是哪一样
  if (subscribed && hosted.exhausted) {
    const when = hosted.resetAt ? `${fmtReset(hosted.resetAt)} 恢复` : "窗口重置后恢复";
    return {
      kind: "blocked",
      reason: `订阅额度已用完，${when}。等不及可以在账号页加购${ownKeyHint}。`,
    };
  }
  if (subscribed && !hosted.supportsModel) {
    return {
      kind: "blocked",
      reason: `订阅额度不供 ${choice.label}，在输入框那枚选单里换一款订阅供的模型。`,
    };
  }
  // 订阅着、这款也供、额度也没用完，却仍然走到这里 = 拿不到登录凭据或网关地址。
  // **这一条以前是悄悄退回自带 key 的**，现在必须说出口：说成"你没订阅"会让一个
  // 正在付钱的人去点续费解决一个不存在的问题（同 ADR-0233 对三种 blocked 分开措辞）
  if (subscribed) {
    return {
      kind: "blocked",
      reason: "连不上订阅网关（多半是网络或登录状态），稍后再试。",
    };
  }
  const grantGone = lane === "grant" ? "官方赠额已停止提供，" : "";
  return {
    kind: "blocked",
    reason: `${grantGone}用 ${choice.label} 有两条路：订阅 Mr Otto（设置 → 订阅），或在设置里填自己的 ${choice.apiKeyEnv}。`,
  };
}

// ── 出图那条路（#1081） ───────────────────────────────────────────────
//
// 与上面 routeModel 的差别只有一处，但那一处是根本的：**出图没有「自带 key」这一档**。
// 维护者定的口径是「生图统一走用户订阅额度、官方 key 所有用户共用一把」，而那把 key
// 只活在 edge 的 Worker secret 里 —— 客户端一个字节都拿不到。于是这条路要么走托管、
// 要么走不通，没有第三种结局，也就不存在 ADR-0233 点名的那个静默失败模式
//（「额度用完悄悄改烧你自己的账号」）：这里压根没有可改道的第二条路。
//
// 四种 blocked 分开措辞，纪律与 ADR-0248 那张表逐条对应 —— 尤其是后两种：
// 「网关不供出图」和「连不上网关」都**不许写成「你没订阅」**，那会让一个正在付钱的人
// 去点续费解决一个不存在的问题。

export interface ImageRouteInput {
  /** 托管额度快照（main/hostedQuota.ts 的 imageInput）。缺席 = 没装配托管
      （子会话 / 探针 / 测试）—— 与 routeModel 同款，这条路永远不会通 */
  hosted?: {
    subscribed: boolean;
    exhausted: boolean;
    resetAt?: number;
    /** 网关此刻供的出图型号（`model_route` 里 kind='image' 那些）。
        **从便宜到贵有序**（routesQuery 的全序，ADR-0237），所以取 `[0]` 是个承诺 */
    imageModels: string[];
  };
  hostedBaseUrl?: string;
  hostedToken?: string;
  /** 用户在选单里挑的那一款（`image_model_changed` 的投影，#1086）。
      **不在网关清单里就回落 `imageModels[0]`**，不报错 —— 同 `visionModelFor` /
      `helperModelFor` 的纪律：网关下架一款不该让出图整个不通，而「你选的那款没了」
      这件事没有任何用户能据此行动的出路。缺席 = 没选过，照旧走最便宜那款 */
  preferred?: string | null | undefined;
}

export type ImageRoute =
  | { kind: "hosted"; url: string; model: string }
  | { kind: "blocked"; reason: string };



/** 快照就能回答的那三条（订阅 / 额度 / 网关供不供出图）。`null` = 这三关都过了。
    **单独拎出来是因为它是同步的**：`generate_image` 的 `available()`（决定这把刀进不进
    模型的工具表）必须同步作答，而拿 JWT 是异步的。拆成两半之后，两个消费方共用这一份
    判据 —— 各写一遍的结果会是「工具表里有这把刀、点下去说你没订阅」那种自相矛盾。 */
export function imageBlocked(hosted: ImageRouteInput["hosted"]): string | null {
  if (!hosted || !hosted.subscribed) return "生成图片要订阅 Mr Otto（设置 → 订阅）。";
  // 额度用完排在「不供出图」前面：它是网关亲口说的那句「拦住你了」，
  // 而清单空只是一张表读出来的推断（同 ADR-0255 让 exhausted 排在百分比前面）
  if (hosted.exhausted) {
    const when = hosted.resetAt ? `${fmtReset(hosted.resetAt)} 恢复` : "窗口重置后恢复";
    return `订阅额度已用完，${when}。等不及可以在账号页加购。`;
  }
  if (hosted.imageModels[0] === undefined) return "订阅网关暂时不供出图。";
  return null;
}

export function routeImage(input: ImageRouteInput): ImageRoute {
  const blocked = imageBlocked(input.hosted);
  if (blocked !== null) return { kind: "blocked", reason: blocked };
  // imageBlocked 过了就一定有第 0 款（那正是它的最后一条）
  const model = pickImageModel(input.hosted!.imageModels, input.preferred);
  if (!input.hostedBaseUrl || !input.hostedToken) {
    return { kind: "blocked", reason: "连不上订阅网关（多半是网络或登录状态），稍后再试。" };
  }
  // `/images` 不是 `/chat/completions`（#1086）：纯出图模型（Seedream 一族、GPT Image 2）
  // 在后者上一律 404 —— 上游按输出模态过滤端点。网关那侧真正决定打哪个上游端点的是
  // 路由行的 `kind`（`upstreamPathFor`），这里敲哪扇门只影响「读这段代码的人以为
  // 它是什么形状」，而请求体与回包确实是另一套形状，所以门也换
  return { kind: "hosted", url: `${input.hostedBaseUrl}/images`, model };
}

// ── 语音那条路（#1163） ───────────────────────────────────────────────
//
// 与出图同形（上面那段的理由原样成立）：官方 key 只在 Worker secret 里，这条路要么走
// 托管、要么走不通，没有「自带 key」这一档，也就没有「额度用完悄悄改烧你自己的账号」。
// 四种 blocked 分开措辞，纪律与 ADR-0248 那张表逐条对应——「网关不供语音」和「连不上
// 网关」都不许写成「你没订阅」。

export interface TtsRouteInput {
  /** 托管额度快照（main/hostedQuota.ts 的 ttsInput）。缺席 = 没装配托管 —— 这条路永远不会通 */
  hosted?: {
    subscribed: boolean;
    exhausted: boolean;
    resetAt?: number;
    /** 网关此刻供的语音型号（`model_route` 里 kind='tts' 那些）。从便宜到贵有序，取 `[0]` */
    ttsModels: string[];
  };
  hostedBaseUrl?: string;
  hostedToken?: string;
}

export type TtsRoute =
  | { kind: "hosted"; url: string; model: string }
  | { kind: "blocked"; reason: string };

/** 快照就能回答的那三条（订阅 / 额度 / 网关供不供语音）。`null` = 三关都过了。
    **单独拎出来是因为它是同步的**：渲染层那颗语音钮画不画由它决定，而拿 JWT 是异步的——
    两个消费方共用这一份判据，各写一遍就是「钮在、点下去说你没订阅」那种自相矛盾 */
export function ttsBlocked(hosted: TtsRouteInput["hosted"]): string | null {
  if (!hosted || !hosted.subscribed) return "语音通话要订阅 Mr Otto（设置 → 订阅）。";
  // 额度用完排在「不供语音」前面：它是网关亲口说的，清单空只是一张表读出来的推断
  if (hosted.exhausted) {
    const when = hosted.resetAt ? `${fmtReset(hosted.resetAt)} 恢复` : "窗口重置后恢复";
    return `订阅额度已用完，${when}。等不及可以在账号页加购。`;
  }
  if (hosted.ttsModels[0] === undefined) return "订阅网关暂时不供语音合成。";
  return null;
}

export function routeTts(input: TtsRouteInput): TtsRoute {
  const blocked = ttsBlocked(input.hosted);
  if (blocked !== null) return { kind: "blocked", reason: blocked };
  if (!input.hostedBaseUrl || !input.hostedToken) {
    return { kind: "blocked", reason: "连不上订阅网关（多半是网络或登录状态），稍后再试。" };
  }
  // ttsBlocked 过了就一定有第 0 款（那正是它的最后一条）
  return { kind: "hosted", url: `${input.hostedBaseUrl}/speech`, model: input.hosted!.ttsModels[0]! };
}
