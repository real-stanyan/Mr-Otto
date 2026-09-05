// 云会话的模型路由（spec 第 5 节）：**工作区所有者**有订阅 → 平台 key（扣所有者）；否则
// 工作区自带 key（ADR-0202）；都没 → 一句人能看懂的错。runtime 仍然一把模型 key 都不拿：
// 托管那条路的凭据是平台身份 + 「我代表谁」，key 在 edge 那边。
//
// 「扣谁的账」在 issue #917（ADR-0217）改过一次：原来是**发起人**。维护者定的规则是
// 「工作区走的都是创建者的订阅额度」，配套的另一半是「非订阅用户建不出工作区」——
// 两条一起，工作区成了「所有者请客、成员进来干活」的形状，成员自己有没有订阅与这本账
// 无关。按发起人扣的话，一个没订阅的成员在群里发一句话会走进 blocked 分支（或者更糟：
// 悄悄改用工作区自带的 key），同一个工作区里两个人得到两种行为，而这件事没有任何界面
// 说得出口。注意本地事件日志里的 `model_usage.uid` 记的仍是**发起人**——那是「谁动的手」，
// 和「谁付的钱」是两个事实，不该合并成一个。
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../../src/model/openaiCompatible.js";
import type { TokenUsage } from "../../../src/session/events.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, parseBillingMe, type BillingMe } from "../../../src/shared/billing.js";

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
    1. 工作区所有者有活跃订阅 + 网关供着一款模型 → hosted（endpoint 带平台身份 + on-behalf-of +
       workspace/session 头，apiKey 留空——edge 的 pxIdentify 先看 x-runtime-secret，
       比中就不看 Authorization，空 Bearer 无害）。目标型号：工作区配的 modelId 若网关也
       供它，否则退到网关第一款（云会话没有型号选单）。
    2. 否则工作区自带 key（ADR-0202）。
    3. 都没有 → blocked，两条出路都说清楚。 */
export function decideRuntimeRoute(o: {
  me: BillingMe | null;
  requestedModel: string | null;
  workspace: { baseUrl: string; apiKey: string; modelId: string } | null;
  /** 扣谁的账 = 工作区所有者（ADR-0217）。`me` 也必须是**这个 uid** 的订阅快照 */
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  edgeBase: string;
  runtimeSecret: string;
  /** 这一 turn 是哪只工作区 agent（#946）。带上就落 usage_event.agent_id；桌面直连没有这一格 */
  agentId?: string;
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
          [ON_BEHALF_HEADER]: o.ownerUid,
          [WORKSPACE_HEADER]: o.workspaceId,
          [SESSION_HEADER]: o.sessionId,
          // exactOptionalPropertyTypes 不许把 undefined 塞进 headers；只有非空
          // agentId 才落这一格（同 sessionService.ts:228 的既有纪律）
          ...(o.agentId ? { [AGENT_HEADER]: o.agentId } : {}),
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
      "这个 turn 没有可用的模型：工作区所有者没有活跃订阅，工作区也没配自己的 API key。" +
      "两条路：所有者订阅 Mr Otto（桌面端设置 → 账号 → 订阅），或在工作区的「仓库/模型」里填一把 key。",
  };
}

export interface HostedRuntimeAdapterDeps {
  edgeBase: string;
  runtimeSecret: string;
  probe: HostedProbe;
  /** 每次现读一次——owner 随时可能改 key/换型号，会话房是长命的 */
  cfg: () => { baseUrl: string; apiKey: string; modelId: string } | null;
  /** 工作区所有者（ADR-0217）。不是 thunk：所有者不会在会话中途换人，
      而 cfg 是 thunk 是因为 key/型号随时可改 */
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  /** 这一台 adapter 服务哪只工作区 agent（#946）；桌面直连没有这一格 */
  agentId?: string;
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
    const uid = deps.ownerUid;
    const ws = deps.cfg();
    const route = decideRuntimeRoute({
      me: uid ? await deps.probe.me(uid) : null,
      requestedModel: ws?.modelId ?? null,
      workspace: ws ? { baseUrl: ws.baseUrl, apiKey: ws.apiKey, modelId: ws.modelId } : null,
      ownerUid: uid,
      workspaceId: deps.workspaceId,
      sessionId: deps.sessionId,
      edgeBase: deps.edgeBase,
      runtimeSecret: deps.runtimeSecret,
      // exactOptionalPropertyTypes：只有非空 agentId 才透传
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
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
