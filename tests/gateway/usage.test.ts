import { describe, expect, it } from "vitest";
import { createUsageSniffer, sniffJson } from "../../services/gateway/src/usage.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

describe("sniffJson（非流式）", () => {
  it("抠出 usage 和 model", () => {
    expect(
      sniffJson(JSON.stringify({ model: "deepseek-v4-pro", usage: { prompt_tokens: 12, completion_tokens: 34 } }))
    ).toEqual({ promptTokens: 12, completionTokens: 34, model: "deepseek-v4-pro" });
  });

  it("没有 usage / 不是 JSON → null（宁可漏账也不按猜的数扣钱）", () => {
    expect(sniffJson(JSON.stringify({ model: "x" }))).toBeNull();
    expect(sniffJson("这不是 json")).toBeNull();
    expect(sniffJson("null")).toBeNull();
  });

  it("缺一半字段按 0 补，不产生 NaN", () => {
    expect(sniffJson(JSON.stringify({ usage: { prompt_tokens: 5 } }))).toEqual({
      promptTokens: 5,
      completionTokens: 0,
      model: "",
    });
  });
});

describe("createUsageSniffer（流式）", () => {
  it("终块的 usage 被抠出来，型号取自首块", () => {
    const s = createUsageSniffer();
    s.feed(enc(sse({ model: "deepseek-v4-flash", choices: [{ delta: { content: "嗨" } }] })));
    s.feed(enc(sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })));
    s.feed(enc("data: [DONE]\n\n"));
    expect(s.result()).toEqual({ promptTokens: 7, completionTokens: 3, model: "deepseek-v4-flash" });
  });

  it("usage 块被切成两半也不漏账（跨 chunk 的半行留在缓冲里）", () => {
    const line = sse({ model: "m", usage: { prompt_tokens: 100, completion_tokens: 200 } });
    const s = createUsageSniffer();
    for (let i = 0; i < line.length; i += 3) s.feed(enc(line.slice(i, i + 3)));
    expect(s.result()).toEqual({ promptTokens: 100, completionTokens: 200, model: "m" });
  });

  it("多字节汉字被切在字节中间也不乱（TextDecoder stream 模式）", () => {
    const line = sse({ model: "m", text: "水獭", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const bytes = enc(line);
    const s = createUsageSniffer();
    s.feed(bytes.slice(0, 30));
    s.feed(bytes.slice(30));
    expect(s.result()).toEqual({ promptTokens: 1, completionTokens: 1, model: "m" });
  });

  it("流不以换行收尾，残余那行也算数", () => {
    const s = createUsageSniffer();
    s.feed(enc(`data: ${JSON.stringify({ model: "m", usage: { prompt_tokens: 2, completion_tokens: 2 } })}`));
    expect(s.result()).toEqual({ promptTokens: 2, completionTokens: 2, model: "m" });
  });

  it("上游没给 usage → null", () => {
    const s = createUsageSniffer();
    s.feed(enc(sse({ model: "m", choices: [{ delta: { content: "a" } }] })));
    s.feed(enc("data: [DONE]\n\n"));
    expect(s.result()).toBeNull();
  });

  it("心跳注释和坏 JSON 不炸整条流", () => {
    const s = createUsageSniffer();
    s.feed(enc(": ping\n\ndata: {坏的\n\n"));
    s.feed(enc(sse({ model: "m", usage: { prompt_tokens: 1, completion_tokens: 0 } })));
    expect(s.result()).toEqual({ promptTokens: 1, completionTokens: 0, model: "m" });
  });

  it("多个 usage 块以最后一个为准", () => {
    const s = createUsageSniffer();
    s.feed(enc(sse({ model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    s.feed(enc(sse({ model: "m", usage: { prompt_tokens: 9, completion_tokens: 9 } })));
    expect(s.result()).toEqual({ promptTokens: 9, completionTokens: 9, model: "m" });
  });
});
