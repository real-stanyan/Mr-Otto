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

    // 两端都在了 → 各自先收到一条在场信号,后面的断言只看载荷
    desktop.chunks.length = 0;
    mobile.chunks.length = 0;

    expect(r.deliver("u1", "desktop", "AAAA")).toBe(true);
    expect(mobile.chunks.join("")).toContain("AAAA");
    expect(desktop.chunks.join("")).toBe(""); // 不回声给发送方

    expect(r.deliver("u1", "mobile", "BBBB")).toBe(true);
    expect(desktop.chunks.join("")).toContain("BBBB");
  });

  // ── 在场信号 ──
  //
  // 握手是双向的:两端都要拿到对方的 hello 才能派生密钥。而中继按设计不排队,
  // 桌面又是长命的那一端 —— 它开机时若盲发 hello,必然掉进虚空。
  // 于是"对端到场"这件事必须由中继说出来:它是唯一同时看得见两个槽的人。
  //
  // 用 SSE 注释行(':' 开头)而不是 data 帧:控制信道与端到端载荷彻底分开,
  // 中继依旧只知道"谁在线",一个字节的内容都不碰。
  it("对端到场时,两侧各收到一条 :peer", () => {
    const r = createRelay();
    const desktop = sink();
    const mobile = sink();
    r.attach("u1", "desktop", desktop);
    expect(desktop.chunks.join("")).toBe(""); // 独自在线:没有对端,不发信号

    r.attach("u1", "mobile", mobile);
    expect(desktop.chunks.join("")).toBe(":peer\n\n"); // 在位的那端被叫醒
    expect(mobile.chunks.join("")).toBe(":peer\n\n");  // 新来的那端也要知道对端已在
  });

  it("同角色重连也重发 :peer（手机切后台再回来,整轮握手要重开）", () => {
    const r = createRelay();
    const desktop = sink();
    r.attach("u1", "desktop", desktop);
    r.attach("u1", "mobile", sink());
    r.attach("u1", "mobile", sink()); // 重连顶掉旧的
    expect(desktop.chunks.join("")).toBe(":peer\n\n:peer\n\n");
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
    // 必须 cancel:ReadableStream 的 start() 在构造时就跑了,25s 心跳的
    // setInterval 已经挂上。不取消,这个定时器会一直活到 worker 结束
    await r.body?.cancel();
  });

  // ── 路由 ↔ 中继的接缝 ──
  //
  // createRelay 单独测过,路由的 401/400/405/409/413/响应头也单独测过,
  // 但**没有一条**把两者接起来:把 relayStream 里的 relay.attach(...) 整行删掉,
  // 上面那些用例全绿。而"管子端到端通"恰恰是这个分支的全部交付物。
  // 这条同时是 write 闭包、detach 赋值、cancel 拆装的唯一覆盖。

  it("stream 挂上去之后，peer POST 的字节原样出现在流上（route ↔ relay 接通）", async () => {
    const g = makeGateway();
    const res = await g(authed("http://x/rl/v1/stream?role=mobile"));
    expect(res.status).toBe(200);
    // 增量读:这条流永远不结束,await 整个 body 会挂死
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(":ok\n\n"); // 开场白

    const sent = await g(
      authed("http://x/rl/v1/send?role=desktop", { method: "POST", body: "PAYLOAD" })
    );
    expect(sent.status).toBe(204); // 对端在线 → 不是 409

    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("data: PAYLOAD\n\n");

    // cancel 走 ReadableStream 的 cancel 回调:detach + clearInterval。
    // 一并断言 detach 真的接上了——之后对端就该是离线的
    await reader.cancel();
    const after = await g(
      authed("http://x/rl/v1/send?role=desktop", { method: "POST", body: "PAYLOAD" })
    );
    expect(after.status).toBe(409);
  });

  // 这条钉的是一条**只在 node:http 那一侧才现形**的失败:
  // res.writeHead() 不会把响应头推到 socket 上,node 要等第一个 body 字节才一起冲刷。
  // 于是"开流时一个字节都不写"的 SSE 端点,客户端连响应状态行都收不到——
  // 实测桌面侧 fetch 与 curl 都卡满 25s(第一次心跳)才拿到头。
  // 上面那条接缝用例测不出来:它总是先让对端 POST 一帧,自带了第一个字节。
  it("开流即刻有字节可读（否则 node:http 不冲刷响应头，客户端要卡到第一次心跳）", async () => {
    const g = makeGateway();
    const res = await g(authed("http://x/rl/v1/stream?role=desktop"));
    const reader = res.body!.getReader();
    // 没有任何对端发送、没有推进任何定时器
    const first = await Promise.race([
      reader.read(),
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 200)),
    ]);
    expect(first).not.toBe("TIMEOUT");
    expect(new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value))
      .toBe(":ok\n\n");
    await reader.cancel();
  });

  it("心跳是注释行 :\\n\\n（不是 data 帧，客户端解析器会跳过）", async () => {
    vi.useFakeTimers();
    try {
      const g = makeGateway();
      const res = await g(authed("http://x/rl/v1/stream?role=mobile"));
      const reader = res.body!.getReader();
      await reader.read(); // 开场白 :ok，先读掉
      // nginx 的 proxy_read_timeout 是 600s,心跳必须远短于它
      await vi.advanceTimersByTimeAsync(25_000);
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(":\n\n");
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
