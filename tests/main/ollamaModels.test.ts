import { describe, expect, it } from "vitest";

import { probeCandidates, probeOllamaModels } from "../../src/main/ollamaModels.js";

const DEFAULT = "http://127.0.0.1:11434/v1";
const P = "ollama/";

/** /v1/models 的真实形状（本机 Ollama 的返回抄下来的） */
const body = (ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 1, owned_by: "library" })),
});

const ok = (json: unknown): Response => ({ ok: true, status: 200, json: async () => json }) as Response;
const status = (code: number): Response => ({ ok: false, status: code, json: async () => ({}) }) as Response;

describe("probeCandidates", () => {
  it("默认端点两种回环写法都试：Ollama 只监听 IPv4，但 localhost 可能先解析到 ::1", () => {
    expect(probeCandidates(DEFAULT)).toEqual([DEFAULT, "http://localhost:11434/v1"]);
  });

  it("用户配了端点就只认它 —— 指名的地址不该被偷偷换掉", () => {
    expect(probeCandidates(DEFAULT, "http://box.lan:11434/v1")).toEqual(["http://box.lan:11434/v1"]);
  });
});

describe("probeOllamaModels", () => {
  it("按 id 排序并加前缀", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => ok(body(["qwen3:30b", "cogito:8b"])),
    });
    expect(r).toEqual({ models: ["ollama/cogito:8b", "ollama/qwen3:30b"], error: "" });
  });

  it("第一个回环写法连不上时换第二个 —— 命令行 curl 得通、应用里却检测不到，就是这个坑", async () => {
    const tried: string[] = [];
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async (url) => {
        tried.push(String(url));
        if (String(url).includes("127.0.0.1")) throw new Error("ECONNREFUSED");
        return ok(body(["llama3.2"]));
      },
    });
    expect(tried).toHaveLength(2);
    expect(r.models).toEqual(["ollama/llama3.2"]);
    expect(r.error).toBe("");
  });

  it("全都连不上：报错带上试过的地址，不然分不清是服务没开还是端点填错", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(r.models).toEqual([]);
    expect(r.error).toContain("127.0.0.1:11434");
    expect(r.error).toContain("localhost:11434");
  });

  it("连上了但一个都没 pull = 空清单 + 无错误，不是故障", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => ok(body([])),
    });
    expect(r).toEqual({ models: [], error: "" });
  });

  it("非 2xx 也换下一个候选，并把状态码记进错误", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => status(403),
    });
    expect(r.error).toContain("403");
  });

  it("配了 key 才带 Authorization —— 本机 Ollama 不需要，别凭空加一个头", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const run = (apiKey?: string) =>
      probeOllamaModels({
        defaultBaseUrl: DEFAULT,
        prefix: P,
        ...(apiKey ? { apiKey } : {}),
        fetchImpl: async (_u, init) => { seen.push(init); return ok(body(["x"])); },
      });
    await run();
    await run("secret");
    expect(seen[0]?.headers).toBeUndefined();
    expect(seen[1]?.headers).toEqual({ authorization: "Bearer secret" });
  });
});
