// 云会话的模型路由（spec 第 5 节）：发起人有订阅 → 平台 key（扣发起人）；否则工作区自带 key
// （ADR-0202）；都没 → 一句人能看懂的错。runtime 仍然一把模型 key 都不拿：托管那条路的
// 凭据是平台身份 + 「我代表谁」，key 在 edge 那边。
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../../src/model/openaiCompatible.js";
import type { TokenUsage } from "../../../src/session/events.js";
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

export interface HostedRuntimeAdapterDeps {
  edgeBase: string;
  runtimeSecret: string;
  probe: HostedProbe;
  /** 每次现读一次——owner 随时可能改 key/换型号，会话房是长命的 */
  cfg: () => { baseUrl: string; apiKey: string; modelId: string } | null;
  initiatorUid: () => string | null;
  workspaceId: string;
  sessionId: string;
}

/** daemon.ts 的 adapterFor 装配点：把 decideRuntimeRoute 包成一个 ModelAdapter
    （issue #696 fix round 1，抽成独立、可单测的工厂——daemon.ts 本身不进 vitest，
    见文件头注释）。
    `prepare()` 让 engine 在读 `model` / 落 request_envelope 之前现算一次路由，
    决出的结果存进闭包里的 `prepared`，`chat()` 用它（用完即清）；没被 prepare()
    先调用的话 `chat()` 自己现决一次——两条路径共用同一份 `decide()`，向后兼容
    不调用 `prepare()` 的调用方。`decide()` 决出 blocked 时把 `model` 设成一个
    说得出口的占位（"(无可用模型)"），真正的原因留给 `chat()` 抛出去。 */
export function createHostedRuntimeAdapter(deps: HostedRuntimeAdapterDeps): ModelAdapter {
  let lastModel = "(未配置)";
  let prepared: RuntimeRoute | null = null;

  async function decide(): Promise<RuntimeRoute> {
    const uid = deps.initiatorUid() ?? "";
    const ws = deps.cfg();
    const route = decideRuntimeRoute({
      me: uid ? await deps.probe.me(uid) : null,
      requestedModel: ws?.modelId ?? null,
      workspace: ws ? { baseUrl: ws.baseUrl, apiKey: ws.apiKey, modelId: ws.modelId } : null,
      initiatorUid: uid,
      workspaceId: deps.workspaceId,
      sessionId: deps.sessionId,
      edgeBase: deps.edgeBase,
      runtimeSecret: deps.runtimeSecret,
    });
    lastModel = route.kind === "blocked" ? "(无可用模型)" : route.model;
    return route;
  }

  return {
    get model(): string {
      return lastModel;
    },
    async prepare(): Promise<void> {
      prepared = await decide();
    },
    async chat(messages, tools, onDelta, signal) {
      const route = prepared ?? (await decide());
      prepared = null;
      if (route.kind === "blocked") {
        throw new Error(route.reason);
      }
      const adapter =
        route.kind === "hosted"
          ? createOpenAICompatibleAdapter({
              baseUrl: route.endpoint.baseUrl,
              apiKey: "",
              resolveEndpoint: async () => route.endpoint,
              model: route.model,
            })
          : createOpenAICompatibleAdapter({
              baseUrl: route.baseUrl,
              apiKey: route.apiKey,
              model: route.model,
            });
      return adapter.chat(messages, tools, onDelta, signal);
    },
  };
}

/** 记账装饰器：包一层 usage 回调，adapter 本身该干嘛干嘛。搬到这份文件而不是
    daemon.ts（issue #696 fix round 2）——daemon.ts 的 `main()` 在 import 那一刻
    就跑（见文件头注释「不进 vitest」），从那儿导出 `withUsage` 会让单测一 import
    就触发真的 Docker/Supabase 装配；这里是已经在 vitest 里跑的纯逻辑文件。
    **不能用对象展开**——`{ ...adapter, async chat(...) {} }` 会在构造这一刻把
    `model` 这个同步 getter 的"此刻取值"复制成一份静态数据属性；`perSessionAdapter`
    只在开会话房那一刻造一次、活整个房间的生命周期，一旦复制就永远冻结在
    construct 时的值（云 runtime 的 adapter 那时还没跑过 prepare()/chat()，是
    "(未配置)"）——round 1 的 prepare() 修复因此在 request_envelope/
    assistant_message 里从没被观察到过。逐个成员显式转发：`model` 转发成 getter
    （每次现读 adapter.model，不是快照）；`prepare`/`requestConfig` 是可选成员，
    adapter 有就转发、没有就不放这个 key（同一份 ModelAdapter 接口，字段各自可选） */
export function withUsage(adapter: ModelAdapter, onUsage: (u: TokenUsage, model: string) => void): ModelAdapter {
  return {
    get model(): string {
      return adapter.model;
    },
    ...(adapter.prepare ? { prepare: () => adapter.prepare!() } : {}),
    ...(adapter.requestConfig ? { requestConfig: adapter.requestConfig } : {}),
    async chat(messages, tools, onDelta, signal) {
      const reply = await adapter.chat(messages, tools, onDelta, signal);
      if (reply.usage) onUsage(reply.usage, adapter.model);
      return reply;
    },
  };
}
