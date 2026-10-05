import { describe, it, expect, vi } from "vitest";
import { fetchGrantedTools, buildPxTools, pxToolName, PX_TOOL_NAME_MAX, type PxCallDeps, type GrantedPxServer } from "../../services/runtime/src/pxTools.js";
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

  it("409 needs_login + onNeedsLogin 回字符串 → run 抛那句话；回调收到 {hostUid, serverId}（#1666）", async () => {
    const fetchImpl = (async () => json(409, { error: { message: "这个应用要在手机上重新登录", type: "otto_edge", code: "needs_login" } })) as typeof fetch;
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "cloud-supabase", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ];
    const seen: { hostUid: string; serverId: string }[] = [];
    const tools = buildPxTools(baseDeps(fetchImpl), "fromU", granted, { onNeedsLogin: (g) => { seen.push(g); return "X"; } });

    await expect(tools[0]!.run({}, fakeWorld)).rejects.toThrow("X");
    expect(seen).toEqual([{ hostUid: "hostA1234", serverId: "cloud-supabase" }]);
  });

  it("409 needs_login + onNeedsLogin 回 null → 抛原 message", async () => {
    const fetchImpl = (async () => json(409, { error: { message: "这个应用要在手机上重新登录", code: "needs_login" } })) as typeof fetch;
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ];
    const tools = buildPxTools(baseDeps(fetchImpl), "fromU", granted, { onNeedsLogin: () => null });

    await expect(tools[0]!.run({}, fakeWorld)).rejects.toThrow("这个应用要在手机上重新登录");
  });

  it("别的 code（403 forbidden）不调 onNeedsLogin，照旧抛原 message", async () => {
    const fetchImpl = (async () => json(403, { error: { message: "没授权", code: "forbidden" } })) as typeof fetch;
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }] },
    ];
    let called = 0;
    const tools = buildPxTools(baseDeps(fetchImpl), "fromU", granted, { onNeedsLogin: () => { called++; return "X"; } });

    await expect(tools[0]!.run({}, fakeWorld)).rejects.toThrow("没授权");
    expect(called).toBe(0);
  });

  it("第四参 requiresApproval:true ——接力棒上的这一刀要点火的人批一次（#957 B-C3）；缺省仍是 false", () => {
    const granted: GrantedPxServer[] = [
      { hostUid: "hostA1234", serverId: "sq", toolDefs: [{ name: "t1", description: "d", inputSchema: {} }, { name: "t2", description: "d", inputSchema: {} }] },
    ];
    const gated = buildPxTools(baseDeps(fetch), "fromU", granted, { requiresApproval: true });
    expect(gated).toHaveLength(2);
    expect(gated.every((t) => t.requiresApproval === true)).toBe(true);
    // 缺省（人自己 @ 起的那一轮）不变：白名单内没有逐次审批（ADR-0151）
    expect(buildPxTools(baseDeps(fetch), "fromU", granted).every((t) => t.requiresApproval === false)).toBe(true);
  });
});

describe("pxToolName", () => {
  it("短的原样（safe 化）", () => {
    expect(pxToolName("abcdef12-xxxx", "cloud-notion", "search")).toBe("px_abcdef12_cloud-notion_search");
  });
  it("超长截到 64 并带哈希尾，不同原名不撞", () => {
    const a = pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metrics");
    const b = pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metricz");
    expect(a.length).toBeLessThanOrEqual(PX_TOOL_NAME_MAX);
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metrics")).toBe(a);
  });
});

// spec §5：工具名被截短时要留一句 warn（原名 → 截后），否则模型那边看到的名字对不上厂商文档、线上无从查起。
// 每个截断名只说一次（buildPxTools 随授权缓存反复跑，每跑一遍说一遍就是刷屏）
describe("buildPxTools：截断的工具名 warn 一次（#1430 终审 M9）", () => {
  it("截了才说，原名与截后都在；同一个名字第二次构建不再说", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const long = "run_realtime_report_with_dimensions_and_metrics_m9_only";
    const granted: GrantedPxServer[] = [{
      hostUid: "abcdef12-m9", serverId: "cloud-google-analytics",
      toolDefs: [{ name: long, description: "", inputSchema: {} }, { name: "short", description: "", inputSchema: {} }],
    }];
    const tools = buildPxTools(baseDeps(fetch), "fromU", granted);
    const capped = tools[0]!.def.name;
    expect(capped.length).toBeLessThanOrEqual(PX_TOOL_NAME_MAX);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]!.join(" ");
    expect(msg).toContain(`px_abcdef12_cloud-google-analytics_${long}`);
    expect(msg).toContain(capped);
    buildPxTools(baseDeps(fetch), "fromU", granted);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
