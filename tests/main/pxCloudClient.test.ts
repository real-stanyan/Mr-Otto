import { describe, expect, it } from "vitest";
import { createPxCloudClient } from "../../src/main/pxCloudClient.js";

// B 侧打云端执行面的客户端（issue #798）。钉三件事：
// grants 的「查询失败 ≠ 授权清空」（回 null 不回 []）、call 的形状转换
// 与 mcpClient 同一份（原始 MCP content → McpContent）、错误话术透传 edge 的人话。

function client(handler: (url: string, init: RequestInit) => Promise<Response>, token: string | null = "jwt") {
  return createPxCloudClient({
    baseUrl: () => "https://edge.test",
    accessToken: async () => token,
    fetchImpl: handler as unknown as typeof fetch,
    timeoutMs: 5_000,
  });
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pxCloudClient.fetchGrants", () => {
  it("拿到清单：结构过门，host 参数带上", async () => {
    let seenUrl = "";
    const c = client(async (url) => {
      seenUrl = url;
      return json(200, { servers: [{ serverId: "square", toolDefs: [{ name: "pay", description: "", inputSchema: {} }] }] });
    });
    const r = await c.fetchGrants("a-uid");
    expect(seenUrl).toBe("https://edge.test/px/v1/grants?host=a-uid");
    expect(r).toEqual([{ serverId: "square", toolDefs: [{ name: "pay", description: "", inputSchema: {} }] }]);
  });

  it("网络失败 / HTTP 错 / 没登录：都回 null——查询失败不冒充「授权清空」", async () => {
    expect(await client(async () => { throw new Error("offline"); }).fetchGrants("a")).toBeNull();
    expect(await client(async () => json(403, { error: { message: "不是好友" } })).fetchGrants("a")).toBeNull();
    expect(await client(async () => json(200, { servers: [] }), null).fetchGrants("a")).toBeNull();
  });
});

describe("pxCloudClient.call", () => {
  it("成功：POST 形状对，原始 MCP content 落回 McpContent[]", async () => {
    let seenBody: unknown;
    const c = client(async (_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return json(200, { result: { content: [{ type: "text", text: "42 单" }] } });
    });
    const out = await c.call("a-uid", "square", "get_orders", { limit: 5 });
    expect(seenBody).toEqual({ hostUid: "a-uid", serverId: "square", tool: "get_orders", args: { limit: 5 } });
    expect(out).toEqual([{ kind: "text", text: "42 单" }]);
  });

  it("被拒：抛的是 edge 那句人话（含「让对方上线重新授权」这类修法）", async () => {
    const c = client(async () => json(502, { error: { message: "托管凭据已失效——让对方上线重新授权一次", code: "upstream_auth" } }));
    await expect(c.call("a", "square", "t", {})).rejects.toThrow("让对方上线重新授权");
  });

  it("信封不是错误形状时给兜底话术；没登录直接抛", async () => {
    const c = client(async () => new Response("gateway timeout", { status: 504 }));
    await expect(c.call("a", "s", "t", {})).rejects.toThrow("HTTP 504");
    await expect(client(async () => json(200, {}), null).call("a", "s", "t", {})).rejects.toThrow("先登录");
  });

  it("调用方取消：立刻收尾，话术说「被取消」而不是网络失败", async () => {
    const ctl = new AbortController();
    const c = client((_url, init) =>
      new Promise((_res, rej) => {
        const fail = (): void => rej(new DOMException("aborted", "AbortError"));
        // abort 可能发生在 accessToken 的 await 期间——fetch 起跑时 signal 已经是熄的
        if (init.signal?.aborted) return fail();
        init.signal?.addEventListener("abort", fail);
      })
    );
    const p = c.call("a", "square", "slow", {}, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow("被取消");
  });
});
