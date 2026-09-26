// ttsRoute —— 语音合成走不走得通（#1163；#1356 A4 从主进程 modelRoute.ts 挪进 shared，手机端用同一份）。
import { resetClockText } from "./billingView.js";
import type { BillingSnapshotView } from "./shellBridge.js";

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
    const when = hosted.resetAt ? `${resetClockText(hosted.resetAt)} 恢复` : "窗口重置后恢复";
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

/** 一份订阅快照 → routeTts 要的那一格（#1356 A4，手机端用）。手机没有桌面 hostedQuota 那份实时额度账，
    额度用完由网关的 429 当场说出口，所以 `exhausted` 恒为 false；还没查到（null / me 为 null）→ undefined */
export function ttsHostedOf(billing: BillingSnapshotView | null): TtsRouteInput["hosted"] {
  const me = billing?.me;
  if (!me) return undefined;
  return { subscribed: me.status === "active" && me.plan !== null, exhausted: false, ttsModels: me.ttsModels };
}
