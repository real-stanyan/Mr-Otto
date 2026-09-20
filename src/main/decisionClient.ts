// decisionClient —— 桌面主进程问决策模型的那一条路（#1281）。
//
// 路是「桌面主进程 → edge 网关 `/llm/v1/decision` → OpenRouter」，与 teamVoice / generate_image
// 同一个形状：官方 key 只在 Worker secret 里，钱记在**用户自己**的订阅额度上（自己的 JWT），
// hold / settle / usage_event 整套现成。
//
// 与那两条路不同的一处：**这里从不向用户报错**。出图 / 语音 blocked 时要说清四种情形各是
// 什么（没订阅 / 额度用完 / 网关不供 / 拿不到 JWT），因为用户点了一颗钮在等结果；决策调用
// 是用户看不见的前置判断，任何一格不过都只有一个后果——`mode` 回 off / `decide` 回 null，
// 调用方走原来那条路。所以没有 routeDecision / decisionBlocked 那一对，原因只进日志。
//
// 「订阅 / 额度用完」两格读 `routeInput("")`，与聊天、出图、语音**同源**：各判一遍就会出现
// 「聊天说额度用完了、决策却照跑」。空串同 index.ts 的 `isSubscribed()`——那两格与问哪一款无关。

import { parseBillingError } from "../shared/billing.js";
import {
  decisionModelOf, modeOf, requestDecision,
  type DecisionModeState, type DecisionQuestion, type DecisionReply, type DecisionState, type DecisionUse,
} from "../shared/decision.js";
import type { HostedQuota } from "./hostedQuota.js";

export interface DecisionClientDeps {
  quota: Pick<HostedQuota, "snapshot" | "routeInput" | "noteHeaders" | "noteExhausted">;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface DecisionClient {
  /** 这一处此刻开着哪一档。**同步**：渲染层 / 工具要据此决定「要不要走那套逻辑」，
      而拿 JWT 是异步的——同 ttsBlocked 与 routeTts 拆两半的理由 */
  mode(use: DecisionUse): DecisionModeState;
  decide(
    use: DecisionUse,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    timeoutMs: number,
  ): Promise<DecisionReply | null>;
}

export function createDecisionClient(deps: DecisionClientDeps): DecisionClient {
  const mode = (use: DecisionUse): DecisionModeState => {
    const r = deps.quota.routeInput("");
    if (!r.subscribed || r.exhausted) return "off";
    return modeOf(deps.quota.snapshot().me, use);
  };
  return {
    mode,
    async decide(use, state, questions, timeoutMs) {
      if (mode(use) === "off") return null;
      const model = decisionModelOf(deps.quota.snapshot().me);
      if (model === null) return null;
      const token = await deps.accessToken();
      if (!token) return null; // 不发空 Bearer
      return requestDecision(
        {
          llmBase: `${deps.edgeBaseUrl()}/llm/v1`,
          headers: { authorization: `Bearer ${token}` },
          timeoutMs,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.log ? { log: deps.log } : {}),
          // 额度头与 chat / 语音那条路同一份纪律：成功就 noteHeaders，429 quota_exhausted 就 noteExhausted
          onResponse: async (res) => {
            if (res.ok) return deps.quota.noteHeaders(res.headers);
            const e = parseBillingError(res.status, await res.json().catch(() => null));
            if (e?.code === "quota_exhausted") {
              deps.quota.noteExhausted({ ...(e.window ? { window: e.window } : {}), ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}) });
            }
          },
        },
        { model, use, state, questions },
      );
    },
  };
}
