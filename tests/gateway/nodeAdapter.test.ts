import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway, type GatewayConfig } from "../../services/gateway/src/gateway.js";
import { createNodeHandler } from "../../services/gateway/src/nodeAdapter.js";
import { createRelay } from "../../services/gateway/src/relay.js";
import type { Wallet } from "../../services/gateway/src/wallet.js";

// 这个文件是**唯一**跑在真 node:http 上的一层。存在的理由很具体:
// gateway.ts 那侧只看得见 Request/Response,而计划 B 的集成探针在 node:http 这条
// 接缝上一口气撞出两条,都不可能在 Response 层面现形:
//   1. res.writeHead() 不冲刷响应头 → SSE 客户端要卡满一个心跳才拿到状态行
//   2. 客户端断开时没人取消读端 → 中继的槽位永远占着,心跳定时器永久泄漏
// 起一台真 server 的代价是几十毫秒,换的是这一整类"只在集成时现形"的失败有人守。

const SECRET = "jwt-secret";
const NOW_MS = 1_800_000_000_000;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(sub = "u1"): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email: "a@b.c", exp: Math.floor(NOW_MS / 1000) + 3600 });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

const config: GatewayConfig = {
  jwtSecret: SECRET,
  upstreamBaseUrl: "https://upstream.example/v1",
  upstreamApiKey: "官方-deepseek-key",
};

const fakeWallet = (): Wallet => ({
  grant: vi.fn(async () => 0),
  spend: vi.fn(async () => 0),
  rebuild: vi.fn(async () => 0),
});

let server: Server | null = null;

async function listen(): Promise<string> {
  const handle = createGateway({
    config, wallet: fakeWallet(), now: () => NOW_MS, relay: createRelay(),
  });
  const s = createServer(createNodeHandler(handle, { origin: "http://127.0.0.1" }));
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const auth = { authorization: `Bearer ${token()}` };
const post = (base: string, role: string, body: string) =>
  fetch(`${base}/rl/v1/send?role=${role}`, { method: "POST", headers: auth, body });

afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
});

describe("node:http 适配层", () => {
  it("SSE 的响应头立刻到达（不等第一次心跳）", async () => {
    const base = await listen();
    const res = await Promise.race([
      fetch(`${base}/rl/v1/stream?role=desktop`, { headers: auth }),
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 2000)),
    ]);
    expect(res).not.toBe("TIMEOUT");
    const stream = res as Response;
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body!.cancel();
  });

  it("客户端断开 → 中继的槽位要腾出来（否则对端永远拿到 204，字节进虚空）", async () => {
    const base = await listen();
    const ac = new AbortController();
    const res = await fetch(`${base}/rl/v1/stream?role=desktop`, { headers: auth, signal: ac.signal });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(":ok\n\n");

    // 桌面在线 → 手机上行送得出去
    expect((await post(base, "mobile", "X")).status).toBe(204);

    ac.abort(); // 客户端消失,不是优雅关闭

    // 服务端要能察觉。给它一小段时间,但**远短于** 25s 的心跳周期——
    // "靠下一次心跳写失败才发现"正是这条要挡的退化
    for (let i = 0; i < 40; i += 1) {
      if ((await post(base, "mobile", "X")).status === 409) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("断开一秒后中继仍认为桌面在线:槽位没腾出来");
  });
});
