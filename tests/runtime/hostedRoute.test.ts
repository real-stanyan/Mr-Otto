import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedProbe,
  createHostedRuntimeAdapter,
  decideRuntimeRoute,
  probeModelRoute,
  withUsage,
  type HostedProbe,
} from "../../services/runtime/src/hostedRoute.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe } from "../../src/shared/billing.js";
import type { TokenUsage } from "../../src/session/events.js";

const me: BillingMe = { plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: ["deepseek-v4-flash", "glm-5.3"] };
const base = { ownerUid: "u1", workspaceId: "w1", sessionId: "s1", edgeBase: "https://edge", runtimeSecret: "rs" };
const ws = { baseUrl: "https://own/v1", apiKey: "sk", modelId: "glm-5.3" };

describe("decideRuntimeRoute", () => {
  it("所有者有订阅 → hosted，带平台身份 + on-behalf-of + workspace/session 头；型号尊重工作区配的（网关供的话）", () => {
    const r = decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: ws, ...base });
    expect(r.kind).toBe("hosted");
    if (r.kind !== "hosted") return;
    expect(r.model).toBe("glm-5.3");
    expect(r.endpoint.baseUrl).toBe("https://edge/llm/v1");
    expect(r.endpoint.headers).toMatchObject({ "x-runtime-secret": "rs", [ON_BEHALF_HEADER]: "u1", "x-otto-workspace": "w1", "x-otto-session": "s1" });
    expect(r.endpoint.route).toBe("hosted");
  });
  it("工作区配的型号网关不供 → 用网关第一款", () => {
    const r = decideRuntimeRoute({ me, requestedModel: "gpt-9", workspace: ws, ...base });
    expect(r.kind === "hosted" && r.model).toBe("deepseek-v4-flash");
  });
  it("所有者没订阅 + 工作区有 key → workspace 原路（ADR-0202）", () => {
    expect(decideRuntimeRoute({ me: null, requestedModel: "glm-5.3", workspace: ws, ...base })).toEqual({ kind: "workspace", baseUrl: "https://own/v1", apiKey: "sk", model: "glm-5.3" });
    expect(decideRuntimeRoute({ me: { ...me, status: "past_due" }, requestedModel: null, workspace: ws, ...base }).kind).toBe("workspace");
  });
  it("都没 → blocked，两条出路都说", () => {
    const r = decideRuntimeRoute({ me: null, requestedModel: null, workspace: null, ...base });
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).toMatch(/key/);
  });
  // #957 D1：白名单是**托管路**的事。原来 daemon 的 cfg() 把 agent.models[0] 塞进
  // 工作区配置里当 modelId 递进来，工作区没配 key 时那份配置整个是 null——白名单
  // 于是静默蒸发，托管路永远拿网关第一款。requestedModel 与 workspace 是两条独立
  // 的入参，这一条钉住「workspace 为 null 也照样尊重 requestedModel」
  it("D1：workspace 为 null（工作区没自带 key）时 hosted 路仍尊重 requestedModel", () => {
    const r = decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: null, ...base });
    expect(r.kind === "hosted" && r.model).toBe("glm-5.3");
  });

  // #957 D2：自带 key 那条路上，型号由 owner 定。白名单是「这只 agent 在**我们的
  // 网关**上能点哪几款」，把群里任何成员填的一串字符原样发给 owner 自己的 provider
  // 是另一回事——那把 key 是 owner 的钱
  it("D2：自带 key 路一律用 ws.modelId，不看 requestedModel", () => {
    expect(decideRuntimeRoute({ me: null, requestedModel: "gpt-9", workspace: ws, ...base })).toEqual({
      kind: "workspace", baseUrl: "https://own/v1", apiKey: "sk", model: "glm-5.3",
    });
    // 探不到也一样（"unreachable" 在这一层与 null 同义，只是 reason 不同）
    expect(decideRuntimeRoute({ me: "unreachable", requestedModel: "gpt-9", workspace: ws, ...base })).toMatchObject({
      kind: "workspace", model: "glm-5.3",
    });
  });

  // #957 D3：探不到 ≠ 没订阅。这一层两者结论相同（都不走 hosted），分歧在
  // createHostedRuntimeAdapter 给 route_changed 写什么 reason
  it("D3：me = \"unreachable\" 当 null 用——有 key 走 workspace，没 key 走 blocked", () => {
    expect(decideRuntimeRoute({ me: "unreachable", requestedModel: null, workspace: ws, ...base }).kind).toBe("workspace");
    expect(decideRuntimeRoute({ me: "unreachable", requestedModel: null, workspace: null, ...base }).kind).toBe("blocked");
  });

  // #957 D4：额度耗尽之后再决一次，hosted 那支必须被跳过——不跳的话
  // resolveEndpoint 会把同一个已经 429 的端点再交回去，改道等于没改
  it("D4：exhausted:true 跳过 hosted 分支（有 key → workspace，没 key → blocked）", () => {
    expect(decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: ws, exhausted: true, ...base })).toMatchObject({
      kind: "workspace", model: "glm-5.3",
    });
    expect(decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: null, exhausted: true, ...base }).kind).toBe("blocked");
    // 缺席 = 现状（不跳）
    expect(decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: ws, ...base }).kind).toBe("hosted");
  });

  it("给了 agentId → hosted 端点多带 x-otto-agent；不给不带（桌面直连的形状）", () => {
    const withAgent = decideRuntimeRoute({ me, requestedModel: null, workspace: null, ...base, agentId: "a_ops" });
    expect(withAgent.kind === "hosted" && withAgent.endpoint.headers).toMatchObject({ [AGENT_HEADER]: "a_ops" });
    const without = decideRuntimeRoute({ me, requestedModel: null, workspace: null, ...base });
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
      probe,
      cfg: () => ws,
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    expect(adapter.model).toBe("(未配置)"); // 还没 prepare()/chat() 过
    await adapter.prepare?.();
    expect(adapter.model).toBe("glm-5.3"); // 网关供着，尊重工作区配的型号
    expect(probe.me).toHaveBeenCalledTimes(1);
  });

  it("chat() 复用 prepare() 决出的路由：不重复现决，且用 prepared 的 hosted endpoint 发请求", async () => {
    const probe = fakeProbe(me);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      probe,
      cfg: () => ws,
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
    const probe = fakeProbe(null); // 没订阅 → workspace 原路
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      probe,
      cfg: () => ws,
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
    expect(adapter.model).toBe("glm-5.3"); // workspace 路，型号即 ws.modelId
    expect(probe.me).toHaveBeenCalledTimes(1);
  });

  it("扣的是 ownerUid，不是发起人（#917/ADR-0217：工作区走创建者的额度）", async () => {
    // 只有 owner-1 有订阅；群里发消息的那个人（member-9）一分钱订阅都没有。
    // 按发起人扣的话这里会落进 workspace/blocked 分支，on-behalf 头也不会是 owner-1。
    // 这一条同时钉住「probe 问的是谁」和「头上写的是谁」——两处只要有一处回到
    // 发起人，这个用例就红
    const probe: HostedProbe = { me: vi.fn(async (uid: string) => (uid === "owner-1" ? me : null)) };
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      probe,
      cfg: () => ws,
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

  it("决出 blocked：model 给一个说得出口的占位，chat() 抛出两条出路都说的原因", async () => {
    const probe = fakeProbe(null);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      probe,
      cfg: () => null, // 工作区也没配 key
      ownerUid: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("(无可用模型)");
    await expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/所有者没有活跃订阅/);
  });
});

// #957 D1/D3/D4：白名单在托管路真生效、换轨落账、额度耗尽真改道
describe("createHostedRuntimeAdapter · 型号路由与换轨（#957 D1/D3/D4）", () => {
  afterEach(() => vi.unstubAllGlobals());

  const adapterBase = { edgeBase: "https://edge", runtimeSecret: "rs", ownerUid: "u1", workspaceId: "w1", sessionId: "s1" };

  it("D1：cfg() 为 null（工作区没自带 key）时，preferredModel 仍然决定托管路的型号", async () => {
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => me },
      cfg: () => null,
      preferredModel: () => "glm-5.3",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("glm-5.3");
  });

  it("D1：preferredModel 网关不供 → 退到网关第一款（不是抛错，也不是原样发过去）", async () => {
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => me },
      cfg: () => null,
      preferredModel: () => "gpt-9",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("deepseek-v4-flash");
  });

  it("D2：没订阅走自带 key 时，型号是 ws.modelId —— preferredModel 一个字都不参与", async () => {
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => null },
      cfg: () => ({ ...ws, modelId: "owner-choice" }),
      preferredModel: () => "gpt-9",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("owner-choice");
  });

  it("D3：hosted → workspace（探不到）→ hosted，两次换轨各回调一次、reason 分得开", async () => {
    let meVal: BillingMe | null | "unreachable" = me;
    const changes: [string, string, string][] = [];
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => meVal },
      cfg: () => ws,
      onRouteChanged: (from, to, reason) => changes.push([from, to, reason]),
    });

    await adapter.prepare?.();
    expect(changes).toEqual([]); // 第一次决策没有「上一条路」可比，不算换轨

    meVal = "unreachable";
    await adapter.prepare?.();
    expect(changes).toEqual([["hosted", "workspace", "probe_failed"]]);

    meVal = me;
    await adapter.prepare?.();
    expect(changes).toEqual([
      ["hosted", "workspace", "probe_failed"],
      ["workspace", "hosted", "subscription_active"],
    ]);
  });

  it("D3：探到了、他确实没订阅 —— reason 是 no_subscription 不是 probe_failed", async () => {
    let meVal: BillingMe | null | "unreachable" = me;
    const changes: [string, string, string][] = [];
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => meVal },
      cfg: () => ws,
      onRouteChanged: (from, to, reason) => changes.push([from, to, reason]),
    });
    await adapter.prepare?.();
    meVal = { ...me, status: "canceled" };
    await adapter.prepare?.();
    expect(changes).toEqual([["hosted", "workspace", "no_subscription"]]);
  });

  it("D4：托管路 429 quota_exhausted → 第二次请求打到 ws.baseUrl，并落一条 quota_exhausted 的换轨", async () => {
    const changes: [string, string, string][] = [];
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => me },
      cfg: () => ws,
      onRouteChanged: (from, to, reason) => changes.push([from, to, reason]),
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.startsWith("https://edge")) {
          return Response.json(
            { error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时窗额度用完了", window: "5h", resetAt: 123 } },
            { status: 429 }
          );
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
      })
    );
    const reply = await adapter.chat([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("ok");
    expect(urls).toEqual(["https://edge/llm/v1/chat/completions", "https://own/v1/chat/completions"]);
    expect(changes).toEqual([["hosted", "workspace", "quota_exhausted"]]);
  });

  it("D4：额度耗尽但工作区没配 key —— 抛原错，且只打了两次网关（没有第三条路可试）", async () => {
    const changes: [string, string, string][] = [];
    const adapter = createHostedRuntimeAdapter({
      ...adapterBase,
      probe: { me: async () => me },
      cfg: () => null,
      onRouteChanged: (from, to, reason) => changes.push([from, to, reason]),
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json(
          { error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时窗额度用完了", window: "5h" } },
          { status: 429 }
        );
      })
    );
    await expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
    expect(urls).toEqual(["https://edge/llm/v1/chat/completions", "https://edge/llm/v1/chat/completions"]);
    // 没有真的改道 —— 不落一条撒谎的换轨（同桌面 main/agent.ts 的 onReroute 纪律）
    expect(changes).toEqual([]);
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
      probe: fakeProbe(me),
      cfg: () => ws,
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
describe("probeModelRoute（#945）", () => {
  const probeOf = (v: BillingMe | null | "unreachable"): HostedProbe => ({ me: async () => v });
  // probeModelRoute 不发请求，所以不需要 sessionId 那一格
  const { sessionId: _sessionId, ...probeBase } = base;

  it("有订阅 → hosted + 实际会用的型号（工作区配的网关不供就退到第一款）", async () => {
    expect(await probeModelRoute({ probe: probeOf(me), cfg: () => ({ ...ws, modelId: "gpt-9" }), ...probeBase })).toEqual({
      kind: "hosted",
      model: "deepseek-v4-flash",
    });
  });

  it("没订阅有 key → workspace；都没 → blocked", async () => {
    expect(await probeModelRoute({ probe: probeOf(null), cfg: () => ws, ...probeBase })).toEqual({ kind: "workspace" });
    expect(await probeModelRoute({ probe: probeOf(null), cfg: () => null, ...probeBase })).toEqual({ kind: "blocked" });
  });

  // #957 D3：welcome 那一格只有三档（CsModelRoute 不变、协议不升版），
  // 「探不到」在这里与「没订阅」同结论——分歧只落在 route_changed 的 reason 上
  it("探不到（\"unreachable\"）在这一格与没订阅同结论：有 key → workspace，没 key → blocked", async () => {
    expect(await probeModelRoute({ probe: probeOf("unreachable"), cfg: () => ws, ...probeBase })).toEqual({ kind: "workspace" });
    expect(await probeModelRoute({ probe: probeOf("unreachable"), cfg: () => null, ...probeBase })).toEqual({ kind: "blocked" });
  });
});
