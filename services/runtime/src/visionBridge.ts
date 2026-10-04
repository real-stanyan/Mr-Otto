// 无视觉模型的代读员，runtime 这一份（#1491 P4，ADR-0349；桌面那份在 src/main/visionBridge.ts）。
//
// 云会话里某只 agent 的型号看不了图，而这一轮它要读的发言里带图 → 起跑前先请网关供的最便宜那款带眼睛的
// 型号把图读成文字，落一条 `image_described{agentId, forSeq}`，再起 turn（model-visible means logged）。
// 调用走托管 adapter（createHostedRuntimeAdapter：同一套 on-behalf / workspace / session 头，账记在所有者名下），
// 非流式、不带工具：代读没有直播价值。
//
// 与桌面不同：**代读失败不让 turn 失败**。桌面是一人一机，失败了人自己换型号重发；群里一只 agent 的代读员
// 抖一下不该把整条接力链卡死——退回 openaiCompatible 的占位文字（它明说「当前模型不支持直接查看」，不是
// 装看过），并在群里落一句系统旁白说清是看图模型没读出来。
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { UserAttachmentRef } from "../../../src/session/events.js";
import { findModel } from "../../../src/shared/modelCatalog.js";
import { DEFAULT_VISION_MODEL, visionModelFor } from "../../../src/shared/visionModel.js";

/** 网关此刻供的清单里，挑给这个所有者的代读员；一款带眼睛的都没供 → null */
export function bridgeModelFor(hosted: readonly string[]): string | null {
  const m = visionModelFor(DEFAULT_VISION_MODEL, hosted, true);
  return hosted.includes(m) && findModel(m)?.supportsVision === true ? m : null;
}

/** 代读的提示词：与桌面那份逐字同一段（两边读图的口径要一样） */
export function describePrompt(userText: string): string {
  return (
    "请逐张仔细解析以下图片(文字内容、版面结构、图表数据、关键细节)。" +
    "解析结果将提供给一个看不到图片的模型,由它回答用户的问题——" +
    "只做客观解析,不要代替它回答。用户的问题:\n" + userText
  );
}

export interface Described {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
  creditCostMicro?: number;
}

export async function describeImagesWith(adapter: ModelAdapter, refs: readonly UserAttachmentRef[], userText: string): Promise<Described> {
  const reply = await adapter.chat([
    {
      role: "user",
      content: [
        { type: "text", text: describePrompt(userText) },
        ...refs.map((r) => ({ type: "image_ref" as const, id: r.id, mediaType: r.mediaType })),
      ],
    },
  ]);
  if (!reply.content.trim()) throw new Error("视觉模型没有产出图片解析");
  return {
    content: reply.content,
    ...(reply.usage ? { usage: reply.usage } : {}),
    ...(reply.creditCostMicro !== undefined ? { creditCostMicro: reply.creditCostMicro } : {}),
  };
}
