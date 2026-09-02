import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedProbe,
  createHostedRuntimeAdapter,
  decideRuntimeRoute,
  type HostedProbe,
} from "../../services/runtime/src/hostedRoute.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe } from "../../src/shared/billing.js";

const me: BillingMe = { plan: "pro", status: "active", windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: ["deepseek-v4-flash", "glm-5.3"] };
const base = { initiatorUid: "u1", workspaceId: "w1", sessionId: "s1", edgeBase: "https://edge", runtimeSecret: "rs" };
const ws = { baseUrl: "https://own/v1", apiKey: "sk", modelId: "glm-5.3" };

describe("decideRuntimeRoute", () => {
  it("发起人有订阅 → hosted，带平台身份 + on-behalf-of + workspace/session 头；型号尊重工作区配的（网关供的话）", () => {
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
  it("没订阅 + 工作区有 key → workspace 原路（ADR-0202）", () => {
    expect(decideRuntimeRoute({ me: null, requestedModel: "glm-5.3", workspace: ws, ...base })).toEqual({ kind: "workspace", baseUrl: "https://own/v1", apiKey: "sk", model: "glm-5.3" });
    expect(decideRuntimeRoute({ me: { ...me, status: "past_due" }, requestedModel: null, workspace: ws, ...base }).kind).toBe("workspace");
  });
  it("都没 → blocked，两条出路都说", () => {
    const r = decideRuntimeRoute({ me: null, requestedModel: null, workspace: null, ...base });
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).toMatch(/key/);
  });
});

describe("createHostedProbe", () => {
  it("带平台身份打 /me，60s 内同 uid 不再打；失败回 null 不抛", async () => {
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
    expect(await p.me("u1")).toBeNull();
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
      initiatorUid: () => "u1",
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
      initiatorUid: () => "u1",
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
      initiatorUid: () => "u1",
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

  it("决出 blocked：model 给一个说得出口的占位，chat() 抛出两条出路都说的原因", async () => {
    const probe = fakeProbe(null);
    const adapter = createHostedRuntimeAdapter({
      edgeBase: "https://edge",
      runtimeSecret: "rs",
      probe,
      cfg: () => null, // 工作区也没配 key
      initiatorUid: () => "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    await adapter.prepare?.();
    expect(adapter.model).toBe("(无可用模型)");
    await expect(adapter.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/订阅/);
  });
});
