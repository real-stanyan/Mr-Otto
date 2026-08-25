// 选文件 / 读字节。**只有这一层碰原生模块**,分片和上限在 shared/remote/uploads.ts,
// 跟着根门禁跑。
//
// 两个原生模块,不是三个:expo-file-system 从 SDK 57 起自带 File.pickFileAsync,
// expo-document-picker 是多余的一层。
//
// **为什么全是 require 不是 import**:原生模块的 JS 在 import 时就会去要对应的
// 原生实现,而原生实现只有重新 build 装机才有。写成顶层 import 的话,一个还没
// 重 build 的机器上整个 app 一打开就白屏 —— 一个还没做完的功能不该把已经能用的
// 那些一起带走。放进 try/catch 里现要,拿不到就只是这一个按钮不能用。

import { UPLOAD_LIMITS } from "../../src/shared/remote/uploads.js";

/** 挑好的一个文件。字节按需再读 —— 选完不一定会发,先读进内存是白读 */
export interface Picked {
  /** 系统给的临时 uri */
  uri: string;
  name: string;
  /** 字节数。**先拿它挡一道**:传到一半才被桌面拒收,前面那几十秒是白等的 */
  bytes: number;
}

/** 原生那半边还没装机。**不是 bug,是"这个 build 里没有这个功能"** */
export class NeedsRebuild extends Error {
  constructor() {
    super("这个功能要重新装机才有(npx expo run:ios --device)");
    this.name = "NeedsRebuild";
  }
}

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

/** File 实例 → Picked。名字取不到就从 uri 末段兜(桌面那侧还会再 stripToBasename 一次) */
function describe(f: any): Picked {
  const uri = String(f.uri);
  const tail = decodeURIComponent(uri.split("/").pop() ?? "") || "(未命名)";
  return { uri, name: String(f.name ?? tail), bytes: Number(f.size ?? 0) };
}

/** 相册。quality 0.7 是有意的:iPhone 一张原图几 MB,而这条路要过公网 +
    中继的分片。压过之后一般一两 MB,落在上限里 */
export async function pickPhotos(): Promise<Picked[]> {
  const ip = imagePicker();
  const r = await ip.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: UPLOAD_LIMITS.maxPending,
    quality: 0.7,
  });
  if (r.canceled) return [];
  return describeAssets(r.assets);
}

/** 拍一张。权限被拒 = 回空,不抛 —— 用户按了"不允许"是个决定,不是故障 */
export async function takePhoto(): Promise<Picked[]> {
  const ip = imagePicker();
  const perm = await ip.requestCameraPermissionsAsync();
  if (!perm.granted) return [];
  const r = await ip.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 });
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
    return { uri, name: String(a.fileName ?? tail), bytes };
  });
}

export async function pickFiles(): Promise<Picked[]> {
  const { File } = fileSystem();
  const r = await File.pickFileAsync({ multipleFiles: true });
  if (r.canceled || !r.result) return [];
  return (r.result as any[]).map(describe);
}

export async function readBytes(uri: string): Promise<Uint8Array> {
  const { File } = fileSystem();
  return new Uint8Array(await new File(uri).bytes());
}

/** 选的时候就能判掉的那一类。传到一半才被桌面拒收,前面几十秒是白等的 */
export function tooBig(p: Picked): boolean {
  return p.bytes > UPLOAD_LIMITS.maxBytes;
}

export const MAX_MB = Math.round(UPLOAD_LIMITS.maxBytes / 1024 / 1024);
