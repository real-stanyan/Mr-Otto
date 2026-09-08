import { describe, it, expect } from "vitest";
import { createGenerateImageTool, type GenerateImageDeps } from "../../src/tools/generateImage.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { HttpPostOptions } from "../../src/world/executionWorld.js";

/** 假 world：只录 http 调用，返回 canned 响应（同 webSearch.test.ts） */
function fakeWorld(response: unknown | (() => unknown)) {
  const calls: { url: string; body: unknown; opts: HttpPostOptions | undefined }[] = [];
  const world: ExecutionWorld = {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: {
      postJson: async (url, body, opts) => {
        calls.push({ url, body, opts });
        return typeof response === "function" ? (response as () => unknown)() : response;
      },
    },
  };
  return { world, calls };
}

const PNG_B64 = "iVBORw0KGgo=";

const reply = (urls: string[], text = "") => ({
  choices: [{ message: { role: "assistant", content: text, images: urls.map((u) => ({ type: "image_url", image_url: { url: u } })) } }],
});

const deps = (over: Partial<GenerateImageDeps> = {}): GenerateImageDeps => ({
  mounted: () => true,
  resolve: async () => ({ url: "https://edge/llm/v1/chat/completions", headers: { authorization: "Bearer jwt" }, model: "gemini-3.1-flash-image" }),
  latestImage: async () => null,
  ...over,
});

describe("generate_image", () => {
  it("文生图：点名出图型号 + modalities，图从 data URL 解成字节交出去", async () => {
    const { world, calls } = fakeWorld(reply([`data:image/png;base64,${PNG_B64}`]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "一只水獭" }, world);

    expect(calls[0]!.url).toBe("https://edge/llm/v1/chat/completions");
    expect(calls[0]!.opts?.headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(calls[0]!.body).toMatchObject({
      model: "gemini-3.1-flash-image",
      modalities: ["image", "text"],
      messages: [{ role: "user", content: "一只水獭" }],
    });
    // 不许带 stream：网关对流式那条路会强塞 include_usage 并旁路挑 usage，
    // 而出图是一次性 JSON
    expect((calls[0]!.body as { stream?: unknown }).stream).toBeUndefined();

    if (typeof out === "string") throw new Error("出图工具必须回对象形态（要挂 images）");
    expect(out.images).toHaveLength(1);
    expect(out.images![0]!.mimeType).toBe("image/png");
    expect(Buffer.from(out.images![0]!.data).toString("base64")).toBe(PNG_B64);
  });

  it("output 明说模型自己看不到内容 —— 否则它会以为这次调用什么都没产出（ADR-0144 §范围外）", async () => {
    const { world } = fakeWorld(reply([`data:image/png;base64,${PNG_B64}`]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    if (typeof out === "string") throw new Error("对象形态");
    expect(out.output).toContain("看不到");
  });

  it("超时自己声明，不吃 LocalWorld 那 30 秒的默认 —— 出图实测 10~45 秒（#1081）", async () => {
    const { world, calls } = fakeWorld(reply([`data:image/png;base64,${PNG_B64}`]));
    await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    expect(calls[0]!.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("走不通时说清原因且**一个字节都不发** —— 措辞由装配根给（ADR-0248 那张四分表）", async () => {
    const { world, calls } = fakeWorld(reply([]));
    const tool = createGenerateImageTool(deps({ resolve: async () => ({ blocked: "订阅额度已用完，14:30 恢复。" }) }));
    await expect(tool.run({ prompt: "x" }, world)).rejects.toThrow(/额度已用完/);
    expect(calls).toHaveLength(0);
  });

  it("模型一张图都没回时抛错并带上它那句话 —— 内容政策拒绝是真结局，不是「成功但没图」", async () => {
    const { world } = fakeWorld(reply([], "这个请求我不能画"));
    await expect(createGenerateImageTool(deps()).run({ prompt: "x" }, world)).rejects.toThrow(/这个请求我不能画/);
  });

  it("解不开的图跳过；一张都不剩才算失败（同 mcpTool.imagesOf 的立场）", async () => {
    const { world } = fakeWorld(reply(["https://cdn/not-a-data-url.png", `data:image/png;base64,${PNG_B64}`]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    if (typeof out === "string") throw new Error("对象形态");
    expect(out.images).toHaveLength(1);
  });

  it("edit_last：把会话里最近那张图附成 image_url part，正文仍是 prompt", async () => {
    const { world, calls } = fakeWorld(reply([`data:image/png;base64,${PNG_B64}`]));
    const tool = createGenerateImageTool(deps({
      latestImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }),
    }));
    await tool.run({ prompt: "改成夜景", edit_last: true }, world);

    const content = (calls[0]!.body as { messages: { content: unknown }[] }).messages[0]!.content as {
      type: string; text?: string; image_url?: { url: string };
    }[];
    expect(content[0]).toEqual({ type: "text", text: "改成夜景" });
    expect(content[1]!.type).toBe("image_url");
    expect(content[1]!.image_url!.url).toBe(`data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`);
  });

  it("edit_last 但会话里一张图都没有：说人话且不发请求 —— 无图可改时打过去只会得到一张凭空捏的图", async () => {
    const { world, calls } = fakeWorld(reply([`data:image/png;base64,${PNG_B64}`]));
    const tool = createGenerateImageTool(deps({ latestImage: async () => null }));
    await expect(tool.run({ prompt: "改成夜景", edit_last: true }, world)).rejects.toThrow(/还没有图/);
    expect(calls).toHaveLength(0);
  });

  it("prompt 必填且非空", async () => {
    const { world } = fakeWorld(reply([]));
    const tool = createGenerateImageTool(deps());
    await expect(tool.run({}, world)).rejects.toThrow(/prompt/);
    await expect(tool.run({ prompt: "   " }, world)).rejects.toThrow(/prompt/);
  });

  it("不过审批门、可并发 —— 与 web_search 同级（它也花钱）", () => {
    const tool = createGenerateImageTool(deps());
    expect(tool.requiresApproval).toBe(false);
    expect(tool.parallelSafe).toBe(true);
  });

  it("available 跟着 mounted 走 —— 没订阅的人工具表里根本没有这把刀，模型不会承诺一张画不出来的图", () => {
    expect(createGenerateImageTool(deps()).available!()).toBe(true);
    expect(createGenerateImageTool(deps({ mounted: () => false })).available!()).toBe(false);
  });
});
