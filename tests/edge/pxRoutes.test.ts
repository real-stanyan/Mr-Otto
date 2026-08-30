import { describe, expect, it, vi } from "vitest";
import { createEdge, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { signTestJwt } from "./jwtTestUtil.js";

// /px/v1/* 路由层（ADR-0197）：验人 → 关系闸 → 转托管箱。
// 箱子是假货——这层只测「谁被拦在门外、转发带上了什么」。

const SECRET = "test-secret-test-secret-test-secret!";
const config: EdgeConfig = { jwtSecret: SECRET };

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

async function jwtFor(uid: string): Promise<string> {
  return signTestJwt(SECRET, { sub: uid, email: "x@y.z", exp: Math.floor(Date.now() / 1000) + 600 });
}

const DOC = {
  v: 1, hostUid: "a-uid", updatedTs: 1,
  services: [{ serverId: "s", url: "https://x.example.com", toolDefs: [] }],
  grants: [{ friendUid: "b-uid", allow: [{ serverId: "s", tools: [] }] }],
};

describe("/px/v1 路由层", () => {
  it("没 token 401；escrow 只能写自己的箱子", async () => {
    const { calls, stub } = fakeEscrow();
    const handle = createEdge({ config, escrow: stub, isFriend: async () => true });

    const noAuth = await handle(new Request("https://e/px/v1/escrow", { method: "PUT", body: JSON.stringify(DOC) }));
    expect(noAuth.status).toBe(401);

    const notYours = await handle(new Request("https://e/px/v1/escrow", {
      method: "PUT",
      headers: { authorization: `Bearer ${await jwtFor("someone-else")}` },
      body: JSON.stringify(DOC),
    }));
    expect(notYours.status).toBe(403);

    const ok = await handle(new Request("https://e/px/v1/escrow", {
      method: "PUT",
      headers: { authorization: `Bearer ${await jwtFor("a-uid")}` },
      body: JSON.stringify(DOC),
    }));
    expect(ok.status).toBe(200);
    expect(calls[0]).toMatchObject({ hostUid: "a-uid", op: "put" });
  });

  it("grants：关系闸拦非好友，好友转发带 fromUid", async () => {
    const { calls, stub } = fakeEscrow();
    const isFriend = vi.fn(async () => false);
    const handle = createEdge({ config, escrow: stub, isFriend });

    const denied = await handle(new Request("https://e/px/v1/grants?host=a-uid", {
      headers: { authorization: `Bearer ${await jwtFor("b-uid")}` },
    }));
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0); // 不是好友：托管箱一个字节都不吐

    isFriend.mockResolvedValue(true);
    await handle(new Request("https://e/px/v1/grants?host=a-uid", {
      headers: { authorization: `Bearer ${await jwtFor("b-uid")}` },
    }));
    expect(calls[0]).toMatchObject({ hostUid: "a-uid", op: "grants", body: { fromUid: "b-uid" } });
  });

  it("call：fromUid 来自 JWT 不来自 body——身份闸比自报硬", async () => {
    const { calls, stub } = fakeEscrow();
    const handle = createEdge({ config, escrow: stub, isFriend: async () => true });
    await handle(new Request("https://e/px/v1/call", {
      method: "POST",
      headers: { authorization: `Bearer ${await jwtFor("b-uid")}` },
      // body 里冒充别人也没用：转发用的是 JWT 的 sub
      body: JSON.stringify({ hostUid: "a-uid", serverId: "s", tool: "t", args: {}, fromUid: "evil" }),
    }));
    expect((calls[0]?.body as { fromUid: string }).fromUid).toBe("b-uid");
    expect((calls[0]?.body as { friendAccepted: boolean }).friendAccepted).toBe(true);
  });

  it("audit：只有自己的箱子（hostUid = JWT sub）", async () => {
    const { calls, stub } = fakeEscrow();
    const handle = createEdge({ config, escrow: stub, isFriend: async () => true });
    await handle(new Request("https://e/px/v1/audit?since=5", {
      headers: { authorization: `Bearer ${await jwtFor("a-uid")}` },
    }));
    expect(calls[0]).toMatchObject({ hostUid: "a-uid", op: "audit", body: { since: 5 } });
  });

  it("没注入 escrow 依赖：/px 整族 404（服务没开）", async () => {
    const handle = createEdge({ config });
    const res = await handle(new Request("https://e/px/v1/call", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
