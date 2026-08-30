import { describe, expect, it } from "vitest";
import {
  buildEscrowDoc, escrowDigest, parseEscrowDoc, type EscrowSources,
} from "../../../src/shared/remote/pxEscrow.js";

// 托管文档的构造（A 侧）与结构门（edge 侧）共用一份（issue #797）。
// 这里钉死的核心：**构造出来的东西必须过得了 edge 的门**——两边各写各的时，
// 一台本地 http server 就能让整箱 PUT 恒 400。

const TOOLS = [{ name: "pay", description: "付款", inputSchema: { type: "object" } }];

function sources(over: Partial<EscrowSources> = {}): EscrowSources {
  return {
    hostUid: "a-uid",
    grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] }],
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
