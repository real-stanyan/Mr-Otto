import { describe, it, expect, vi } from "vitest";
import { fetchGrantedTools, buildPxTools, type PxCallDeps, type GrantedPxServer } from "../../services/runtime/src/pxTools.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const baseDeps = (fetchImpl: typeof fetch): PxCallDeps => ({
  edgeBase: "https://edge.example",
  runtimeSecret: "sek",
  fetchImpl,
});

describe("fetchGrantedTools", () => {
  it("按 host 逐个 GET /px/v1/grants?host=&fromUid=，带 x-runtime-secret 头，合并结果", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return json(200, { servers: [{ serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] }] });
    }) as typeof fetch;

    const out = await fetchGrantedTools(baseDeps(fetchImpl), "fromU", ["hostA", "hostB"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://edge.example/px/v1/grants?host=hostA&fromUid=fromU");
    expect(calls[0]!.headers["x-runtime-secret"]).toBe("sek");
    expect(calls[1]!.url).toBe("https://edge.example/px/v1/grants?host=hostB&fromUid=fromU");
    expect(out).toEqual([
      { hostUid: "hostA", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
      { hostUid: "hostB", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ]);
  });

  it("单 host 查询失败（网络/HTTP 错）跳过该 host，不炸掉整批", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) throw new Error("network down");
      if (n === 2) return json(500, { error: "boom" });
      return json(200, { servers: [{ serverId: "ok", toolDefs: [] }] });
    }) as typeof fetch;

    const out = await fetchGrantedTools(baseDeps(fetchImpl), "fromU", ["bad-net", "bad-http", "good"]);

    expect(out).toEqual([{ hostUid: "good", serverId: "ok", toolDefs: [] }]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("buildPxTools", () => {
  it("工具名 = px_<host前8位>_<serverId>_<toolName> 过 safe 化，requiresApproval=false", () => {
    const granted: GrantedPxServer[] = [
      { hostUid: "abcdefgh12345", serverId: "square store", toolDefs: [{ name: "list.products", description: "d", inputSchema: {} }] },
    ];
    const tools = buildPxTools(baseDeps(fetch), "fromU", granted);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.def.name).toBe("px_abcdefgh_square_store_list_products");
    expect(tools[0]!.requiresApproval).toBe(false);
  });

  it("撞名（两个不同 host/server 生成同一个安全名）：保留先到者，warn 带两边 hostUid/serverId/tool 名（复审 Minor）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const granted: GrantedPxServer[] = [
      { hostUid: "abcdefgh1111", serverId: "sq", toolDefs: [{ name: "t1", description: "first", inputSchema: {} }] },
      { hostUid: "abcdefgh2222", serverId: "sq", toolDefs: [{ name: "t1", description: "second", inputSchema: {} }] },
    ];

    const tools = buildPxTools(baseDeps(fetch), "fromU", granted);

    // 两个 host 的短前缀（slice(0,8)）恰好相同 → 生成同一个安全名，只保留先到者
    expect(tools).toHaveLength(1);
    expect(tools[0]!.def.description).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]!.join(" ");
    expect(msg).toContain("px_abcdefgh_sq_t1");
    expect(msg).toContain("abcdefgh1111");
    expect(msg).toContain("abcdefgh2222");
    expect(msg).toContain("sq");
    expect(msg).toContain("t1");
    warn.mockRestore();
  });

  it("run() 打 POST /px/v1/call，载荷形状 {fromUid,hostUid,serverId,tool,args}；content 数组压成文本", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return json(200, { result: { content: [{ type: "text", text: "a" }, { type: "json", data: 1 }] } });
    }) as typeof fetch;
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ];

    const tools = buildPxTools(baseDeps(fetchImpl), "fromU", granted);
    const output = await tools[0]!.run({ x: 1 }, fakeWorld);

    expect(calls[0]!.url).toBe("https://edge.example/px/v1/call");
    expect(JSON.parse(calls[0]!.body)).toEqual({ fromUid: "fromU", hostUid: "hostA1234", serverId: "sq", tool: "t1", args: { x: 1 } });
    expect(output).toBe('a\n{"type":"json","data":1}');
  });

  it("调用回 4xx → run 抛错（错误进 tool_result，不吞）", async () => {
    const fetchImpl = (async () => json(403, { error: "no_grant" })) as typeof fetch;
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ];
    const tools = buildPxTools(baseDeps(fetchImpl), "fromU", granted);

    await expect(tools[0]!.run({}, fakeWorld)).rejects.toThrow("no_grant");
  });
});
