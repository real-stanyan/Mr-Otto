import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisionBridge, VISION_BRIDGE_MODEL } from "../../src/main/visionBridge.js";

const ref = { id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 3 };

afterEach(() => vi.unstubAllGlobals());

describe("visionBridge 代读", () => {
  it("请求打到 glm-4.6v-flash:带用户问题 + 图片 base64;返回解析文本", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toContain("bigmodel.cn");
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "一只像素水獭" } }] }) };
    }));
    const describeImages = createVisionBridge(() => new Uint8Array([1, 2, 3]));
    const out = await describeImages([ref], "这是什么");
    expect(out).toBe("一只像素水獭");
    const sent = JSON.parse(bodies[0]!) as {
      model: string;
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
    };
    expect(sent.model).toBe(VISION_BRIDGE_MODEL);
    const parts = sent.messages[0]!.content;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toContain("这是什么");
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` },
    });
  });

  it("视觉模型回空 → 抛错(不落无意义事件)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ choices: [{ message: { content: "  " } }] }),
    })));
    const describeImages = createVisionBridge(() => new Uint8Array([1]));
    await expect(describeImages([ref], "看图")).rejects.toThrow(/解析/);
  });
});

describe("visionBridge 429 重试", () => {
  it("限流两次后成功:自动重试拿到解析,退避经 sleep", async () => {
    let calls = 0;
    const slept: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return { ok: false, status: 429, text: async () => '{"error":{"code":"1305"}}' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "解析成功" } }] }) };
    }));
    const describeImages = createVisionBridge(
      () => new Uint8Array([1]),
      async (ms) => { slept.push(ms); }
    );
    await expect(describeImages([ref], "看图")).resolves.toBe("解析成功");
    expect(calls).toBe(3);
    expect(slept).toEqual([1500, 3000]);
  });

  it("持续 429 → 重试耗尽后抛原始错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 429, text: async () => '{"error":{"code":"1305","message":"访问量过大"}}',
    })));
    const describeImages = createVisionBridge(() => new Uint8Array([1]), async () => {});
    await expect(describeImages([ref], "看图")).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("非 429(如 401 无 key)不重试,一击即抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, text: async () => "unauthorized",
    })));
    const describeImages = createVisionBridge(() => new Uint8Array([1]), async () => {});
    await expect(describeImages([ref], "看图")).rejects.toThrow(/401/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
