// 选文件 / 读字节 / 发之前把图片调到能过的尺寸。
// **只有这一层碰原生模块**,分片和上限在 shared/remote/uploads.ts,跟着根门禁跑。
//
// 三个原生模块:
//   expo-image-picker      相册 / 拍照
//   expo-file-system       文件选择器(SDK 57 起自带,不用 expo-document-picker)+ 读字节
//   expo-image-manipulator 缩放 + 转码
//
// **为什么全是 require 不是 import**:原生模块的 JS 在 import 时就会去要对应的
// 原生实现,而原生实现只有重新 build 装机才有。写成顶层 import 的话,一个还没
// 重 build 的机器上整个 app 一打开就白屏 —— 一个还没做完的功能不该把已经能用的
// 那些一起带走。放进 try/catch 里现要,拿不到就只是这一个按钮不能用。

import { detectImageType } from "../../src/shared/images.js";
import { IMAGE_FIT_LADDER, asJpegName } from "../../src/shared/imageFit.js";
import { UPLOAD_LIMITS } from "../../src/shared/remote/uploads.js";

/** 挑好的一个文件。字节按需再读 —— 选完不一定会发,先读进内存是白读 */
export interface Picked {
  /** 系统给的临时 uri */
  uri: string;
  name: string;
  /** 字节数。0 = 量不到 */
  bytes: number;
  /** 从相册/相机来的,或者扩展名看着是图。**只有这一类能靠缩放救** */
  image: boolean;
  /** 像素尺寸,相册给的。文件选择器不给,那时按需现探 */
  width?: number;
  height?: number;
}

/** 原生那半边还没装机。**不是 bug,是"这个 build 里没有这个功能"** */
export class NeedsRebuild extends Error {
  constructor() {
    super("这个功能要重新装机才有(npx expo run:ios --device)");
    this.name = "NeedsRebuild";
  }
}

export class TooBig extends Error {}

// 缩放阶梯搬去了 src/shared/imageFit.ts —— 桌面那侧(issue #882)也要缩,
// 两边各写一张表的话,同一张照片从手机传和从桌面传会得到不同画质,
// 而这种差别没人会去查(同 shared/images.ts 那张签名表的理由)。
// **这里仍然自己走阶梯**:手机上缩图的是 expo-image-manipulator,它按 uri 工作、
// 顺带解 HEIC,和桌面那个按字节工作的编解码器不是同一台机器,共用的只有那张表。

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

// require 的参数必须是字面量:metro 靠静态分析决定打包哪些模块,
// 拼出来的名字它看不见,运行时就成了"找不到模块"
function fileSystem(): any {
  try {
    return require("expo-file-system");
  } catch {
    throw new NeedsRebuild();
  }
}

function imagePicker(): any {
  try {
    return require("expo-image-picker");
  } catch {
    throw new NeedsRebuild();
  }
}

function manipulator(): any {
  try {
    return require("expo-image-manipulator");
  } catch {
    throw new NeedsRebuild();
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

/** File 实例 → Picked。名字取不到就从 uri 末段兜(桌面那侧还会再 stripToBasename 一次) */
function describe(f: any): Picked {
  const uri = String(f.uri);
  const tail = decodeURIComponent(uri.split("/").pop() ?? "") || "(未命名)";
  const name = String(f.name ?? tail);
  return { uri, name, bytes: Number(f.size ?? 0), image: IMAGE_EXT.test(name) };
}

/** 相册。这里**不设 quality** —— 压缩交给发送前的阶梯统一做,
    在两处各压一次等于压两遍,画质白丢一道 */
export async function pickPhotos(): Promise<Picked[]> {
  const ip = imagePicker();
  const r = await ip.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: UPLOAD_LIMITS.maxPending,
  });
  if (r.canceled) return [];
  return describeAssets(r.assets);
}

/** 拍一张。权限被拒 = 回空,不抛 —— 用户按了"不允许"是个决定,不是故障 */
export async function takePhoto(): Promise<Picked[]> {
  const ip = imagePicker();
  const perm = await ip.requestCameraPermissionsAsync();
  if (!perm.granted) return [];
  const r = await ip.launchCameraAsync({ mediaTypes: ["images"] });
  if (r.canceled) return [];
  return describeAssets(r.assets);
}

/** ImagePicker 的 asset 没有可靠的 size,回头找 File 要一次 */
function describeAssets(assets: any[]): Picked[] {
  const { File } = fileSystem();
  return (assets ?? []).map((a: any) => {
    const uri = String(a.uri);
    const tail = decodeURIComponent(uri.split("/").pop() ?? "") || "photo.jpg";
    let bytes = Number(a.fileSize ?? 0);
    if (!bytes) {
      try {
        bytes = Number(new File(uri).size ?? 0);
      } catch {
        bytes = 0; // 量不到就交给发送时的真实字节数去挡
      }
    }
    return {
      uri,
      name: String(a.fileName ?? tail),
      bytes,
      image: true,
      width: Number(a.width) || undefined,
      height: Number(a.height) || undefined,
    };
  });
}

export async function pickFiles(): Promise<Picked[]> {
  const { File } = fileSystem();
  const r = await File.pickFileAsync({ multipleFiles: true });
  if (r.canceled || !r.result) return [];
  return (r.result as any[]).map(describe);
}

async function readBytes(uri: string): Promise<Uint8Array> {
  const { File } = fileSystem();
  return new Uint8Array(await new File(uri).bytes());
}

/**
 * 送去分片之前的最后一步。回来的字节就是要传的字节。
 *
 * 两件事在这里一起解决,因为它们的修法是同一个:
 *
 * 1. **iPhone 默认拍 HEIC,而桌面不认它**(src/shared/images.ts 的签名表里只有
 *    png/jpeg/gif/webp)。原样传上去会被当成"图片和文档之外的二进制"拒收 ——
 *    也就是说最常见的那条路本来是走不通的。
 * 2. **一张原图可能顶到上限。** 4032px 的照片有一多半字节花在模型不会看的细节上。
 *
 * 都用同一台机器:转成 JPEG,同时按阶梯降到能过为止。**每一级都量真实字节数**,
 * 不从像素尺寸去猜(同样 2048px,纯色图几十 KB,树叶几 MB)。
 *
 * 不是图片的(pdf/docx/txt)没有这条路可走:超了就是超了,当场说清楚,
 * 别让人等完一次上传再被拒。
 */
export async function prepareForUpload(p: Picked): Promise<{ name: string; data: Uint8Array }> {
  const cap = UPLOAD_LIMITS.maxBytes;
  let data = await readBytes(p.uri);

  // 桌面认得的格式 + 尺寸够小 = 原样走。**截图是 PNG,别白转一道 JPEG** ——
  // 手机上发的截图多半是报错信息,转 JPEG 会让小字糊掉
  if (detectImageType(data) && data.byteLength <= cap) return { name: p.name, data };

  if (!p.image) {
    if (data.byteLength > cap) throw new TooBig(`${p.name} 有 ${mb(data.byteLength)}MB,超过 ${MAX_MB}MB`);
    return { name: p.name, data }; // 格式对不对由桌面那道闸门说了算
  }

  const { manipulateAsync, SaveFormat } = manipulator();
  let { width, height } = p;
  if (!width || !height) {
    // 文件选择器不给尺寸。空动作跑一趟只为把尺寸问出来 —— 这条路只有
    // "从文件里挑的图,而且它需要处理"才会走到,不是常态
    const probe = await manipulateAsync(p.uri, [], { compress: 1, format: SaveFormat.JPEG });
    width = Number(probe.width) || 0;
    height = Number(probe.height) || 0;
  }
  const longEdge = Math.max(width, height);

  for (const step of IMAGE_FIT_LADDER) {
    // **只缩不放**:比目标还小的图硬拉到 2048 只会更大更糊
    const actions = longEdge > step.edge
      ? [width >= height ? { resize: { width: step.edge } } : { resize: { height: step.edge } }]
      : [];
    const r = await manipulateAsync(p.uri, actions, {
      compress: step.quality,
      format: SaveFormat.JPEG,
    });
    data = await readBytes(String(r.uri));
    if (data.byteLength <= cap) return { name: asJpegName(p.name), data };
  }
  throw new TooBig(`${p.name} 压到最小还有 ${mb(data.byteLength)}MB,超过 ${MAX_MB}MB`);
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

/**
 * 选的时候就该判掉的那一类:**只有非图片**。
 * 图片一律放行 —— 它有缩放这条路可走,在这儿按原图大小拒掉等于
 * 把一张能传的照片说成传不了。
 */
export function tooBig(p: Picked): boolean {
  return !p.image && p.bytes > UPLOAD_LIMITS.maxBytes;
}

export const MAX_MB = Math.round(UPLOAD_LIMITS.maxBytes / 1024 / 1024);
