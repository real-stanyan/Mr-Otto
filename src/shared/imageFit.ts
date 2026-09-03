// 图片"缩到能过为止"的那台机器 —— 纯逻辑,编解码由调用方注入。
//
// 为什么需要它:一张 11.7MB 的手机原图被 AttachmentStore 的上限当场拒掉
// (issue #882),而用户在 app 里没有下一步可做 —— 只能自己去别处压完再回来。
// 拒收本身没错,错的是把"这张图能不能用"当成用户的问题:图是能用的,只是
// 大了一圈,而缩它是一件机器该干的活。
//
// **上限定在 4MB 不是 10MB**:入库成功不等于送得到模型。Anthropic 单张图的
// API 上限是 5MB,一张 8MB 的图今天入库成功、发出去 400 —— 用户看到的是一条
// 与图片无关的报错。既然要缩,就该缩到真能送到那一端的数值;4MB 也正好是手机端
// 那条路早就在用的口径(shared/remote/uploads.ts 的 UPLOAD_LIMITS.maxBytes)。
//
// **阶梯与手机端共用一份**:两侧各写一张表的话,同一张照片在手机上传和在桌面上
// 传会得到不同画质,而这种差别没人会去查(同 shared/images.ts 那张签名表的理由)。
//
// 纯文件:不许 import node builtin / electron —— 手机端(Expo/RN)直接 import 这一份。

/** 缩到目标以下就停。见文件头:这是"送得到模型"的口径,不是"存得下"的口径 */
export const IMAGE_FIT_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * 缩放阶梯。**一级一级往下试,每级都量真实字节数** ——
 * 从像素尺寸预测 JPEG 大小是猜:同样 2048px,一张纯色图几十 KB,
 * 一张树叶几 MB。猜错的代价是用户白等一次,然后被告知传不了。
 *
 * 顶格 2048 是有意的:模型看图基本用不到更高,而 iPhone 原图 4032px
 * 有一多半的字节花在没人会看的细节上。
 */
export const IMAGE_FIT_LADDER: readonly { edge: number; quality: number }[] = [
  { edge: 2048, quality: 0.8 },
  { edge: 1600, quality: 0.7 },
  { edge: 1280, quality: 0.6 },
  { edge: 1024, quality: 0.5 },
];

/**
 * 按长边缩到 edge、以 quality(0..1)重编码成 JPEG。
 * **回 null = 这个格式解不了**(不是"这次失败了"):桌面侧的 Electron
 * nativeImage 只解 png/jpeg,webp/gif 进去出来是一张空图。
 * 只缩不放由实现负责 —— 比目标还小的图硬拉到 2048 只会更大更糊。
 */
export type FitEncoder = (
  data: Uint8Array,
  edge: number,
  quality: number
) => Promise<Uint8Array | null>;

/** 结果是 kind 不是 ok+reason:四种情形调用方要做四件不同的事,
    "成功了吗"这个问法答不了"该拿它怎么办"(同 ADR-0193 的立场) */
export type FitOutcome =
  /** 本来就够小,一个字节没动 —— 截图是 PNG,别白转一道 JPEG 把小字糊掉 */
  | { kind: "unchanged"; data: Uint8Array }
  /** 缩过了。from = 原始字节数,给界面/日志说清楚发生了什么 */
  | { kind: "shrunk"; data: Uint8Array; from: number }
  /** 解码器不认这个格式。调用方按"没有缩这条路"处理(原样交给原来的上限) */
  | { kind: "undecodable" }
  /** 压到阶梯最底一级仍然超。bytes = 最小那一版的字节数 */
  | { kind: "stillTooBig"; bytes: number };

export async function fitImage(
  data: Uint8Array,
  cap: number,
  encode: FitEncoder
): Promise<FitOutcome> {
  if (data.byteLength <= cap) return { kind: "unchanged", data };

  let smallest = data.byteLength;
  for (const step of IMAGE_FIT_LADDER) {
    const out = await encode(data, step.edge, step.quality);
    // null 只可能来自"格式不认",而格式不会在阶梯中途变 —— 第一级认不出
    // 后面几级也认不出,继续试只是白跑四趟
    if (out === null) return { kind: "undecodable" };
    if (out.byteLength <= cap) return { kind: "shrunk", data: out, from: data.byteLength };
    smallest = Math.min(smallest, out.byteLength);
  }
  return { kind: "stillTooBig", bytes: smallest };
}

/** 只改扩展名。转码之后文件就是 JPEG 了,名字还挂着 .png/.heic 会骗到人 */
export function asJpegName(name: string): string {
  return name.replace(/\.[^./\\]*$/, "") + ".jpg";
}
