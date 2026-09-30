import { describe, expect, it } from "vitest";
import { createEdge, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { signTestJwt } from "./jwtTestUtil.js";

const SECRET = "test-secret-test-secret-test-secret!";
const config: EdgeConfig = { jwtSecret: SECRET, runtimeSecret: "rt-secret" };
const UID = "8f0c6a0e-1111-4222-8333-444455556666";
const STATE = `${UID}.${"A".repeat(43)}`;

function fakeEscrow(reply: unknown = { ok: true }) {
  const calls: { hostUid: string; op: string; body: any }[] = [];
  const stub = (hostUid: string): RelayStub => ({
    fetch: async (req: Request) => {
      calls.push({ hostUid, op: new URL(req.url).pathname.slice(1), body: await req.json() });
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  });
  return { calls, stub };
}
const auth = async () => ({ authorization: `Bearer ${await signTestJwt(SECRET, { sub: UID, email: "x@y.z", exp: Math.floor(Date.now() / 1000) + 600 })}` });

describe("/px/v1/cloud 路由", () => {
  it("connect：带 uid 转发到自己的箱；参数只收字符串", async () => {
    const { calls, stub } = fakeEscrow({ kind: "connected", serverId: "cloud-context7" });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const ok = await h(new Request("https://e/px/v1/cloud/connect", { method: "POST", headers: await auth(), body: JSON.stringify({ catalogId: "context7", params: { a: "1" } }) }));
    expect(ok.status).toBe(200);
    expect(calls[0]).toEqual({ hostUid: UID, op: "cloud_connect", body: { uid: UID, catalogId: "context7", params: { a: "1" } } });
    const bad = await h(new Request("https://e/px/v1/cloud/connect", { method: "POST", headers: await auth(), body: JSON.stringify({ catalogId: "x", params: { a: 1 } }) }));
    expect(bad.status).toBe(400);
  });
  it("平台身份一律 403", async () => {
    const { stub } = fakeEscrow();
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request("https://e/px/v1/cloud", { headers: { "x-runtime-secret": "rt-secret" } }));
    expect(r.status).toBe(403);
  });
  it("callback 不要 JWT；按 state 前半段找箱；302 到深链", async () => {
    const { calls, stub } = fakeEscrow({ ok: true, serverId: "cloud-notion" });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request(`https://e/px/v1/cloud/callback?code=C&state=${encodeURIComponent(STATE)}`));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("mrotto://connector-done?ok=1&serverId=cloud-notion");
    expect(calls[0]).toEqual({ hostUid: UID, op: "cloud_callback", body: { uid: UID, state: STATE, code: "C", error: null } });
  });
  it("callback 的 state 形状不对：不碰任何箱，302 带「超时」", async () => {
    const { calls, stub } = fakeEscrow();
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request("https://e/px/v1/cloud/callback?code=C&state=junk"));
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("ok=0");
    expect(calls).toEqual([]);
  });
  it("view / grant / remove", async () => {
    const { calls, stub } = fakeEscrow({ apps: [] });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    expect((await h(new Request("https://e/px/v1/cloud", { headers: await auth() }))).status).toBe(200);
    await h(new Request("https://e/px/v1/cloud/grant", { method: "POST", headers: await auth(), body: JSON.stringify({ serverId: "cloud-x", workspaceId: "22222222-2222-2222-2222-222222222222", on: true }) }));
    await h(new Request("https://e/px/v1/cloud/cloud-x", { method: "DELETE", headers: await auth() }));
    expect(calls.map((c) => c.op)).toEqual(["cloud_view", "cloud_grant", "cloud_remove"]);
    expect(calls[1]!.body).toEqual({ uid: UID, serverId: "cloud-x", workspaceId: "22222222-2222-2222-2222-222222222222", on: true });
    expect(calls[2]!.body).toEqual({ serverId: "cloud-x" });
    const badGrant = await h(new Request("https://e/px/v1/cloud/grant", { method: "POST", headers: await auth(), body: JSON.stringify({ serverId: "cloud-x", workspaceId: "w", on: "yes" }) }));
    expect(badGrant.status).toBe(400);
    const badDel = await h(new Request("https://e/px/v1/cloud/notion", { method: "DELETE", headers: await auth() }));
    expect(badDel.status).toBe(400);
  });
});
