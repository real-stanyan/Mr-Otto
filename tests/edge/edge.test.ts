import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEdge, type EdgeConfig } from "../../services/edge/src/edge.js";
import { createRelay } from "../../services/edge/src/relay.js";

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

const edge = (): ((req: Request) => Promise<Response>) =>
  createEdge({ config, now: () => NOW_MS, relay: createRelay() });

async function drain(res: Response): Promise<string> {
  return res.body ? await new Response(res.body).text() : "";
}

describe("路由", () => {
  it("/healthz 不要令牌", async () => {
    expect((await edge()(new Request("http://edge/healthz"))).status).toBe(200);
  });

  it("未知路径 404", async () => {
    expect((await edge()(new Request("http://edge/nope"))).status).toBe(404);
  });

  it("/auth/landing 不要令牌:回 HTML,内含 mrotto 深链转发(OAuth 落地页)", async () => {
    const res = await edge()(new Request("http://edge/auth/landing?code=abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await drain(res)).toContain("mrotto://auth-callback");
  });

  it("/auth/landing 只收 GET", async () => {
    const res = await edge()(new Request("http://edge/auth/landing", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  // 这条钉的是**删除本身**(ADR-0129):官方额度那两个端点不是"关着",是不存在了。
  // 405 和 404 的区别就是"这条路还在,只是你方法用错了" vs "这条路没了" ——
  // 哪天有人把 buckets/wallet 那一串又接回来,这条会红。
  it("官方额度的两个端点已经不存在:404,不是 405", async () => {
    const h = edge();
    for (const [path, method] of [
      ["/v1/chat/completions", "POST"],
      ["/v1/wallet", "GET"],
    ] as const) {
      const res = await h(new Request(`http://edge${path}`, {
        method,
        headers: { authorization: `Bearer ${token()}` },
        ...(method === "POST" ? { body: "{}" } : {}),
      }));
      expect(res.status, path).toBe(404);
      expect((await res.json()).error.code, path).toBe("not_found");
    }
  });
});

describe("认证", () => {
  it("没有 Authorization → 401", async () => {
    const res = await edge()(new Request("http://edge/rl/v1/stream?role=desktop"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("no_token");
  });

  it("令牌过期 → 401", async () => {
    const res = await edge()(
      new Request("http://edge/rl/v1/stream?role=desktop", {
        headers: { authorization: `Bearer ${token("u1", -1)}` },
      })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_token");
  });
});
