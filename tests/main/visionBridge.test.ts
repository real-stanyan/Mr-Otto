import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisionBridge } from "../../src/main/visionBridge.js";
import { DEFAULT_VISION_MODEL } from "../../src/shared/visionModel.js";

const ref = { id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 3 };

// 代读员的 key 由跑测试的机器决定有没有 —— 钉死它，否则同一份测试在
// 配了 GLM key 的机器上和没配的机器上跑的是两条路
beforeEach(() => vi.stubEnv("GLM_API_KEY", "sk-test"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
    expect(sent.model).toBe(DEFAULT_VISION_MODEL);
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

describe("visionBridge 缺 key", () => {
  it("没配看图模型的 key → 一个请求都不发,报错点名是看图模型 + 该填哪个变量", async () => {
    // 主模型的 key 是好的(纯文字发得出去),坏的只是代读员那把。空 Bearer 硬发
    // 上去,智谱回的是"令牌已过期或验证不正确"——读起来像主模型的 key 过期了
    vi.stubEnv("GLM_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const describeImages = createVisionBridge(() => new Uint8Array([1]));
    await expect(describeImages([ref], "看图")).rejects.toThrow(/看图模型[\s\S]*GLM_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("上游 401 的错误带上是哪一款代读员在报 —— 别让人以为主模型的 key 过期了", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401,
      text: async () => '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}',
    })));
    const describeImages = createVisionBridge(() => new Uint8Array([1]), async () => {});
    await expect(describeImages([ref], "看图")).rejects.toThrow(
      /vision-bridge\(glm-4\.6v-flash\)[\s\S]*401/
    );
  });
});
