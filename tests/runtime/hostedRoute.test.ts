import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedProbe,
  createHostedRuntimeAdapter,
  createRouteMemo,
  decideRuntimeRoute,
  probeModelRoute,
  withUsage,
  INFLIGHT_MAX_ATTEMPTS,
  INFLIGHT_RETRY_MS,
  type HostedProbe,
} from "../../services/runtime/src/hostedRoute.js";
import { AGENT_HEADER, MAX_INFLIGHT, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe } from "../../src/shared/billing.js";
import { billingErrorOf, errorClassOf } from "../../src/model/errorClass.js";
import type { TokenUsage } from "../../src/session/events.js";

const me: BillingMe = { plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: ["deepseek-v4-flash", "glm-5.3"] };
const base = { ownerUid: "u1", workspaceId: "w1", sessionId: "s1", edgeBase: "https://edge", runtimeSecret: "rs" };

describe("decideRuntimeRoute（ADR-0233：只有 hosted / blocked 两态）", () => {
  it("所有者有订阅 → hosted，带平台身份 + on-behalf-of + workspace/session 头；型号按白名单顺序取网关供着的", () => {
    const r = decideRuntimeRoute({ me, requestedModels: ["glm-5.3"], ...base });
    expect(r.kind).toBe("hosted");
    if (r.kind !== "hosted") return;
    expect(r.model).toBe("glm-5.3");
    expect(r.endpoint.baseUrl).toBe("https://edge/llm/v1");
    expect(r.endpoint.headers).toMatchObject({ "x-runtime-secret": "rs", [ON_BEHALF_HEADER]: "u1", "x-otto-workspace": "w1", "x-otto-session": "s1" });
    expect(r.endpoint.route).toBe("hosted");
  });
  it("白名单网关都不供 → 用网关第一款；空白名单同款", () => {
    expect(decideRuntimeRoute({ me, requestedModels: ["gpt-9"], ...base })).toMatchObject({ kind: "hosted", model: "deepseek-v4-flash" });
    expect(decideRuntimeRoute({ me, requestedModels: [], ...base })).toMatchObject({ kind: "hosted", model: "deepseek-v4-flash" });
  });
  it("所有者没订阅 / past_due → blocked，说的是所有者的订阅，一个字不提 key（ADR-0233 推翻 ADR-0202）", () => {
    const r = decideRuntimeRoute({ me: null, requestedModels: ["glm-5.3"], ...base });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).not.toMatch(/key/i);
    expect(decideRuntimeRoute({ me: { ...me, status: "past_due" }, requestedModels: [], ...base }).kind).toBe("blocked");
  });
  // #957 D3：探不到 ≠ 没订阅。结论相同（都 blocked），措辞要分开——一次 edge 抖动
  // 被写成「你没订阅」，用户会去点续费按钮解决一个不存在的问题
  it("D3：me = \"unreachable\" → blocked，但措辞是「查不到」不是「没订阅」", () => {
    const r = decideRuntimeRoute({ me: "unreachable", requestedModels: [], ...base });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/查不到/);
    expect(r.kind === "blocked" && r.reason).not.toMatch(/没有活跃订阅/);
  });
  // #957 D4 → ADR-0233：额度耗尽之后没有第二条路，诚实地 blocked 并说「额度用完」
  it("D4：exhausted:true → blocked，措辞是额度用完；不带 exhausted 照常 hosted", () => {
    const r = decideRuntimeRoute({ me, requestedModels: ["glm-5.3"], exhausted: true, ...base });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/额度用完/);
    expect(decideRuntimeRoute({ me, requestedModels: ["glm-5.3"], ...base }).kind).toBe("hosted");
  });
  it("给了 agentId → hosted 端点多带 x-otto-agent；不给不带（桌面直连的形状）", () => {
    const withAgent = decideRuntimeRoute({ me, requestedModels: [], ...base, agentId: "a_ops" });
    expect(withAgent.kind === "hosted" && withAgent.endpoint.headers).toMatchObject({ [AGENT_HEADER]: "a_ops" });
    const without = decideRuntimeRoute({ me, requestedModels: [], ...base });
    expect(without.kind === "hosted" && AGENT_HEADER in (without.endpoint.headers ?? {})).toBe(false);
  });
});

describe("createHostedProbe", () => {
  it("带平台身份打 /me，60s 内同 uid 不再打；失败回 \"unreachable\" 不抛（#957 D3）", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => Response.json(me)) as unknown as typeof fetch;
    const p = createHostedProbe({ edgeBase: "https://edge", runtimeSecret: "rs", fetchImpl, now: () => now });
    expect(await p.me("u1")).toEqual(me);
    expect(await p.me("u1")).toEqual(me);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "x-runtime-secret": "rs", [ON_BEHALF_HEADER]: "u1" });
    now = 61_000;
    (fetchImpl as unknown as { mockResolvedValueOnce: (v: Response) => void }).mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await p.me("u1")).toBe("unreachable");
  });

  // #957 D3：「探不到」与「探到了、他没订阅」是两个事实——合成一个 null 的话，
  // 一次 edge 抖动与一次真实退订在日志里长得一模一样，而 route_changed 的
  // reason 恰恰要把它们分开说
  it("fetch 抛错 → \"unreachable\"；res.ok 且解得出 status:\"none\" → 那个对象（不是 null）", async () => {
    const throwing = createHostedProbe({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(await throwing.me("u1")).toBe("unreachable");

    const none: BillingMe = { ...me, plan: null, status: "none", windows: null, models: [] };
    const ok = createHostedProbe({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      fetchImpl: (async () => Response.json(none)) as unknown as typeof fetch,
    });
    expect(await ok.me("u1")).toEqual(none);
  });
});

describe("createHostedRuntimeAdapter（issue #696 fix round 1：request_envelope.model 不落后一个 turn）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeProbe(v: BillingMe | null): HostedProbe {
    return { me: vi.fn(async () => v) };
  }

  it("prepare() 现算路由 → model getter 在 chat() 之前就等于决出的型号", async () => {
    const probe = fakeProbe(me);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe,
      preferredModels: () => ["glm-5.3"],
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    expect(adapter.model).toBe("(未配置)"); // 还没 prepare()/chat() 过
    await adapter.prepare?.();
    expect(adapter.model).toBe("glm-5.3"); // 网关供着，尊重白名单
    expect(probe.me).toHaveBeenCalledTimes(1);
  });

  it("chat() 复用 prepare() 决出的路由：不重复现决，且用 prepared 的 hosted endpoint 发请求", async () => {
    const probe = fakeProbe(me);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe,
      preferredModels: () => ["glm-5.3"],
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
      })
    );

    await adapter.prepare?.();
    expect(adapter.model).toBe("glm-5.3");
    await adapter.chat([{ role: "user", content: "hi" }]);

    // prepare() 现决过一次；chat() 复用它，不再打第二次 probe
    expect(probe.me).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://edge/llm/v1/chat/completions");
    expect(calls[0]!.init.headers).toMatchObject({
      "x-runtime-secret": "rs",
      [ON_BEHALF_HEADER]: "u1",
      [WORKSPACE_HEADER]: "w1",
      [SESSION_HEADER]: "s1",
    });
  });

  it("没调用 prepare() 时 chat() 向后兼容：自己现决一次", async () => {
    const probe = fakeProbe(me);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe,
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }))
    );
    const reply = await adapter.chat([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("ok");
    expect(adapter.model).toBe("deepseek-v4-flash"); // 没给白名单 → 网关第一款
    expect(probe.me).toHaveBeenCalledTimes(1);
  });

  it("扣的是 ownerUid，不是发起人（#917/ADR-0217：工作区走创建者的额度）", async () => {
    // 只有 owner-1 有订阅；群里发消息的那个人（member-9）一分钱订阅都没有。
    // 按发起人扣的话这里会落进 blocked 分支，on-behalf 头也不会是 owner-1。
    // 这一条同时钉住「probe 问的是谁」和「头上写的是谁」——两处只要有一处回到
    // 发起人，这个用例就红
    const probe: HostedProbe = { me: vi.fn(async (uid: string) => (uid === "owner-1" ? me : null)) };
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe,
      ownerUid: "owner-1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    const calls: { init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ init });
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
      })
    );
    await adapter.chat([{ role: "user", content: "hi" }]);
    expect(probe.me).toHaveBeenCalledWith("owner-1");
    expect(calls[0]!.init.headers).toMatchObject({ [ON_BEHALF_HEADER]: "owner-1" });
  });

  it("决出 blocked：model 给一个说得出口的占位，chat() 抛出说清楚该谁做什么的原因", async () => {
    const probe = fakeProbe(null);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe,
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("(无可用模型)");
    await expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/所有者没有活跃订阅/);
  });
});

// #957 D1/D4 → ADR-0233：白名单在托管路生效；额度耗尽没有第二条路——记住窗口、诚实地停
describe("createHostedRuntimeAdapter · 型号与额度窗口（#957 D1/D4，ADR-0233）", () => {
  afterEach(() => vi.unstubAllGlobals());
  const adapterBase = { edgeBase: "https://edge", runtimeSecret: "rs", ownerUid: "u1", workspaceId: "w1", sessionId: "s1" };
  const solo = () => ({ ...adapterBase, routeMemo: createRouteMemo() });

  it("D1：preferredModels 决定托管路的型号；网关不供 → 退到网关第一款（不是抛错，也不是原样发过去）", async () => {
    const a1 = createHostedRuntimeAdapter({ ...solo(), probe: { me: async () => me }, preferredModels: () => ["glm-5.3"] });
    await a1.prepare?.();
    expect(a1.model).toBe("glm-5.3");
    const a2 = createHostedRuntimeAdapter({ ...solo(), probe: { me: async () => me }, preferredModels: () => ["gpt-9"] });
    await a2.prepare?.();
    expect(a2.model).toBe("deepseek-v4-flash");
  });

  it("D4：托管路 429 quota_exhausted → 没有第二条路：端点原样再试一次，抛的是原错（带 resetAt 的那条）", async () => {
    const adapter = createHostedRuntimeAdapter({ ...solo(), probe: { me: async () => me } });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(
        { error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时窗额度用完了", window: "5h", resetAt: 123 } },
        { status: 429 }
      );
    }));
    await expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
    expect(urls).toEqual(["https://edge/llm/v1/chat/completions", "https://edge/llm/v1/chat/completions"]);
  });

  // #957 D4 复审 Minor 4：不记住窗口的话，重置之前每个 turn 都要先烧一次注定 429 的
  // 网关请求。ADR-0233 之后窗口内的 turn 直接 blocked（不打网关），窗口过了再试托管
  it("D4：记住耗尽窗口 —— 窗口内的下一个 turn 一次网关都不打、直接说额度用完；窗口过了再试托管", async () => {
    let clock = 0;
    const memo = createRouteMemo();
    const build = () => createHostedRuntimeAdapter({ ...adapterBase, routeMemo: memo, now: () => clock, probe: { me: async () => me } });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(
        { error: { type: "otto_edge", code: "quota_exhausted", message: "满了", window: "5h", resetAt: 10_000 } },
        { status: 429 }
      );
    }));
    await build().chat([{ role: "user", content: "1" }]).catch(() => {}); // turn 1：撞网关，记住 resetAt
    expect(urls.length).toBe(2);
    expect(memo.exhaustedUntil()).toBe(10_000);

    clock = 5_000; // 还在窗口里
    urls.length = 0;
    await expect(build().chat([{ role: "user", content: "2" }])).rejects.toThrow(/额度用完/);
    expect(urls).toEqual([]); // 一次网关都不打

    clock = 20_000; // 窗口过了 —— 该回去试托管，不能永远挡在门外
    urls.length = 0;
    await build().chat([{ role: "user", content: "3" }]).catch(() => {});
    expect(urls[0]).toBe("https://edge/llm/v1/chat/completions");
  });

  it("D4：网关没给 resetAt 就不记窗口 —— 猜长了会在额度已经恢复之后继续把 turn 挡在门外", async () => {
    const memo = createRouteMemo();
    const adapter = createHostedRuntimeAdapter({ ...adapterBase, routeMemo: memo, probe: { me: async () => me } });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: { type: "otto_edge", code: "quota_exhausted", message: "满了", window: "5h" } }, { status: 429 })
    ));
    await adapter.chat([{ role: "user", content: "hi" }]).catch(() => {});
    expect(memo.exhaustedUntil()).toBeNull();
  });
});

describe("withUsage（issue #696 fix round 2：不能用对象展开转发 model，否则永远冻结在构造时的快照）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeProbe(v: BillingMe | null): HostedProbe {
    return { me: vi.fn(async () => v) };
  }

  it("包一层 withUsage 之后，prepare() 决出的型号仍然反映在外层 .model 上（不是构造时的旧快照）", async () => {
    const inner = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      routeMemo: createRouteMemo(),
      probe: fakeProbe(me),
      preferredModels: () => ["glm-5.3"],
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    const usages: { u: TokenUsage; model: string }[] = [];
    const wrapped = withUsage(inner, (u, model) => usages.push({ u, model }));

    // 包完那一刻，内层还没 prepare()/chat() 过——外层照样得是内层此刻的值，
    // 不是"包的时候顺手 spread 出来的快照"
    expect(wrapped.model).toBe(inner.model);
    expect(wrapped.model).toBe("(未配置)");

    expect(wrapped.prepare).toBeDefined();
    await wrapped.prepare?.();

    // 关键断言：包一层之后 .model 依然跟着内层的真实路由走
    expect(wrapped.model).toBe("glm-5.3");
    expect(inner.model).toBe("glm-5.3");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      }))
    );
    await wrapped.chat([{ role: "user", content: "hi" }]);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.model).toBe("glm-5.3"); // usage 回调也读到刚决出的型号，不是旧快照
  });

  it("adapter 没有 prepare()（桌面端的老 adapter）：wrapped 也不应该凭空长出 prepare", () => {
    const noPrepareAdapter = { model: "m-1", async chat() { return { content: "ok" }; } };
    const wrapped = withUsage(noPrepareAdapter, () => {});
    expect(wrapped.prepare).toBeUndefined();
    expect(wrapped.model).toBe("m-1");
  });
});


// issue #945：welcome/config_result 那一格 `modelRoute` 与真正跑 turn 的那条路
// 同源——桌面不再拿 `model === null` 推断「起不了 turn」（订阅用户走托管路照跑）
describe("probeModelRoute（#945，ADR-0233 两态）", () => {
  const probeOf = (v: BillingMe | null | "unreachable"): HostedProbe => ({ me: async () => v });
  // probeModelRoute 不发请求，所以不需要 sessionId 那一格
  const { sessionId: _sessionId, ...probeBase } = base;

  it("有订阅 → hosted + 网关第一款（这一格答的是工作区默认那份）", async () => {
    expect(await probeModelRoute({ probe: probeOf(me), ...probeBase })).toEqual({ kind: "hosted", model: "deepseek-v4-flash" });
  });

  it("没订阅 → blocked；探不到 → 也是 blocked（这一格只有两态，措辞分歧留在 turn 那条路上）", async () => {
    expect(await probeModelRoute({ probe: probeOf(null), ...probeBase })).toEqual({ kind: "blocked" });
    expect(await probeModelRoute({ probe: probeOf("unreachable"), ...probeBase })).toEqual({ kind: "blocked" });
  });
});

// ── #960：云端并发已满时排队重试，放弃时说人话 ──────────────────────────
// edge 的 Quota DO 按 uid 卡并发（MAX_INFLIGHT = 4），而 ADR-0217 让一个工作区
// 里所有云会话都记在**所有者**头上：成员的会话 + 所有者自己的桌面共用这四个槽位，
// 撞上是常态而不是异常。原来 adapter 退避三次（≈2.5s）就报废整轮，且把 edge 的
// JSON 信封原样甩给用户。
describe("createHostedRuntimeAdapter · 云端并发已满时排队（#960）", () => {
  afterEach(() => vi.unstubAllGlobals());
  const inflightBase = { edgeBase: "https://edge", runtimeSecret: "rs", ownerUid: "u1", workspaceId: "w1", sessionId: "s1" };
  const soloInflight = () => ({ ...inflightBase, routeMemo: createRouteMemo() });
  const inflight = () =>
    Response.json({ error: { type: "otto_edge", code: "too_many_inflight", message: "同时进行的请求太多，稍后再试" } }, { status: 429 });
  const okRes = { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };

  it("网关连回 3 次「并发已满」→ 第 4 次轮上就成功，这一轮不报废", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchMock = vi.fn(async () => {
        n += 1;
        return n <= 3 ? inflight() : okRes;
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createHostedRuntimeAdapter({ ...soloInflight(), probe: { me: async () => me } });
      const pending = adapter.chat([{ role: "user", content: "hi" }]);
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(INFLIGHT_RETRY_MS);
      expect((await pending).content).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("排到上限仍轮不上 → 抛人话（并发上限 + 等了多久 + 下一步做什么），class 仍是 rate-limit", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => inflight());
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createHostedRuntimeAdapter({ ...soloInflight(), probe: { me: async () => me } });
      const assertion = expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toSatisfy((e: unknown) =>
        e instanceof Error &&
        e.message.includes(`最多 ${MAX_INFLIGHT} 条模型调用`) &&
        e.message.includes("90 秒") &&
        !e.message.includes("otto_edge") &&
        errorClassOf(e) === "rate-limit" &&
        billingErrorOf(e)?.code === "too_many_inflight");
      for (let i = 0; i <= INFLIGHT_MAX_ATTEMPTS + 3; i++) await vi.advanceTimersByTimeAsync(INFLIGHT_RETRY_MS);
      await assertion;
      // 18 次排队（attempt 1..18 都在 INFLIGHT_MAX_ATTEMPTS 之内，18 × 5 s = 「约 90 秒」那句话的来源）+ 默认预算 3 次：
      // 排队不吃 maxAttempts（复审 fix round 1），所以队排满之后这条 429 照旧是一条
      // 普通的可重试限流，该有的三次退避一次不少
      expect(fetchMock).toHaveBeenCalledTimes(INFLIGHT_MAX_ATTEMPTS + 3);
    } finally {
      vi.useRealTimers();
    }
  });

});

// #979 第 4 条（ADR-0232）：白名单原来只有 [0] 有消费方——表单写「逗号分隔」，其余
// 元素没人读。现在它是一条优先级链：agent 白名单按顺序 → 网关第一款（ADR-0233 之后
// 中间那级「工作区配的那款」随自带 key 路一起删了）
describe("型号白名单是优先级链（#979 第 4 条，ADR-0232）", () => {
  const solo = () => ({ ownerUid: "u1", workspaceId: "w1", sessionId: "s1", edgeBase: "https://edge", runtimeSecret: "rs", routeMemo: createRouteMemo() });

  it("decideRuntimeRoute：按顺序取网关供着的第一个；一个都不供才退网关第一款", () => {
    expect(decideRuntimeRoute({ me, requestedModels: ["gpt-9", "glm-5.3"], ...base })).toMatchObject({ kind: "hosted", model: "glm-5.3" });
    expect(decideRuntimeRoute({ me, requestedModels: ["gpt-9", "gpt-8"], ...base })).toMatchObject({ kind: "hosted", model: "deepseek-v4-flash" });
    expect(decideRuntimeRoute({ me, requestedModels: [], ...base })).toMatchObject({ kind: "hosted", model: "deepseek-v4-flash" });
  });

  it("adapter：白名单第二个供 → 用第二个", async () => {
    const adapter = createHostedRuntimeAdapter({
      ...solo(),
      probe: { me: async () => me },
      preferredModels: () => ["gpt-9", "deepseek-v4-flash"],
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("deepseek-v4-flash");
  });
});
