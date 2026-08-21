// attachmentIntake — ＋ 按钮选中文件的分类闸门(纯逻辑,fs 由调用方喂 bytes)。
// 四路出口:图片(嗅探认得)→ 入附件库返 ref+预览;文档(容器签名认得)→ 转 Markdown
// 后并入文本那条路(ADR-0046);文本(可 UTF-8、无 \0)→ 内容直接带走(发送时内联进
// 消息,不入库);其余 → rejected 带人话理由。

import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";
import { AttachmentStore, detectImageType, stripToBasename } from "../session/attachments.js";
import type { StagedAttachment } from "../shared/shellBridge.js";

export const TEXT_MAX_BYTES = 100 * 1024;

/** anydoc 的 ConvertErrorCode → 人话。用户看得懂才知道下一步该干什么。
    unsupported 不在这张表里:它的说法要看格式,见 reasonFor */
const CONVERT_REASON: Record<string, string> = {
  malformed: "文档结构损坏,抽不出内容",
  encrypted: "文档有密码保护,请先解除加密再传",
  resourceLimit: "文档嵌套/体积超出安全解析上限",
  missingPart: "文档缺少必要的组成部分,可能没保存完整",
  io: "文档读取失败",
};

export async function intakeFile(
  path: string,
  data: Uint8Array,
  store: AttachmentStore
): Promise<StagedAttachment> {
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

  // 文档必须判在 \0 嗅探之前:docx 是 zip、pdf 头是 %PDF,两者都含 \0,
  // 放到后面等于永远走不到这条路。
  // 只认容器签名,不按扩展名回退:签名认不出的都是纯文本(csv/md/txt),
  // 它们本来就走得通,转成 GFM 表格反而撑大体积、可能顶出 100KB 上限
  const format = formatFromBytes(data);
  if (format !== null) {
    return convertDocument(data, format, name);
  }

  // 头 8KB 含 \0 = 不是文本。图片、文档之外的二进制不收
  if (data.subarray(0, 8192).includes(0)) {
    return { kind: "rejected", name, reason: "二进制文件(图片和文档之外的二进制不支持)" };
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

/** 转 Markdown 并入文本出口。失败一律降级成 rejected —— 转换器不该炸穿闸门 */
async function convertDocument(
  data: Uint8Array,
  format: NonNullable<ReturnType<typeof formatFromBytes>>,
  name: string
): Promise<StagedAttachment> {
  let markdown: string;
  try {
    markdown = await toMarkdownBytes(data, format);
  } catch (e) {
    return { kind: "rejected", name, reason: reasonFor((e as { code?: string }).code, format) };
  }
  if (markdown.trim() === "") {
    // 给模型一份空文件,比告诉用户"没转出东西"更糟
    return { kind: "rejected", name, reason: "文档转换后没有任何文字内容" };
  }
  // 上限判的是 md 的长度,不是原文件的:3MB 的 pptx 可能只转出 8KB 文字
  const bytes = new TextEncoder().encode(markdown).byteLength;
  if (bytes > TEXT_MAX_BYTES) {
    return {
      kind: "rejected", name,
      reason: `文档转成文本后超过 100KB 上限(实际 ${(bytes / 1024).toFixed(0)}KB)`,
    };
  }
  return { kind: "text", name, content: markdown, bytes };
}

function reasonFor(code: string | undefined, format: string): string {
  if (code === "unsupported") {
    // 已经过了 formatFromBytes,格式是认得的 —— 这里的 unsupported 只剩
    // "认得但转不动",文档记的唯一情形就是没有文本层的 PDF
    return format === "pdf"
      ? "这个 PDF 没有文本层(扫描件/图片型),需要 OCR 才能读,本期不支持"
      : `这份 ${format} 文档抽不出可读内容`;
  }
  return (code && CONVERT_REASON[code]) ?? `文档转换失败(${format})`;
}
