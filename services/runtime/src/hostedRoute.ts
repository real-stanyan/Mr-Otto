// 云会话的模型路由（spec 第 5 节）：发起人有订阅 → 平台 key（扣发起人）；否则工作区自带 key
// （ADR-0202）；都没 → 一句人能看懂的错。runtime 仍然一把模型 key 都不拿：托管那条路的
// 凭据是平台身份 + 「我代表谁」，key 在 edge 那边。
import type { ResolvedEndpoint } from "../../../src/model/openaiCompatible.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, parseBillingMe, type BillingMe } from "../../../src/shared/billing.js";

export interface HostedRouteDeps { edgeBase: string; runtimeSecret: string; fetchImpl?: typeof fetch; now?: () => number }
export interface HostedProbe { me(uid: string): Promise<BillingMe | null> }

/** /billing/v1/me 的 60s/uid 缓存客户端。带平台身份（x-runtime-secret + on-behalf-of）
    打 edge；失败（网络/非 2xx/解不出）也缓存 60s——一个坏掉的 edge 不该被每个 turn 打一次。 */
export function createHostedProbe(deps: HostedRouteDeps): HostedProbe {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { v: BillingMe | null; exp: number }>();
  return {
    async me(uid) {
      const hit = cache.get(uid);
      if (hit && hit.exp > now()) return hit.v;
      let v: BillingMe | null = null;
      try {
        const res = await doFetch(`${deps.edgeBase}/billing/v1/me`, { headers: { "x-runtime-secret": deps.runtimeSecret, [ON_BEHALF_HEADER]: uid } });
        v = res.ok ? parseBillingMe(await res.json()) : null;
      } catch {
        v = null;
      }
      cache.set(uid, { v, exp: now() + 60_000 });
      return v;
    },
  };
}

export type RuntimeRoute =
  | { kind: "hosted"; endpoint: ResolvedEndpoint; model: string }
  | { kind: "workspace"; baseUrl: string; apiKey: string; model: string }
  | { kind: "blocked"; reason: string };

/** 决策（spec 第 5 节）：
    1. 发起人有活跃订阅 + 网关供着一款模型 → hosted（endpoint 带平台身份 + on-behalf-of +
       workspace/session 头，apiKey 留空——edge 的 pxIdentify 先看 x-runtime-secret，
       比中就不看 Authorization，空 Bearer 无害）。目标型号：工作区配的 modelId 若网关也
       供它，否则退到网关第一款（云会话没有型号选单）。
    2. 否则工作区自带 key（ADR-0202）。
    3. 都没有 → blocked，两条出路都说清楚。 */
export function decideRuntimeRoute(o: {
  me: BillingMe | null;
  requestedModel: string | null;
  workspace: { baseUrl: string; apiKey: string; modelId: string } | null;
  initiatorUid: string;
  workspaceId: string;
  sessionId: string;
  edgeBase: string;
  runtimeSecret: string;
}): RuntimeRoute {
  const me = o.me;
  if (me && me.status === "active" && me.plan && me.models.length > 0) {
    const model = o.requestedModel && me.models.includes(o.requestedModel) ? o.requestedModel : me.models[0]!;
    return {
      kind: "hosted",
      model,
      endpoint: {
        baseUrl: `${o.edgeBase}/llm/v1`,
        apiKey: "",
        route: "hosted",
        headers: {
          "x-runtime-secret": o.runtimeSecret,
          [ON_BEHALF_HEADER]: o.initiatorUid,
          [WORKSPACE_HEADER]: o.workspaceId,
          [SESSION_HEADER]: o.sessionId,
        },
      },
    };
  }
  if (o.workspace) {
    return { kind: "workspace", baseUrl: o.workspace.baseUrl, apiKey: o.workspace.apiKey, model: o.workspace.modelId };
  }
  return {
    kind: "blocked",
    reason:
      "这个 turn 没有可用的模型：发起人没有活跃订阅，工作区也没配自己的 API key。" +
      "两条路：发起人订阅 Mr Otto（桌面端设置 → 订阅），或工作区所有者在「仓库/模型」里填一把 key。",
  };
}
