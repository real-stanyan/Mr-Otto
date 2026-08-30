import { describe, expect, it } from "vitest";
import {
  buildEscrowDoc, escrowDigest, parseEscrowDoc, type EscrowSources,
} from "../../../src/shared/remote/pxEscrow.js";

const srcWithOneLiveHttpsServer: EscrowSources = {
  hostUid: "a-uid",
  grants: [],
  workspaceGrants: [],
  servers: [{ id: "srv", live: true, tools: [] }],
  configOf: () => ({ kind: "http", url: "https://x.example/mcp" }),
  authOf: () => ({}),
  now: 1000,
};

// 托管文档的构造（A 侧）与结构门（edge 侧）共用一份（issue #797）。
// 这里钉死的核心：**构造出来的东西必须过得了 edge 的门**——两边各写各的时，
// 一台本地 http server 就能让整箱 PUT 恒 400。

const TOOLS = [{ name: "pay", description: "付款", inputSchema: { type: "object" } }];

function sources(over: Partial<EscrowSources> = {}): EscrowSources {
  return {
    hostUid: "a-uid",
    grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] }],
    workspaceGrants: [],
    servers: [{ id: "square", live: true, tools: TOOLS }],
    configOf: () => ({ kind: "http", url: "https://mcp.squareup.com/mcp", headers: {} }),
    authOf: () => ({ tokens: { access_token: "tok" } }),
    now: 1000,
    ...over,
  };
}

describe("buildEscrowDoc（issue #797 / ADR-0197）", () => {
  it("零授权 = null（调用方该 DELETE 而不是 PUT 空箱）", () => {
    expect(buildEscrowDoc(sources({ grants: [] }))).toBeNull();
  });

  it("整箱带上 url / 凭据 / 工具表快照，且过得了 edge 的结构门", () => {
    const doc = buildEscrowDoc(sources());
    expect(doc).not.toBeNull();
    expect(doc!.services).toEqual([{
      serverId: "square",
      url: "https://mcp.squareup.com/mcp",
      oauth: { tokens: { access_token: "tok" } },
      toolDefs: TOOLS,
    }]);
    expect(doc!.grants).toEqual([{ friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] }]);
    // 关键闭环：构造方的产物必须被解析方原样认下
    expect(parseEscrowDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("stdio / 非 https / 没 live 的服务不进箱——授权条目保留，箱子照样合法", () => {
    const doc = buildEscrowDoc(sources({
      grants: [{
        friendUid: "b-uid",
        allow: [
          { serverId: "square", tools: [] },
          { serverId: "local-fs", tools: [] },   // stdio
          { serverId: "dev-http", tools: [] },   // http://localhost，毒不死全箱
          { serverId: "sleeping", tools: [] },   // http 但没 live
        ],
      }],
      servers: [
        { id: "square", live: true, tools: TOOLS },
        { id: "local-fs", live: true, tools: TOOLS },
        { id: "dev-http", live: true, tools: TOOLS },
        { id: "sleeping", live: false, tools: TOOLS },
      ],
      configOf: (id) =>
        id === "square" ? { kind: "http", url: "https://mcp.squareup.com/mcp" }
        : id === "local-fs" ? { kind: "stdio" }
        : id === "dev-http" ? { kind: "http", url: "http://localhost:3999/mcp" }
        : { kind: "http", url: "https://sleeping.example/mcp" },
    }));
    expect(doc!.services.map((s) => s.serverId)).toEqual(["square"]);
    expect(doc!.grants[0]!.allow).toHaveLength(4); // 白名单原样——过滤在边缘侧消化
    expect(parseEscrowDoc(JSON.parse(JSON.stringify(doc)))).not.toBeNull();
  });

  it("headers 有内容才带；没授权过 OAuth 的服务不带 oauth", () => {
    const doc = buildEscrowDoc(sources({
      configOf: () => ({ kind: "http", url: "https://x.example/mcp", headers: { authorization: "Bearer k" } }),
      authOf: () => ({}),
    }));
    expect(doc!.services[0]).toEqual({
      serverId: "square",
      url: "https://x.example/mcp",
      headers: { authorization: "Bearer k" },
      toolDefs: TOOLS,
    });
  });
});

describe("EscrowGrant workspaceId 变体（ADR-0198 切片 1）", () => {
  it("parseEscrowDoc 认 workspaceId 变体，两个键都有/都没有的拒", () => {
    const base = { v: 1, hostUid: "h", services: [], updatedTs: 1 };
    // 合法 workspaceId 走 UUID 形状（见下面单独一条测试）——这里只钉「变体判据」本身
    expect(parseEscrowDoc({ ...base, grants: [{ workspaceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", allow: [] }] })).not.toBeNull();
    expect(parseEscrowDoc({ ...base, grants: [{ allow: [] }] })).toBeNull();
    expect(parseEscrowDoc({ ...base, grants: [{ friendUid: "f", workspaceId: "w", allow: [] }] })).toBeNull();
  });
  it("buildEscrowDoc 把 workspaceGrants 并进箱（服务准入三条不变）", () => {
    const doc = buildEscrowDoc({ ...srcWithOneLiveHttpsServer, grants: [], workspaceGrants: [{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }] });
    expect(doc?.services.map((s) => s.serverId)).toEqual(["srv"]);
    expect(doc?.grants).toEqual([{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }]);
  });
  it("buildEscrowDoc 两组授权都空才回 null", () => {
    expect(buildEscrowDoc({ ...srcWithOneLiveHttpsServer, grants: [], workspaceGrants: [] })).toBeNull();
  });

  const VALID_WS_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("workspaceId 必须是 UUID 形状——不是就拒整份文档（PostgREST in.() 拼接的注入面）", () => {
    const base = { v: 1, hostUid: "h", services: [], updatedTs: 1 };
    // 括号/逗号能在 membershipQuery 的 in.(...) 里拼出多余的逻辑分支——workspaceId
    // 来自 A 上传的 EscrowDoc（攻击者可影响），不能只靠 encodeURIComponent（它不转义括号）
    expect(parseEscrowDoc({ ...base, grants: [{ workspaceId: "w1)and(evil", allow: [] }] })).toBeNull();
    expect(parseEscrowDoc({ ...base, grants: [{ workspaceId: "not-a-uuid", allow: [] }] })).toBeNull();
    expect(parseEscrowDoc({ ...base, grants: [{ workspaceId: VALID_WS_ID, allow: [] }] })).not.toBeNull();
  });

  it("parseEscrowDoc 归一化：合法一侧之外的假值兄弟键被剥掉", () => {
    // isFriendGrant 按值判据，不是按键判据——但两边各写各的时，「键在但值是空字符串」
    // 这种半吊子形状不该活着流到下游；parseEscrowDoc 索性把它剥掉，归一化只留合法那一侧
    const base = { v: 1, hostUid: "h", services: [], updatedTs: 1 };
    const doc = parseEscrowDoc({ ...base, grants: [{ friendUid: "", workspaceId: VALID_WS_ID, allow: [] }] });
    expect(doc?.grants[0]).toEqual({ workspaceId: VALID_WS_ID, allow: [] });
    expect(doc?.grants[0]).not.toHaveProperty("friendUid");
  });
});

describe("escrowDigest", () => {
  it("只看内容不看 updatedTs；null = 'absent'", () => {
    const d1 = buildEscrowDoc(sources({ now: 1 }));
    const d2 = buildEscrowDoc(sources({ now: 2 }));
    expect(escrowDigest(d1)).toBe(escrowDigest(d2));
    expect(escrowDigest(null)).toBe("absent");
    const d3 = buildEscrowDoc(sources({ authOf: () => ({ tokens: { access_token: "renewed" } }), now: 3 }));
    expect(escrowDigest(d3)).not.toBe(escrowDigest(d1)); // token 刷新 = 内容变了 = 该重传
  });
});
