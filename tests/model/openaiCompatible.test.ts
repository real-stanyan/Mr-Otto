import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleAdapter,
  localTiming,
  LOCAL_IDLE_TIMEOUT_MS,
} from "../../src/model/openaiCompatible.js";
import { errorClassOf } from "../../src/model/errorClass.js";

/** 把字符串数组变成字节流——每个元素模拟一次网络分块（分块边界 ≠ 行边界） */
function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[i++];
      if (part === undefined) controller.close();
      else controller.enqueue(enc.encode(part));
    },
  });
}

function mockFetchSSE(parts: string[]) {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, body: streamOf(parts) };
    })
  );
  return bodies;
}

const adapter = createOpenAICompatibleAdapter({
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "test-model",
});

afterEach(() => vi.unstubAllGlobals());

describe("openaiCompatible 流式（SSE）", () => {
  it("文本碎片边到边回调，最终 reply 是完整拼接 + 终块 usage", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      // 一行劈在两次网络分块之间：缓冲逻辑的核心用例
      'data: {"choices":[{"delta":{"con',
      'tent":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const deltas: string[] = [];
    const reply = await adapter.chat([], undefined, (t) => deltas.push(t));

    expect(deltas).toEqual(["你", "好"]);
    expect(reply.content).toBe("你好");
    expect(reply.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("reasoning_content 单独成频道：先想后说，两条流分开攒", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"reasoning_content":"让我想"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"想…"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案是 42"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const deltas: { text: string; kind: string }[] = [];
    const reply = await adapter.chat([], undefined, (text, kind) => deltas.push({ text, kind }));

    expect(deltas).toEqual([
      { text: "让我想", kind: "reasoning" },
      { text: "想…", kind: "reasoning" },
      { text: "答案是 42", kind: "content" },
    ]);
    expect(reply.reasoning).toBe("让我想想…");
    expect(reply.content).toBe("答案是 42");
  });

  it("无 reasoning（关 thinking / 型号不支持）→ reply 不带该字段，别污染事件", async () => {
    mockFetchSSE(['data: {"choices":[{"delta":{"content":"嗯"}}]}\n\n', "data: [DONE]\n\n"]);
    const reply = await adapter.chat([], undefined, () => {});
    expect(reply).not.toHaveProperty("reasoning");
  });

  it("tool_calls 碎片按 index 归位，arguments 拼完整才 parse", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const reply = await adapter.chat([], undefined, () => {});
    expect(reply.toolCalls).toEqual([{ id: "c1", name: "bash", args: { cmd: "ls" } }]);
  });

  it("onDelta 给了才带 stream 字段；不给 = 非流式请求体，别惊扰旧行为", async () => {
    const bodies = mockFetchSSE(["data: [DONE]\n\n"]);
    await adapter.chat([], undefined, () => {});
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        expect(JSON.parse(init.body)).not.toHaveProperty("stream");
        return { ok: true, json: async () => ({ choices: [{ message: { content: "嗯" } }] }) };
      })
    );
    const reply = await adapter.chat([]);
    expect(reply.content).toBe("嗯");
  });

  it("服务器不带尾换行也能收尾：缓冲里的残行在流关闭后补喂", async () => {
    mockFetchSSE(['data: {"choices":[{"delta":{"content":"尾巴"}}]}']); // 无 \n
    const reply = await adapter.chat([], undefined, () => {});
    expect(reply.content).toBe("尾巴");
  });

  it("cache 命中字段(DeepSeek 方言 prompt_cache_hit_tokens)→ usage.cachedTokens", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"content":"嗯"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_cache_hit_tokens":64}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const reply = await adapter.chat([], undefined, () => {});
    expect(reply.usage).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 64 });
  });

  it("cache 命中字段(OpenAI/GLM 方言 prompt_tokens_details.cached_tokens)→ 同一个 cachedTokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "嗯" } }],
          usage: { prompt_tokens: 200, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 128 } },
        }),
      }))
    );
    const reply = await adapter.chat([]);
    expect(reply.usage).toEqual({ promptTokens: 200, completionTokens: 3, cachedTokens: 128 });
  });

  it("两个方言都不报 cache → usage 不带 cachedTokens:「API 不报」≠「命中 0」", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const reply = await adapter.chat([], undefined, () => {});
    expect(reply.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    expect(reply.usage).not.toHaveProperty("cachedTokens");
  });

  it("外部 abort 传导：中断掐断在飞的请求（ADR-0006）", async () => {
    // 重试/超时改造后（issue #283）fetch 拿到的是 adapter 自建的 signal（看门狗要能
    // 自己掐断单次请求），契约从"同一个对象"改成"外部 abort 单向传导进来"
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_res, rej) => {
            init.signal.addEventListener("abort", () => rej(init.signal.reason), { once: true });
          })
      )
    );
    const ctrl = new AbortController();
    const pending = adapter.chat([], undefined, undefined, ctrl.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    ctrl.abort();
    await assertion;
  });
});

describe("传输层重试与超时（issue #283）", () => {
  /** 退避清零的适配器：测试不等真退避 */
  const fastAdapter = (timing?: Partial<import("../../src/model/openaiCompatible.js").AdapterTiming>) =>
    createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      timing: { backoffMs: [0], ...timing },
    });

  const okJson = { ok: true, json: async () => ({ choices: [{ message: { content: "好了" } }] }) };

  it("429 后重试成功：一次限流不报废整个 turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" })
      .mockResolvedValueOnce(okJson);
    vi.stubGlobal("fetch", fetchMock);
    const reply = await fastAdapter().chat([]);
    expect(reply.content).toBe("好了");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("网络层失败（fetch reject）后重试成功", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okJson);
    vi.stubGlobal("fetch", fetchMock);
    const reply = await fastAdapter().chat([]);
    expect(reply.content).toBe("好了");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("400（请求非法）不重试：重试只会得到同一个答案", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fastAdapter().chat([])).rejects.toThrow("model API 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("重试次数用尽 → 抛最后一次的错误", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => "overloaded" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fastAdapter({ maxAttempts: 3 }).chat([])).rejects.toThrow("model API 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("用户 abort 不重试：停止是意志不是故障（ADR-0006）", async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      ctrl.abort(); // 请求在天上时用户按了停止
      throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fastAdapter().chat([], undefined, undefined, ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("响应头超时：挂死的连接被掐断并重试", async () => {
    const fetchMock = vi
      .fn()
      // 首发永远不返回，但认 signal——被看门狗掐断后 reject
      .mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_res, rej) => {
            init.signal.addEventListener("abort", () => rej(init.signal.reason), { once: true });
          })
      )
      .mockResolvedValueOnce(okJson);
    vi.stubGlobal("fetch", fetchMock);
    const reply = await fastAdapter({ headersTimeoutMs: 20 }).chat([]);
    expect(reply.content).toBe("好了");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("SSE 首字节前静默超时：可重试（什么都没直播过）", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: hangingBody })
      .mockResolvedValueOnce({
        ok: true,
        body: streamOf(['data: {"choices":[{"delta":{"content":"迟到"}}]}\n\n', "data: [DONE]\n\n"]),
      });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await fastAdapter({ idleTimeoutMs: 20 }).chat([], undefined, () => {});
    expect(reply.content).toBe("迟到");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("SSE 首字节后静默超时：不重试（半条消息续不上），报静默错误", async () => {
    const enc = new TextEncoder();
    const partialBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"说了一半"}}]}\n\n'));
        // 之后永远不再吐字，也不 close
      },
      pull: () => new Promise(() => {}),
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: partialBody });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fastAdapter({ idleTimeoutMs: 30 }).chat([], undefined, () => {})
    ).rejects.toThrow("无数据");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("图片附件(image_ref → image_url,file-input-v1)", () => {
  it("parts 消息转 vision 方言:text 原样,image_ref 变 base64 data URL", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "看到了" } }] }) };
    }));
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      vision: true,
      readAttachment: (id) => {
        expect(id).toBe("sha256:" + "a".repeat(64));
        return new Uint8Array([1, 2, 3]);
      },
    });
    await adapter.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么" },
          { type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" },
        ],
      },
    ]);
    const sent = JSON.parse(bodies[0]!) as { messages: { content: unknown }[] };
    expect(sent.messages[0]!.content).toEqual([
      { type: "text", text: "这是什么" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` },
      },
    ]);
  });

  it("string content 请求体保持原样(老路径回归)", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    }));
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
    });
    await adapter.chat([{ role: "user", content: "纯文本" }]);
    const sent = JSON.parse(bodies[0]!) as { messages: unknown[] };
    expect(sent.messages).toEqual([{ role: "user", content: "纯文本" }]);
  });

  it("未注入 readAttachment 遇 image_ref 抛错(配置缺口早暴露)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", vision: true,
    });
    await expect(
      adapter.chat([
        { role: "user", content: [{ type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" }] },
      ])
    ).rejects.toThrow(/readAttachment|附件/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("无视觉模型(vision 缺省)遇 image_ref → 占位文本,不解 bytes 不炸(vision-bridge)", async () => {
    const bodies: string[] = [];
    const read = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }));
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
      readAttachment: read, // 注入了也不许碰:无视觉模型发 base64 = 白烧带宽还 400
    });
    await adapter.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" },
        ],
      },
    ]);
    const sent = JSON.parse(bodies[0]!) as { messages: { content: unknown }[] };
    expect(sent.messages[0]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "text", text: "[图片附件:当前模型不支持直接查看,图片内容见随附的图片解析]" },
    ]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("端点解析（otto-gateway 路线）", () => {
  /** 记下每次请求的 url / headers,用来断言"用的是哪一套凭据" */
  function mockFetchJSON(status = 200, body = '{"choices":[{"message":{"content":"ok"}}]}') {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        return {
          ok: status < 400,
          status,
          json: async () => JSON.parse(body),
          text: async () => body,
        };
      })
    );
    return calls;
  }

  it("不给 resolveEndpoint → 老路径一字不变，用静态 baseUrl/apiKey", async () => {
    const calls = mockFetchJSON();
    await createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "static-key",
      model: "m",
    }).chat([{ role: "user", content: "hi" }]);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer static-key");
  });

  it("给了 resolveEndpoint → 以它为准，静态值被忽略", async () => {
    const calls = mockFetchJSON();
    await createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "static-key",
      model: "m",
      resolveEndpoint: async () => ({
        baseUrl: "https://gw.example/gw/v1",
        apiKey: "jwt-token",
        headers: { "x-otto-request-id": "req-1" },
      }),
    }).chat([{ role: "user", content: "hi" }]);
    expect(calls[0]!.url).toBe("https://gw.example/gw/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer jwt-token");
    expect(calls[0]!.headers["x-otto-request-id"]).toBe("req-1");
  });

  it("每次请求都重解析——access token 一小时就过期，构造时定死等于跑一半 401", async () => {
    const calls = mockFetchJSON();
    let n = 0;
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "unused",
      model: "m",
      resolveEndpoint: async () => ({ baseUrl: "https://gw.example/v1", apiKey: `jwt-${++n}` }),
    });
    await adapter.chat([{ role: "user", content: "a" }]);
    await adapter.chat([{ role: "user", content: "b" }]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
  });

  it("resolveEndpoint 抛错（没登录也没 key）→ 原样上抛，不发请求", async () => {
    const calls = mockFetchJSON();
    await expect(
      createOpenAICompatibleAdapter({
        baseUrl: "x",
        apiKey: "",
        model: "m",
        resolveEndpoint: async () => {
          throw new Error("还没法调用模型：登录即可用官方赠额");
        },
      }).chat([{ role: "user", content: "hi" }])
    ).rejects.toThrow("登录即可用官方赠额");
    expect(calls).toHaveLength(0);
  });

  it("网关 402 → 只报那句人话，不裹 'model API 402:'", async () => {
    mockFetchJSON(
      402,
      JSON.stringify({
        error: { message: "token 额度已用尽。可在设置里改用自己的 API key。", type: "otto_gateway", code: "quota_exhausted" },
      })
    );
    await expect(
      createOpenAICompatibleAdapter({ baseUrl: "x", apiKey: "k", model: "m" }).chat([
        { role: "user", content: "hi" },
      ])
    ).rejects.toThrow("token 额度已用尽。可在设置里改用自己的 API key。");
  });

  it("上游自己的错误照旧带状态码报——那不是网关说的话", async () => {
    mockFetchJSON(401, JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }));
    await expect(
      createOpenAICompatibleAdapter({ baseUrl: "x", apiKey: "k", model: "m" }).chat([
        { role: "user", content: "hi" },
      ])
    ).rejects.toThrow("model API 401");
  });
});

describe("thinking 挡位 → 请求体（各家方言不是同一个字段）", () => {
  /** 只关心请求体，用最短的 SSE 收尾 */
  const bodyOf = async (thinking: Parameters<typeof createOpenAICompatibleAdapter>[0]["thinking"]) => {
    const bodies = mockFetchSSE(["data: [DONE]\n\n"]);
    await createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      ...(thinking ? { thinking } : {}),
    }).chat([], undefined, () => {});
    return JSON.parse(bodies[0]!) as Record<string, unknown>;
  };

  it("flag：GLM / DeepSeek 的 thinking:{type}", async () => {
    expect(await bodyOf({ mode: "on", wire: "flag" })).toMatchObject({
      thinking: { type: "enabled" },
    });
    expect(await bodyOf({ mode: "off", wire: "flag" })).toMatchObject({
      thinking: { type: "disabled" },
    });
  });

  it("effort：reasoning_effort，关 = none（本机 Ollama 0.32 实测的关法）", async () => {
    expect(await bodyOf({ mode: "high", wire: "effort" })).toMatchObject({
      reasoning_effort: "high",
    });
    expect(await bodyOf({ mode: "off", wire: "effort" })).toMatchObject({
      reasoning_effort: "none",
    });
  });

  it("effort：max 原样发 —— Ollama 的 /v1 收 high/medium/low/max/none 这五个", async () => {
    expect(await bodyOf({ mode: "max", wire: "effort" })).toMatchObject({
      reasoning_effort: "max",
    });
  });

  it("effort 收到二选一那派的「开」也发得出去 —— 当中档，不发一个非法值", async () => {
    expect(await bodyOf({ mode: "on", wire: "effort" })).toMatchObject({
      reasoning_effort: "medium",
    });
  });

  it("enable_thinking：Qwen 系的布尔写法", async () => {
    expect(await bodyOf({ mode: "on", wire: "enable_thinking" })).toMatchObject({
      enable_thinking: true,
    });
    expect(await bodyOf({ mode: "off", wire: "enable_thinking" })).toMatchObject({
      enable_thinking: false,
    });
  });

  it("openrouter：关是 enabled:false，不是 effort 的某一档", async () => {
    expect(await bodyOf({ mode: "low", wire: "openrouter" })).toMatchObject({
      reasoning: { effort: "low" },
    });
    expect(await bodyOf({ mode: "off", wire: "openrouter" })).toMatchObject({
      reasoning: { enabled: false },
    });
  });

  it("没有挡位的型号：相关字段一个都不出现 —— 陌生参数发过去可能直接 400", async () => {
    const none = await bodyOf({ mode: "off", wire: "none" });
    const absent = await bodyOf(undefined);
    for (const b of [none, absent]) {
      expect(b).not.toHaveProperty("thinking");
      expect(b).not.toHaveProperty("reasoning_effort");
      expect(b).not.toHaveProperty("enable_thinking");
      expect(b).not.toHaveProperty("reasoning");
    }
  });
});

describe("思考过程的字段名不止一个", () => {
  it("Ollama 的 /v1 叫 reasoning（不是 reasoning_content）—— 少收一个就当场丢失", async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"reasoning":"先想想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"4"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const kinds: string[] = [];
    const reply = await adapter.chat([], undefined, (_t, k) => kinds.push(k));
    expect(reply.reasoning).toBe("先想想");
    expect(kinds).toEqual(["reasoning", "content"]);
  });
});

describe("localTiming — 本机推理的看门狗放宽（issue #300）", () => {
  it("keyless（本机 Ollama）：headers/idle 都放宽到 10 分钟 —— 冷加载 + prefill 是干活不是挂死", () => {
    expect(localTiming({ keyless: true })).toEqual({
      headersTimeoutMs: LOCAL_IDLE_TIMEOUT_MS,
      idleTimeoutMs: LOCAL_IDLE_TIMEOUT_MS,
    });
    expect(LOCAL_IDLE_TIMEOUT_MS).toBe(600_000);
  });

  it("云端型号：{} = 沿用默认看门狗（30s/90s，那里的静默才是挂死）", () => {
    expect(localTiming({ keyless: false })).toEqual({});
  });
});

describe("errorClass 标记（issue #389）——抛错处分类，下游读标记", () => {
  const clsAdapter = () =>
    createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      timing: { backoffMs: [0], maxAttempts: 1 },
    });

  it.each([
    [429, "rate-limit"],
    [503, "retryable"],
    [400, "fatal"],
  ] as const)("HTTP %i → errorClass %s", async (status, cls) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, text: async () => "x" }));
    const err = await clsAdapter().chat([]).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe(cls);
  });

  it("网关限流（人话文案，无 'API 429' 字样）也带 rate-limit 分类", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({ error: { type: "otto_gateway", message: "访问量过大，稍后再试" } }),
      })
    );
    const err = await clsAdapter().chat([]).catch((e: unknown) => e);
    expect((err as Error).message).toBe("访问量过大，稍后再试");
    expect(errorClassOf(err)).toBe("rate-limit");
  });

  it("网络层失败带 retryable 分类", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const err = await clsAdapter().chat([]).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe("retryable");
  });
});
