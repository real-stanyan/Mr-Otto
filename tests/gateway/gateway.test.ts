import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGateway, type GatewayConfig } from "../../services/gateway/src/gateway.js";
import type { Tier } from "../../services/gateway/src/buckets.js";
import type { SpendEntry, Wallet } from "../../services/gateway/src/wallet.js";

const SECRET = "jwt-secret";
const NOW_MS = 1_800_000_000_000;
const GRANTS: Record<Tier, number> = { flash: 20_000_000, pro: 5_000_000 };

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub = "u1", expOffset = 3600): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email: "a@b.c", exp: Math.floor(NOW_MS / 1000) + expOffset });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const config: GatewayConfig = {
  jwtSecret: SECRET,
  upstreamBaseUrl: "https://upstream.example/v1",
  upstreamApiKey: "官方-deepseek-key",
};

/** 每个桶各自的余额；grant 只在第一次把余额补到赠额（和真函数一样幂等） */
function fakeWallet(balances: Partial<Record<Tier, number>> = {}): Wallet & {
  spends: SpendEntry[];
  balances: Record<Tier, number>;
} {
  const state: Record<Tier, number> = {
    flash: balances.flash ?? GRANTS.flash,
    pro: balances.pro ?? GRANTS.pro,
  };
  const spends: SpendEntry[] = [];
  return {
    spends,
    balances: state,
    grant: vi.fn(async (_u: string, tier: Tier) => state[tier]),
    spend: vi.fn(async (e: SpendEntry) => {
      spends.push(e);
      state[e.tier] += e.deltaTokens;
      return state[e.tier];
    }),
    rebuild: vi.fn(async (_u: string, tier: Tier) => state[tier]),
  };
}

const jsonBody = (usage?: { prompt_tokens: number; completion_tokens: number }, model = "deepseek-v4-flash"): string =>
  JSON.stringify({ model, choices: [], ...(usage ? { usage } : {}) });

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

interface Harness {
  handle: (req: Request) => Promise<Response>;
  wallet: ReturnType<typeof fakeWallet>;
  upstreamCalls: Array<[string, RequestInit]>;
  errors: Array<[string, unknown]>;
}

function harness(
  opts: {
    wallet?: ReturnType<typeof fakeWallet>;
    respond?: () => Response;
    upstreamThrows?: boolean;
  } = {}
): Harness {
  const wallet = opts.wallet ?? fakeWallet();
  const upstreamCalls: Array<[string, RequestInit]> = [];
  const errors: Array<[string, unknown]> = [];
  const handle = createGateway({
    config,
    wallet,
    now: () => NOW_MS,
    grants: (tier) => GRANTS[tier],
    onError: (w, e) => errors.push([w, e]),
    fetchImpl: async (url, init) => {
      upstreamCalls.push([url, init]);
      if (opts.upstreamThrows) throw new Error("ECONNREFUSED");
      return opts.respond
        ? opts.respond()
        : new Response(jsonBody({ prompt_tokens: 1000, completion_tokens: 25 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
  });
  return { handle, wallet, upstreamCalls, errors };
}

const chat = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, ...headers },
    body: JSON.stringify(body),
  });

async function drain(res: Response): Promise<string> {
  return res.body ? await new Response(res.body).text() : "";
}

describe("路由", () => {
  it("/healthz 不要令牌", async () => {
    expect((await harness().handle(new Request("http://gw/healthz"))).status).toBe(200);
  });

  it("未知路径 404，方法不对 405", async () => {
    const h = harness();
    expect((await h.handle(new Request("http://gw/nope"))).status).toBe(404);
    expect((await h.handle(new Request("http://gw/v1/chat/completions"))).status).toBe(405);
    expect((await h.handle(new Request("http://gw/v1/wallet", { method: "POST" }))).status).toBe(405);
  });
});

describe("认证与额度门槛", () => {
  it("没有 Authorization → 401，且不惊动上游", async () => {
    const h = harness();
    const res = await h.handle(
      new Request("http://gw/v1/chat/completions", { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(401);
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("令牌过期 → 401", async () => {
    const h = harness();
    const res = await h.handle(chat({ model: "deepseek-v4-flash" }, { authorization: `Bearer ${token("u1", -1)}` }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_token");
  });

  it("型号不在桶里 → 400 拒收，不惊动上游（顺带堵住拿官方 key 代理任意模型）", async () => {
    const h = harness();
    const res = await h.handle(chat({ model: "gpt-5" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_covered");
    expect(body.error.message).toContain("gpt-5");
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("该桶余额 <= 0 → 402，且错误里点名是哪个桶", async () => {
    const h = harness({ wallet: fakeWallet({ pro: 0 }) });
    const res = await h.handle(chat({ model: "deepseek-v4-pro" }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("quota_exhausted");
    expect(body.error.message).toContain("pro");
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("一个桶空了，另一个桶照常用——分桶的意义就在这", async () => {
    const h = harness({ wallet: fakeWallet({ pro: 0 }) });
    expect((await h.handle(chat({ model: "deepseek-v4-pro" }))).status).toBe(402);
    expect((await h.handle(chat({ model: "deepseek-v4-flash" }))).status).toBe(200);
  });

  it("钱包服务挂了 → 503，绝不放行（宁可不服务，也不无账可查地烧 key）", async () => {
    const wallet = fakeWallet();
    wallet.grant = vi.fn(async () => {
      throw new Error("db down");
    });
    const h = harness({ wallet });
    const res = await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(0);
    expect(h.errors[0]![0]).toBe("wallet.grant");
  });

  it("请求体不是 JSON → 400", async () => {
    const h = harness();
    const res = await h.handle(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token()}` },
        body: "不是 json",
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("转发", () => {
  it("客户端的 JWT 到此为止，上游只见官方 key", async () => {
    const h = harness();
    await h.handle(chat({ model: "deepseek-v4-flash" }));
    const [url, init] = h.upstreamCalls[0]!;
    expect(url).toBe("https://upstream.example/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer 官方-deepseek-key");
    expect(JSON.stringify(headers)).not.toContain(token());
  });

  it("上游不可达 → 502，不扣 token", async () => {
    const h = harness({ upstreamThrows: true });
    expect((await h.handle(chat({ model: "deepseek-v4-flash" }))).status).toBe(502);
    expect(h.wallet.spends).toHaveLength(0);
  });

  it("上游报错 → 原样透传状态码，一个 token 不扣（没产生用量）", async () => {
    const h = harness({
      respond: () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    });
    const res = await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("rate limited");
    expect(h.wallet.spends).toHaveLength(0);
  });
});

describe("记账（非流式）", () => {
  it("按 进+出 扣该桶的 token", async () => {
    const h = harness();
    const res = await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(res.status).toBe(200);
    expect(h.wallet.spends).toEqual([
      expect.objectContaining({
        userId: "u1",
        tier: "flash",
        deltaTokens: -1025,
        reason: "api_usage",
        model: "deepseek-v4-flash",
        promptTokens: 1000,
        completionTokens: 25,
      }),
    ]);
  });

  it("桶按请求的型号定，不按上游回报的（别名解析在上游那边）", async () => {
    const h = harness({
      respond: () =>
        new Response(jsonBody({ prompt_tokens: 10, completion_tokens: 1 }, "deepseek-v4-flash"), {
          status: 200,
        }),
    });
    // 请求 pro，上游回报 flash：仍然扣 pro 桶
    await h.handle(chat({ model: "deepseek-v4-pro" }));
    expect(h.wallet.spends[0]!.tier).toBe("pro");
  });

  it("上游没给 usage → 不扣（宁可漏一笔，也不按猜的数扣）", async () => {
    const h = harness({ respond: () => new Response(jsonBody(), { status: 200 }) });
    await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(h.wallet.spends).toHaveLength(0);
  });

  it("客户端给了 x-otto-request-id → 当幂等键（重试不扣两遍）", async () => {
    const h = harness();
    await h.handle(chat({ model: "deepseek-v4-flash" }, { "x-otto-request-id": "req-42" }));
    expect(h.wallet.spends[0]!.requestId).toBe("req-42");
  });

  it("没给就自己生成一个，不留空", async () => {
    const h = harness();
    await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(h.wallet.spends[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("记账失败不影响已经答完的响应，只记日志", async () => {
    const wallet = fakeWallet();
    wallet.spend = vi.fn(async () => {
      throw new Error("db down");
    });
    const h = harness({ wallet });
    expect((await h.handle(chat({ model: "deepseek-v4-flash" }))).status).toBe(200);
    expect(h.errors.map(([w]) => w)).toContain("wallet.spend");
  });
});

describe("记账（流式）", () => {
  const stream = (): Response =>
    new Response(
      sseStream([
        `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "嗨" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 500 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  it("客户端没要 usage 也强制加上——不要 = 记不了账 = 白送", async () => {
    const h = harness({ respond: stream });
    await h.handle(chat({ model: "deepseek-v4-flash", stream: true }));
    expect(JSON.parse(h.upstreamCalls[0]![1].body as string).stream_options).toEqual({
      include_usage: true,
    });
  });

  it("客户端自带的 stream_options 保留，只补 include_usage", async () => {
    const h = harness({ respond: stream });
    await h.handle(chat({ model: "deepseek-v4-flash", stream: true, stream_options: { 别的: 1 } }));
    expect(JSON.parse(h.upstreamCalls[0]![1].body as string).stream_options).toEqual({
      别的: 1,
      include_usage: true,
    });
  });

  it("字节原样透传，收尾后按终块 usage 扣 token", async () => {
    const h = harness({ respond: stream });
    const res = await h.handle(chat({ model: "deepseek-v4-flash", stream: true }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await drain(res);
    expect(text).toContain("嗨");
    expect(text).toContain("[DONE]");
    expect(h.wallet.spends).toEqual([
      expect.objectContaining({ tier: "flash", deltaTokens: -2500 }),
    ]);
  });

  it("客户端中途断开 → 已看到的用量照扣，且只扣一次", async () => {
    const h = harness({ respond: stream });
    const res = await h.handle(chat({ model: "deepseek-v4-flash", stream: true }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("用户按了停止");
    expect(h.wallet.spends.length).toBeLessThanOrEqual(1);
  });

  it("非流式请求不带 stream_options（别给上游塞它没要的字段）", async () => {
    const h = harness();
    await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(JSON.parse(h.upstreamCalls[0]![1].body as string).stream_options).toBeUndefined();
  });
});

describe("GET /v1/wallet", () => {
  it("逐桶回余额和赠额", async () => {
    const h = harness({ wallet: fakeWallet({ flash: 19_997_500, pro: 4_000_000 }) });
    const res = await h.handle(
      new Request("http://gw/v1/wallet", { headers: { authorization: `Bearer ${token()}` } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      buckets: {
        flash: { balanceTokens: 19_997_500, grantTokens: GRANTS.flash },
        pro: { balanceTokens: 4_000_000, grantTokens: GRANTS.pro },
      },
    });
  });

  it("余额为 0 也照查——那正是用户最需要看到数字的时候", async () => {
    const h = harness({ wallet: fakeWallet({ flash: 0, pro: 0 }) });
    const res = await h.handle(
      new Request("http://gw/v1/wallet", { headers: { authorization: `Bearer ${token()}` } })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).buckets.flash.balanceTokens).toBe(0);
  });

  it("没令牌 → 401", async () => {
    expect((await harness().handle(new Request("http://gw/v1/wallet"))).status).toBe(401);
  });

  it("钱包服务挂了 → 503（「查不到」不能显示成 0）", async () => {
    const wallet = fakeWallet();
    wallet.grant = vi.fn(async () => {
      throw new Error("db down");
    });
    const h = harness({ wallet });
    const res = await h.handle(
      new Request("http://gw/v1/wallet", { headers: { authorization: `Bearer ${token()}` } })
    );
    expect(res.status).toBe(503);
  });
});
