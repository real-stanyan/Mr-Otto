// visionBridge — 无视觉模型的代读员(见 docs/adr/0009 追记)。
// 当前模型没眼睛而消息带图时,发送路径先请目录里的视觉款把图读成文字,
// 解析落 image_described 事件再喂当前模型。复用 openaiCompatible adapter:
// 代读就是一次普通的非流式 vision 调用,不新增方言。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { findModel } from "../shared/modelCatalog.js";
import { DEFAULT_VISION_MODEL } from "../shared/visionModel.js";
import type { UserAttachmentRef } from "../session/events.js";

/** 429 重试节奏(ms)。免费档高峰限流是瞬态错(智谱 code 1305「访问量过大」),
    实测高峰期逐次成功率仅 ~1/3,两段退避常耗尽——加密到五段(总窗 ~35s)
    穿过拥堵;放弃后照旧 turn 失败,用户看得到原始错误 */
const RETRY_DELAYS_MS = [1500, 3000, 6000, 10000, 15000];

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
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey: process.env[choice.apiKeyEnv] ?? "",
      model: choice.model,
      vision: true,
      readAttachment,
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
        // 只重试 429(免费档高峰限流,瞬态);其他错误(401 无 key/400/断网)重试无意义
        const msg = e instanceof Error ? e.message : String(e);
        const delay = RETRY_DELAYS_MS[attempt];
        if (!/API 429/.test(msg) || delay === undefined) throw e;
        await sleep(delay);
      }
    }
  };
}
