// visionBridge — 无视觉模型的代读员(见 docs/adr/0009 追记)。
// 当前模型没眼睛而消息带图时,发送路径先请目录里的视觉款把图读成文字,
// 解析落 image_described 事件再喂当前模型。复用 openaiCompatible adapter:
// 代读就是一次普通的非流式 vision 调用,不新增方言。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { findModel } from "../shared/modelCatalog.js";
import type { UserAttachmentRef } from "../session/events.js";

/** 代读员型号:目录里的免费视觉款。换代读员改这一行 */
export const VISION_BRIDGE_MODEL = "glm-4.6v-flash";

/** 组装根注入附件读取器,返回代读函数。
    userText 一并交给视觉模型——带着问题读图,解析才有针对性,不是干巴巴 OCR */
export function createVisionBridge(readAttachment: (id: string) => Uint8Array) {
  return async function describeImages(
    refs: UserAttachmentRef[],
    userText: string
  ): Promise<string> {
    const choice = findModel(VISION_BRIDGE_MODEL);
    if (!choice) throw new Error(`vision-bridge 型号不在目录: ${VISION_BRIDGE_MODEL}`);
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey: process.env[choice.apiKeyEnv] ?? "",
      model: choice.model,
      vision: true,
      readAttachment,
    });
    // 非流式、不带工具:代读没有直播价值,结果整段落事件
    const reply = await adapter.chat([
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "请逐张仔细解析以下图片(文字内容、版面结构、图表数据、关键细节)。" +
              "解析结果将提供给一个看不到图片的模型,由它回答用户的问题——" +
              "只做客观解析,不要代替它回答。用户的问题:\n" + userText,
          },
          ...refs.map((r) => ({ type: "image_ref" as const, id: r.id, mediaType: r.mediaType })),
        ],
      },
    ]);
    if (!reply.content.trim()) throw new Error("视觉模型没有产出图片解析,turn 已放弃");
    return reply.content;
  };
}
