// 聊天里发图片和视频（#1443，ADR-0343）的纯判据：上限、消息里那一格 media 的严格解析、占位正文、
// 存储路径、一次挑了好几样时拆成几条、图片要不要重编码与缩放阶梯、视频收不收、气泡尺寸。
//
// 文件本身放 Supabase Storage 的两个私有 bucket（migration 0052）：`dm-media`（朋友私聊）、`chat-media`
// （云会话，P2 起用）。消息里只带引用——朋友私聊是 messages.media（jsonb），云会话是事件里的引用。
//
// **纯媒体消息的正文写占位**（`[图片]` / `[视频]`，维护者拍板的第 3 条）：messages.body 那条 1..4000 的 check
// 一个字不动，老客户端、会话列表第二行（dmPreview）、推送正文（friendPushOf）都照常读 body，于是它们
// 自动显示成「[图片]」——降级是由构造保证的，不靠每个读者各自认得这一格。新客户端带着能解析的媒体、
// 且正文就是占位时才把字藏起来（`mediaBodyHidden`）；解析失败（形状不对）那条照旧画占位文字，说的仍是实话。
//
// 纯文件：不许 import node builtin / electron —— 手机端（Expo/RN）直接 import 这一份。
import { IMAGE_FIT_LADDER, IMAGE_FIT_TARGET_BYTES } from "./imageFit.js";

export const DM_MEDIA_BUCKET = "dm-media";
export const CHAT_MEDIA_BUCKET = "chat-media";

/** 一条消息最多几样（同微信九宫格）。migration 0052 的 check 写的是同一个数 */
export const MEDIA_MAX_PER_MESSAGE = 9;
/** 图片长边上限与字节上限：与 imageFit 同一份（「送得到模型」的口径，云会话那边模型要看这张图） */
export const IMAGE_MAX_EDGE = IMAGE_FIT_LADDER[0]?.edge ?? 2048;
export const IMAGE_MAX_BYTES = IMAGE_FIT_TARGET_BYTES;
/** 视频上限（维护者拍板的第 2 条）。50MB 也是 Supabase Free 档单文件的上限，bucket 的 file_size_limit 写同一个数 */
export const VIDEO_MAX_MS = 60_000;
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** 视频封面的长边。封面只画在气泡里（≤200pt）与给模型看（P2），720 够两样用 */
export const POSTER_MAX_EDGE = 720;

/** 存进 bucket 的格式。HEIC 在客户端转成 JPEG 再传：桌面的 Electron 解不了 HEIC，模型也不收 */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type VideoMime = (typeof VIDEO_MIME_TYPES)[number];

export const MEDIA_PLACEHOLDER = { image: "[图片]", video: "[视频]" } as const;

export interface ChatMediaItem {
  kind: "image" | "video";
  /** bucket 里的对象键（不含 bucket 名） */
  path: string;
  mediaType: string;
  bytes: number;
  /** 0 = 系统没给（image-picker 的原话：Can be 0），界面按方块画 */
  width: number;
  height: number;
  /** 只有视频有 */
  durationMs?: number;
  /** 视频封面的对象键（同一个 bucket，JPEG）。缺席 = 没生成出来，气泡画一块底色加播放钮 */
  poster?: string;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/quicktime": "mov" };

export function extForMime(mime: string): string | null {
  return EXT[mime] ?? null;
}

function isImageMime(m: unknown): m is ImageMime {
  return typeof m === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(m);
}
function isVideoMime(m: unknown): m is VideoMime {
  return typeof m === "string" && (VIDEO_MIME_TYPES as readonly string[]).includes(m);
}

/** 对象键：非空、不以 / 开头、没有空段 / . / ..、没有反斜杠与控制字符。只防「指到别处」，不管命名风格 */
function isObjectKey(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || p.length > 512 || p.startsWith("/")) return false;
  if (/[\\\u0000-\u001f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000;
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

function parseItem(raw: unknown): ChatMediaItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isObjectKey(o.path) || !isPositiveInt(o.bytes) || !isCount(o.width) || !isCount(o.height)) return null;
  const base = { path: o.path, mediaType: o.mediaType as string, bytes: o.bytes, width: o.width, height: o.height };
  if (o.kind === "image") {
    if (!isImageMime(o.mediaType) || o.durationMs !== undefined || o.poster !== undefined) return null;
    return { kind: "image", ...base };
  }
  if (o.kind === "video") {
    if (!isVideoMime(o.mediaType) || !isPositiveInt(o.durationMs)) return null;
    if (o.poster !== undefined && !isObjectKey(o.poster)) return null;
    return { kind: "video", ...base, durationMs: o.durationMs, ...(o.poster !== undefined ? { poster: o.poster } : {}) };
  }
  return null;
}

/**
 * messages.media / 事件里那一格。字节来自网络（别人的客户端写的），逐格验：
 * **一格不对整份 null**——留半份的话九宫格少一张、人以为对方只发了八张；整份丢掉时那条照旧画占位正文，
 * 说的仍是实话（同 parseDecisionReply 的纪律）。缺席 / null 也回 null：那是一条普通文字消息。
 */
export function parseChatMedia(raw: unknown): ChatMediaItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MEDIA_MAX_PER_MESSAGE) return null;
  const out: ChatMediaItem[] = [];
  for (const r of raw) {
    const it = parseItem(r);
    if (it === null) return null;
    out.push(it);
  }
  return out;
}

/**
 * 朋友私聊那一格：另外要求每个对象键（含封面）都落在这一对人的目录下（`<发送方>/<接收方>/`）。
 * RLS 只管「读的人读不读得到」——一条消息引用了读者恰好读得到的、另一段对话里的对象，库不会拦，
 * 那张图就会出现在一段它不属于的对话里。
 */
export function parseDmMedia(raw: unknown, sender: string, recipient: string): ChatMediaItem[] | null {
  const items = parseChatMedia(raw);
  if (items === null) return null;
  const prefix = `${sender}/${recipient}/`;
  const ok = items.every((it) => it.path.startsWith(prefix) && (it.poster === undefined || it.poster.startsWith(prefix)));
  return ok ? items : null;
}

/** 纯媒体消息的正文。全是图片 [图片]、全是视频 [视频]、混着两样都写（今天的界面不会发出混的，见 planMediaMessages） */
export function mediaPlaceholder(items: readonly Pick<ChatMediaItem, "kind">[]): string {
  const img = items.some((i) => i.kind === "image");
  const vid = items.some((i) => i.kind === "video");
  return (img ? MEDIA_PLACEHOLDER.image : "") + (vid ? MEDIA_PLACEHOLDER.video : "");
}

/** 新客户端藏不藏正文：带着解析得出的媒体、且正文恰好是它的占位。别的情形（有人配了字、媒体解析失败）照画字 */
export function mediaBodyHidden(body: string, media: readonly ChatMediaItem[] | null): boolean {
  return media !== null && media.length > 0 && body.trim() === mediaPlaceholder(media);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function seg(s: string, what: string): string {
  if (s === "" || s.includes("/") || s.includes("\\") || s === "." || s === "..") throw new Error(`${what} 不能当路径段：${s}`);
  return s;
}

function extOrThrow(mime: string): string {
  const ext = extForMime(mime);
  if (ext === null) throw new Error(`这个格式发不了：${mime}`);
  return ext;
}

/** 朋友私聊：`<发送方>/<接收方>/<uuid>.<扩展名>`。前两段是 RLS 的判据（0052） */
export function dmMediaPath(sender: string, recipient: string, id: string, mime: string): string {
  if (!UUID.test(id)) throw new Error(`对象 id 要是 uuid：${id}`);
  return `${seg(sender, "发送方")}/${seg(recipient, "接收方")}/${id}.${extOrThrow(mime)}`;
}

/** 视频封面：与视频同目录同 id */
export function dmPosterPath(sender: string, recipient: string, id: string): string {
  if (!UUID.test(id)) throw new Error(`对象 id 要是 uuid：${id}`);
  return `${seg(sender, "发送方")}/${seg(recipient, "接收方")}/${id}.poster.jpg`;
}

/** 云会话（P2 起用）：`<团队>/<会话>/<sha256>.<扩展名>`——按内容寻址，同一张图传两次是同一个对象 */
export function chatMediaPath(workspaceId: string, sessionId: string, sha256hex: string, mime: string): string {
  if (!SHA256.test(sha256hex)) throw new Error(`内容哈希要是 64 位十六进制：${sha256hex}`);
  return `${seg(workspaceId, "团队")}/${seg(sessionId, "会话")}/${sha256hex}.${extOrThrow(mime)}`;
}

/**
 * 一次挑了好几样，拆成几条消息：**图片攒成一条**（满 9 张换下一条），**视频一条一个**——一条消息里一段视频
 * 加几张图在气泡里没有好的排法，而视频是要点开看的东西。顺序跟挑的顺序走：每条消息出现在它第一样的位置。
 */
export function planMediaMessages<T extends { kind: "image" | "video" }>(picks: readonly T[]): T[][] {
  const out: T[][] = [];
  let open: T[] | null = null;
  for (const p of picks) {
    if (p.kind === "video") {
      out.push([p]);
      continue;
    }
    if (open === null || open.length >= MEDIA_MAX_PER_MESSAGE) {
      open = [];
      out.push(open);
    }
    open.push(p);
  }
  return out;
}

/**
 * 图片要不要重编码成 JPEG：格式不是 JPEG/PNG（HEIC）、长边超过 2048、字节超过 4MB、或字节读不出时都要。
 * 小的截图（PNG）原样传——白转一道 JPEG 会把小字糊掉（同 fitImage 的 unchanged）。
 */
export function imageNeedsReencode(a: { mimeType: string | undefined; bytes: number | undefined; width: number; height: number }): boolean {
  if (!isImageMime(a.mimeType)) return true;
  if (a.bytes === undefined || a.bytes > IMAGE_MAX_BYTES) return true;
  return Math.max(a.width, a.height) > IMAGE_MAX_EDGE;
}

export type FitStepsOutcome<T> = { kind: "fit"; out: T } | { kind: "stillTooBig"; bytes: number };

/**
 * 沿 imageFit 的阶梯一级一级往下试（长边 + 画质），每级量真实字节数，够小就停。
 * 与 fitImage 的区别只在载体：fitImage 收字节（桌面），这里由编码器自己管文件（手机端是文件 URI，
 * 不把一张原图读进 JS 内存）。阶梯是同一张表——同一张照片在两端传出来是同一个画质。
 */
export async function fitImageSteps<T>(
  encode: (edge: number, quality: number) => Promise<{ bytes: number; out: T }>,
  cap: number = IMAGE_MAX_BYTES,
): Promise<FitStepsOutcome<T>> {
  let smallest = Number.POSITIVE_INFINITY;
  for (const step of IMAGE_FIT_LADDER) {
    const r = await encode(step.edge, step.quality);
    if (r.bytes <= cap) return { kind: "fit", out: r.out };
    smallest = Math.min(smallest, r.bytes);
  }
  return { kind: "stillTooBig", bytes: smallest };
}

/** 视频收不收。回 null = 收；否则是一句给人看的话。大小读不出时放行：上传那一刻 bucket 的上限会挡 */
export function videoProblem(v: { durationMs: number | null | undefined; bytes: number | undefined; mimeType: string | undefined }): string | null {
  if (!isVideoMime(v.mimeType)) return "这个视频的格式发不了";
  if (v.durationMs === null || v.durationMs === undefined || !(v.durationMs > 0)) return "读不出这段视频的时长，发不了";
  // 系统报的时长常带几十毫秒的零头（60.02 秒），按整秒判，别让一段「正好一分钟」的被拒
  if (Math.round(v.durationMs / 1000) * 1000 > VIDEO_MAX_MS) return "视频超过 60 秒，剪短一点再发";
  if (v.bytes !== undefined && v.bytes > VIDEO_MAX_BYTES) return "视频超过 50MB，发不了";
  return null;
}

/** 视频时长写成 m:ss。不足一秒算一秒（「0:00」读起来像坏了） */
export function videoDurationLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 手机上准备好、还没传的一样：本机文件 URI + 传完要写进 media 的那几格 */
export interface PreparedMedia {
  kind: "image" | "video";
  uri: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  durationMs?: number;
  /** 视频封面的本机 JPEG。缺席 = 没生成出来 */
  posterUri?: string;
}

export interface MediaSendDeps<T> {
  newId(): string;
  /** 把本机文件传到 bucket 的 path。onProgress 报这个文件已经发出去的字节数 */
  upload(path: string, uri: string, mime: string, onProgress: (sent: number) => void): Promise<void>;
  /** 收掉传了一半的那几个（尽力而为，失败不抛） */
  remove(paths: string[]): Promise<void>;
  /** 写消息那一行 */
  insert(body: string, media: ChatMediaItem[]): Promise<T>;
}

/**
 * 发一条带媒体的私聊：**先把文件全传上去、再写消息**——反过来的话对方会先收到一条点不开的消息。
 * 半路失败（某个文件没传上去 / 消息没写成）把已经传上去的收掉再抛：留着就是 bucket 里没人引用的孤儿，
 * 而 P6 的生命周期只管「删会话时一起删」，私聊那边永久保留，孤儿永远不会被收。
 * 视频封面传不上去不算失败：不带封面照发，气泡画一块底色加播放钮。
 */
export async function sendMediaMessage<T>(
  deps: MediaSendDeps<T>,
  sender: string,
  recipient: string,
  items: readonly PreparedMedia[],
  onProgress?: (fraction: number) => void,
): Promise<T> {
  if (items.length === 0 || items.length > MEDIA_MAX_PER_MESSAGE) throw new Error(`一条消息里放 1~${MEDIA_MAX_PER_MESSAGE} 样`);
  const total = items.reduce((n, it) => n + it.bytes, 0) || 1;
  let done = 0;
  let best = 0;
  const report = (sentNow: number): void => {
    const f = Math.min(1, (done + sentNow) / total);
    if (f > best) {
      best = f;
      onProgress?.(f);
    }
  };
  const uploaded: string[] = [];
  const media: ChatMediaItem[] = [];
  try {
    for (const it of items) {
      const id = deps.newId();
      const path = dmMediaPath(sender, recipient, id, it.mediaType);
      await deps.upload(path, it.uri, it.mediaType, (sent) => report(Math.min(sent, it.bytes)));
      uploaded.push(path);
      done += it.bytes;
      report(0);
      const base: ChatMediaItem = { kind: it.kind, path, mediaType: it.mediaType, bytes: it.bytes, width: it.width, height: it.height };
      if (it.kind === "video") {
        let poster: string | undefined;
        if (it.posterUri !== undefined) {
          const p = dmPosterPath(sender, recipient, id);
          try {
            await deps.upload(p, it.posterUri, "image/jpeg", () => undefined);
            uploaded.push(p);
            poster = p;
          } catch {
            // 封面传不上去：不带封面照发
          }
        }
        media.push({ ...base, durationMs: it.durationMs ?? 0, ...(poster !== undefined ? { poster } : {}) });
      } else {
        media.push(base);
      }
    }
    const row = await deps.insert(mediaPlaceholder(media), media);
    report(0);
    if (best < 1) onProgress?.(1);
    return row;
  } catch (e) {
    if (uploaded.length > 0) await deps.remove(uploaded).catch(() => undefined);
    throw e;
  }
}

/**
 * 「messages 上还没有 media 这一列」（0052 还没在库上跑）。只认 undefined_column（42703）与 PostgREST 的
 * 「schema cache 里没有这一列」（PGRST204），且话里提到 media——别的错一概不认，不把真故障吞成「没这一列」。
 */
export function missingMediaColumn(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const o = err as { code?: unknown; message?: unknown };
  if (o.code !== "42703" && o.code !== "PGRST204") return false;
  return typeof o.message === "string" && /\bmedia\b/.test(o.message);
}

/** 气泡里单张图 / 一段视频画多大：长边封顶 200，短边至少 80（太细长的图别画成一根线），宽高读不出画 160 的方块 */
export function mediaBubbleBox(width: number, height: number, max = 200, min = 80): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 160, height: 160 };
  const k = max / Math.max(width, height);
  return { width: Math.max(min, Math.round(width * k)), height: Math.max(min, Math.round(height * k)) };
}
