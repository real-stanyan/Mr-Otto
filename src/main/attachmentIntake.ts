// attachmentIntake — ＋ 按钮选中文件的分类闸门(纯逻辑,fs 由调用方喂 bytes)。
// 四路出口:图片(嗅探认得)→ 缩到能送出去的尺寸后入附件库返 ref+预览;文档(容器
// 签名认得)→ 转 Markdown 后并入文本那条路(ADR-0046);文本(可 UTF-8、无 \0)→
// 内容直接带走(发送时内联进消息,不入库);其余 → rejected 带人话理由。
//
// 图片那条出口为什么要缩:见 shared/imageFit.ts 的文件头(issue #882)。
// 编解码由调用方注入(encode),这一层继续不碰 electron —— 它是有单元测试的纯逻辑。

import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";
import {
  AttachmentStore, IMAGE_MAX_BYTES, detectImageType, stripToBasename,
} from "../session/attachments.js";
import {
  IMAGE_FIT_TARGET_BYTES, asJpegName, fitImage, type FitEncoder,
} from "../shared/imageFit.js";
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
  store: AttachmentStore,
  /** 缩图用的编解码器。**必填**——给个默认值等于"忘了接线时静默不缩",
      而那个失败模式是无症状的:用户只会看到一条"图片太大" */
  encode: FitEncoder
): Promise<StagedAttachment> {
  const name = stripToBasename(path) ?? "(未命名)";
  const imageType = detectImageType(data);
  if (imageType) return intakeImage(path, name, data, imageType, store, encode);

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

/**
 * 图片出口。超上限的先缩再入库,缩不动才拒 —— 一张能用的图不该因为大了一圈
 * 就变成用户的问题(issue #882)。
 *
 * 三种结局各有各的说法:
 *   缩过了      → 名字改成 .jpg(文件已经是 JPEG 了,名字还挂着 .png 会骗到人)
 *   格式解不了  → 原样入库,能不能过交给 AttachmentStore 的 10MB 上限;
 *                 超了的话理由要说"压不动这个格式",不是干巴巴一句"太大"
 *   压到底还超  → 拒,并报最小那一版的真实字节数
 */
async function intakeImage(
  path: string,
  name: string,
  data: Uint8Array,
  imageType: string,
  store: AttachmentStore,
  encode: FitEncoder
): Promise<StagedAttachment> {
  try {
    const fit = await fitImage(data, IMAGE_FIT_TARGET_BYTES, encode);
    if (fit.kind === "stillTooBig") {
      return {
        kind: "rejected", name,
        reason: `图片压到最小仍有 ${mb(fit.bytes)}MB,超过 ${mb(IMAGE_FIT_TARGET_BYTES)}MB 上限`,
      };
    }
    if (fit.kind === "undecodable" && data.byteLength > IMAGE_MAX_BYTES) {
      return {
        kind: "rejected", name,
        reason: `${imageType} 有 ${mb(data.byteLength)}MB,而本机压不动这个格式——转存成 png/jpg 再传`,
      };
    }
    const shrunk = fit.kind === "shrunk";
    const bytes = shrunk ? fit.data : data;
    // mediaType 一律取 ref 上那个:它是 store 按最终字节的签名重新认的,
    // 比这里从入参推更可信(转码之后 imageType 已经过期了)
    const ref = store.save(bytes, shrunk ? asJpegName(path) : path);
    return {
      kind: "image",
      ref,
      previewDataUrl: `data:${ref.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  } catch (e) {
    // 入库拒绝/解码器抛:转成分类结果——一个坏文件不该炸掉整次多选
    return { kind: "rejected", name, reason: e instanceof Error ? e.message : String(e) };
  }
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

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
  // 两个字节数含义不同,别混:
  // markdownBytes 是准入判据 —— 3MB 的 pptx 可能只转出 8KB 文字,
  //   上限管的是喂给模型的那份,按原文件大小拒它没道理
  // bytes 是展示口径 —— 用户丢进来的是那个 docx,界面上就该显示那个大小。
  //   转换是内部优化,不该从一个奇怪的小数字里漏出去
  const markdownBytes = new TextEncoder().encode(markdown).byteLength;
  if (markdownBytes > TEXT_MAX_BYTES) {
    return {
      kind: "rejected", name,
      reason: `文档转成文本后超过 100KB 上限(实际 ${(markdownBytes / 1024).toFixed(0)}KB)`,
    };
  }
  return { kind: "text", name, content: markdown, bytes: data.byteLength };
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
