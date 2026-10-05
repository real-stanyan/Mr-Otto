// tests/edge/pxCloudOps.test.ts
import { describe, expect, it } from "vitest";
import {
  cloudCallback, cloudConnect, cloudGrant, cloudRefresh, cloudRemove, cloudViewOf,
  type CloudOpsDeps, type CloudStore, type PendingAuth,
} from "../../services/edge/src/pxCloudOps.js";
import { CLOUD_TEXT, presetUnconfiguredText, upsertCloudService, type CloudBox } from "../../src/shared/remote/pxCloud.js";
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
  {
    id: "gmail", name: "Gmail", description: "", transport: "http", url: "https://gmail.example/mcp/v1", params: [], auth: "oauth", authNote: "",
    presetClient: "google", scopes: ["g.read", "g.compose"], authorizeParams: { access_type: "offline", prompt: "consent" },
  },
];

/** 内存假货。atomic 串行化并记录临界区里有没有打过 fetch（Global Constraints：临界区里不许外呼）；
    写方法在临界区外被调用就抛（读方法可以在外面——那是「外呼在前」的快照） */
function memStore() {
  let box: CloudBox | null = null;
  const pending = new Map<string, PendingAuth>();
  let rate: number[] = [];
  let inAtomic = false;
  let chain: Promise<unknown> = Promise.resolve();
  const guarded = (what: string) => { if (!inAtomic) throw new Error(`临界区外写了：${what}`); };
  const store: CloudStore & { inAtomic: () => boolean } = {
    getBox: async () => box, putBox: async (b) => { guarded("putBox"); box = b; },
    getPending: async (s) => pending.get(s) ?? null, putPending: async (p) => { guarded("putPending"); pending.set(p.state, p); },
    deletePending: async (s) => { guarded("deletePending"); pending.delete(s); }, listPending: async () => [...pending.values()],
    getRate: async () => rate, putRate: async (r) => { guarded("putRate"); rate = r; },
    atomic: (fn) => {
      const run = chain.then(async () => { inAtomic = true; try { return await fn(); } finally { inAtomic = false; } });
      chain = run.catch(() => undefined);
      return run;
    },
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
    if (url === "https://gmail.example/.well-known/oauth-protected-resource/mcp/v1") {
      return J(200, { resource: "https://gmail.example/mcp/v1", authorization_servers: ["https://accounts.example/"], scopes_supported: ["https://mail.example/", "g.read", "g.compose"] });
    }
    if (url === "https://accounts.example/.well-known/oauth-authorization-server") {
      return J(200, { authorization_endpoint: "https://accounts.example/auth", token_endpoint: "https://oauth2.example/token" });
    }
    if (url === "https://oauth2.example/token") {
      const b = new URLSearchParams(String(init.body));
      if (b.get("client_secret") !== "GSECRET") return J(401, { error: "invalid_client" });
      return b.get("grant_type") === "refresh_token" ? J(200, { access_token: "AT2" }) : J(200, { access_token: "AT", refresh_token: "RT" });
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
    // 上面那次已经把 pending 摘掉了，过期要用一条新的 state 单独测
    const rExp = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!rExp.ok || rExp.reply.kind !== "authorize") throw new Error("x");
    const stateExp = new URL(rExp.reply.authorizeUrl).searchParams.get("state")!;
    tick(600_001);
    expect(await cloudCallback(d, UID, { state: stateExp, code: "C", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
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
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: true })).toMatchObject({ ok: false, status: 404 });
    x.d.isMember = async () => false;
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true })).toMatchObject({ ok: false, status: 403 });
  });
  it("关掉一台箱里已经没有的应用：算成功且不写（撤回要能重试到底）", async () => {
    const x = await connected();
    const before = x.m.peekBox();
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: false })).toEqual({ ok: true });
    expect(x.m.peekBox()).toBe(before);
    // 一个箱子都没有：同样算成功，也不凭空建箱
    const empty = deps();
    expect(await cloudGrant(empty.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: false })).toEqual({ ok: true });
    expect(empty.m.peekBox()).toBeNull();
  });
  it("打开一台箱里没有的应用仍是 404（没有箱也一样）", async () => {
    const empty = deps();
    expect(await cloudGrant(empty.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: true })).toMatchObject({ ok: false, status: 404 });
    expect(empty.m.peekBox()).toBeNull();
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
  // #1430 终审 M2：断开同授权关掉一样幂等——上一次断开其实已经落地、只是回执丢了，再点一次该收干净而不是报「没接」
  it("断开一台箱里已经没有的：算成功且不写；一个箱子都没有也一样，不凭空建箱", async () => {
    const x = await connected();
    await cloudRemove(x.d, "cloud-context7");
    const before = x.m.peekBox();
    expect(await cloudRemove(x.d, "cloud-context7")).toEqual({ ok: true });
    expect(x.m.peekBox()).toBe(before);
    const empty = deps();
    expect(await cloudRemove(empty.d, "cloud-nope")).toEqual({ ok: true });
    expect(empty.m.peekBox()).toBeNull();
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

// ─── 复审补的（fix round 1）──────────────────────────────────────────────

/** 走完一整轮浏览器登录，接上 notion（tokens: AT / RT） */
async function loginNotion(x: ReturnType<typeof deps>) {
  const r = await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
  if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回授权 URL");
  const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
  return cloudCallback(x.d, UID, { state, code: "C", error: null });
}

/** 在原假上游外面包一层：先问 hook（回 Response 就用它），否则交给原上游；临界区里外呼照样抛 */
function wrapFetch(x: ReturnType<typeof deps>, hook: (url: string, init: RequestInit) => Promise<Response | undefined> | Response | undefined) {
  const base = x.d.fetch;
  x.d.fetch = async (url, init) => {
    if (x.m.store.inAtomic()) throw new Error(`临界区里外呼了：${url}`);
    return (await hook(url, init)) ?? base(url, init);
  };
}
const isRefresh = (url: string, init: RequestInit) =>
  url === "https://auth.notion.com/t" && new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token";

describe("OAuth 请求的形状（#1430 终审 M7）", () => {
  it("资源元数据给了 resource / scopes：授权 URL、pending、换 token、落箱的凭据都用它；注册回的 client_secret 换 token 时带上", async () => {
    const x = deps();
    const tokenBodies: URLSearchParams[] = [];
    wrapFetch(x, (url, init) => {
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return J(200, { resource: "https://mcp.notion.com/", scopes_supported: ["mcp"], authorization_servers: ["https://auth.notion.com"] });
      }
      if (url === "https://auth.notion.com/r") return J(201, { client_id: "cid", client_secret: "sek" });
      if (url === "https://auth.notion.com/t") tokenBodies.push(new URLSearchParams(String(init.body)));
      return undefined;
    });
    const r = await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回授权 URL");
    const u = new URL(r.reply.authorizeUrl);
    expect(u.searchParams.get("resource")).toBe("https://mcp.notion.com/");
    expect(u.searchParams.get("scope")).toBe("mcp");
    const state = u.searchParams.get("state")!;
    expect(x.m.pending.get(state)).toMatchObject({ resource: "https://mcp.notion.com/", url: "https://mcp.notion.com/mcp" });
    expect(await cloudCallback(x.d, UID, { state, code: "C", error: null })).toMatchObject({ ok: true });
    expect(Object.fromEntries(tokenBodies[0]!)).toMatchObject({ resource: "https://mcp.notion.com/", client_secret: "sek" });
    const svc = x.m.peekBox()!.services[0]!;
    expect(svc.oauth).toMatchObject({ resource: "https://mcp.notion.com/", clientInformation: { client_id: "cid", client_secret: "sek" } });
    // MCP 请求仍打接入 URL，resource 只是凭据的受众
    expect(svc.url).toBe("https://mcp.notion.com/mcp");
  });
  it("资源元数据没给 resource：退回接入 URL，也照样记进凭据", async () => {
    const x = deps();
    await loginNotion(x);
    expect(x.m.peekBox()!.services[0]!.oauth).toMatchObject({ resource: "https://mcp.notion.com/mcp" });
  });
});

describe("cloudRefresh：并发 / 中途变化（I1）", () => {
  it("两次并发续期、厂商轮换 refresh_token：第二次 invalid_grant 不许把好凭据标成 needs_login", async () => {
    const x = deps();
    await loginNotion(x);
    let n = 0;
    let releaseSecond: () => void = () => undefined;
    const secondMayAnswer = new Promise<void>((r) => { releaseSecond = r; });
    wrapFetch(x, async (url, init) => {
      if (!isRefresh(url, init)) return undefined;
      n += 1;
      if (n === 1) return J(200, { access_token: "AT2", refresh_token: "RT2" });
      await secondMayAnswer; // 用旧 refresh_token 的第二发，厂商在第一发落地之后才回 invalid_grant（真实里就是这个顺序）
      return J(400, { error: "invalid_grant" });
    });
    const first = cloudRefresh(x.d, "cloud-notion");
    const second = cloudRefresh(x.d, "cloud-notion");
    const a = await first;
    releaseSecond();
    const b = await second;
    expect(n).toBe(2);
    expect(x.m.peekBox()!.services[0]!.status).toBe("ok");
    expect(x.m.peekBox()!.services[0]!.oauth!.tokens).toMatchObject({ access_token: "AT2", refresh_token: "RT2" });
    expect(a).toMatchObject({ tokens: { access_token: "AT2" } });
    expect(b).toMatchObject({ tokens: { access_token: "AT2", refresh_token: "RT2" } });
  });
  it("续期途中这台被断开：不写、不把箱子写回来，回 null", async () => {
    const x = deps();
    await loginNotion(x);
    wrapFetch(x, async (url, init) => {
      if (!isRefresh(url, init)) return undefined;
      await cloudRemove(x.d, "cloud-notion");
      return J(200, { access_token: "AT2", refresh_token: "RT2" });
    });
    expect(await cloudRefresh(x.d, "cloud-notion")).toBeNull();
    expect(x.m.peekBox()!.services).toEqual([]);
  });
  it("续期途中手机重新登录了：不覆盖新登录（成功回包与 invalid_grant 两种都是）", async () => {
    for (const reply of [() => J(200, { access_token: "STALE", refresh_token: "RT-STALE" }), () => J(400, { error: "invalid_grant" })]) {
      const x = deps();
      await loginNotion(x);
      wrapFetch(x, async (url, init) => {
        if (!isRefresh(url, init)) return undefined;
        await x.m.store.atomic(async () => {
          const box = x.m.peekBox()!;
          const svc = box.services[0]!;
          await x.m.store.putBox(upsertCloudService(box, {
            serverId: svc.serverId, catalogId: svc.catalogId, url: svc.url, toolDefs: svc.toolDefs,
            oauth: { tokens: { access_token: "AT-NEW", refresh_token: "RT-NEW" }, clientInformation: { client_id: "cid2" }, tokenEndpoint: "https://auth.notion.com/t" },
          }, HOME, 2_000_000));
        });
        return reply();
      });
      const r = await cloudRefresh(x.d, "cloud-notion");
      const svc = x.m.peekBox()!.services[0]!;
      expect(svc.status).toBe("ok");
      expect(svc.oauth).toMatchObject({ tokens: { access_token: "AT-NEW", refresh_token: "RT-NEW" }, clientInformation: { client_id: "cid2" } });
      expect(r).toMatchObject({ tokens: { access_token: "AT-NEW" } });
    }
  });
  it("续期成功：新 token 写回，没轮换就留着旧 refresh_token", async () => {
    const x = deps();
    await loginNotion(x);
    wrapFetch(x, (url, init) => (isRefresh(url, init) ? J(200, { access_token: "AT2" }) : undefined));
    const r = await cloudRefresh(x.d, "cloud-notion");
    expect(r).toMatchObject({ tokens: { access_token: "AT2", refresh_token: "RT" } });
    expect(x.m.peekBox()!.services[0]).toMatchObject({ status: "ok", oauth: { tokens: { access_token: "AT2", refresh_token: "RT" } } });
  });
  it("网络抖 / 5xx 不是「登录失效」：不标 needs_login，箱子不动，回 null（M6）", async () => {
    for (const hook of [() => { throw new Error("reset"); }, () => J(503, {})]) {
      const x = deps();
      await loginNotion(x);
      const before = JSON.stringify(x.m.peekBox());
      wrapFetch(x, (url, init) => (isRefresh(url, init) ? hook() : undefined));
      expect(await cloudRefresh(x.d, "cloud-notion")).toBeNull();
      expect(JSON.stringify(x.m.peekBox())).toBe(before);
    }
  });
});

describe("重新登录（M4）", () => {
  it("needs_login 之后重新登录：状态回 ok，借给团队的授权保留", async () => {
    const x = deps();
    await loginNotion(x);
    await cloudGrant(x.d, UID, { serverId: "cloud-notion", workspaceId: TEAM, on: true });
    expect(await cloudRefresh(x.d, "cloud-notion")).toBeNull(); // 假上游：refresh 400 = dead
    expect(x.m.peekBox()!.services[0]!.status).toBe("needs_login");
    expect(await loginNotion(x)).toEqual({ ok: true, serverId: "cloud-notion" });
    const svc = x.m.peekBox()!.services[0]!;
    expect(svc.status).toBe("ok");
    expect(svc.grants.map((g) => g.workspaceId)).toEqual([HOME, TEAM]);
    expect(x.m.peekBox()!.services).toHaveLength(1);
  });
});

describe("外呼抛异常不许往外漏（I2）", () => {
  it("回调里 tools/list 那一发 fetch 自己抛 → 回 {ok:false}，pending 已消费", async () => {
    const x = deps();
    const r = await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("x");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    wrapFetch(x, (url) => { if (url === "https://mcp.notion.com/mcp") throw new Error("boom"); return undefined; });
    const done = await cloudCallback(x.d, UID, { state, code: "C", error: null });
    expect(done).toEqual({ ok: false, message: "登录成功，但读不到它的工具：boom" });
    expect(x.m.pending.size).toBe(0);
    expect(x.m.peekBox()).toBeNull();
  });
  it("token 接入时 fetch 自己抛 → 回 502，不抛", async () => {
    const x = deps();
    x.d.fetch = async () => { throw new Error("ENOTFOUND"); };
    expect(await cloudConnect(x.d, UID, { catalogId: "github", params: { github_token: "t" } })).toMatchObject({ ok: false, status: 502 });
  });
});

describe("cloudViewOf：补主场授权（M5）", () => {
  it("接入时没主场、后来只借给了团队：视图仍补上主场授权", async () => {
    const x = deps({ homeIdOf: async () => null });
    await cloudConnect(x.d, UID, { catalogId: "context7", params: {} });
    await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true });
    expect(x.m.peekBox()!.services[0]!.grants.map((g) => g.workspaceId)).toEqual([TEAM]);
    x.d.homeIdOf = async () => HOME;
    const v = await cloudViewOf(x.d, UID);
    expect(v[0]!.grants.slice().sort()).toEqual([HOME, TEAM].sort());
    expect(x.m.peekBox()!.services[0]!.grants.map((g) => g.workspaceId)).toEqual([TEAM, HOME]);
  });
  it("箱是空的不查库；该有的授权都在时不写库", async () => {
    let lookups = 0;
    const x = deps({ homeIdOf: async () => { lookups += 1; return HOME; } });
    expect(await cloudViewOf(x.d, UID)).toEqual([]);
    expect(lookups).toBe(0);
    await cloudConnect(x.d, UID, { catalogId: "context7", params: {} });
    const lookupsAfterConnect = lookups;
    let writes = 0;
    const put = x.m.store.putBox;
    x.m.store.putBox = async (b) => { writes += 1; await put(b); };
    await cloudViewOf(x.d, UID);
    expect(lookups).toBe(lookupsAfterConnect + 1);
    expect(writes).toBe(0);
  });
});

describe("话怎么说（M7）", () => {
  it("pending 封顶说「十分钟」，每分钟限速仍说「一分钟」", async () => {
    const { d } = deps();
    let n = 0;
    d.random = (len) => new Uint8Array(len).fill(++n % 250);
    for (let i = 0; i < 5; i += 1) await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    expect(CLOUD_TEXT.tooManyPending).toBe("有几次登录还没走完，过十分钟再试");
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, status: 429, message: CLOUD_TEXT.tooManyPending });
  });
  it("地址里有没代入的占位符 ≠ 不是 https", async () => {
    const { d } = deps();
    d.catalog = [...CATALOG, { id: "tenant", name: "Tenant", description: "", transport: "http", url: "https://{tenant}.example.com/mcp", params: [], auth: "none", authNote: "" }];
    const r = await cloudConnect(d, UID, { catalogId: "tenant", params: {} });
    expect(r).toMatchObject({ ok: false, status: 400, code: "missing_params", message: "还缺参数" });
    expect(await cloudConnect(d, UID, { catalogId: "plain", params: {} })).toMatchObject({ ok: false, status: 400, code: "bad_url", message: "这个应用的地址不是 https，不能在云端接" });
  });
  it("免登录应用被 401：不说「token 用不了」；token 应用才说", async () => {
    const { d, m } = deps();
    d.fetch = upstream(m.store, { token401: true }).f;
    const none = await cloudConnect(d, UID, { catalogId: "context7", params: {} });
    expect(none).toMatchObject({ ok: false });
    expect((none as { message: string }).message).not.toBe(CLOUD_TEXT.badToken);
    expect((none as { message: string }).message.startsWith("没接上：")).toBe(true);
    expect(await cloudConnect(d, UID, { catalogId: "github", params: { github_token: "bad" } })).toMatchObject({ ok: false, message: CLOUD_TEXT.badToken });
  });
});

describe("原文进日志（M8）", () => {
  it("发现失败 / 换 token 失败 / 登录后读工具失败，各留一行带厂商原话", async () => {
    const logs: string[] = [];
    // 发现失败：所有 .well-known 都 404
    const a = deps({ log: (m) => logs.push(m) });
    wrapFetch(a, (url) => (url.includes("/.well-known/") ? J(404, {}) : undefined));
    expect(await cloudConnect(a.d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, status: 502 });
    expect(logs.filter((l) => l.startsWith("[px-cloud]") && l.includes("cloud-notion") && l.includes("discovery")).length).toBe(1);

    // 换 token 失败
    logs.length = 0;
    const b = deps({ log: (m) => logs.push(m) });
    const rb = await cloudConnect(b.d, UID, { catalogId: "notion", params: {} });
    if (!rb.ok || rb.reply.kind !== "authorize") throw new Error("x");
    wrapFetch(b, (url, init) => (url === "https://auth.notion.com/t" && !isRefresh(url, init) ? J(400, { error_description: "code expired" }) : undefined));
    await cloudCallback(b.d, UID, { state: new URL(rb.reply.authorizeUrl).searchParams.get("state")!, code: "C", error: null });
    expect(logs.some((l) => l.startsWith("[px-cloud]") && l.includes("code expired"))).toBe(true);

    // 登录后读工具失败
    logs.length = 0;
    const c = deps({ log: (m) => logs.push(m) });
    const rc = await cloudConnect(c.d, UID, { catalogId: "notion", params: {} });
    if (!rc.ok || rc.reply.kind !== "authorize") throw new Error("x");
    wrapFetch(c, (url) => (url === "https://mcp.notion.com/mcp" ? new Response("", { status: 500 }) : undefined));
    await cloudCallback(c.d, UID, { state: new URL(rc.reply.authorizeUrl).searchParams.get("state")!, code: "C", error: null });
    expect(logs.some((l) => l.startsWith("[px-cloud]") && l.includes("initialize 失败（500）"))).toBe(true);
  });
});

describe("pending 满了不先去厂商注册（M9）", () => {
  it("第六次被拒时没有再打注册端点", async () => {
    const x = deps();
    let n = 0;
    x.d.random = (len) => new Uint8Array(len).fill(++n % 250);
    const regs = () => x.up.calls.filter((u) => u === "https://auth.notion.com/r").length;
    for (let i = 0; i < 5; i += 1) await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
    expect(regs()).toBe(5);
    expect(await cloudConnect(x.d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, status: 429 });
    expect(regs()).toBe(5);
  });
});

describe("cloudRefresh：没有 oauth 的应用被 401（Task 7 I1a）", () => {
  it("token / 免登录应用：标 needs_login 回 null，手机据此弹重新登录（粘新 token）", async () => {
    for (const [catalogId, params] of [["github", { github_token: "ghp_x" }], ["context7", {}]] as const) {
      const x = deps();
      await cloudConnect(x.d, UID, { catalogId, params });
      expect(x.m.peekBox()!.services[0]!.oauth).toBeUndefined();
      expect(await cloudRefresh(x.d, `cloud-${catalogId}`)).toBeNull();
      expect(x.m.peekBox()!.services[0]!.status).toBe("needs_login");
    }
  });
  it("这台已经不在箱里：不写、不建箱子", async () => {
    const x = deps();
    expect(await cloudRefresh(x.d, "cloud-github")).toBeNull();
    expect(x.m.peekBox()).toBeNull();
  });
  it("重新粘 token 之后回 ok", async () => {
    const x = deps();
    await cloudConnect(x.d, UID, { catalogId: "github", params: { github_token: "old" } });
    await cloudRefresh(x.d, "cloud-github");
    await cloudConnect(x.d, UID, { catalogId: "github", params: { github_token: "new" } });
    expect(x.m.peekBox()!.services[0]).toMatchObject({ status: "ok", headers: { Authorization: "Bearer new" } });
  });
});

describe("预置 OAuth 客户端（#1619）", () => {
  const PRESET = { client_id: "gcid.apps.example", client_secret: "GSECRET" };
  const withPreset = (p: typeof PRESET | null = PRESET) => deps({ presetClient: () => p });

  it("不调注册；授权 URL 用预置 client_id、目录的 scope 与额外参数", async () => {
    const { d, up } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    expect(r.ok).toBe(true);
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const u = new URL(r.reply.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.example/auth");
    expect(u.searchParams.get("client_id")).toBe("gcid.apps.example");
    expect(u.searchParams.get("scope")).toBe("g.read g.compose");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(up.calls.some((c) => c.includes("register"))).toBe(false);
  });

  it("没配凭据：503 preset_unconfigured，一发外呼都没有", async () => {
    const { d, up } = withPreset(null);
    expect(await cloudConnect(d, UID, { catalogId: "gmail", params: {} }))
      .toEqual({ ok: false, status: 503, code: "preset_unconfigured", message: presetUnconfiguredText("Gmail") });
    expect(presetUnconfiguredText("Gmail")).toBe("Gmail 还没开放，稍后再试");
    expect(up.calls).toEqual([]);
    const none = deps(); // deps 里根本没有 presetClient
    expect(await cloudConnect(none.d, UID, { catalogId: "gmail", params: {} })).toMatchObject({ status: 503 });
  });

  it("pending 与落箱里都没有 client_secret；换 token 时带上了（假上游不带 secret 就 401）", async () => {
    const { d, m } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    const p = m.pending.get(state)!;
    expect(p.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: true, serverId: "cloud-gmail" });
    const svc = m.peekBox()!.services[0]!;
    expect(svc.oauth!.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(JSON.stringify(m.peekBox())).not.toContain("GSECRET");
  });

  it("回调时凭据被撤了：不换 token，说还没开放", async () => {
    let p: typeof PRESET | null = PRESET;
    const { d, up } = deps({ presetClient: () => p });
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    p = null;
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: false, message: presetUnconfiguredText("Gmail") });
    expect(up.calls.some((c) => c === "https://oauth2.example/token")).toBe(false);
  });

  it("续期：带上现取的 secret；写回的箱里仍没有 secret，旧 refresh_token 保留", async () => {
    const { d, m } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    await cloudCallback(d, UID, { state, code: "C", error: null });
    const oauth = await cloudRefresh(d, "cloud-gmail");
    expect(oauth?.tokens).toMatchObject({ access_token: "AT2", refresh_token: "RT" });
    expect(oauth?.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(JSON.stringify(m.peekBox())).not.toContain("GSECRET");
    expect(m.peekBox()!.services[0]!.status).toBe("ok");
  });

  it("续期时凭据取不到 = transient：不外呼、不标 needs_login", async () => {
    let p: typeof PRESET | null = PRESET;
    const { d, m, up } = deps({ presetClient: () => p });
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    await cloudCallback(d, UID, { state, code: "C", error: null });
    p = null;
    const before = up.calls.length;
    expect(await cloudRefresh(d, "cloud-gmail")).toBeNull();
    expect(up.calls.length).toBe(before);
    expect(m.peekBox()!.services[0]!.status).toBe("ok");
  });
});
