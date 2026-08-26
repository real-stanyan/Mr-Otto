import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEdge, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { SUBPROTOCOL } from "../../services/edge/src/relay.js";

const SECRET = "jwt-secret";
const NOW_MS = 1_800_000_000_000;

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub = "u1", expOffset = 3600): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email: "a@b.c", exp: Math.floor(NOW_MS / 1000) + expOffset });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const config: EdgeConfig = { jwtSecret: SECRET };

/** 记下被路由到哪个 userId、以及转下去的那个 Request 长什么样 */
function harness() {
  const routed: Array<{ userId: string; req: Request }> = [];
  const stub = (userId: string): RelayStub => ({
    fetch: async (req) => {
      routed.push({ userId, req });
      // 生产上 DO 回的是 101 + webSocket。这里回 200:**标准 Response 不收 101**
      // (Node/undici 限制 200-599),101 + webSocket 是 workerd 的扩展。
      // 这条差异正是 worker.ts 那一层不进这个文件的原因 —— 它握的是运行时的手
      return new Response(null, { status: 200 });
    },
  });
  return { routed, handle: createEdge({ config, now: () => NOW_MS, relay: stub }) };
}

const upgrade = (url: string, protos?: string): Request =>
  new Request(url, {
    headers: {
      upgrade: "websocket",
      ...(protos === undefined ? {} : { "sec-websocket-protocol": protos }),
    },
  });

const authed = (url: string, t = token()): Request => upgrade(url, `${SUBPROTOCOL}, ${t}`);

async function drain(res: Response): Promise<string> {
  return res.body ? await new Response(res.body).text() : "";
}

describe("路由", () => {
  it("/healthz 不要令牌", async () => {
    expect((await harness().handle(new Request("http://edge/healthz"))).status).toBe(200);
  });

  it("未知路径 404", async () => {
    expect((await harness().handle(new Request("http://edge/nope"))).status).toBe(404);
  });

  it("/auth/landing 不要令牌:回 HTML,内含 mrotto 深链转发(OAuth 落地页)", async () => {
    const res = await harness().handle(new Request("http://edge/auth/landing?code=abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await drain(res)).toContain("mrotto://auth-callback");
  });

  it("/auth/landing 只收 GET", async () => {
    const res = await harness().handle(new Request("http://edge/auth/landing", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  // 这条钉的是**删除本身**(ADR-0129):官方额度那两个端点不是"关着",是不存在了。
  // 哪天有人把 buckets/wallet 那一串又接回来,这条会红
  it("官方额度的两个端点已经不存在", async () => {
    const h = harness();
    for (const path of ["/v1/chat/completions", "/v1/wallet"]) {
      const res = await h.handle(new Request(`http://edge${path}`, { method: "POST", body: "{}" }));
      expect(res.status, path).toBe(404);
      expect((await res.json()).error.code, path).toBe("not_found");
    }
  });

  // SSE 时代的两个端点也没了 —— 它们换成了一个 upgrade
  it("旧的 /rl/v1/stream 与 /rl/v1/send 已经不存在", async () => {
    const h = harness();
    for (const path of ["/rl/v1/stream", "/rl/v1/send"]) {
      expect((await h.handle(new Request(`http://edge${path}?role=desktop`))).status, path).toBe(404);
    }
  });
});

describe("/rl/v1/connect", () => {
  it("不是 upgrade 请求 → 426", async () => {
    const res = await harness().handle(new Request("http://edge/rl/v1/connect?role=desktop"));
    expect(res.status).toBe(426);
    expect((await res.json()).error.code).toBe("upgrade_required");
  });

  it("没带子协议 → 401", async () => {
    const res = await harness().handle(upgrade("http://edge/rl/v1/connect?role=desktop"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("no_token");
  });

  it("子协议第一个值不是约定的那个 → 401（不猜，不容错）", async () => {
    const res = await harness().handle(
      upgrade("http://edge/rl/v1/connect?role=desktop", `chat, ${token()}`)
    );
    expect(res.status).toBe(401);
  });

  it("令牌过期 → 401", async () => {
    const res = await harness().handle(
      authed("http://edge/rl/v1/connect?role=desktop", token("u1", -1))
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_token");
  });

  it("role 非法 → 400，且**验完身份才判**（认不出的人不该知道 role 长什么样）", async () => {
    const res = await harness().handle(authed("http://edge/rl/v1/connect?role=both"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_role");
  });

  it("没接中继 → 404", async () => {
    const handle = createEdge({ config, now: () => NOW_MS });
    const res = await handle(authed("http://edge/rl/v1/connect?role=desktop"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("relay_disabled");
  });

  it("验完签按 sub 路由到那个人的中继实例", async () => {
    const h = harness();
    await h.handle(authed("http://edge/rl/v1/connect?role=mobile", token("user-42")));
    expect(h.routed).toHaveLength(1);
    expect(h.routed[0]!.userId).toBe("user-42");
    expect(new URL(h.routed[0]!.req.url).searchParams.get("role")).toBe("mobile");
  });

  // 验完就到此为止：DO 只需要知道 role。原样转发等于把凭据再往下游递一层
  it("转给中继的请求里没有 token", async () => {
    const h = harness();
    await h.handle(authed("http://edge/rl/v1/connect?role=desktop", token("u9")));
    const req = h.routed[0]!.req;
    expect(req.headers.get("sec-websocket-protocol")).toBeNull();
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.url).not.toContain("eyJ");
  });

  it("两个人各去各的实例，不串线", async () => {
    const h = harness();
    await h.handle(authed("http://edge/rl/v1/connect?role=desktop", token("a")));
    await h.handle(authed("http://edge/rl/v1/connect?role=desktop", token("b")));
    expect(h.routed.map((r) => r.userId)).toEqual(["a", "b"]);
  });
});
