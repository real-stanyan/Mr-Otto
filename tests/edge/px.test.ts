import { describe, expect, it } from "vitest";
import {
  appendAudit, friendshipQuery, grantedView, membershipQuery, openEscrow, parseEscrowDoc,
  parseFriendshipRows, parseMembershipRows, pxGate, pxMcpCall, pxRefreshTokens, sealEscrow,
  workspaceIdsOf,
  PX_AUDIT_CAP, type AllowEntry, type EscrowDoc, type PxRelations,
} from "../../services/edge/src/px.js";

// 云端执行面的纯逻辑（ADR-0197，issue #796；关系闸群组化 ADR-0198 切片 1）。
// 钉五件事：闸序与口径（好友 + 工作区两支）、托管文档的结构门、密封往返、
// 迷你 MCP 客户端的两种响应形态、在籍查询的拼串与解析。

/** rel(friendAccepted, ...workspaceIds) —— 机械替换旧布尔参数用的小工厂 */
const rel = (f: boolean, ...ws: string[]): PxRelations => ({ friendAccepted: f, workspaceOk: new Set(ws) });

const doc: EscrowDoc = {
  v: 1,
  hostUid: "a-uid",
  services: [{
    serverId: "square",
    url: "https://mcp.example.com/mcp",
    oauth: { tokens: { access_token: "tok-1", refresh_token: "ref-1" }, clientInformation: { client_id: "cid" } },
    toolDefs: [
      { name: "make_api_request", description: "d1", inputSchema: {} },
      { name: "get_service_info", description: "d2", inputSchema: {} },
    ],
  }],
  grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] }],
  updatedTs: 1,
};

describe("pxGate（三道闸的后两道，口径同 proxyProtocol）", () => {
  it("好友 + 整服务放行：过", () => {
    const r = pxGate(doc, { fromUid: "b-uid", serverId: "square", tool: "make_api_request" }, rel(true));
    expect(r.ok).toBe(true);
  });

  it("关系闸最先：不是好友，连「有没有托管」都不该知道", () => {
    const r = pxGate(doc, { fromUid: "b-uid", serverId: "square", tool: "make_api_request" }, rel(false));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_friends");
  });

  it("点名工具的白名单：名单外的刀被拒", () => {
    const narrow: EscrowDoc = {
      ...doc,
      grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: ["get_service_info"] }] }],
    };
    expect(pxGate(narrow, { fromUid: "b-uid", serverId: "square", tool: "get_service_info" }, rel(true)).ok).toBe(true);
    const denied = pxGate(narrow, { fromUid: "b-uid", serverId: "square", tool: "make_api_request" }, rel(true));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("tool_not_granted");
  });

  it("没托管 / 没授权 / 服务缺席：各说各的话", () => {
    expect((pxGate(null, { fromUid: "b-uid", serverId: "square", tool: "t" }, rel(true)) as { code: string }).code).toBe("no_escrow");
    expect((pxGate(doc, { fromUid: "c-uid", serverId: "square", tool: "t" }, rel(true)) as { code: string }).code).toBe("no_grant");
    expect((pxGate(doc, { fromUid: "b-uid", serverId: "shopify", tool: "t" }, rel(true)) as { code: string }).code).toBe("server_not_granted");
  });
});

describe("parseEscrowDoc（线上来的结构门）", () => {
  it("合法文档原样回", () => {
    expect(parseEscrowDoc(JSON.parse(JSON.stringify(doc)))).not.toBeNull();
  });
  it("非 https 的服务 url 拒绝——执行面不给明文端点当跳板", () => {
    const bad = JSON.parse(JSON.stringify(doc)) as EscrowDoc;
    (bad.services[0] as { url: string }).url = "http://mcp.example.com";
    expect(parseEscrowDoc(bad)).toBeNull();
  });
  it("垃圾进来回 null 不抛", () => {
    for (const junk of [null, 1, "x", [], { v: 2 }, { v: 1, hostUid: "" }]) {
      expect(parseEscrowDoc(junk)).toBeNull();
    }
  });
});

describe("密封往返（AES-GCM）", () => {
  const key = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  it("seal → open 得回原文档", async () => {
    const back = await openEscrow(key, await sealEscrow(key, doc));
    expect(back?.services[0]?.serverId).toBe("square");
  });
  it("换了 key 解不开：回 null 不抛（换 key = 全部重传）", async () => {
    const other = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
    expect(await openEscrow(other, await sealEscrow(key, doc))).toBeNull();
  });
});

describe("grantedView（B 视角，凭据永不出箱）", () => {
  it("只回 toolDefs，绝无 oauth/url", () => {
    const v = grantedView(doc, "b-uid", rel(true));
    expect(v.servers).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain("tok-1");
    expect(JSON.stringify(v)).not.toContain("https://mcp.example.com");
  });
  it("点名工具时 toolDefs 跟着过滤", () => {
    const narrow: EscrowDoc = {
      ...doc,
      grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: ["get_service_info"] }] }],
    };
    expect(grantedView(narrow, "b-uid", rel(true)).servers[0]?.toolDefs.map((t) => t.name)).toEqual(["get_service_info"]);
  });
});

describe("审计环形上限", () => {
  it("超过 CAP 掐头", () => {
    let list = [] as ReturnType<typeof appendAudit>;
    for (let i = 0; i < PX_AUDIT_CAP + 10; i++) {
      list = appendAudit(list, { ts: i, fromUid: "b", serverId: "s", tool: "t", outcome: "ok" });
    }
    expect(list).toHaveLength(PX_AUDIT_CAP);
    expect(list[0]?.ts).toBe(10);
  });
});

describe("pxMcpCall（迷你 Streamable HTTP 客户端）", () => {
  const svc = doc.services[0]!;
  const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

  it("initialize → initialized → tools/call，带 session 头与 Bearer", async () => {
    const seen: { url: string; body: unknown; auth: string | null; session: string | null }[] = [];
    const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { method?: string; id?: number };
      const h = new Headers(init.headers);
      seen.push({ url, body, auth: h.get("authorization"), session: h.get("mcp-session-id") });
      if (body.method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "sess-9" });
      if (body.method === "tools/call") return jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hi" }] } });
      return jsonRes({});
    };
    const r = await pxMcpCall(fetchLike, svc, "make_api_request", { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.content)).toContain("hi");
    expect(seen[0]?.auth).toBe("Bearer tok-1");
    // tools/call 那一跳带上了 initialize 换来的 session id
    expect(seen[2]?.session).toBe("sess-9");
  });

  it("SSE 形态的响应也解得出来", async () => {
    const sse = (id: number, result: unknown) =>
      new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    const fetchLike = async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { method?: string };
      if (body.method === "initialize") return sse(1, {});
      if (body.method === "tools/call") return sse(2, { content: [{ type: "text", text: "from-sse" }] });
      return jsonRes({});
    };
    const r = await pxMcpCall(fetchLike, svc, "t", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.content)).toContain("from-sse");
  });

  it("上游 401 上报 upstream_auth——刷新与重试是 worker 层的事", async () => {
    const fetchLike = async (): Promise<Response> => new Response("", { status: 401 });
    const r = await pxMcpCall(fetchLike, svc, "t", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("upstream_auth");
  });
});

describe("pxRefreshTokens（RFC8414 兜底自刷）", () => {
  const svc = doc.services[0]!;
  it("discovery → token_endpoint → 新 tokens 合并（新 refresh_token 覆盖旧的）", async () => {
    const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify({ token_endpoint: "https://auth.example.com/token" }), { status: 200 });
      }
      expect(url).toBe("https://auth.example.com/token");
      expect(String(init.body)).toContain("grant_type=refresh_token");
      return new Response(JSON.stringify({ access_token: "tok-2", refresh_token: "ref-2" }), { status: 200 });
    };
    const oauth = await pxRefreshTokens(fetchLike, svc);
    expect((oauth?.tokens as { access_token?: string })?.access_token).toBe("tok-2");
    expect((oauth?.tokens as { refresh_token?: string })?.refresh_token).toBe("ref-2");
  });
  it("没有 refresh_token / discovery 失败：回 null 不抛", async () => {
    expect(await pxRefreshTokens(async () => new Response("", { status: 404 }), svc)).toBeNull();
    expect(await pxRefreshTokens(async () => new Response("{}", { status: 200 }), { ...svc, oauth: {} })).toBeNull();
  });
});

describe("关系闸查询", () => {
  it("查询串两个方向都问、只认 accepted", () => {
    const q = friendshipQuery("a", "b");
    expect(q).toContain("status=eq.accepted");
    expect(q).toContain("requester.eq.a,addressee.eq.b");
    expect(q).toContain("requester.eq.b,addressee.eq.a");
  });
  it("形状认不出一律 false（失败关闭）", () => {
    expect(parseFriendshipRows([{ status: "accepted" }])).toBe(true);
    for (const junk of [[], null, {}, "x"]) expect(parseFriendshipRows(junk)).toBe(false);
  });
});

describe("pxGate / grantedView 群组化——workspace grant（ADR-0198 切片 1）", () => {
  const wsDoc: EscrowDoc = {
    v: 1, hostUid: "host", updatedTs: 1,
    services: [{ serverId: "srv", url: "https://x", toolDefs: [{ name: "t1", description: "", inputSchema: {} }] }],
    grants: [{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }],
  };

  it("workspace grant：在籍放行", () => {
    expect(pxGate(wsDoc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false, "w1")).ok).toBe(true);
  });
  it("workspace grant：不在籍拒 not_member（非好友身份不影响）", () => {
    const r = pxGate(wsDoc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false));
    expect(r).toMatchObject({ ok: false, code: "not_member" });
  });
  it("friend 与 workspace 并存：任一放行即过", () => {
    const both = { ...wsDoc, grants: [...wsDoc.grants, { friendUid: "b", allow: [] as AllowEntry[] }] };
    expect(pxGate(both, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(true)).ok).toBe(false); // friend 空 allow，ws 不在籍
    expect(pxGate(both, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false, "w1")).ok).toBe(true);
  });
  it("纯 friend 路老语义不变：非好友拒 not_friends", () => {
    const fdoc = { ...wsDoc, grants: [{ friendUid: "b", allow: [{ serverId: "srv", tools: [] }] }] };
    expect(pxGate(fdoc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false))).toMatchObject({ ok: false, code: "not_friends" });
  });
  it("grantedView：workspace 来的条目带 workspaceId，friend 来的不带；同服务两路都给时 friend 赢", () => {
    const v = grantedView(wsDoc, "b", rel(false, "w1"));
    expect(v.servers).toEqual([{ serverId: "srv", toolDefs: wsDoc.services[0]!.toolDefs, workspaceId: "w1" }]);
  });
  it("同服务两路都给：friend 与 workspace 并存时不带 workspaceId（friend 赢）", () => {
    const both = { ...wsDoc, grants: [...wsDoc.grants, { friendUid: "b", allow: [{ serverId: "srv", tools: [] }] }] };
    const v = grantedView(both, "b", rel(true, "w1"));
    expect(v.servers).toEqual([{ serverId: "srv", toolDefs: wsDoc.services[0]!.toolDefs }]);
  });
  it("同服务被两条 workspace grant 各点名不同工具：并集放行（互不排斥）", () => {
    const twoWs: EscrowDoc = {
      ...wsDoc,
      services: [{
        serverId: "srv",
        url: "https://x",
        toolDefs: [
          { name: "t1", description: "", inputSchema: {} },
          { name: "t2", description: "", inputSchema: {} },
        ],
      }],
      grants: [
        { workspaceId: "w1", allow: [{ serverId: "srv", tools: ["t1"] }] },
        { workspaceId: "w2", allow: [{ serverId: "srv", tools: ["t2"] }] },
      ],
    };
    expect(pxGate(twoWs, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false, "w1")).ok).toBe(true);
    expect(pxGate(twoWs, { fromUid: "b", serverId: "srv", tool: "t2" }, rel(false, "w1")).ok).toBe(false); // 只在 w1 籍，t2 是 w2 授的
    const v = grantedView(twoWs, "b", rel(false, "w1", "w2"));
    expect(v.servers[0]?.toolDefs.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
  });
  it("workspaceIdsOf：去重文档里出现过的 workspaceId", () => {
    const twoWs: EscrowDoc = {
      ...wsDoc,
      grants: [
        { workspaceId: "w1", allow: [] },
        { workspaceId: "w1", allow: [] },
        { workspaceId: "w2", allow: [] },
        { friendUid: "b", allow: [] },
      ],
    };
    expect(workspaceIdsOf(twoWs).sort()).toEqual(["w1", "w2"]);
    expect(workspaceIdsOf(null)).toEqual([]);
  });
});

describe("membershipQuery / parseMembershipRows（在籍查询，Task 5 接线）", () => {
  it("双方都在的 workspace 才算", () => {
    const rows = [{ workspace_id: "w1", uid: "a" }, { workspace_id: "w1", uid: "b" }, { workspace_id: "w2", uid: "a" }];
    expect(parseMembershipRows(rows, "a", "b")).toEqual(new Set(["w1"]));
    expect(parseMembershipRows("garbage", "a", "b")).toEqual(new Set()); // 失败关闭
    expect(membershipQuery(["w1"], "a", "b")).toContain("workspace_members");
  });
  it("垃圾行混在合法行里：跳过垃圾行，合法行照算", () => {
    const rows = [{ workspace_id: "w1", uid: "a" }, "junk", { workspace_id: "w1" }, { workspace_id: "w1", uid: "b" }];
    expect(parseMembershipRows(rows, "a", "b")).toEqual(new Set(["w1"]));
  });
});
