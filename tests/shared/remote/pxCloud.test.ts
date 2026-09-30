// tests/shared/remote/pxCloud.test.ts
import { describe, expect, it } from "vitest";
import {
  CLOUD_ID_RESERVED_TEXT, CLOUD_TEXT, cloudIdReservedError, cloudNeedsLogin, cloudServerId, cloudView, connectDoneUrl, emptyCloudBox, ensureHomeGrant,
  isCloudServerId, markNeedsLogin, mergeEscrow, parseCloudBox, parseCloudError, parseCloudView, parseConnectDone,
  parseConnectReply, removeCloudService, setCloudGrant, toConnectDone, upsertCloudService, withCloudOAuth,
  type CloudBox,
} from "../../../src/shared/remote/pxCloud.js";
import type { EscrowDoc } from "../../../src/shared/remote/pxEscrow.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const tool = (name: string) => ({ name, description: "", inputSchema: {} });

function boxWithNotion(): CloudBox {
  return upsertCloudService(emptyCloudBox("u1", 1), {
    serverId: "cloud-notion", catalogId: "notion", url: "https://mcp.notion.com/mcp",
    oauth: { tokens: { access_token: "AT", refresh_token: "RT" }, clientInformation: { client_id: "c" }, tokenEndpoint: "https://api.notion.com/token" },
    toolDefs: [tool("search"), tool("create_page")],
  }, HOME, 2);
}

describe("serverId 前缀", () => {
  it("cloud- 前缀只认开头", () => {
    expect(cloudServerId("notion")).toBe("cloud-notion");
    expect(isCloudServerId("cloud-notion")).toBe(true);
    expect(isCloudServerId("notion-cloud-x")).toBe(false);
  });
});

describe("parseCloudBox", () => {
  it("往返", () => {
    const box = boxWithNotion();
    expect(parseCloudBox(JSON.parse(JSON.stringify(box)))).toEqual(box);
  });
  it("拒非 https、拒缺 tokenEndpoint 的 oauth、拒坏 workspaceId、拒坏 status", () => {
    const good = JSON.parse(JSON.stringify(boxWithNotion()));
    const bad = (mut: (b: any) => void) => { const b = JSON.parse(JSON.stringify(good)); mut(b); return parseCloudBox(b); };
    expect(bad((b) => { b.services[0].url = "http://x"; })).toBeNull();
    expect(bad((b) => { delete b.services[0].oauth.tokenEndpoint; })).toBeNull();
    expect(bad((b) => { b.services[0].grants[0].workspaceId = "x),or(1"; })).toBeNull();
    expect(bad((b) => { b.services[0].status = "weird"; })).toBeNull();
    expect(bad((b) => { b.services[0].serverId = "notion"; })).toBeNull(); // 必须带 cloud- 前缀
    expect(bad((b) => { b.v = 2; })).toBeNull();
  });
  it("oauth.resource 可选（没有这一格的旧箱照样有效）；有就得是 https 字符串（#1430 终审 M7）", () => {
    const good = JSON.parse(JSON.stringify(boxWithNotion()));
    expect(good.services[0].oauth.resource).toBeUndefined();
    expect(parseCloudBox(good)).not.toBeNull();
    const withRes = JSON.parse(JSON.stringify(good));
    withRes.services[0].oauth.resource = "https://mcp.notion.com/";
    expect(parseCloudBox(withRes)?.services[0]?.oauth?.resource).toBe("https://mcp.notion.com/");
    withRes.services[0].oauth.resource = "http://mcp.notion.com/";
    expect(parseCloudBox(withRes)).toBeNull();
    withRes.services[0].oauth.resource = 7;
    expect(parseCloudBox(withRes)).toBeNull();
  });
});

describe("保留前缀闸（#1430 终审 I-2）", () => {
  it("cloud- 开头（去掉首尾空白后）回那句话，别的回 null", () => {
    expect(cloudIdReservedError(" cloud-x")).toBe(CLOUD_ID_RESERVED_TEXT);
    expect(cloudIdReservedError("cloudflare")).toBeNull();
    expect([...CLOUD_ID_RESERVED_TEXT].some((c) => c === ",")).toBe(false); // 中文里的逗号是全角
  });
});

describe("箱操作", () => {
  it("新接入默认带主场授权；没主场就不带", () => {
    expect(boxWithNotion().services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    const noHome = upsertCloudService(emptyCloudBox("u1", 1), {
      serverId: "cloud-x", catalogId: "x", url: "https://x.example", toolDefs: [],
    }, null, 2);
    expect(noHome.services[0]!.grants).toEqual([]);
  });
  it("重新登录覆盖凭据与工具清单、保留授权、状态回 ok", () => {
    let box = setCloudGrant(boxWithNotion(), "cloud-notion", TEAM, true, 3)!;
    box = markNeedsLogin(box, "cloud-notion", 4);
    box = upsertCloudService(box, {
      serverId: "cloud-notion", catalogId: "notion", url: "https://mcp.notion.com/mcp",
      oauth: { tokens: { access_token: "AT2" }, tokenEndpoint: "https://api.notion.com/token" },
      toolDefs: [tool("search")],
    }, HOME, 5);
    const s = box.services[0]!;
    expect(s.status).toBe("ok");
    expect(s.toolDefs.map((t) => t.name)).toEqual(["search"]);
    expect(s.grants.map((g) => g.workspaceId).sort()).toEqual([HOME, TEAM].sort());
    expect(s.connectedTs).toBe(5);
  });
  it("授权开关幂等；没有这台回 null", () => {
    const on = setCloudGrant(boxWithNotion(), "cloud-notion", TEAM, true, 3)!;
    expect(setCloudGrant(on, "cloud-notion", TEAM, true, 4)!.services[0]!.grants).toHaveLength(2);
    const off = setCloudGrant(on, "cloud-notion", TEAM, false, 5)!;
    expect(off.services[0]!.grants.map((g) => g.workspaceId)).toEqual([HOME]);
    expect(setCloudGrant(on, "cloud-nope", TEAM, true, 6)).toBeNull();
  });
  it("ensureHomeGrant 只补没有主场授权的那几台", () => {
    const noHome = upsertCloudService(emptyCloudBox("u1", 1), {
      serverId: "cloud-x", catalogId: "x", url: "https://x.example", toolDefs: [],
    }, null, 2);
    const fixed = ensureHomeGrant(noHome, HOME, 3);
    expect(fixed.services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    expect(ensureHomeGrant(fixed, HOME, 4)).toBe(fixed); // 没变就原样返回（调用方据此不写库）
  });
  it("续期写回 oauth；删除", () => {
    const box = withCloudOAuth(boxWithNotion(), "cloud-notion", { tokens: { access_token: "NEW" }, tokenEndpoint: "https://t" }, 9);
    expect(box.services[0]!.oauth!.tokens).toEqual({ access_token: "NEW" });
    expect(removeCloudService(box, "cloud-notion", 10).services).toEqual([]);
  });
});

describe("mergeEscrow", () => {
  const sealed: EscrowDoc = {
    v: 1, hostUid: "u1", updatedTs: 1,
    services: [{ serverId: "linear", url: "https://mcp.linear.app/mcp", toolDefs: [tool("list")] }],
    grants: [{ workspaceId: HOME, allow: [{ serverId: "linear", tools: [] }] }],
  };
  it("两边摊平成一份；cloud 的授权变成 EscrowGrant", () => {
    const m = mergeEscrow(sealed, boxWithNotion())!;
    expect(m.services.map((s) => s.serverId)).toEqual(["linear", "cloud-notion"]);
    expect(m.grants).toContainEqual({ workspaceId: HOME, allow: [{ serverId: "cloud-notion", tools: [] }] });
    expect(m.grants).toContainEqual(sealed.grants[0]);
  });
  it("needs_login 的不进 services 也不进 grants", () => {
    const m = mergeEscrow(null, markNeedsLogin(boxWithNotion(), "cloud-notion", 3));
    expect(m!.services).toEqual([]);
    expect(m!.grants).toEqual([]);
    expect(cloudNeedsLogin(markNeedsLogin(boxWithNotion(), "cloud-notion", 3), "cloud-notion")).toBe(true);
  });
  it("两边都没有 = null；只有 sealed 原样", () => {
    expect(mergeEscrow(null, null)).toBeNull();
    expect(mergeEscrow(sealed, null)).toEqual(sealed);
  });
});

describe("无凭据视图", () => {
  it("不漏 url / headers / token", () => {
    const view = cloudView(boxWithNotion());
    expect(JSON.stringify(view)).not.toMatch(/AT|RT|notion\.com|client_id/);
    expect(view).toEqual([{ serverId: "cloud-notion", catalogId: "notion", status: "ok", tools: ["search", "create_page"], grants: [HOME], connectedTs: 2 }]);
    expect(parseCloudView({ apps: view })).toEqual(view);
    expect(parseCloudView({ apps: [{ serverId: 1 }] })).toBeNull();
  });
});

describe("线上回包与深链", () => {
  it("connect 回包两种", () => {
    expect(parseConnectReply({ kind: "authorize", authorizeUrl: "https://a" })).toEqual({ kind: "authorize", authorizeUrl: "https://a" });
    expect(parseConnectReply({ kind: "connected", serverId: "cloud-x" })).toEqual({ kind: "connected", serverId: "cloud-x" });
    expect(parseConnectReply({ kind: "authorize" })).toBeNull();
  });
  it("深链往返（中文原话能回来）", () => {
    expect(parseConnectDone(connectDoneUrl({ ok: true, serverId: "cloud-notion" }))).toEqual({ ok: true, serverId: "cloud-notion" });
    expect(parseConnectDone(connectDoneUrl({ ok: false, message: CLOUD_TEXT.stateExpired }))).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    expect(parseConnectDone("mrotto://connector-done")).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
  });
  it("toConnectDone 归一化 DO 的回包", () => {
    expect(toConnectDone({ ok: true, serverId: "cloud-x" })).toEqual({ ok: true, serverId: "cloud-x" });
    expect(toConnectDone({ ok: false, message: "坏" })).toEqual({ ok: false, message: "坏" });
    expect(toConnectDone({ ok: true })).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
    expect(toConnectDone(null)).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
  });
  it("错误回包：认 otto_edge 形状，其余 null", () => {
    expect(parseCloudError(400, { error: { message: "坏", type: "otto_edge", code: "x" } })).toBe("坏");
    expect(parseCloudError(200, { error: { message: "坏", type: "otto_edge" } })).toBeNull();
    expect(parseCloudError(500, "oops")).toBeNull();
  });
});

describe("CLOUD_TEXT.refreshFailed（Task 7 I1b）", () => {
  it("原样的一句话，逗号是全角 U+FF0C", () => {
    expect(CLOUD_TEXT.refreshFailed).toBe("这个应用暂时连不上，稍后再试");
  });
});
