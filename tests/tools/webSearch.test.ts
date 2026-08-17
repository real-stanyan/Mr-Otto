import { describe, it, expect } from "vitest";
import { createWebSearchTool } from "../../src/tools/webSearch.js";
import { createWebExtractTool } from "../../src/tools/webExtract.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 假 world:只录 http 调用,返回 canned 响应 */
function fakeWorld(response: unknown) {
  const calls: { url: string; body: unknown; headers: Record<string, string> | undefined }[] = [];
  const world: ExecutionWorld = {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: {
      postJson: async (url, body, opts) => {
        calls.push({ url, body, headers: opts?.headers });
        return response;
      },
    },
  };
  return { world, calls };
}

const ok = (texts: string[]) => ({
  result: { content: texts.map((t) => ({ type: "text", text: t })) },
});

describe("web_search", () => {
  it("组装 JSON-RPC tools/call 并拼接 content 文本", async () => {
    const { world, calls } = fakeWorld(ok(["结果A", "结果B"]));
    const tool = createWebSearchTool(() => undefined);
    const out = await tool.run({ query: "electron ipc", max_results: 3 }, world);

    expect(out).toBe("结果A\n\n结果B");
    expect(calls[0]!.url).toBe("https://api.anysearch.com/mcp");
    expect(calls[0]!.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search", arguments: { query: "electron ipc", max_results: 3 } },
    });
  });

  it("无 key 匿名(不带 Authorization);有 key 带 Bearer", async () => {
    const anon = fakeWorld(ok(["x"]));
    await createWebSearchTool(() => undefined).run({ query: "q" }, anon.world);
    expect(anon.calls[0]!.headers?.["Authorization"]).toBeUndefined();

    const keyed = fakeWorld(ok(["x"]));
    await createWebSearchTool(() => "as_sk_test").run({ query: "q" }, keyed.world);
    expect(keyed.calls[0]!.headers?.["Authorization"]).toBe("Bearer as_sk_test");
  });

  it("max_results 缺省 5,越界(0 / 11 / 非整数)抛错", async () => {
    const { world, calls } = fakeWorld(ok(["x"]));
    const tool = createWebSearchTool(() => undefined);
    await tool.run({ query: "q" }, world);
    expect(
      (calls[0]!.body as { params: { arguments: { max_results: number } } }).params.arguments.max_results
    ).toBe(5);
    await expect(tool.run({ query: "q", max_results: 0 }, world)).rejects.toThrow(/max_results/);
    await expect(tool.run({ query: "q", max_results: 11 }, world)).rejects.toThrow(/max_results/);
    await expect(tool.run({ query: "q", max_results: 2.5 }, world)).rejects.toThrow(/max_results/);
  });

  it("query 空/非字符串抛错", async () => {
    const { world } = fakeWorld(ok(["x"]));
    const tool = createWebSearchTool(() => undefined);
    await expect(tool.run({ query: "" }, world)).rejects.toThrow(/query/);
    await expect(tool.run({}, world)).rejects.toThrow(/query/);
  });

  it("JSON-RPC error 响应抛错;content 缺失/无文本抛错", async () => {
    const errWorld = fakeWorld({ error: { message: "quota exceeded" } });
    await expect(createWebSearchTool(() => undefined).run({ query: "q" }, errWorld.world)).rejects.toThrow(
      /quota exceeded/
    );
    const emptyWorld = fakeWorld({ result: { content: [] } });
    await expect(createWebSearchTool(() => undefined).run({ query: "q" }, emptyWorld.world)).rejects.toThrow(
      /没有.*文本|无.*内容|响应/
    );
  });

  it("不需要审批(纯读,与 read_file 同级)", () => {
    expect(createWebSearchTool(() => undefined).requiresApproval).toBe(false);
    expect(createWebExtractTool(() => undefined).requiresApproval).toBe(false);
  });
});

describe("web_extract", () => {
  it("组装 extract 调用并返回 markdown 文本", async () => {
    const { world, calls } = fakeWorld(ok(["# 页面标题\n\n正文"]));
    const tool = createWebExtractTool(() => undefined);
    const out = await tool.run({ url: "https://example.com/a" }, world);
    expect(out).toBe("# 页面标题\n\n正文");
    expect(calls[0]!.body).toMatchObject({
      params: { name: "extract", arguments: { url: "https://example.com/a" } },
    });
  });

  it("url 空/非 http(s) 抛错", async () => {
    const { world } = fakeWorld(ok(["x"]));
    const tool = createWebExtractTool(() => undefined);
    await expect(tool.run({ url: "" }, world)).rejects.toThrow(/url/);
    await expect(tool.run({ url: "file:///etc/passwd" }, world)).rejects.toThrow(/url/);
  });
});
