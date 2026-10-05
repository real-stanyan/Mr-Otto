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
    // 授权服务器的 scopes_supported 不整份照搬（#1430 终审 M7）：那是它**支持**的全集，不是这个资源要的
    expect(r).toEqual({ ok: true, meta: { authorizationEndpoint: "https://auth.notion.com/a", tokenEndpoint: "https://auth.notion.com/t", registrationEndpoint: "https://auth.notion.com/r", scopes: [], resource: null } });
  });
  it("9728 的 resource / scopes_supported 优先：resource 参数用它、scope 只取资源元数据给的", async () => {
    const f = async (u: string) => {
      if (u === "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp") {
        return J(200, { resource: "https://mcp.notion.com/", scopes_supported: ["mcp:read", 7], authorization_servers: ["https://auth.notion.com"] });
      }
      if (u === "https://auth.notion.com/.well-known/oauth-authorization-server") {
        return J(200, { authorization_endpoint: "https://auth.notion.com/a", token_endpoint: "https://auth.notion.com/t", scopes_supported: ["everything"] });
      }
      return J(404, {});
    };
    expect(await discoverOAuth(f, "https://mcp.notion.com/mcp")).toMatchObject({ ok: true, meta: { resource: "https://mcp.notion.com/", scopes: ["mcp:read"] } });
    // resource 不是 https 就不认（凭据的受众不往明文地址指）
    const g = async (u: string) =>
      u.endsWith("/oauth-protected-resource/mcp") ? J(200, { resource: "http://mcp.x/", authorization_servers: ["https://auth.x"] })
        : u === "https://auth.x/.well-known/oauth-authorization-server" ? J(200, { authorization_endpoint: "https://auth.x/a", token_endpoint: "https://auth.x/t" })
          : J(404, {});
    expect(await discoverOAuth(g, "https://mcp.x/mcp")).toMatchObject({ ok: true, meta: { resource: null, scopes: [] } });
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

describe("外呼都带 15 秒超时（#1430 终审 M6），超时落进原来的失败形状", () => {
  const timeout = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  const meta = { authorizationEndpoint: "https://a/a", tokenEndpoint: "https://a/t", registrationEndpoint: "https://a/r", scopes: [], resource: null };
  it("每一发都带 signal", async () => {
    const signals: unknown[] = [];
    const f = async (_u: string, init: RequestInit) => { signals.push(init.signal); return J(404, {}); };
    await discoverOAuth(f, "https://x.example/mcp");
    await registerClient(f, meta, "https://e/cb");
    await exchangeCode(f, { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "r" });
    await refreshCloudOAuth(f, { tokens: { refresh_token: "RT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://a/t" });
    expect(signals.length).toBeGreaterThanOrEqual(6);
    for (const sg of signals) expect(sg).toBeInstanceOf(AbortSignal);
  });
  it("discovery / register / token / 续期 transient", async () => {
    expect(await discoverOAuth(timeout, "https://x.example/mcp")).toMatchObject({ ok: false, code: "discovery" });
    expect(await registerClient(timeout, meta, "https://e/cb")).toMatchObject({ ok: false, code: "register" });
    expect(await exchangeCode(timeout, { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "r" }))
      .toMatchObject({ ok: false, code: "token" });
    expect(await refreshCloudOAuth(timeout, { tokens: { refresh_token: "RT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://a/t" }))
      .toEqual({ kind: "transient" });
  });
});

describe("registerClient", () => {
  const meta = { authorizationEndpoint: "https://a/a", tokenEndpoint: "https://a/t", registrationEndpoint: "https://a/r", scopes: [], resource: null };
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
  const meta = { authorizationEndpoint: "https://a/authorize?x=1", tokenEndpoint: "https://a/t", registrationEndpoint: null, scopes: ["read", "write"], resource: null };
  it("授权 URL 带 S256、resource、scope，保留原有 query", () => {
    const u = new URL(authorizeUrl({ meta, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp" }));
    expect(u.searchParams.get("x")).toBe("1");
    // 资源元数据没给 scopes 就不带 scope（#1430 终审 M7）
    expect(new URL(authorizeUrl({ meta: { ...meta, scopes: [] }, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp" })).searchParams.has("scope")).toBe(false);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "cid", redirect_uri: "https://e/cb", code_challenge: "ch", code_challenge_method: "S256", state: "st", resource: "https://m/mcp", scope: "read write" });
  });
  it("scopes 覆盖资源元数据那份；extra 逐个带上，保留键不许被覆盖（#1619）", () => {
    const u = new URL(authorizeUrl({
      meta, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp",
      scopes: ["s.read", "s.compose"],
      extra: { access_type: "offline", prompt: "consent", client_id: "evil", redirect_uri: "https://evil/cb", scope: "all" },
    }));
    expect(u.searchParams.get("scope")).toBe("s.read s.compose");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://e/cb");
    expect(u.searchParams.getAll("client_id")).toHaveLength(1);
  });
  it("scopes 给了空数组 = 不带 scope（不退回资源元数据那份）", () => {
    const u = new URL(authorizeUrl({ meta: { ...meta, scopes: ["x"] }, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp", scopes: [] }));
    expect(u.searchParams.has("scope")).toBe(false);
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
  it("注册回了 client_secret 就在换 token 时带上（client_secret_post）；没回就不带这个键", async () => {
    let body = "";
    await exchangeCode(async (_u, init) => { body = String(init.body); return J(200, { access_token: "AT" }); },
      { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", clientSecret: "sek", redirectUri: "https://e/cb", resource: "https://m/" });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ client_secret: "sek", resource: "https://m/" });
    await exchangeCode(async (_u, init) => { body = String(init.body); return J(200, { access_token: "AT" }); },
      { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "https://m/" });
    expect(new URLSearchParams(body).has("client_secret")).toBe(false);
  });
  const oauth = { tokens: { access_token: "old", refresh_token: "RT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://a/t" };
  it("续期：记下的 resource 与 client_secret 一起带上；都没有就都不带", async () => {
    let body = "";
    const cap = async (_u: string, init: RequestInit) => { body = String(init.body); return J(200, { access_token: "new" }); };
    await refreshCloudOAuth(cap, { ...oauth, clientInformation: { client_id: "cid", client_secret: "sek" }, resource: "https://m/" });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ grant_type: "refresh_token", client_secret: "sek", resource: "https://m/" });
    await refreshCloudOAuth(cap, oauth);
    const b = new URLSearchParams(body);
    expect(b.has("client_secret") || b.has("resource")).toBe(false);
  });
  it("续期用记下的 tokenEndpoint；不轮换就保留旧 refresh_token", async () => {
    let hit = "";
    const r = await refreshCloudOAuth(async (u) => { hit = u; return J(200, { access_token: "new" }); }, oauth);
    expect(hit).toBe("https://a/t");
    expect(r).toEqual({ kind: "ok", oauth: { ...oauth, tokens: { access_token: "new", refresh_token: "RT" } } });
  });
  it("dead 带上回包里的 OAuth error（尽力而为）：读不出来就不带这个键，永不抛", async () => {
    expect(await refreshCloudOAuth(async () => J(401, { error: "invalid_client" }), oauth)).toEqual({ kind: "dead", error: "invalid_client" });
    expect(await refreshCloudOAuth(async () => new Response("<html>nope", { status: 400 }), oauth)).toStrictEqual({ kind: "dead" });
    expect(await refreshCloudOAuth(async () => J(403, { error: 7 }), oauth)).toStrictEqual({ kind: "dead" });
    expect(await refreshCloudOAuth(async () => J(400, {}), oauth)).toStrictEqual({ kind: "dead" });
    expect(await refreshCloudOAuth(async () => J(400, { error: "" }), oauth)).toStrictEqual({ kind: "dead" });
  });
  it("三态：厂商 4xx / 缺料 / 非 https = dead；网络错 / 5xx / 2xx 读不懂 = transient", async () => {
    expect(await refreshCloudOAuth(async () => J(400, { error: "invalid_grant" }), oauth)).toEqual({ kind: "dead", error: "invalid_grant" });
    expect(await refreshCloudOAuth(async () => J(200, {}), { tokenEndpoint: "https://a/t" })).toEqual({ kind: "dead" });
    let called = false;
    expect(await refreshCloudOAuth(async () => { called = true; return J(200, { access_token: "x" }); }, { ...oauth, tokenEndpoint: "http://a/t" })).toEqual({ kind: "dead" });
    expect(called).toBe(false);
    expect(await refreshCloudOAuth(async () => { throw new Error("reset"); }, oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => J(503, {}), oauth)).toEqual({ kind: "transient" });
    // 408 / 429 是「这一次没问成」，不是「登录失效了」（#1430 终审 M1）
    expect(await refreshCloudOAuth(async () => J(408, {}), oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => J(429, { error: "slow_down" }), oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => J(200, { nope: 1 }), oauth)).toEqual({ kind: "transient" });
    expect(await refreshCloudOAuth(async () => new Response("<html>", { status: 200 }), oauth)).toEqual({ kind: "transient" });
  });
});
