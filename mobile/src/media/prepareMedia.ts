// 从相册挑 / 当场拍的图片和视频，变成可以传的本机文件（#1443 P1，ADR-0343）。判据都在 src/shared/chatMedia.ts：
// · 图片：JPEG/PNG 且长边 ≤2048、≤4MB 的原样传；否则（HEIC、原图 4032px、超大）沿 imageFit 的阶梯重编码成 JPEG，
//   每级量真实字节数，够小就停。用文件 URI 来回，不把原图读进 JS 内存。
// · 视频：≤60 秒、≤50MB、MP4/MOV；用 expo-video 抽第一帧当封面（抽不出来不拦，气泡画一块底色加播放钮）。
//   挑相册时让系统转成 H.264 1280×720（Passthrough 的 4K 一分钟有几百 MB），拍摄用 Medium 档。
import { createVideoPlayer } from "expo-video";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
  MEDIA_MAX_PER_MESSAGE, POSTER_MAX_EDGE, VIDEO_MAX_MS, fitImageSteps, imageNeedsReencode, videoProblem,
  type PreparedMedia,
} from "../../../src/shared/chatMedia.js";

/** 挑 / 拍出来的一样，还没处理 */
export type PickedAsset = ImagePicker.ImagePickerAsset;

const LIBRARY_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images", "videos"],
  allowsMultipleSelection: true,
  selectionLimit: MEDIA_MAX_PER_MESSAGE,
  orderedSelection: true,
  videoMaxDuration: VIDEO_MAX_MS / 1000,
  videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
  quality: 1,
};

/** 打开相册。取消回 []（不是错） */
export async function pickFromLibrary(): Promise<PickedAsset[]> {
  const r = await ImagePicker.launchImageLibraryAsync(LIBRARY_OPTIONS);
  return r.canceled ? [] : r.assets;
}

/** 打开相机（拍照或录像）。没给相机权限抛一句人话；取消回 [] */
export async function pickFromCamera(): Promise<PickedAsset[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("没有相机权限，去「设置 → Otto」里打开");
  const r = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images", "videos"],
    videoMaxDuration: VIDEO_MAX_MS / 1000,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    quality: 1,
  });
  return r.canceled ? [] : r.assets;
}

export function pickedKind(a: PickedAsset): "image" | "video" {
  return a.type === "video" || a.type === "pairedVideo" ? "video" : "image";
}

function sizeOf(uri: string): number {
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

/** 系统没给 mimeType 时按扩展名猜（相机拍的常常不带） */
function mimeOf(a: PickedAsset): string | undefined {
  if (a.mimeType !== undefined && a.mimeType !== "") return a.mimeType.toLowerCase();
  const name = (a.fileName ?? a.uri).toLowerCase();
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (/\.png$/.test(name)) return "image/png";
  if (/\.(heic|heif)$/.test(name)) return "image/heic";
  if (/\.mp4$/.test(name)) return "video/mp4";
  if (/\.mov$/.test(name)) return "video/quicktime";
  return undefined;
}

async function prepareImage(a: PickedAsset): Promise<PreparedMedia> {
  const mime = mimeOf(a);
  const bytes = a.fileSize ?? (sizeOf(a.uri) || undefined);
  if (!imageNeedsReencode({ mimeType: mime, bytes, width: a.width, height: a.height }) && mime !== undefined && bytes !== undefined) {
    return { kind: "image", uri: a.uri, mediaType: mime, bytes, width: a.width, height: a.height };
  }
  const long = Math.max(a.width, a.height);
  const r = await fitImageSteps(async (edge, quality) => {
    let ctx = ImageManipulator.manipulate(a.uri);
    // 只缩不放；宽高读不出（0）时按长边缩一次，比原样传一张不知道多大的图稳
    if (long === 0 || long > edge) ctx = ctx.resize(a.width >= a.height ? { width: edge } : { height: edge });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    return { bytes: sizeOf(out.uri), out };
  });
  if (r.kind === "stillTooBig") throw new Error("这张图太大了，压不下来，换一张试试");
  return { kind: "image", uri: r.out.uri, mediaType: "image/jpeg", bytes: sizeOf(r.out.uri), width: r.out.width, height: r.out.height };
}

/** 等播放器把视频加载好（readyToPlay）。刚建出来就抽帧会扑空：相册里的 4K 原片加载要一两秒（#1480 真机上封面是黑块） */
function whenReady(player: ReturnType<typeof createVideoPlayer>, ms: number): Promise<void> {
  if (player.status === "readyToPlay") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      sub.remove();
      reject(new Error("timeout"));
    }, ms);
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") {
        clearTimeout(t);
        sub.remove();
        resolve();
      } else if (status === "error") {
        clearTimeout(t);
        sub.remove();
        reject(new Error("error"));
      }
    });
  });
}

/** 抽封面：等播放器加载好，再用 expo-video 的 generateThumbnailsAsync 抽第一帧，交给 ImageManipulator 存成 JPEG。
    加载 + 抽帧最多 8 秒，抽不出来就算了（不拦发送，气泡画一块底色加播放钮） */
async function posterOf(uri: string): Promise<string | undefined> {
  const player = createVideoPlayer(uri);
  try {
    await whenReady(player, 6000);
    const thumbs = await Promise.race([
      player.generateThumbnailsAsync(0.1, { maxWidth: POSTER_MAX_EDGE, maxHeight: POSTER_MAX_EDGE }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    const t = thumbs[0];
    if (t === undefined) return undefined;
    const img = await ImageManipulator.manipulate(t).renderAsync();
    const out = await img.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
    return out.uri;
  } catch {
    return undefined;
  } finally {
    player.release();
  }
}

async function prepareVideo(a: PickedAsset): Promise<PreparedMedia> {
  const mime = mimeOf(a);
  const bytes = a.fileSize ?? (sizeOf(a.uri) || undefined);
  const problem = videoProblem({ durationMs: a.duration, bytes, mimeType: mime });
  if (problem !== null) throw new Error(problem);
  const poster = await posterOf(a.uri);
  return {
    kind: "video", uri: a.uri, mediaType: mime ?? "video/mp4", bytes: bytes ?? sizeOf(a.uri), width: a.width, height: a.height,
    durationMs: Math.round(a.duration ?? 0),
    ...(poster !== undefined ? { posterUri: poster } : {}),
  };
}

export async function prepareAsset(a: PickedAsset): Promise<PreparedMedia> {
  return pickedKind(a) === "video" ? prepareVideo(a) : prepareImage(a);
}

/** 本地气泡（还没传完时）用哪个 URI 画：图片画它自己，视频画封面 */
export function previewUri(p: PreparedMedia): string | undefined {
  return p.kind === "image" ? p.uri : p.posterUri;
}

