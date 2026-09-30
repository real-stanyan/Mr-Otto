// tests/edge/pxCloudOps.test.ts
import { describe, expect, it } from "vitest";
import {
  cloudCallback, cloudConnect, cloudGrant, cloudRefresh, cloudRemove, cloudViewOf,
  type CloudOpsDeps, type CloudStore, type PendingAuth,
} from "../../services/edge/src/pxCloudOps.js";
import { CLOUD_TEXT, type CloudBox } from "../../src/shared/remote/pxCloud.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";

const UID = "8f0c6a0e-1111-4222-8333-444455556666";
const HOME = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const J = (status: number, body: unknown, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...h } });

const CATALOG: CatalogEntry[] = [
  { id: "notion", name: "Notion", description: "", transport: "http", url: "https://mcp.notion.com/mcp", params: [], auth: "oauth", authNote: "" },
  { id: "github", name: "GitHub", description: "", transport: "http", url: "https://api.githubcopilot.com/mcp/", params: [{ name: "github_token", description: "", required: true }], auth: "token", authNote: "", headerTemplates: { Authorization: "Bearer {github_token}" } },
  { id: "context7", name: "Context7", description: "", transport: "http", url: "https://mcp.context7.com/mcp", params: [], auth: "none", authNote: "" },
  { id: "local", name: "Local", description: "", transport: "stdio", command: "npx", params: [], auth: "none", authNote: "" },
  { id: "plain", name: "Plain", description: "", transport: "http", url: "http://insecure.example/mcp", params: [], auth: "none", authNote: "" },
];

/** 内存假货。atomic 串行化并记录临界区里有没有打过 fetch（Global Constraints：临界区里不许外呼） */
function memStore() {
  let box: CloudBox | null = null;
  const pending = new Map<string, PendingAuth>();
  let rate: number[] = [];
  let inAtomic = false;
  const store: CloudStore & { inAtomic: () => boolean } = {
    getBox: async () => box, putBox: async (b) => { box = b; },
    getPending: async (s) => pending.get(s) ?? null, putPending: async (p) => { pending.set(p.state, p); },
    deletePending: async (s) => { pending.delete(s); }, listPending: async () => [...pending.values()],
    getRate: async () => rate, putRate: async (r) => { rate = r; },
    atomic: async (fn) => { inAtomic = true; try { return await fn(); } finally { inAtomic = false; } },
    inAtomic: () => inAtomic,
  };
  return { store, peekBox: () => box, pending };
}

/** 假上游：MCP（initialize/tools/list）+ Notion 的 OAuth 全套。临界区里被打到就抛 */
function upstream(store: { inAtomic: () => boolean }, opts: { token401?: boolean; noDcr?: boolean } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    if (store.inAtomic()) throw new Error(`临界区里外呼了：${url}`);
    calls.push(url);
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) return J(200, { authorization_servers: ["https://auth.notion.com"] });
    if (url === "https://auth.notion.com/.well-known/oauth-authorization-server") {
      return J(200, { authorization_endpoint: "https://auth.notion.com/a", token_endpoint: "https://auth.notion.com/t", ...(opts.noDcr ? {} : { registration_endpoint: "https://auth.notion.com/r" }) });
    }
    if (url === "https://auth.notion.com/r") return J(201, { client_id: "cid" });
    if (url === "https://auth.notion.com/t") {
      const b = new URLSearchParams(String(init.body));
      return b.get("grant_type") === "refresh_token" ? J(400, { error: "invalid_grant" }) : J(200, { access_token: "AT", refresh_token: "RT" });
    }
    if (url.startsWith("https://")) {
      if (opts.token401) return new Response("", { status: 401 });
      const body = JSON.parse(String(init.body ?? "{}"));
      if (body.method === "initialize") return J(200, { jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return J(200, { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "", inputSchema: {} }] } });
    }
    return J(404, {});
  };
  return { f, calls };
}

function deps(over: Partial<CloudOpsDeps> = {}) {
  const m = memStore();
  const up = upstream(m.store, {});
  let t = 1_000_000;
  const d: CloudOpsDeps = {
    store: m.store, fetch: up.f, now: () => t, random: (n) => new Uint8Array(n).fill(9),
    catalog: CATALOG, callbackUrl: "https://edge.example/px/v1/cloud/callback",
    homeIdOf: async () => HOME, isMember: async () => true,
    ...over,
  };
  return { d, m, up, tick: (ms: number) => { t += ms; } };
}

describe("cloudConnect：token / 免登录", () => {
  it("token：验过才存，默认主场授权，头按模板代入", async () => {
    const { d, m } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "github", params: { github_token: "ghp_x" } });
    expect(r).toEqual({ ok: true, reply: { kind: "connected", serverId: "cloud-github" } });
    const s = m.peekBox()!.services[0]!;
    expect(s).toMatchObject({ serverId: "cloud-github", catalogId: "github", headers: { Authorization: "Bearer ghp_x" }, status: "ok", grants: [{ workspaceId: HOME, allow: [] }] });
    expect(s.toolDefs.map((t) => t.name)).toEqual(["search"]);
  });
  it("token 401 → 不存，说「token 用不了」", async () => {
    const { d, m } = deps();
    d.fetch = upstream(m.store, { token401: true }).f;
    const r = await cloudConnect(d, UID, { catalogId: "github", params: { github_token: "bad" } });
    expect(r).toMatchObject({ ok: false, message: CLOUD_TEXT.badToken });
    expect(m.peekBox()).toBeNull();
  });
  it("拒：目录外 / stdio / 非 https / 缺必填参数", async () => {
    const { d } = deps();
    expect(await cloudConnect(d, UID, { catalogId: "nope", params: {} })).toMatchObject({ ok: false, status: 404 });
    expect(await cloudConnect(d, UID, { catalogId: "local", params: {} })).toMatchObject({ ok: false, status: 400 });
    expect(await cloudConnect(d, UID, { catalogId: "plain", params: {} })).toMatchObject({ ok: false, status: 400 });
    expect(await cloudConnect(d, UID, { catalogId: "github", params: {} })).toMatchObject({ ok: false, status: 400 });
  });
  it("免登录直接连；主场没建就先不带授权", async () => {
    const { d, m } = deps({ homeIdOf: async () => null });
    expect(await cloudConnect(d, UID, { catalogId: "context7", params: {} })).toMatchObject({ ok: true });
    expect(m.peekBox()!.services[0]!.grants).toEqual([]);
  });
  it("每分钟 10 次", async () => {
    const { d } = deps();
    for (let i = 0; i < 10; i += 1) await cloudConnect(d, UID, { catalogId: "context7", params: {} });
    expect(await cloudConnect(d, UID, { catalogId: "context7", params: {} })).toMatchObject({ ok: false, status: 429, message: CLOUD_TEXT.tooMany });
  });
});

describe("cloudConnect + cloudCallback：浏览器登录", () => {
  it("走完一整轮：pending 一次性，回调换 token 列工具再存", async () => {
    const { d, m } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回授权 URL");
    const u = new URL(r.reply.authorizeUrl);
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("redirect_uri")).toBe("https://edge.example/px/v1/cloud/callback");
    expect(m.pending.get(state)).toMatchObject({ uid: UID, catalogId: "notion", tokenEndpoint: "https://auth.notion.com/t" });

    const done = await cloudCallback(d, UID, { state, code: "CODE", error: null });
    expect(done).toEqual({ ok: true, serverId: "cloud-notion" });
    expect(m.pending.size).toBe(0);
    expect(m.peekBox()!.services[0]!.oauth).toMatchObject({ tokens: { access_token: "AT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://auth.notion.com/t" });

    expect(await cloudCallback(d, UID, { state, code: "CODE", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
  });
  it("过期 / 别人的 state / 厂商回 error", async () => {
    const { d, tick } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("x");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    expect(await cloudCallback(d, "99999999-9999-4999-8999-999999999999", { state, code: "C", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    tick(600_001);
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    const r2 = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r2.ok || r2.reply.kind !== "authorize") throw new Error("x");
    const s2 = new URL(r2.reply.authorizeUrl).searchParams.get("state")!;
    expect(await cloudCallback(d, UID, { state: s2, code: null, error: "access_denied" })).toEqual({ ok: false, message: "access_denied" });
  });
  it("不支持动态注册 → 明说去电脑上接", async () => {
    const { d, m } = deps();
    d.fetch = upstream(m.store, { noDcr: true }).f;
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, message: CLOUD_TEXT.noDcr });
  });
  it("pending 封顶 5：先清过期的，仍满就拒", async () => {
    const { d, tick } = deps();
    let n = 0;
    d.random = (len) => new Uint8Array(len).fill(++n % 250);
    for (let i = 0; i < 5; i += 1) expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: true });
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, status: 429 });
    tick(600_001);
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: true });
  });
});

describe("授权 / 断开 / 视图 / 续期", () => {
  async function connected() {
    const x = deps();
    await cloudConnect(x.d, UID, { catalogId: "context7", params: {} });
    return x;
  }
  it("借给团队要在籍；没这台 404", async () => {
    const x = await connected();
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true })).toEqual({ ok: true });
    expect(x.m.peekBox()!.services[0]!.grants.map((g) => g.workspaceId)).toEqual([HOME, TEAM]);
    x.d.isMember = async () => false;
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true })).toMatchObject({ ok: false, status: 403 });
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: false })).toMatchObject({ ok: false, status: 404 });
  });
  it("关掉不查在籍（被踢出去的人也要能收回）", async () => {
    const x = await connected();
    await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true });
    x.d.isMember = async () => false;
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: false })).toEqual({ ok: true });
  });
  it("断开：凭据消失", async () => {
    const x = await connected();
    expect(await cloudRemove(x.d, "cloud-context7")).toEqual({ ok: true });
    expect(x.m.peekBox()!.services).toEqual([]);
  });
  it("视图补上主场授权并落库；无凭据", async () => {
    const x = deps({ homeIdOf: async () => null });
    await cloudConnect(x.d, UID, { catalogId: "github", params: { github_token: "ghp_secret" } });
    x.d.homeIdOf = async () => HOME;
    const v = await cloudViewOf(x.d, UID);
    expect(v[0]!.grants).toEqual([HOME]);
    expect(x.m.peekBox()!.services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    expect(JSON.stringify(v)).not.toContain("ghp_secret");
  });
  it("续期失败 → needs_login", async () => {
    const x = deps();
    const r = await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("x");
    await cloudCallback(x.d, UID, { state: new URL(r.reply.authorizeUrl).searchParams.get("state")!, code: "C", error: null });
    expect(await cloudRefresh(x.d, "cloud-notion")).toBeNull();
    expect(x.m.peekBox()!.services[0]!.status).toBe("needs_login");
  });
});
