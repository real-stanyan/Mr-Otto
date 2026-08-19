import { describe, expect, it } from "vitest";

import {
  ollamaHostToBaseUrl,
  probeOllamaModels,
  resolveOllamaBaseUrls,
} from "../../src/main/ollamaModels.js";

const DEFAULT = "http://127.0.0.1:11434/v1";
const P = "ollama/";

/** /v1/models 与 /api/show 的真实形状（本机 Ollama 0.32 的返回抄下来的） */
const models = (ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 1, owned_by: "library" })),
});
const show = (caps: string[], ctx: number) => ({
  capabilities: caps,
  model_info: { "general.architecture": "qwen3", "qwen3.context_length": ctx },
});

const ok = (json: unknown): Response => ({ ok: true, status: 200, json: async () => json }) as Response;
const bad = (code: number): Response => ({ ok: false, status: code, json: async () => ({}) }) as Response;

/** 一台"装了 Ollama 的机器"：/v1/models 给清单，/api/show 给能力 */
const machine =
  (byTag: Record<string, { caps: string[]; ctx: number }>): typeof fetch =>
  async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return ok(models(Object.keys(byTag)));
    if (u.endsWith("/api/show")) {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      const m = byTag[model]!;
      return ok(show(m.caps, m.ctx));
    }
    throw new Error(`unexpected ${u}`);
  };

describe("ollamaHostToBaseUrl —— 跟着 Ollama 自己的 OLLAMA_HOST 写法走", () => {
  it("host:port", () => {
    expect(ollamaHostToBaseUrl("192.168.1.9:11434")).toBe("http://192.168.1.9:11434/v1");
  });

  it("只写端口 = 补本机", () => {
    expect(ollamaHostToBaseUrl(":11500")).toBe("http://127.0.0.1:11500/v1");
  });

  it("只写主机 = 补 Ollama 的默认端口", () => {
    expect(ollamaHostToBaseUrl("ollama.lan")).toBe("http://ollama.lan:11434/v1");
  });

  it("带 scheme 的原样保留（反代常见 https）", () => {
    expect(ollamaHostToBaseUrl("https://ollama.example.com")).toBe(
      "https://ollama.example.com:11434/v1"
    );
  });

  it("0.0.0.0 / :: 是监听地址不是拨号地址，换成回环", () => {
    expect(ollamaHostToBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434/v1");
    expect(ollamaHostToBaseUrl("[::]:11434")).toBe("http://[::1]:11434/v1");
  });

  it("空串 / 垃圾值 → null，由调用方回退到默认", () => {
    expect(ollamaHostToBaseUrl("   ")).toBeNull();
    expect(ollamaHostToBaseUrl("http://")).toBeNull();
  });
});

describe("resolveOllamaBaseUrls —— 优先级：我们的覆盖 > OLLAMA_HOST > 默认", () => {
  it("默认这一档探两种回环写法", () => {
    expect(resolveOllamaBaseUrls({ defaultBaseUrl: DEFAULT })).toEqual([
      DEFAULT,
      "http://localhost:11434/v1",
    ]);
  });

  it("OLLAMA_HOST 一旦有值就只认它 —— 用户指名的地址不该被替他改主意", () => {
    expect(
      resolveOllamaBaseUrls({ defaultBaseUrl: DEFAULT, ollamaHost: "0.0.0.0:11500" })
    ).toEqual(["http://127.0.0.1:11500/v1"]);
  });

  it("OLLAMA_BASE_URL 压过 OLLAMA_HOST", () => {
    expect(
      resolveOllamaBaseUrls({
        defaultBaseUrl: DEFAULT,
        ollamaHost: "127.0.0.1:11434",
        baseUrlOverride: "http://box.lan:9999/v1",
      })
    ).toEqual(["http://box.lan:9999/v1"]);
  });

  it("OLLAMA_HOST 是垃圾值时退回默认，而不是整个功能失灵", () => {
    expect(resolveOllamaBaseUrls({ defaultBaseUrl: DEFAULT, ollamaHost: "  " })).toEqual([
      DEFAULT,
      "http://localhost:11434/v1",
    ]);
  });
});

describe("probeOllamaModels", () => {
  it("清单按 id 排序、带前缀，能力和上下文取自 /api/show", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: machine({
        "qwen3:30b": { caps: ["completion", "tools", "thinking"], ctx: 262144 },
        "cogito:8b": { caps: ["completion", "tools"], ctx: 131072 },
      }),
    });
    expect(r.baseUrl).toBe(DEFAULT);
    expect(r.error).toBe("");
    expect(r.models).toEqual([
      { id: "ollama/cogito:8b", tag: "cogito:8b", contextLength: 131072, tools: true, vision: false, thinking: false },
      { id: "ollama/qwen3:30b", tag: "qwen3:30b", contextLength: 262144, tools: true, vision: false, thinking: true },
    ]);
  });

  it("vision 能力如实反映 —— 看得见图的型号不用绕 vision-bridge", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: machine({ "qwen3.8:27b": { caps: ["completion", "vision", "tools"], ctx: 262144 } }),
    });
    expect(r.models[0]).toMatchObject({ vision: true, tools: true });
  });

  it("会不会思考如实反映 —— composer 上那个挡位框对这一款可不可点，看它", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: machine({
        "qwen3:30b": { caps: ["completion", "tools", "thinking"], ctx: 262144 },
        "cogito:8b": { caps: ["completion", "tools"], ctx: 131072 },
      }),
    });
    expect(r.models.map((m) => [m.tag, m.thinking])).toEqual([
      ["cogito:8b", false],
      ["qwen3:30b", true],
    ]);
  });

  it("不会调工具的型号如实标出来 —— 这个 agent 每一步都是工具调用", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: machine({ "embed-only": { caps: ["completion"], ctx: 8192 } }),
    });
    expect(r.models[0]).toMatchObject({ tools: false });
  });

  it("OLLAMA_CONTEXT_LENGTH 给模型的窗封顶 —— 服务端只会用更小的那个", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      contextCap: 8192,
      fetchImpl: machine({ big: { caps: ["tools"], ctx: 262144 } }),
    });
    expect(r.models[0]?.contextLength).toBe(8192);
  });

  it("/api/show 挂了只降级那一款，清单本身照出 —— 且不把它从选单里抹掉", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async (url) =>
        String(url).endsWith("/v1/models") ? ok(models(["x"])) : bad(500),
    });
    expect(r.models).toEqual([
      { id: "ollama/x", tag: "x", contextLength: 4096, tools: true, vision: false, thinking: false },
    ]);
  });

  it("第一个回环写法连不上就换第二个 —— 命令行 curl 得通、应用里却检测不到就是这个坑", async () => {
    const tried: string[] = [];
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.endsWith("/v1/models")) tried.push(u);
        if (u.includes("127.0.0.1")) throw new Error("ECONNREFUSED");
        return machine({ "llama3.2": { caps: ["tools"], ctx: 131072 } })(url, init);
      },
    });
    expect(tried).toHaveLength(2);
    expect(r.baseUrl).toBe("http://localhost:11434/v1");
    expect(r.models.map((m) => m.id)).toEqual(["ollama/llama3.2"]);
  });

  it("全都连不上：错误带上试过的地址，不然分不清是服务没开还是端点填错", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r).toMatchObject({ baseUrl: "", models: [] });
    expect(r.error).toContain("127.0.0.1:11434");
    expect(r.error).toContain("localhost:11434");
  });

  it("连上了但一个都没 pull = 空清单 + 无错误，不是故障", async () => {
    const r = await probeOllamaModels({
      defaultBaseUrl: DEFAULT,
      prefix: P,
      fetchImpl: async () => ok(models([])),
    });
    expect(r).toEqual({ baseUrl: DEFAULT, models: [], error: "" });
  });

  it("配了 key 才带 Authorization —— 本机 Ollama 不需要，别凭空加一个头", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const run = (apiKey?: string) =>
      probeOllamaModels({
        defaultBaseUrl: DEFAULT,
        prefix: P,
        ...(apiKey ? { apiKey } : {}),
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/v1/models")) seen.push(init);
          return String(url).endsWith("/v1/models") ? ok(models(["x"])) : ok(show(["tools"], 4096));
        },
      });
    await run();
    await run("secret");
    expect(seen[0]?.headers).toBeUndefined();
    expect(seen[1]?.headers).toEqual({ authorization: "Bearer secret" });
  });
});
