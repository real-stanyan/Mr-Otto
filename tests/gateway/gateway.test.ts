import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGateway, type GatewayConfig } from "../../services/gateway/src/gateway.js";
import type { ChargeEntry, Wallet } from "../../services/gateway/src/wallet.js";

const SECRET = "jwt-secret";
const NOW_MS = 1_800_000_000_000;

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
  signupGrantMicroUsd: 20_000_000,
};

function fakeWallet(balance = 20_000_000): Wallet & { charges: ChargeEntry[] } {
  const charges: ChargeEntry[] = [];
  return {
    charges,
    ensure: vi.fn(async () => balance),
    charge: vi.fn(async (e: ChargeEntry) => {
      charges.push(e);
      return balance + e.deltaMicroUsd;
    }),
    rebuild: vi.fn(async () => balance),
  };
}

const jsonBody = (usage?: { prompt_tokens: number; completion_tokens: number }): string =>
  JSON.stringify({ model: "deepseek-v4-flash", choices: [], ...(usage ? { usage } : {}) });

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
  wallet: Wallet & { charges: ChargeEntry[] };
  upstreamCalls: Array<[string, RequestInit]>;
  errors: Array<[string, unknown]>;
}

function harness(opts: {
  wallet?: Wallet & { charges: ChargeEntry[] };
  respond?: () => Response;
  upstreamThrows?: boolean;
} = {}): Harness {
  const wallet = opts.wallet ?? fakeWallet();
  const upstreamCalls: Array<[string, RequestInit]> = [];
  const errors: Array<[string, unknown]> = [];
  const handle = createGateway({
    config,
    wallet,
    now: () => NOW_MS,
    onError: (w, e) => errors.push([w, e]),
    fetchImpl: async (url, init) => {
      upstreamCalls.push([url, init]);
      if (opts.upstreamThrows) throw new Error("ECONNREFUSED");
      return opts.respond
        ? opts.respond()
        : new Response(jsonBody({ prompt_tokens: 1_000_000, completion_tokens: 0 }), {
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
    const res = await harness().handle(new Request("http://gw/healthz"));
    expect(res.status).toBe(200);
  });

  it("未知路径 404，方法不对 405", async () => {
    const h = harness();
    expect((await h.handle(new Request("http://gw/nope"))).status).toBe(404);
    expect((await h.handle(new Request("http://gw/v1/chat/completions"))).status).toBe(405);
    expect(
      (await h.handle(new Request("http://gw/v1/wallet", { method: "POST" }))).status
    ).toBe(405);
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
    const res = await h.handle(chat({ model: "m" }, { authorization: `Bearer ${token("u1", -1)}` }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_token");
  });

  it("余额 <= 0 → 402，不转发（欠着的人不该继续花官方的钱）", async () => {
    const h = harness({ wallet: fakeWallet(0) });
    const res = await h.handle(chat({ model: "deepseek-v4-flash" }));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("quota_exhausted");
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("钱包服务挂了 → 503，绝不放行（宁可不服务，也不无账可查地烧 key）", async () => {
    const wallet = fakeWallet();
    wallet.ensure = vi.fn(async () => {
      throw new Error("db down");
    });
    const h = harness({ wallet });
    const res = await h.handle(chat({ model: "m" }));
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(0);
    expect(h.errors[0]![0]).toBe("wallet.ensure");
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

  it("上游不可达 → 502，不扣钱", async () => {
    const h = harness({ upstreamThrows: true });
    const res = await h.handle(chat({ model: "m" }));
    expect(res.status).toBe(502);
    expect(h.wallet.charges).toHaveLength(0);
  });

  it("上游报错 → 原样透传状态码，一分不扣（没产生用量）", async () => {
    const h = harness({
      respond: () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    });
    const res = await h.handle(chat({ model: "m" }));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("rate limited");
    expect(h.wallet.charges).toHaveLength(0);
  });
});

describe("记账（非流式）", () => {
  it("按上游给的 usage 扣钱，型号以上游自报的为准", async () => {
    const h = harness();
    const res = await h.handle(chat({ model: "随便写的" }));
    expect(res.status).toBe(200);
    // 1M 入 × 0.28 USD = 280_000 micro
    expect(h.wallet.charges).toEqual([
      expect.objectContaining({
        userId: "u1",
        deltaMicroUsd: -280_000,
        reason: "api_usage",
        model: "deepseek-v4-flash",
        promptTokens: 1_000_000,
        completionTokens: 0,
      }),
    ]);
  });

  it("上游没给 usage → 不扣（宁可漏一笔，也不按猜的数扣钱）", async () => {
    const h = harness({ respond: () => new Response(jsonBody(), { status: 200 }) });
    await h.handle(chat({ model: "m" }));
    expect(h.wallet.charges).toHaveLength(0);
  });

  it("客户端给了 x-otto-request-id → 当幂等键（重试不扣两遍）", async () => {
    const h = harness();
    await h.handle(chat({ model: "m" }, { "x-otto-request-id": "req-42" }));
    expect(h.wallet.charges[0]!.requestId).toBe("req-42");
  });

  it("没给就自己生成一个，不留空", async () => {
    const h = harness();
    await h.handle(chat({ model: "m" }));
    expect(h.wallet.charges[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("记账失败不影响已经答完的响应，只记日志", async () => {
    const wallet = fakeWallet();
    wallet.charge = vi.fn(async () => {
      throw new Error("db down");
    });
    const h = harness({ wallet });
    const res = await h.handle(chat({ model: "m" }));
    expect(res.status).toBe(200);
    expect(h.errors.map(([w]) => w)).toContain("wallet.charge");
  });
});

describe("记账（流式）", () => {
  const stream = (): Response =>
    new Response(
      sseStream([
        `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "嗨" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  it("客户端没要 usage 也强制加上——不要 = 记不了账 = 白送", async () => {
    const h = harness({ respond: stream });
    await h.handle(chat({ model: "m", stream: true }));
    const sent = JSON.parse(h.upstreamCalls[0]![1].body as string);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it("客户端自带的 stream_options 保留，只补 include_usage", async () => {
    const h = harness({ respond: stream });
    await h.handle(chat({ model: "m", stream: true, stream_options: { 别的: 1 } }));
    expect(JSON.parse(h.upstreamCalls[0]![1].body as string).stream_options).toEqual({
      别的: 1,
      include_usage: true,
    });
  });

  it("字节原样透传，收尾后按终块 usage 扣钱", async () => {
    const h = harness({ respond: stream });
    const res = await h.handle(chat({ model: "m", stream: true }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await drain(res);
    expect(text).toContain("嗨");
    expect(text).toContain("[DONE]");
    // 1M 入 × 0.28 + 1M 出 × 0.42 = 700_000 micro
    expect(h.wallet.charges).toEqual([
      expect.objectContaining({ deltaMicroUsd: -700_000, model: "deepseek-v4-flash" }),
    ]);
  });

  it("客户端中途断开 → 已看到的用量照扣，且只扣一次", async () => {
    const h = harness({ respond: stream });
    const res = await h.handle(chat({ model: "m", stream: true }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("用户按了停止");
    expect(h.wallet.charges.length).toBeLessThanOrEqual(1);
  });

  it("非流式请求不带 stream_options（别给上游塞它没要的字段）", async () => {
    const h = harness();
    await h.handle(chat({ model: "m" }));
    expect(JSON.parse(h.upstreamCalls[0]![1].body as string).stream_options).toBeUndefined();
  });
});

describe("GET /v1/wallet", () => {
  it("返回余额的 micro 和 USD 两种表示", async () => {
    const h = harness({ wallet: fakeWallet(19_300_000) });
    const res = await h.handle(
      new Request("http://gw/v1/wallet", { headers: { authorization: `Bearer ${token()}` } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      balanceMicroUsd: 19_300_000,
      balanceUsd: 19.3,
      grantMicroUsd: 20_000_000,
    });
  });

  it("余额为 0 也照查——那正是用户最需要看到数字的时候", async () => {
    const h = harness({ wallet: fakeWallet(0) });
    const res = await h.handle(
      new Request("http://gw/v1/wallet", { headers: { authorization: `Bearer ${token()}` } })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).balanceUsd).toBe(0);
  });

  it("没令牌 → 401", async () => {
    const res = await harness().handle(new Request("http://gw/v1/wallet"));
    expect(res.status).toBe(401);
  });
});
