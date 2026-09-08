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

/** `/images` 的回包形状（#1086）。整份用例从 `choices[].message.images[].image_url.url`
    改成这一套，是因为**产品那侧换了端点**：纯出图模型在 `/chat/completions` 上一律 404
    （上游按输出模态过滤端点），所以七款里有四款在旧形状下根本跑不起来。
    不是「删测试让它变绿」——旧形状的断言此刻描述的是一条不存在的请求 */
const reply = (imgs: ({ b64_json?: unknown; media_type?: unknown })[]) => ({ created: 1, data: imgs });
const png = (b64 = PNG_B64) => ({ b64_json: b64, media_type: "image/png" });

const deps = (over: Partial<GenerateImageDeps> = {}): GenerateImageDeps => ({
  mounted: () => true,
  resolve: async () => ({ url: "https://edge/llm/v1/images", headers: { authorization: "Bearer jwt" }, model: "gemini-3.1-flash-image" }),
  latestImage: async () => null,
  ...over,
});

describe("generate_image", () => {
  it("文生图：点名出图型号 + prompt，b64_json 解成字节交出去", async () => {
    const { world, calls } = fakeWorld(reply([png()]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "一只水獭" }, world);

    expect(calls[0]!.url).toBe("https://edge/llm/v1/images");
    expect(calls[0]!.opts?.headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(calls[0]!.body).toMatchObject({ model: "gemini-3.1-flash-image", prompt: "一只水獭" });
    // 没有底图时**不带** input_references：带一个空数组等于对上游声明「我给了参考图」
    expect((calls[0]!.body as { input_references?: unknown }).input_references).toBeUndefined();
    // 不许带 stream：网关对流式那条路会强塞 include_usage 并旁路挑 usage，
    // 而出图是一次性 JSON
    expect((calls[0]!.body as { stream?: unknown }).stream).toBeUndefined();

    if (typeof out === "string") throw new Error("出图工具必须回对象形态（要挂 images）");
    expect(out.images).toHaveLength(1);
    expect(out.images![0]!.mimeType).toBe("image/png");
    expect(Buffer.from(out.images![0]!.data).toString("base64")).toBe(PNG_B64);
  });

  it("output 明说模型自己看不到内容 —— 否则它会以为这次调用什么都没产出（ADR-0144 §范围外）", async () => {
    const { world } = fakeWorld(reply([png()]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    if (typeof out === "string") throw new Error("对象形态");
    expect(out.output).toContain("看不到");
  });

  it("超时自己声明，不吃 LocalWorld 那 30 秒的默认 —— 出图实测 10~45 秒（#1081）", async () => {
    const { world, calls } = fakeWorld(reply([png()]));
    await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    expect(calls[0]!.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("走不通时说清原因且**一个字节都不发** —— 措辞由装配根给（ADR-0248 那张四分表）", async () => {
    const { world, calls } = fakeWorld(reply([]));
    const tool = createGenerateImageTool(deps({ resolve: async () => ({ blocked: "订阅额度已用完，14:30 恢复。" }) }));
    await expect(tool.run({ prompt: "x" }, world)).rejects.toThrow(/额度已用完/);
    expect(calls).toHaveLength(0);
  });

  it("一张图都没回时抛错 —— 内容政策拒绝是真结局，不是「成功但没图」", async () => {
    // `/images` 的回包里没有一格「模型说了什么」，所以拒绝时带不出上游的理由（已知代价）
    const { world } = fakeWorld(reply([]));
    await expect(createGenerateImageTool(deps()).run({ prompt: "x" }, world)).rejects.toThrow(/没有返回图片/);
  });

  it("解不开的图跳过；一张都不剩才算失败（同 mcpTool.imagesOf 的立场）", async () => {
    const { world } = fakeWorld(reply([{ media_type: "image/png" }, { b64_json: "" }, png()]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    if (typeof out === "string") throw new Error("对象形态");
    expect(out.images).toHaveLength(1);
  });

  it("media_type 缺席按 png —— 猜错只是扩展名，猜「没有图」是整次调用失败", async () => {
    const { world } = fakeWorld(reply([{ b64_json: PNG_B64 }]));
    const out = await createGenerateImageTool(deps()).run({ prompt: "x" }, world);
    if (typeof out === "string") throw new Error("对象形态");
    expect(out.images![0]!.mimeType).toBe("image/png");
  });

  it("edit_last：底图走 input_references，prompt 仍是那句话", async () => {
    const { world, calls } = fakeWorld(reply([png()]));
    const tool = createGenerateImageTool(deps({
      latestImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }),
    }));
    await tool.run({ prompt: "改成夜景", edit_last: true }, world);

    const body = calls[0]!.body as { prompt: string; input_references: { type: string; image_url: { url: string } }[] };
    expect(body.prompt).toBe("改成夜景");
    expect(body.input_references).toHaveLength(1);
    expect(body.input_references[0]!.type).toBe("image_url");
    expect(body.input_references[0]!.image_url.url).toBe(`data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`);
  });

  it("edit_last 但会话里一张图都没有：说人话且不发请求 —— 无图可改时打过去只会得到一张凭空捏的图", async () => {
    const { world, calls } = fakeWorld(reply([png()]));
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
