// generate_image — 会话里出一张图（issue #1081）。
//
// **路是「桌面 → edge 网关 → OpenRouter」，不是桌面直连**。两条约束合起来只有这一个
// 落点：生图统一走用户的订阅额度、官方 key 所有用户共用一把。key 写进桌面包的方案
// 否掉了 —— app bundle 是用户机器上的可读文件，key 挖得出来就是无限花维护者的钱，
// 而额度闸（hold/settle）在客户端根本不存在。走网关则那一整套都是现成的：网关转发
// 请求体是 `{...body}` 展开的，所以 `modalities` 原样到上游、`message.images` 原样
// 回来；计价按输出 token 走 `costMicro()`，与 OpenRouter 的账单逐 micro 相等
// （`model_route` 那一行的价怎么定的写在 supabase/migrations/0031 的头注里）。
//
// 这一层**不知道怎么向网关证明身份**：端点和一份算好的头由装配根递进来（同 ADR-0244
// 的纪律——runtime 带 x-runtime-secret，桌面带用户自己的 JWT，两边只在这一格不同）。
// 图的字节也一样交出去不落盘：硬规则「工具只依赖 ExecutionWorld，禁止 import fs」，
// 落附件库是 imageIntake 中间件的事（ADR-0144 决定二）。
//
// base64 解码用 Buffer：这是 src/tools 层，允许（同 mcpTool.imagesOf）。放不进
// src/shared —— 手机端 import 同一份源码，而 RN 上没有 Buffer。

import { BILLING_HEADERS } from "../shared/billing.js";
import type { TokenUsage } from "../session/events.js";
import type { Tool, ToolBilling, ToolImage } from "./tool.js";
import type { ExecutionWorld } from "../world/executionWorld.js";

/** 出图比一次 chat 慢一个量级：实测 `gemini-3.1-flash-image` 10.4s、
    `gpt-5-image-mini` 44.5s（#1081）。LocalWorld 默认 30s 会让后者永远超时，
    而那种失败在用户眼里是「说好了画，然后报了个网络错」。
    不放宽全局默认，只在这一次声明——见 HttpPostOptions.timeoutMs */
const IMAGE_TIMEOUT_MS = 180_000;

export interface GenerateImageDeps {
  /** 这把刀此刻进不进模型的工具表（**同步**，快照就能答：订阅 / 额度 / 网关供不供出图）。
      false = 工具表里根本没有它，于是模型不会先承诺一张画不出来的图再失败。
      故意是**粗**闸：拿 JWT、打网络这些只有到调用那一刻才知道，由 resolve 兜住 */
  mounted: () => boolean;
  /** 真要发请求时现解一次路：端点 + 一份算好的头 + 点名哪款逻辑型号。
      身份怎么证明由装配根决定（ADR-0244「那一层收的是一份算好的 headers」）。
      `blocked` = 走不通的原因，措辞照 ADR-0248 那张四分表 —— 这一层不知道用户
      订没订阅，也不该知道 */
  resolve: () => Promise<{ url: string; headers: Record<string, string>; model: string } | { blocked: string }>;
  /** 这个会话里最近一张图（用户刚贴的附件，或上次生成的产出）。`null` = 一张都没有。
      **图生图只有这一条入口**：模型看得见图，但看不见附件 id —— `deriveMessages` 把
      附件折成 `image_ref` part，id 不进模型正文，所以它没有办法「点名那一张」。
      工作区文件路径那条路没做：`world.fs.read` 只回 string，读 PNG 会烂码 */
  latestImage: () => Promise<{ data: Uint8Array; mimeType: string } | null>;
}

/** `/images` 的回包（#1086）：`{created, data:[{b64_json, media_type}], usage}`。
    与 `/chat/completions` 那套 `choices[].message.images[].image_url.url` 不是一个形状 */
interface OrImage { b64_json?: unknown; media_type?: unknown }
interface OrReply { data?: OrImage[]; usage?: unknown }

/** 回包里的 usage（OpenAI 蛇形）折成日志里的 TokenUsage（驼峰）。字段与网关那份
    parseUsage 同源（ADR-0261：两条端点的 usage 形状逐字相同），但刻意不共享代码——
    那份在 services/edge，这一层够不着；字段就这四个，各读各的。
    一处刻意不同：cached 缺席就**缺席**，不像网关那份补 0——日志里「这家不报 cache」
    与「报了但没中」是两个事实（issue #213），记账不在乎的区别，日志在乎 */
function parseImageUsage(v: unknown): TokenUsage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  if (typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  const details =
    typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  const cached =
    typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens
    : details && typeof details.cached_tokens === "number" ? details.cached_tokens
    : undefined;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
  };
}

/** 回包里的一张 → 字节。认不出的形状回 null（跳过这一张，不炸整次调用，
    同 mcpTool.imagesOf 的立场）。Buffer.from 对坏 base64 是静默截断而不是抛错，
    空结果是唯一能查的信号。
    `media_type` 缺席时按 png：上游七款里实测回的是 `image/png` 或 `image/jpeg`，
    但这一格是可选的，猜错的代价只是附件卡的扩展名，猜「没有图」的代价是整次调用失败 */
function decodeImage(img: OrImage): ToolImage | null {
  if (typeof img.b64_json !== "string" || img.b64_json === "") return null;
  const data = Buffer.from(img.b64_json, "base64");
  if (data.byteLength === 0) return null;
  return { data: new Uint8Array(data), mimeType: typeof img.media_type === "string" ? img.media_type : "image/png" };
}

const dataUrlOf = (img: { data: Uint8Array; mimeType: string }): string =>
  `data:${img.mimeType};base64,${Buffer.from(img.data).toString("base64")}`;

export function createGenerateImageTool(deps: GenerateImageDeps): Tool {
  return {
    def: {
      name: "generate_image",
      description:
        "生成一张图片并显示给用户。edit_last=true 时以会话里最近那张图为底改（用户刚贴的图、或上一次生成的图）",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "画什么。描述得越具体越好；改图时描述要改成什么样" },
          edit_last: { type: "boolean", description: "以会话里最近那张图为底改，默认 false（从零画）" },
        },
        required: ["prompt"],
      },
    },
    requiresApproval: false, // 同 web_search：纯外呼、无本地副作用（它也花钱）
    parallelSafe: true,
    available: () => deps.mounted(),

    async run(args, world: ExecutionWorld) {
      const { prompt, edit_last } = args as { prompt?: unknown; edit_last?: unknown };
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("generate_image: 参数 prompt 必须是非空字符串");
      }

      // 走不通就在这儿收口，**一个字节都不发**：网络先打出去再失败，钱可能已经花了，
      // 而这条路径的全部意义就是「这次不该发生」
      const route = await deps.resolve();
      if ("blocked" in route) throw new Error(route.blocked);
      const { url, headers, model } = route;

      // 底图（图生图）走 `input_references`，不是塞进 messages（#1086）
      let refs: { type: "image_url"; image_url: { url: string } }[] | null = null;
      if (edit_last === true) {
        const base = await deps.latestImage();
        // 没有底图时不能照发：那样得到的是一张凭空捏的图，而用户以为你改了他那张
        if (base === null) throw new Error("generate_image: 这个会话里还没有图可改，先生成一张或让用户贴一张");
        refs = [{ type: "image_url", image_url: { url: dataUrlOf(base) } }];
      }

      // **不带 stream**：网关对流式那条路会强塞 stream_options.include_usage 并旁路
      // 挑 usage，而出图是一次性 JSON，走非流式那条分支才对得上
      const body = { model, prompt, ...(refs ? { input_references: refs } : {}) };
      // 这次调用的账（#1084）：usage 在 body 里；结算的 credit 在响应头
      // （x-otto-cost-micro，非流式，ADR-0211）——世界读得到响应头才拿得到它，
      // 读不到（旧实现/测试假 world）就按「没记到」处理：creditCostMicro 缺席 ≠ 0
      let data: OrReply;
      let costHeader: string | undefined;
      if (world.http.postJsonWithHeaders) {
        const res = await world.http.postJsonWithHeaders(url, body, { headers, timeoutMs: IMAGE_TIMEOUT_MS });
        data = res.body as OrReply;
        costHeader = res.headers[BILLING_HEADERS.cost];
      } else {
        data = (await world.http.postJson(url, body, { headers, timeoutMs: IMAGE_TIMEOUT_MS })) as OrReply;
      }

      const images: ToolImage[] = [];
      for (const img of data.data ?? []) {
        const decoded = decodeImage(img);
        if (decoded) images.push(decoded);
      }

      if (images.length === 0) {
        // 一张图都没有是**真结局**（内容政策拒绝最常见），不是「成功但没图」。
        // `/images` 的回包里没有一格「模型说了什么」（chat 那条有 `message.content`，
        // 拒绝的理由常常写在那儿）—— 这条端点换来七款可用，代价是拒绝时说不出原因
        throw new Error("generate_image: 上游没有返回图片（最常见的原因是内容政策拒绝，换个说法再试）");
      }

      // 出图的钱：usage 缺席 = 回包没报数，整条账不带（deriveUsage 的规矩：
      // usage 缺省的事件不算账——没记 ≠ 没花）。route 恒 hosted：出图没有
      // direct 这一档（ADR-0257），走通了就是托管
      const usage = parseImageUsage(data.usage);
      const costMicro = costHeader === undefined ? undefined : Number(costHeader);
      const billing: ToolBilling | undefined = usage
        ? {
            model,
            usage,
            route: "hosted",
            ...(costMicro !== undefined && Number.isFinite(costMicro) && costMicro >= 0
              ? { creditCostMicro: costMicro }
              : {}),
          }
        : undefined;

      return {
        // 模型看到的只有这句话（ADR-0144 §范围外）。**必须说清它自己看不到内容**，
        // 否则它会以为这次调用什么都没产出，转头再画一次
        output: `已生成 ${images.length} 张图并显示给用户。你自己看不到图的内容，但可以就它和用户对话；要改这张图就再调一次并带上 edit_last: true。`,
        images,
        ...(billing ? { billing } : {}),
      };
    },
  };
}
