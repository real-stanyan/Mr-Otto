// visionBridge — 无视觉模型的代读员(见 docs/adr/0009 追记)。
// 当前模型没眼睛而消息带图时,发送路径先请目录里的视觉款把图读成文字,
// 解析落 image_described 事件再喂当前模型。复用 openaiCompatible adapter:
// 代读就是一次普通的非流式 vision 调用,不新增方言。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { errorClassOf, markErrorClass } from "../model/errorClass.js";
import { routeModel } from "./modelRoute.js";
import { findModel } from "../shared/modelCatalog.js";
import { DEFAULT_VISION_MODEL } from "../shared/visionModel.js";
import type { UserAttachmentRef } from "../session/events.js";

/** 429 重试节奏(ms)。免费档高峰限流是瞬态错(智谱 code 1305「访问量过大」),
    实测高峰期逐次成功率仅 ~1/3,两段退避常耗尽——加密到五段(总窗 ~35s)
    穿过拥堵;放弃后照旧 turn 失败,用户看得到原始错误 */
const RETRY_DELAYS_MS = [1500, 3000, 6000, 10000, 15000];

/** 代读失败的戳。渲染层剥壳时据此说清"报错的是看图模型,不是你正在用的这款"
    (renderer/lib/modelError.ts)。只加前缀不改原文——上游那句原话是排查时
    唯一能信的东西,得原样落进 turn_ended.error */
function brandBridgeError(e: unknown, model: string): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.message.startsWith("vision-bridge(")) return err; // 别盖第二遍
  const branded = new Error(`vision-bridge(${model}) ${err.message}`, { cause: err });
  const cls = errorClassOf(err);
  return cls ? markErrorClass(branded, cls) : branded;
}

/** 组装根注入附件读取器,返回代读函数。
    userText 一并交给视觉模型——带着问题读图,解析才有针对性,不是干巴巴 OCR。
    sleep 可注入(测试不真等)。
    model 由调用方从设置现读传入(visionModelStore,默认免费视觉款)——这里
    不自己读盘:组装根决定配置从哪来,和 helperModel 在 index.ts 的用法同款 */
export function createVisionBridge(
  readAttachment: (id: string) => Uint8Array,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  model: string = DEFAULT_VISION_MODEL
) {
  return async function describeImages(
    refs: UserAttachmentRef[],
    userText: string
  ): Promise<string> {
    const choice = findModel(model);
    if (!choice) throw new Error(`vision-bridge 型号不在目录: ${model}`);
    // 没配代读员的 key 时别硬发:空 Bearer 打上去,上游回的是一句自己的鉴权
    // 文案(智谱是"令牌已过期或验证不正确")——用户看到的是"发不出去",却完全
    // 看不出坏的是代读员那把 key,而不是他正在用的那款模型的 key。
    // 走 modelRoute 这道既有的闸门,把"缺什么"在发请求之前说成人话
    const route = routeModel({
      choice,
      ownKey: process.env[choice.apiKeyEnv] ?? "",
      ownBaseUrl: process.env[choice.baseUrlEnv],
    });
    if (route.kind === "blocked") {
      throw new Error(
        `看图模型「${choice.label}」代读失败:${route.reason}` +
          "(当前模型看不了图,带图的消息要先请看图模型把图读成文字;" +
          "也可以在设置里把当前模型换成能直接看图的那款)"
      );
    }
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: choice.model,
      vision: true,
      readAttachment,
      // adapter 内建的通用重试（issue #283 ①）在这关掉：本文件的五段退避是给
      // 免费视觉档的高峰限流专门调的（总窗 ~35s），两层叠加会把等待时间乘起来
      timing: { maxAttempts: 1 },
    });
    // 非流式、不带工具:代读没有直播价值,结果整段落事件
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text:
              "请逐张仔细解析以下图片(文字内容、版面结构、图表数据、关键细节)。" +
              "解析结果将提供给一个看不到图片的模型,由它回答用户的问题——" +
              "只做客观解析,不要代替它回答。用户的问题:\n" + userText,
          },
          ...refs.map((r) => ({ type: "image_ref" as const, id: r.id, mediaType: r.mediaType })),
        ],
      },
    ];
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await adapter.chat(messages);
        if (!reply.content.trim()) throw new Error("视觉模型没有产出图片解析,turn 已放弃");
        return reply.content;
      } catch (e) {
        // 只重试限流(免费档高峰,瞬态);其他错误(401 无 key/400/断网)重试无意义。
        // 判据是抛错处贴的 errorClass(issue #389)——不再从错误文案里正则倒推,
        // 网关限流(人话文案,没有 "API 429" 字样)从此也能被认出来
        const delay = RETRY_DELAYS_MS[attempt];
        if (errorClassOf(e) !== "rate-limit" || delay === undefined) throw brandBridgeError(e, model);
        await sleep(delay);
      }
    }
  };
}
