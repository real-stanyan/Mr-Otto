import { describe, expect, it } from "vitest";
import { createEdge, RUNTIME_SERVICE_UID, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { SUBPROTOCOL } from "../../services/edge/src/relay.js";
import { signTestJwt } from "./jwtTestUtil.js";
import { csChannel, csCtlChannel } from "../../src/shared/remote/cloudSession.js";

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

// 终审 C1：cs-* 房间（工作区云会话）里，role=host 只认平台身份。真人一律
// 降级成 guest——房名 `cs-${workspaceId}-${sessionId}` 现任成员和被踢的
// 前成员都知道，不收口的话谁先连上谁就能抢到 host 角色、被 relay 当权威
// 广播（真 runtime 的帧被丢弃、攻击者的帧被当权威）。
//
// 判据是精确格式匹配（isCsChannel），不是「以 cs- 开头」（终审复审 R1）：
// 好友代理的 channelId 是随机 base64url（字母表含 `-`），约 1/262144 的
// 邀请码会撞出一个 `cs-` 开头的房名——用真实形状的 UUID 房名 / 代理频道名
// 分别验证两条边界。
describe("cs-* 房间角色收口（终审 C1 / R1）", () => {
  const realUserJwt = (sub = "real-user"): string =>
    signTestJwt(JWT_SECRET, { sub, email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 });

  // 真实形状：workspaceId/sessionId 都是标准 UUID，用 csChannel() 本身构造——
  // 与生产上 daemon.ts 的 openSessionRoom 用的是同一个函数，保证测试没有
  // 自己臆造一个"看起来像"但实际上房间构造代码永远不会生成的房名
  const REAL_CS_CHANNEL = csChannel("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");

  // 手工构造一个真实形状的代理 channelId：b64encode(randomBytes(32)) 的
  // 长度是 43 字符，字母表含 `-`/`_`——这一条恰好以 "cs-" 开头，但显然不是
  // cs-<uuid>-<uuid> 的精确格式（终审复审 R1 的原始复现：约 1/262144 的
  // 邀请码会撞出这种形状）
  const PROXY_LIKE_CHANNEL = "cs-Qx7mZ2pL9vN4wR8tY1zA6bC3dE5fG0hJ_mK-lMnO";

  it("真人 JWT 对合法 cs 房名要 role=host → 被降级成 guest", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(
      upgrade(`http://edge/rl/v1/connect?role=host&channel=${REAL_CS_CHANNEL}`, `${SUBPROTOCOL}, ${realUserJwt()}`)
    );
    expect(res.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(new URL(routed[0]!.req.url).searchParams.get("role")).toBe("guest");
  });

  it("平台身份（RUNTIME_SECRET）对合法 cs 房名要 role=host → 保留 host（真 runtime 不受收口影响）", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(
      upgrade(`http://edge/rl/v1/connect?role=host&channel=${REAL_CS_CHANNEL}`, `${SUBPROTOCOL}, ${RUNTIME_SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(new URL(routed[0]!.req.url).searchParams.get("role")).toBe("host");
  });

  // R1 的直接回归用例：一个 cs- 开头但不是精确 cs 房名格式的代理频道——
  // 真人拿 role=host 连它不该被误伤，否则 A/B 双方都变 guest，peersOf
  // 永远配不上，配对永远开不起来且没有任何报错
  it("真人 JWT 对 cs- 开头但非法格式的频道（代理频道撞前缀）要 role=host → 不被降级（R1）", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(
      upgrade(
        `http://edge/rl/v1/connect?role=host&channel=${PROXY_LIKE_CHANNEL}`,
        `${SUBPROTOCOL}, ${realUserJwt()}`
      )
    );
    expect(res.status).toBe(200);
    expect(new URL(routed[0]!.req.url).searchParams.get("role")).toBe("host");
  });

  it("真人 JWT 对非 cs- 频道（好友代理房间）要 role=host → 不受收口影响，正常放行", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(
      upgrade("http://edge/rl/v1/connect?role=host&channel=some-proxy-channel", `${SUBPROTOCOL}, ${realUserJwt()}`)
    );
    expect(res.status).toBe(200);
    expect(new URL(routed[0]!.req.url).searchParams.get("role")).toBe("host");
  });

  it("真人 JWT 对合法 cs 房名要 role=guest → 不受影响（收口只降级 host）", async () => {
    const { routed, handle } = relayHarness();
    const res = await handle(
      upgrade(`http://edge/rl/v1/connect?role=guest&channel=${REAL_CS_CHANNEL}`, `${SUBPROTOCOL}, ${realUserJwt()}`)
    );
    expect(res.status).toBe(200);
    expect(new URL(routed[0]!.req.url).searchParams.get("role")).toBe("guest");
  });
});

// issue #824：`MAX_CONNS_PER_USER` 数的一直是**房间里的连接总数**——自远程
// 的房间键就是 userId，两者碰巧相等，所以没露馅；cs-ctl 是全平台一个固定
// 房，于是它变成了"全平台同时最多 16 条人类连接进控制房"。修法是让 DO 按
// 人分桶数数，而分桶键由 edge.ts 算好递下去（DO 不该认识 userId——好友代理
// 房间的设计前提就是中继不懂参与者是谁，ADR-0151）。
describe("连接计数键 ck（issue #824）", () => {
  const jwtOf = (sub: string): string =>
    signTestJwt(JWT_SECRET, { sub, email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 });
  const ckOf = async (sub: string, channel?: string): Promise<string> => {
    const { routed, handle } = relayHarness();
    const url = `http://edge/rl/v1/connect?role=guest${channel === undefined ? "" : `&channel=${channel}`}`;
    await handle(upgrade(url, `${SUBPROTOCOL}, ${jwtOf(sub)}`));
    return new URL(routed[0]!.req.url).searchParams.get("ck") ?? "";
  };

  it("每条转发都带 ck，且同一个人在同一个房间里稳定相同", async () => {
    const a1 = await ckOf("user-a");
    const a2 = await ckOf("user-a");
    expect(a1).toMatch(/^[0-9a-f]{16}$/);
    expect(a2).toBe(a1);
  });

  it("同一个房间里两个人的 ck 不同 —— 这正是「别人占满 16 条」不再殃及自己的原因", async () => {
    const ctl = csCtlChannel();
    expect(await ckOf("user-a", ctl)).not.toBe(await ckOf("user-b", ctl));
  });

  it("ck 不是身份：同一个人在两个房间里对不上号，且哪里都不出现 uid 明文", async () => {
    const ctl = await ckOf("user-a", csCtlChannel());
    const proxy = await ckOf("user-a", "some-proxy-channel");
    // 跨房间不可关联——好友代理的中继本来就不该认得出"这两条是同一个人"
    expect(ctl).not.toBe(proxy);
    expect(ctl).not.toContain("user-a");
    expect(proxy).not.toContain("user-a");
  });
});
