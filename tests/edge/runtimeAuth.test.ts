import { describe, expect, it } from "vitest";
import { createEdge, RUNTIME_SERVICE_UID, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { SUBPROTOCOL } from "../../services/edge/src/relay.js";

// runtime 服务身份（ADR-0199）：VPS 上的云 runtime 之后要以平台身份连 relay、
// 打 px 执行面，不必先替一个真用户签出 JWT。四条断言对应 task-3-brief 的四件事：
//   1. connect 子协议 token = RUNTIME_SECRET → 身份是 svc-runtime
//   2. connect 子协议 token = 错 secret → 401，且落进跟"普通烂 token"一模一样
//      的错误路径——错 secret 不该让人多看出"这个服务认识 runtime secret 这回事"
//   3. POST /px/v1/call 带 x-runtime-secret + body.fromUid → 转发给托管箱的
//      载荷里 fromUid = 声明值
//   4. POST /px/v1/call 带 x-runtime-secret 但缺 body.fromUid → 400
//
// 搭法照抄 tests/edge/edge.test.ts（relay 假货）与 tests/edge/pxRoutes.test.ts（escrow 假货）。

const JWT_SECRET = "jwt-secret";
const RUNTIME_SECRET = "runtime-secret-xyz-not-a-jwt";
const config: EdgeConfig = { jwtSecret: JWT_SECRET, runtimeSecret: RUNTIME_SECRET };

const upgrade = (url: string, protos?: string): Request =>
  new Request(url, {
    headers: {
      upgrade: "websocket",
      ...(protos === undefined ? {} : { "sec-websocket-protocol": protos }),
    },
  });

function relayHarness() {
  const routed: Array<{ userId: string; req: Request }> = [];
  const stub = (userId: string): RelayStub => ({
    fetch: async (req) => {
      routed.push({ userId, req });
      return new Response(null, { status: 200 });
    },
  });
  return { routed, handle: createEdge({ config, relay: stub }) };
}

function fakeEscrow() {
  const calls: { hostUid: string; op: string; body: unknown }[] = [];
  const stub = (hostUid: string): RelayStub => ({
    fetch: async (req: Request) => {
      calls.push({ hostUid, op: new URL(req.url).pathname.slice(1), body: await req.json() });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  return { calls, stub };
}

describe("runtime 服务身份（ADR-0199）", () => {
  it("connect：子协议 token = RUNTIME_SECRET → identify 通过，userId 是 svc-runtime", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(upgrade("http://edge/rl/v1/connect?role=host", `${SUBPROTOCOL}, ${RUNTIME_SECRET}`));
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.userId).toBe(RUNTIME_SERVICE_UID);
  });

  it("connect：子协议 token = 错 secret → 401，且和普通烂 token 走同一条错误路径（防 oracle）", async () => {
    const wrong = await relayHarness().handle(
      upgrade("http://edge/rl/v1/connect?role=host", `${SUBPROTOCOL}, wrong-secret-guess`)
    );
    expect(wrong.status).toBe(401);
    const wrongBody = (await wrong.json()) as { error: { code: string; message: string } };

    // 对照组：一个压根不知道 RUNTIME_SECRET 存在的普通烂 token。
    // 两条路径的响应必须完全一样——错 secret 不该比"随便一个假 token"多暴露任何信号
    const garbage = await relayHarness().handle(
      upgrade("http://edge/rl/v1/connect?role=host", `${SUBPROTOCOL}, not-even-a-jwt`)
    );
    expect(garbage.status).toBe(401);
    const garbageBody = (await garbage.json()) as { error: { code: string; message: string } };

    expect(wrongBody.error.code).toBe(garbageBody.error.code);
    expect(wrongBody.error.message).toBe(garbageBody.error.message);
  });

  it("/px/v1/call：带 x-runtime-secret + body.fromUid → 转发给托管箱的 fromUid = 声明值", async () => {
    const { calls, stub } = fakeEscrow();
    const handle = createEdge({ config, escrow: stub, isFriend: async () => true });
    const res = await handle(new Request("https://e/px/v1/call", {
      method: "POST",
      headers: { "x-runtime-secret": RUNTIME_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ hostUid: "a-uid", serverId: "s", tool: "t", args: {}, fromUid: "real-user" }),
    }));
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ hostUid: "a-uid", op: "call", body: { fromUid: "real-user" } });
  });

  it("/px/v1/call：带 x-runtime-secret 但缺 body.fromUid → 400", async () => {
    const { calls, stub } = fakeEscrow();
    const handle = createEdge({ config, escrow: stub, isFriend: async () => true });
    const res = await handle(new Request("https://e/px/v1/call", {
      method: "POST",
      headers: { "x-runtime-secret": RUNTIME_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ hostUid: "a-uid", serverId: "s", tool: "t", args: {} }),
    }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
