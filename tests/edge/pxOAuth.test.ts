// tests/edge/pxOAuth.test.ts
import { describe, expect, it } from "vitest";
import {
  authorizeUrl, b64url, discoverOAuth, exchangeCode, makeState, pkcePair, refreshCloudOAuth, registerClient, stateUid,
} from "../../services/edge/src/pxOAuth.js";

const rnd = (n: number) => new Uint8Array(n).fill(1);
const J = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const UID = "8f0c6a0e-1111-4222-8333-444455556666";

describe("state", () => {
  it("uid + 32 字节随机；拆得回 uid；坏形状 null", () => {
    const s = makeState(UID, rnd);
    expect(s.startsWith(`${UID}.`)).toBe(true);
    expect(s.slice(UID.length + 1)).toHaveLength(43);
    expect(stateUid(s)).toBe(UID);
    expect(stateUid("nouid")).toBeNull();
    expect(stateUid(`${UID}.short`)).toBeNull();
    expect(stateUid(`../x.${"A".repeat(43)}`)).toBeNull();
  });
});

describe("PKCE", () => {
  it("challenge = base64url(sha256(verifier))（RFC 7636 附录 B 的向量）", async () => {
    // 附录 B：verifier 由这 32 字节生成
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const { verifier, challenge } = await pkcePair(() => bytes);
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(b64url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("discoverOAuth", () => {
  it("9728 给了授权服务器就去它那儿读 8414", async () => {
    const hits: string[] = [];
    const f = async (u: string) => {
      hits.push(u);
      if (u === "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp") return J(200, { authorization_servers: ["https://auth.notion.com"] });
      if (u === "https://auth.notion.com/.well-known/oauth-authorization-server") {
        return J(200, { authorization_endpoint: "https://auth.notion.com/a", token_endpoint: "https://auth.notion.com/t", registration_endpoint: "https://auth.notion.com/r", scopes_supported: ["read"] });
      }
      return J(404, {});
    };
    const r = await discoverOAuth(f, "https://mcp.notion.com/mcp");
    expect(r).toEqual({ ok: true, meta: { authorizationEndpoint: "https://auth.notion.com/a", tokenEndpoint: "https://auth.notion.com/t", registrationEndpoint: "https://auth.notion.com/r", scopes: ["read"] } });
  });
  it("9728 没有就退回资源同源的 8414", async () => {
    const f = async (u: string) =>
      u === "https://mcp.linear.app/.well-known/oauth-authorization-server"
        ? J(200, { authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token" })
        : J(404, {});
    const r = await discoverOAuth(f, "https://mcp.linear.app/mcp");
    expect(r).toMatchObject({ ok: true, meta: { registrationEndpoint: null } });
  });
  it("拒非 https 的端点；都找不到回 discovery", async () => {
    const f = async () => J(200, { authorization_endpoint: "http://x/a", token_endpoint: "https://x/t" });
    expect(await discoverOAuth(f, "https://x.example/mcp")).toMatchObject({ ok: false, code: "discovery" });
    expect(await discoverOAuth(async () => J(404, {}), "https://x.example/mcp")).toMatchObject({ ok: false, code: "discovery" });
  });
});

describe("registerClient", () => {
  const meta = { authorizationEndpoint: "https://a/a", tokenEndpoint: "https://a/t", registrationEndpoint: "https://a/r", scopes: [] };
  it("没有注册端点 = no_dcr", async () => {
    expect(await registerClient(async () => J(200, {}), { ...meta, registrationEndpoint: null }, "https://e/cb")).toMatchObject({ ok: false, code: "no_dcr" });
  });
  it("带 https 回调、无密钥、名字 Mr Otto", async () => {
    let sent: any = null;
    const r = await registerClient(async (_u, init) => { sent = JSON.parse(String(init.body)); return J(201, { client_id: "cid" }); }, meta, "https://e/cb");
    expect(r).toEqual({ ok: true, client: { client_id: "cid" } });
    expect(sent).toMatchObject({ redirect_uris: ["https://e/cb"], token_endpoint_auth_method: "none", client_name: "Mr Otto", grant_types: ["authorization_code", "refresh_token"] });
  });
  it("注册被拒带厂商原话", async () => {
    const r = await registerClient(async () => J(400, { error_description: "redirect_uri not allowed" }), meta, "https://e/cb");
    expect(r).toEqual({ ok: false, code: "register", message: "redirect_uri not allowed" });
  });
});

describe("authorizeUrl / exchangeCode / refresh", () => {
  const meta = { authorizationEndpoint: "https://a/authorize?x=1", tokenEndpoint: "https://a/t", registrationEndpoint: null, scopes: ["read", "write"] };
  it("授权 URL 带 S256、resource、scope，保留原有 query", () => {
    const u = new URL(authorizeUrl({ meta, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp" }));
    expect(u.searchParams.get("x")).toBe("1");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "cid", redirect_uri: "https://e/cb", code_challenge: "ch", code_challenge_method: "S256", state: "st", resource: "https://m/mcp", scope: "read write" });
  });
  it("换 token：表单体；没 access_token 算失败", async () => {
    let body = "";
    const ok = await exchangeCode(async (_u, init) => { body = String(init.body); return J(200, { access_token: "AT", refresh_token: "RT" }); },
      { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "https://m/mcp" });
    expect(ok).toEqual({ ok: true, tokens: { access_token: "AT", refresh_token: "RT" } });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", redirect_uri: "https://e/cb" });
    expect(await exchangeCode(async () => J(400, { error: "invalid_grant" }), { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "r" }))
      .toEqual({ ok: false, code: "token", message: "invalid_grant" });
  });
  const oauth = { tokens: { access_token: "old", refresh_token: "RT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://a/t" };
  it("续期用记下的 tokenEndpoint；不轮换就保留旧 refresh_token", async () => {
    let hit = "";
    const r = await refreshCloudOAuth(async (u) => { hit = u; return J(200, { access_token: "new" }); }, oauth);
    expect(hit).toBe("https://a/t");
    expect(r).toEqual({ kind: "ok", oauth: { ...oauth, tokens: { access_token: "new", refresh_token: "RT" } } });
  });
  it("三态：厂商 4xx / 缺料 / 非 https = dead；网络错 / 5xx / 2xx 读不懂 = transient", async () => {
    expect(await refreshCloudOAuth(async () => J(400, { error: "invalid_grant" }), oauth)).toEqual({ kind: "dead" });
    expect(await refreshCloudOAuth(async () => J(200, {}), { tokenEndpoint: "https://a/t" })).toEqual({ kind: "dead" });
    let called = false;
    expect(await refreshCloudOAuth(async () => { called = true; return J(200, { access_token: "x" }); }, { ...oauth, tokenEndpoint: "http://a/t" })).toEqual({ kind: "dead" });
    expect(called).toBe(false);
    expect(await refreshCloudOAuth(async () => { throw new Error("reset"); }, oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => J(503, {}), oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => J(200, { nope: 1 }), oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => new Response("<html>", { status: 200 }), oauth)).toEqual({ kind: "transient" });
  });
});
