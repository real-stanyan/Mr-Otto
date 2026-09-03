import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEdge, type BillingPort, type EdgeConfig } from "../../services/edge/src/edge.js";
import type { Caller } from "../../services/edge/src/llmGateway.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe } from "../../src/shared/billing.js";

const SECRET = "jwt-secret";
const RUNTIME = "runtime-secret";
const NOW_MS = 1_800_000_000_000;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub = "u1"): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email: "a@b.c", exp: Math.floor(NOW_MS / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const config: EdgeConfig = { jwtSecret: SECRET, runtimeSecret: RUNTIME };
// I4 起 `x-otto-on-behalf-of` 必须是 uuid（它的值直接变成被扣钱的 uid）
const U7 = "77777777-7777-4777-8777-777777777777";
const U3 = "33333333-3333-4333-8333-333333333333";
const U2 = "22222222-2222-4222-8222-222222222222";

const me: BillingMe = { plan: "lite", status: "active", plans: [{ id: "lite", priceUsdCents: 1900, capabilities: { image: false, video: false } }], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [] };

function harness() {
  const llmCalls: Caller[] = [];
  const billingCalls: string[] = [];
  const billing: BillingPort = {
    me: async (uid) => { billingCalls.push(`me:${uid}`); return me; },
    checkout: async (uid, target) => { billingCalls.push(`checkout:${uid}:${JSON.stringify(target)}`); return { url: "https://stripe/x" }; },
    portal: async (uid) => { billingCalls.push(`portal:${uid}`); return { url: "https://stripe/p" }; },
    webhook: async (payload, sig) => { billingCalls.push(`webhook:${payload}:${sig}`); return { status: 200, body: { ok: true } }; },
  };
  const handle = createEdge({
    config, now: () => NOW_MS,
    llm: async (_req, caller) => { llmCalls.push(caller); return new Response("llm-ok"); },
    billing,
  });
  return { handle, llmCalls, billingCalls };
}

const post = (path: string, headers: Record<string, string>, body = "{}") =>
  new Request(`https://edge${path}`, { method: "POST", headers, body });

describe("/llm/v1/chat/completions 身份", () => {
  it("桌面 JWT → caller.source=desktop，uid 是 sub；workspace/session 头透进 caller", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token("u9")}`, [WORKSPACE_HEADER]: "w1", [SESSION_HEADER]: "s1" }));
    expect(res.status).toBe(200);
    expect(h.llmCalls).toEqual([{ uid: "u9", source: "desktop", workspaceId: "w1", sessionId: "s1" }]);
  });

  it("workspace/session 头超长会被截断到 128 字符才递给 llm（Task 7 落库用）", async () => {
    const h = harness();
    const long = "w".repeat(5000);
    const res = await h.handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token("u9")}`, [WORKSPACE_HEADER]: long, [SESSION_HEADER]: long }));
    expect(res.status).toBe(200);
    expect(h.llmCalls[0]!.workspaceId).toHaveLength(128);
    expect(h.llmCalls[0]!.sessionId).toHaveLength(128);
    expect(h.llmCalls[0]!.workspaceId).toBe(long.slice(0, 128));
  });

  it("没令牌 401 no_token；坏令牌 401 bad_token", async () => {
    const h = harness();
    expect((await h.handle(post("/llm/v1/chat/completions", {}))).status).toBe(401);
    const bad = await h.handle(post("/llm/v1/chat/completions", { authorization: "Bearer nope" }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("bad_token");
  });

  it("平台身份 + on-behalf-of → caller.source=runtime，uid 是被代表的人", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: U7 }));
    expect(res.status).toBe(200);
    expect(h.llmCalls[0]).toMatchObject({ uid: U7, source: "runtime" });
  });

  it("平台身份没带 on-behalf-of → 400；桌面 JWT 带了 on-behalf-of → 400（只有平台能代表别人）", async () => {
    const h = harness();
    expect((await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": RUNTIME }))).status).toBe(400);
    expect((await h.handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token()}`, [ON_BEHALF_HEADER]: U2 }))).status).toBe(400);
    expect(h.llmCalls).toEqual([]);
  });

  it("on-behalf-of 不是 uuid → 400 bad_request（它的值就是被扣钱的 uid，不校验等于凭空开户，I4）", async () => {
    const h = harness();
    // 注意不放「uuid 后面跟个空格」：Request 建头时会把头值 trim 掉，那个值到不了这里
    for (const bad of ["u7", "", "77777777-7777-4777-8777-77777777777", `${U7}x`, "'; drop--"]) {
      const res = await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    expect(h.llmCalls).toEqual([]);
  });

  it("错的 runtime secret 落进普通 JWT 校验：401 bad_token，形状和烂 token 一样（不泄露 secret 存在）", async () => {
    const h = harness();
    // on-behalf 故意写成不合法的形状：身份没验过就该 401，不该先漏出「你这个头形状不对」
    const res = await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": "wrong", [ON_BEHALF_HEADER]: "u7" }));
    expect(res.status).toBe(401);
  });

  it("没注入 llm → 404 llm_disabled", async () => {
    const handle = createEdge({ config, now: () => NOW_MS });
    expect((await handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token()}` }))).status).toBe(404);
  });
});

describe("/billing/v1/*", () => {
  it("BillingPort.me 抛（Quota DO / Supabase 挂）→ 502 otto_edge 信封，不是裸 500（C1）", async () => {
    const handle = createEdge({
      config, now: () => NOW_MS,
      billing: {
        me: async () => { throw new Error("quota view 503"); },
        checkout: async () => ({ url: "x" }), portal: async () => ({ url: "x" }),
        webhook: async () => ({ status: 200, body: {} }),
      },
    });
    const res = await handle(new Request("https://edge/billing/v1/me", { headers: { authorization: `Bearer ${token("u1")}` } }));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { type: string; code: string; message: string } };
    expect(body.error).toMatchObject({ type: "otto_edge", code: "upstream" });
    // 原因带出去：客户端不用猜，wrangler tail 里也认得出是哪一段
    expect(body.error.message).toContain("quota view 503");
  });

  it("GET /me 回 BillingPort.me 的结果；平台身份也能代表人查", async () => {
    const h = harness();
    const res = await h.handle(new Request("https://edge/billing/v1/me", { headers: { authorization: `Bearer ${token("u1")}` } }));
    expect(await res.json()).toEqual(me);
    await h.handle(new Request("https://edge/billing/v1/me", { headers: { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: U3 } }));
    expect(h.billingCalls).toEqual(["me:u1", `me:${U3}`]);
  });

  it("POST /checkout {planId} 与 {addon,quantity} 都回 url；planId 不合法 400；平台身份不许买（402 那条路是人的事）", async () => {
    const h = harness();
    const r1 = await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}`, "content-type": "application/json" }, JSON.stringify({ planId: "pro" })));
    expect(await r1.json()).toEqual({ url: "https://stripe/x" });
    const r2 = await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ addon: true, quantity: 2 })));
    expect(r2.status).toBe(200);
    expect(h.billingCalls).toEqual(['checkout:u1:{"planId":"pro"}', 'checkout:u1:{"addon":true,"quantity":2}']);
    expect((await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ planId: "gold" })))).status).toBe(400);
    expect((await h.handle(post("/billing/v1/checkout", { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: U7 }, JSON.stringify({ planId: "pro" })))).status).toBe(403);
  });

  it("quantity 超过 MAX_GRANT_QUANTITY → 400", async () => {
    const h = harness();
    const res = await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ addon: true, quantity: 101 })));
    expect(res.status).toBe(400);
  });

  it("{addon:true} 不带 quantity → 400；quantity:0 → 400（不悄悄夹回 1，见 commit 说明）", async () => {
    const h = harness();
    expect((await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ addon: true })))).status).toBe(400);
    expect((await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ addon: true, quantity: 0 })))).status).toBe(400);
    expect(h.billingCalls).toEqual([]);
  });

  it("BillingPort.checkout 回 already_subscribed → 409，不是 502（C2：502 会被客户端当「稍后再试」而重试）", async () => {
    const handle = createEdge({
      config, now: () => NOW_MS,
      billing: {
        me: async () => me,
        checkout: async () => ({ error: "已有订阅，换档请走「管理」", code: "already_subscribed" as const }),
        portal: async () => ({ url: "x" }),
        webhook: async () => ({ status: 200, body: {} }),
      },
    });
    const res = await handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ planId: "pro" })));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { type: string; code: string; message: string } };
    expect(body.error).toMatchObject({ type: "otto_edge", code: "already_subscribed" });
    expect(body.error.message).toContain("管理");
  });

  it("checkout 的其它失败照旧 502 upstream（只有 already_subscribed 这一类走 409）", async () => {
    const handle = createEdge({
      config, now: () => NOW_MS,
      billing: {
        me: async () => me,
        checkout: async () => ({ error: "stripe checkout/sessions 500: ?" }),
        portal: async () => ({ url: "x" }),
        webhook: async () => ({ status: 200, body: {} }),
      },
    });
    const res = await handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ planId: "pro" })));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream");
  });

  it("POST /portal 回 url", async () => {
    const h = harness();
    expect(await (await h.handle(post("/billing/v1/portal", { authorization: `Bearer ${token()}` }))).json()).toEqual({ url: "https://stripe/p" });
  });

  it("POST /webhook 不验 JWT：原文 + Stripe-Signature 头原样交给 BillingPort", async () => {
    const h = harness();
    const res = await h.handle(post("/billing/v1/webhook", { "stripe-signature": "t=1,v1=abc" }, '{"type":"x"}'));
    expect(res.status).toBe(200);
    expect(h.billingCalls).toEqual(['webhook:{"type":"x"}:t=1,v1=abc']);
  });

  it("webhook 正文超过 1 MB（按 content-length）→ 413，不读 body 也不进 BillingPort", async () => {
    const h = harness();
    const res = await h.handle(post("/billing/v1/webhook", { "stripe-signature": "t=1,v1=abc", "content-length": String(1_000_001) }, "x"));
    expect(res.status).toBe(413);
    expect(h.billingCalls).toEqual([]);
  });

  it("GET /billing/v1/done 是给浏览器看的 HTML，不要令牌", async () => {
    const res = await harness().handle(new Request("https://edge/billing/v1/done"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("没注入 billing → 404 billing_disabled", async () => {
    const handle = createEdge({ config, now: () => NOW_MS });
    expect((await handle(new Request("https://edge/billing/v1/me", { headers: { authorization: `Bearer ${token()}` } }))).status).toBe(404);
  });
});
