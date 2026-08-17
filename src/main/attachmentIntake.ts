// attachmentIntake — ＋ 按钮选中文件的分类闸门(纯逻辑,fs 由调用方喂 bytes)。
// 三路出口:图片(嗅探认得)→ 入附件库返 ref+预览;文本(可 UTF-8、无 \0)→
// 内容直接带走(发送时内联进消息,不入库);其余 → rejected 带人话理由。

import { AttachmentStore, detectImageType, stripToBasename } from "../session/attachments.js";
import type { StagedAttachment } from "../shared/shellBridge.js";

export const TEXT_MAX_BYTES = 100 * 1024;

export function intakeFile(path: string, data: Uint8Array, store: AttachmentStore): StagedAttachment {
  const name = stripToBasename(path) ?? "(未命名)";
  const imageType = detectImageType(data);
  if (imageType) {
    try {
      const ref = store.save(data, path);
      return {
        kind: "image",
        ref,
        previewDataUrl: `data:${imageType};base64,${Buffer.from(data).toString("base64")}`,
      };
    } catch (e) {
      // 超限等入库拒绝:转成分类结果——一个坏文件不该炸掉整次多选
      return { kind: "rejected", name, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  // 二进制嗅探:头 8KB 含 \0 = 不是文本。图片之外的二进制本期不收(spec 明确不做)
  if (data.subarray(0, 8192).includes(0)) {
    return { kind: "rejected", name, reason: "二进制文件(图片之外的二进制本期不支持)" };
  }
  if (data.byteLength > TEXT_MAX_BYTES) {
    return {
      kind: "rejected", name,
      reason: `文本文件超过 100KB 上限(实际 ${(data.byteLength / 1024).toFixed(0)}KB)`,
    };
  }
  return {
    kind: "text",
    name,
    content: new TextDecoder().decode(data),
    bytes: data.byteLength,
  };
}
