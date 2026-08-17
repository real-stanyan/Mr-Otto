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
