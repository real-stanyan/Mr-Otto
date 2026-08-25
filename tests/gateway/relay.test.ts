import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRelay } from "../../services/gateway/src/relay.js";
import { createGateway, type GatewayConfig } from "../../services/gateway/src/gateway.js";
import type { Tier } from "../../services/gateway/src/buckets.js";
import type { Wallet } from "../../services/gateway/src/wallet.js";

function sink() {
  const chunks: string[] = [];
  return { chunks, write(c: string) { chunks.push(c); } };
}

describe("createRelay", () => {
  it("同一 user 的两端互转字节", () => {
    const r = createRelay();
    const desktop = sink();
    const mobile = sink();
    r.attach("u1", "desktop", desktop);
    r.attach("u1", "mobile", mobile);

    expect(r.deliver("u1", "desktop", "AAAA")).toBe(true);
    expect(mobile.chunks.join("")).toContain("AAAA");
    expect(desktop.chunks.join("")).toBe(""); // 不回声给发送方

    expect(r.deliver("u1", "mobile", "BBBB")).toBe(true);
    expect(desktop.chunks.join("")).toContain("BBBB");
  });

  it("不同 user 之间绝不串线", () => {
    const r = createRelay();
    const a = sink();
    const b = sink();
    r.attach("u1", "mobile", a);
    r.attach("u2", "mobile", b);
    r.deliver("u1", "desktop", "SECRET");
    expect(b.chunks.join("")).toBe("");
  });

  it("对端不在线 → deliver 回 false，字节丢弃", () => {
    const r = createRelay();
    r.attach("u1", "desktop", sink());
    expect(r.deliver("u1", "desktop", "X")).toBe(false);
    expect(r.peerOnline("u1", "desktop")).toBe(false);
  });

  it("detach 之后不再收", () => {
    const r = createRelay();
    const m = sink();
    const off = r.attach("u1", "mobile", m);
    off();
    expect(r.deliver("u1", "desktop", "X")).toBe(false);
    expect(m.chunks.join("")).toBe("");
  });

  it("同角色重连顶掉旧连接（一户一桌面一手机）", () => {
    const r = createRelay();
    const old = sink();
    const fresh = sink();
    r.attach("u1", "mobile", old);
    r.attach("u1", "mobile", fresh);
    r.deliver("u1", "desktop", "X");
    expect(old.chunks.join("")).toBe("");
    expect(fresh.chunks.join("")).toContain("X");
  });

  // ↓ 盲管道这个性质要有测试守着，否则三个月后有人为调试加一行 console.log
  it("负载从不被解析：deliver 收到坏 JSON 也照转不误", () => {
    const r = createRelay();
    const m = sink();
    r.attach("u1", "mobile", m);
    expect(r.deliver("u1", "desktop", "{{{ not json at all")).toBe(true);
    expect(m.chunks.join("")).toContain("{{{ not json at all");
  });

  it("负载从不进日志", () => {
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createRelay();
    r.attach("u1", "mobile", sink());
    r.deliver("u1", "desktop", "TOP-SECRET-PAYLOAD");
    const all = [...spyLog.mock.calls, ...spyErr.mock.calls].flat().join(" ");
    expect(all).not.toContain("TOP-SECRET-PAYLOAD");
    spyLog.mockRestore();
    spyErr.mockRestore();
  });

  it("SSE 线格式：data: 一行 + 空行收尾", () => {
    const r = createRelay();
    const m = sink();
    r.attach("u1", "mobile", m);
    r.deliver("u1", "desktop", "PAYLOAD");
    expect(m.chunks.join("")).toBe("data: PAYLOAD\n\n");
  });
});

// ---- 路由层：本文件独有的小型 harness ----
//
// 与 tests/gateway/gateway.test.ts 的模式一致（token()/config/fakeWallet()），
// 但那些 helper 没有导出，这里是特意保留的重复：本任务不改那个文件
// （见 task-6-brief 的“resolved ambiguity”）。

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

/** relay 端点不碰钱包，随便一个不抛的假实现就够 */
function fakeWallet(): Wallet {
  return {
    grant: vi.fn(async () => 0),
    spend: vi.fn(async () => 0),
    rebuild: vi.fn(async () => 0),
  };
}

function makeGateway(): (req: Request) => Promise<Response> {
  return createGateway({
    config,
    wallet: fakeWallet(),
    now: () => NOW_MS,
    grants: (tier) => GRANTS[tier],
    relay: createRelay(),
  });
}

function authed(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  });
}

describe("/rl/v1 路由", () => {
  it("没 token → 401；role 非法 → 400；方法不对 → 405", async () => {
    const g = makeGateway();
    expect((await g(new Request("http://x/rl/v1/stream?role=desktop"))).status).toBe(401);
    expect((await g(authed("http://x/rl/v1/stream?role=wat"))).status).toBe(400);
    expect((await g(authed("http://x/rl/v1/send?role=desktop", { method: "GET" }))).status).toBe(405);
  });

  it("对端不在线 → POST /send 回 409", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/send?role=desktop", { method: "POST", body: "AAAA" }));
    expect(r.status).toBe(409);
  });

  it("超过 256 KiB → 413，且不解析内容", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/send?role=desktop", {
      method: "POST",
      body: "A".repeat(256 * 1024 + 1),
    }));
    expect(r.status).toBe(413);
  });

  it("SSE 响应头带 text/event-stream 与 x-accel-buffering: no", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/stream?role=desktop"));
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
  });
});
