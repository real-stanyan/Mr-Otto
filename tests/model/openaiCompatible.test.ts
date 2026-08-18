import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/model/openaiCompatible.js";

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

  it("signal 透传给 fetch：中断从这一根线穿进请求和 SSE 读流（ADR-0006）", async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
        seenSignal = init.signal;
        return { ok: true, json: async () => ({ choices: [{ message: { content: "嗯" } }] }) };
      })
    );
    const ctrl = new AbortController();
    await adapter.chat([], undefined, undefined, ctrl.signal);
    expect(seenSignal).toBe(ctrl.signal);
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
