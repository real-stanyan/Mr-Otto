// 云会话的模型路由（spec 第 5 节，ADR-0233 收窄）：**工作区所有者**有订阅 → 平台 key
// （扣所有者）；没有 → 一句人能看懂的错。**没有第二条路**：云会话不再支持工作区自带 key
// （ADR-0233 推翻 ADR-0202 与 ADR-0203 D4 的改道）——维护者定的产品口径是「工作区统一
// 走订阅额度」，自带 key 那条路存在一天，「额度用完悄悄改烧所有者自己的 key」这个
// 静默失败模式就存在一天。runtime 仍然一把模型 key 都不拿：托管那条路的凭据是平台身份
// + 「我代表谁」，key 在 edge 那边。
//
// 「扣谁的账」在 issue #917（ADR-0217）改过一次：原来是**发起人**。维护者定的规则是
// 「工作区走的都是创建者的订阅额度」，配套的另一半是「非订阅用户建不出工作区」——
// 两条一起，工作区成了「所有者请客、成员进来干活」的形状，成员自己有没有订阅与这本账
// 无关。注意本地事件日志里的 `model_usage.uid` 记的仍是**发起人**——那是「谁动的手」，
// 和「谁付的钱」是两个事实，不该合并成一个。
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../../src/model/openaiCompatible.js";
import type { TokenUsage } from "../../../src/session/events.js";
import type { CsModelRoute } from "../../../src/shared/remote/cloudSession.js";
import { AGENT_HEADER, MAX_INFLIGHT, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, parseBillingMe, type BillingMe } from "../../../src/shared/billing.js";
import { billingErrorOf, markBilling, markErrorClass } from "../../../src/model/errorClass.js";

/** 云端并发已满时的排队节奏（#960）。edge 的 Quota DO 按 uid 卡 MAX_INFLIGHT 条
    并发，而 ADR-0217 让一个工作区里所有云会话都记在**所有者**头上：成员的会话 +
    所有者自己的桌面共用那几个槽位，一个 hold 活到流结束（HOLD_TTL 10 分钟），
    所以撞上是常态不是异常。原来 adapter 退避三次（≈2.5s）就报废整轮。
    等满 ≈90s：比一条流式 turn 的典型长度长（等得到别人让出槽位），比 HOLD_TTL 短
    （不至于替一条已经死掉的 hold 空等）。刻意不做指数退避——排的是队，不是在
    安抚一个过载的上游，固定节奏让「第几个轮到我」这件事是可预期的 */
export const INFLIGHT_RETRY_MS = 5_000;
export const INFLIGHT_MAX_ATTEMPTS = 18;

export interface HostedRouteDeps { edgeBase: string; runtimeSecret: string; fetchImpl?: typeof fetch; now?: () => number }
/** `"unreachable"` = **没问到**（网络挂了 / edge 非 2xx / 信封解不出），不是
    「问到了，他没订阅」（#957 D3）。路由那一层两者结论相同（都走不了 hosted），
    但换轨落账要把它们分开说：一次 edge 抖动被写成「你的订阅额度用完了」，用户
    会去点续费按钮解决一个不存在的问题。`null` 保留给「明确没有订阅信息」的
    调用方（测试与将来别的实现），createHostedProbe 自己不再产出它 */
export interface HostedProbe { me(uid: string): Promise<BillingMe | null | "unreachable"> }

/** /billing/v1/me 的 60s/uid 缓存客户端。带平台身份（x-runtime-secret + on-behalf-of）
    打 edge；失败（网络/非 2xx/解不出）也缓存 60s——一个坏掉的 edge 不该被每个 turn 打一次。 */
export function createHostedProbe(deps: HostedRouteDeps): HostedProbe {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { v: BillingMe | null | "unreachable"; exp: number }>();
  return {
    async me(uid) {
      const hit = cache.get(uid);
      if (hit && hit.exp > now()) return hit.v;
      // 三种失败合成同一个 "unreachable"：它们的共同点是「这一刻问不出订阅状态」，
      // 而不是「问出来了，答案是没有」。解得出的信封原样回（`status: "none"` 是
      // 一个**确定的**答案，不是失败）
      let v: BillingMe | null | "unreachable" = "unreachable";
      try {
        const res = await doFetch(`${deps.edgeBase}/billing/v1/me`, { headers: { "x-runtime-secret": deps.runtimeSecret, [ON_BEHALF_HEADER]: uid } });
        v = res.ok ? (parseBillingMe(await res.json()) ?? "unreachable") : "unreachable";
      } catch {
        v = "unreachable";
      }
      cache.set(uid, { v, exp: now() + 60_000 });
      return v;
    },
  };
}

/** 「网关说过额度用完、什么时候恢复」的记忆（#957 D4 复审；ADR-0233 之后只剩这一格）。
    **住在会话上，不住在 adapter 上**：daemon 的 `adapterFor` 每次 `engineFor`
    都新造一台 adapter（每只 agent 一台、且 engine 命中缓存也 `setAdapter`），
    记在闭包里等于每个 turn 都从 null 开始。不记的话，窗口重置之前的**每一个**
    turn 都要先烧一次注定 429 的网关请求（外加 adapter 的退避），才知道额度还没回来。
    「上一次走的是哪条路」那一格随自带 key 路一起删了：只剩一条路，没有换轨可记 */
export interface RouteMemo {
  /** 网关说过额度用完、恢复时刻（epoch ms）；null = 没有已知的耗尽窗口 */
  exhaustedUntil(): number | null;
  noteExhausted(until: number): void;
}

/** 一份普通的内存 memo。daemon 每开一条会话房造一个；测试里也用它 */
export function createRouteMemo(): RouteMemo {
  let until: number | null = null;
  return {
    exhaustedUntil: () => until,
    noteExhausted: (u) => { until = u; },
  };
}

export type RuntimeRoute =
  | { kind: "hosted"; endpoint: ResolvedEndpoint; model: string }
  | { kind: "blocked"; reason: string };

/** 决策（spec 第 5 节，ADR-0233 收窄成两态）：
    1. 工作区所有者有活跃订阅 + 网关供着一款模型 → hosted（endpoint 带平台身份 + on-behalf-of +
       workspace/session 头，apiKey 留空——edge 的 pxIdentify 先看 x-runtime-secret，
       比中就不看 Authorization，空 Bearer 无害）。
    2. 否则 blocked，一句人话说清楚为什么、该谁做什么。
    **没有「工作区自带 key」这一级**（ADR-0233）。 */
export function decideRuntimeRoute(o: {
  /** `"unreachable"` 在这一层与 `null` 同义（都走不了 hosted）；分歧只在措辞：
      「问不到订阅状态」与「问到了、没有订阅」该做的动作不同（#957 D3） */
  me: BillingMe | null | "unreachable";
  /** 这只 agent 在我们的网关上想点哪几款，**按顺序取网关供着的第一个**（#979 第 4 条，
      ADR-0232）：agent 白名单按顺序 → 网关第一款。空数组 = 直接网关第一款 */
  requestedModels: readonly string[];
  /** 扣谁的账 = 工作区所有者（ADR-0217）。`me` 也必须是**这个 uid** 的订阅快照 */
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  edgeBase: string;
  runtimeSecret: string;
  /** 这一 turn 是哪只工作区 agent（#946）。带上就落 usage_event.agent_id；桌面直连没有这一格 */
  agentId?: string;
  /** 网关刚说过额度用完了、窗口还没到（#957 D4）。true = 不再撞 hosted，直接 blocked
      并说「额度用完」——ADR-0233 之前这里改道自带 key，现在没有第二条路，
      诚实地停下比每个 turn 先烧一次注定 429 的请求强 */
  exhausted?: boolean;
}): RuntimeRoute {
  const me = o.me === "unreachable" ? null : o.me;
  if (o.exhausted) {
    return {
      kind: "blocked",
      reason:
        "工作区所有者的订阅额度用完了，这个 turn 起不了。等这扇额度窗口刷新，或所有者加购额度后再 @。",
    };
  }
  if (me && me.status === "active" && me.plan && me.models.length > 0) {
    const model = o.requestedModels.find((m) => me.models.includes(m)) ?? me.models[0]!;
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
  return {
    kind: "blocked",
    reason:
      o.me === "unreachable"
        ? "这一刻查不到工作区所有者的订阅状态，这个 turn 没跑；稍后再 @ 一次。"
        : "工作区所有者没有活跃订阅，这个 turn 起不了。云会话统一走所有者的订阅额度——所有者订阅 Mr Otto（桌面端设置 → 账号 → 订阅）后再 @。",
  };
}

/** welcome/config_result 那一格 `modelRoute`（issue #945）：与 turn 真正走的那条路
    同一份 decideRuntimeRoute，sessionId 留空——这里只要 kind 与型号，不发请求。
    两处各写一份判定迟早分家，而分家的症状恰恰是这个 issue：界面说「未配模型」，
    turn 却跑得好好的。 */
export async function probeModelRoute(o: {
  probe: HostedProbe;
  ownerUid: string;
  workspaceId: string;
  edgeBase: string;
  runtimeSecret: string;
}): Promise<CsModelRoute> {
  const route = decideRuntimeRoute({
    me: await o.probe.me(o.ownerUid),
    requestedModels: [],
    ownerUid: o.ownerUid,
    workspaceId: o.workspaceId,
    sessionId: "",
    edgeBase: o.edgeBase,
    runtimeSecret: o.runtimeSecret,
  });
  if (route.kind === "hosted") return { kind: "hosted", model: route.model };
  return { kind: route.kind };
}

export interface HostedRuntimeAdapterDeps {
  edgeBase: string;
  runtimeSecret: string;
  probe: HostedProbe;
  /** 工作区所有者（ADR-0217）。不是 thunk：所有者不会在会话中途换人 */
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  /** 这一台 adapter 服务哪只工作区 agent（#946）；桌面直连没有这一格 */
  agentId?: string;
  /** 这只 agent 的型号白名单，**按顺序**（#957 D1 / #979 第 4 条）。**每次现读**
      （白名单在设置页里随时可改，会话房是长命的）。缺席/回 [] = 网关第一款 */
  preferredModels?: () => readonly string[];
  /** 额度耗尽窗口，**每条会话一份**（见 RouteMemo）。
      **必需**，不给默认值：写成可选就等于「忘接线那天它安静地退化成
      每台 adapter 各记各的」——每个 turn 先烧一次注定 429 的请求
      （同 `FrameHandlerDeps.log` / `rateLimit` 的纪律） */
  routeMemo: RouteMemo;
  /** 判「额度窗口过了没有」用的时钟；测试注入。缺省 Date.now */
  now?: () => number;
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
  const now = deps.now ?? (() => Date.now());

  /** 网关在这条会话上说过额度用完、且窗口还没到（#957 D4 复审 Minor 4）。
      不记住的话，窗口重置之前每一个 turn 都要先烧一次注定 429 的网关请求 */
  function quotaKnownExhausted(): boolean {
    const until = deps.routeMemo.exhaustedUntil();
    return until !== null && now() < until;
  }

  async function decide(): Promise<RuntimeRoute> {
    const uid = deps.ownerUid;
    const me = uid ? await deps.probe.me(uid) : null;
    const route = decideRuntimeRoute({
      me,
      // 白名单按顺序 → 网关第一款（后一级在 decideRuntimeRoute 里）。现读一次，不缓存（D1）
      requestedModels: deps.preferredModels?.() ?? [],
      ownerUid: uid,
      workspaceId: deps.workspaceId,
      sessionId: deps.sessionId,
      edgeBase: deps.edgeBase,
      runtimeSecret: deps.runtimeSecret,
      // exactOptionalPropertyTypes：只有非空 agentId 才透传
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
      ...(quotaKnownExhausted() ? { exhausted: true } : {}),
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
      const adapter = createOpenAICompatibleAdapter({
        baseUrl: route.endpoint.baseUrl,
        apiKey: "",
        // 额度用完那一刻 openaiCompatible 会 onReroute 一声、再 resolve 一次端点，
        // 指望调用方这次给出另一条路。ADR-0233 之后**没有另一条路**：记住窗口
        // （省掉之后每个 turn 那一次注定 429 的网关请求），端点原样交回去——
        // 第二次 429 之后 openaiCompatible 抛的就是**原错**，用户看到的是「额度
        // 用完了」且带 resetAt，不是一句我们自己编的话。代价是这一轮多打一次网关。
        // 没给 resetAt 就不记——猜一个时长的话，猜长了会在额度已经恢复之后继续
        // 把 turn 挡在门外
        onReroute: (info) => {
          if (info.resetAt !== undefined) deps.routeMemo.noteExhausted(info.resetAt);
        },
        resolveEndpoint: async () => route.endpoint,
        // 并发已满就排队（#960）：edge 的 Quota DO 按 uid 卡 MAX_INFLIGHT 条并发，
        // 整个工作区所有云会话共用所有者那几个槽位，撞上是常态
        retryDelayFor: (err, attempt) =>
          billingErrorOf(err)?.code === "too_many_inflight" && attempt <= INFLIGHT_MAX_ATTEMPTS
            ? INFLIGHT_RETRY_MS
            : null,
        model: route.model,
      });
      try {
        return await adapter.chat(messages, tools, onDelta, signal);
      } catch (err) {
        // 等满了还是没轮上 → 换成人话再抛（#960）。原来冒上去的是
        // `model API 429: {"error":{"type":"otto_edge",...}}`，用户在群里看到的
        // 就是那一坨信封：它既没说这是**工作区**共用的闸门（所以不是「我的额度」
        // 出了问题），也没说等一等就好。秒数从两个常量算出来，别写死——改了节奏
        // 而话没改，就成了另一句言之凿凿的假话
        const billing = billingErrorOf(err);
        if (billing?.code !== "too_many_inflight") throw err;
        const waited = Math.round((INFLIGHT_MAX_ATTEMPTS * INFLIGHT_RETRY_MS) / 1000);
        // class 与 billing 标记都要跟着搬到新错误上：换成人话是**措辞**的事，
        // 「这是哪一种错」的判断不该因为换了一句话而蒸发
        throw markBilling(
          markErrorClass(
            new Error(
              `工作区的云端模型并发已满：同一时刻最多 ${MAX_INFLIGHT} 条模型调用（整个工作区所有云会话共用），等了约 ${waited} 秒还没轮上。稍后再 @ 一次。`
            ),
            "rate-limit"
          ),
          billing
        );
      }
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
