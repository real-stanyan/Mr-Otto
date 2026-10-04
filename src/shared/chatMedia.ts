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
/** 语音消息（#1492）：手机录的 AAC 装在 m4a 里 */
export const AUDIO_MIME_TYPES = ["audio/mp4"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type VideoMime = (typeof VIDEO_MIME_TYPES)[number];
export type AudioMime = (typeof AUDIO_MIME_TYPES)[number];
/** 一条语音最长 60 秒（照微信）、最多 5MB（60 秒 AAC 远不到）、转写最多 2000 字 */
export const AUDIO_MAX_MS = 60_000;
export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const TRANSCRIPT_MAX_CHARS = 2000;

export const MEDIA_PLACEHOLDER = { image: "[图片]", video: "[视频]", audio: "[语音]" } as const;

export interface ChatMediaItem {
  /** `audio`（#1492，ADR-0351）= 一条语音消息：m4a 一段 + 时长 + 发送方那一刻的转写（可缺席） */
  kind: "image" | "video" | "audio";
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
  /** 只有语音有：发送方录的时候听写出来的字（#1492，维护者拍板：接收方「转文字」不再识别一遍，用这一份）。
      缺席 = 没听清 / 没开听写 */
  transcript?: string;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/quicktime": "mov", "audio/mp4": "m4a" };

export function extForMime(mime: string): string | null {
  return EXT[mime] ?? null;
}

function isImageMime(m: unknown): m is ImageMime {
  return typeof m === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(m);
}
function isAudioMime(m: unknown): m is AudioMime {
  return typeof m === "string" && (AUDIO_MIME_TYPES as readonly string[]).includes(m);
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
  if (o.kind === "audio") {
    // 语音（#1492）：m4a、有时长且 ≤ 60 秒、没有尺寸也没有封面；转写可缺席、是字符串、≤ 2000 字
    if (!isAudioMime(o.mediaType) || !isPositiveInt(o.durationMs) || o.durationMs > AUDIO_MAX_MS || o.bytes > AUDIO_MAX_BYTES) return null;
    if (o.width !== 0 || o.height !== 0 || o.poster !== undefined) return null;
    if (o.transcript !== undefined && (typeof o.transcript !== "string" || o.transcript.length > TRANSCRIPT_MAX_CHARS)) return null;
    return { kind: "audio", ...base, durationMs: o.durationMs, ...(typeof o.transcript === "string" && o.transcript !== "" ? { transcript: o.transcript } : {}) };
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

/** 纯媒体消息的正文。全是图片 [图片]、全是视频 [视频]、语音 [语音]、混着的都写（今天的界面不会发出混的，见 planMediaMessages） */
export function mediaPlaceholder(items: readonly Pick<ChatMediaItem, "kind">[]): string {
  const img = items.some((i) => i.kind === "image");
  const vid = items.some((i) => i.kind === "video");
  const aud = items.some((i) => i.kind === "audio");
  return (img ? MEDIA_PLACEHOLDER.image : "") + (vid ? MEDIA_PLACEHOLDER.video : "") + (aud ? MEDIA_PLACEHOLDER.audio : "");
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
export function planMediaMessages<T extends { kind: "image" | "video" | "audio" }>(picks: readonly T[]): T[][] {
  const out: T[][] = [];
  let open: T[] | null = null;
  for (const p of picks) {
    // 视频一条一个；语音也是（#1492：一条语音消息就是一段）
    if (p.kind !== "image") {
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
  kind: "image" | "video" | "audio";
  uri: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  durationMs?: number;
  /** 视频封面的本机 JPEG。缺席 = 没生成出来 */
  posterUri?: string;
  /** 语音（#1492）：录的时候听写出来的字，随消息一起走 */
  transcript?: string;
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
      } else if (it.kind === "audio") {
        // 语音（#1492）：时长 + 转写（有才带，截到上限）
        const t = (it.transcript ?? "").slice(0, TRANSCRIPT_MAX_CHARS);
        media.push({ ...base, durationMs: it.durationMs ?? 0, ...(t !== "" ? { transcript: t } : {}) });
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

// ── 云会话（#1491，#1443 P2）：say 帧里的媒体引用 ───────────────────────────────────────────────
//
// 手机先把文件传进 `chat-media`（路径 = chatMediaPath，按内容寻址），再在 say 帧里带引用。引用里**不带路径**：
// 路径由 runtime 用 `<团队>/<会话>/<sha256>` 自己拼——客户端给路径就是给它一个指到别的会话目录的机会，
// 而 RLS 只管「读的人读不读得到」，不管「这条消息引用的是不是自己目录里的对象」（同 parseDmMedia 那条纪律）。
// runtime 下载后还会复算 sha256 对一遍：客户端声称的哈希就是对象名，名不副实的对象一个字节不进附件库。
export interface ChatMediaRef {
  kind: "image" | "video";
  /** 64 位小写十六进制。对象名就是它 */
  sha256: string;
  mediaType: ImageMime | VideoMime;
  bytes: number;
  /** 0 = 系统没给（同 ChatMediaItem） */
  width: number;
  height: number;
  /** 只有视频有，必填（模型只看封面，这个数要进那句「发了一段 N 秒视频」） */
  durationMs?: number;
  /** 视频封面（JPEG，同一个 bucket 的另一个对象）。缺席 = 没抽出来：模型只能听说有一段视频 */
  poster?: { sha256: string; bytes: number };
}

const DIM_MAX = 16_384;
const isHex64 = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);
const isCountUpTo = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
const isDim = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= DIM_MAX;

function parseMediaRef(raw: unknown): ChatMediaRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isHex64(o.sha256) || !isDim(o.width) || !isDim(o.height)) return null;
  if (o.kind === "image") {
    if (!isImageMime(o.mediaType) || !isCountUpTo(o.bytes, IMAGE_MAX_BYTES)) return null;
    if (o.durationMs !== undefined || o.poster !== undefined) return null;
    return { kind: "image", sha256: o.sha256, mediaType: o.mediaType, bytes: o.bytes, width: o.width, height: o.height };
  }
  if (o.kind === "video") {
    if (!isVideoMime(o.mediaType) || !isCountUpTo(o.bytes, VIDEO_MAX_BYTES) || !isCountUpTo(o.durationMs, VIDEO_MAX_MS)) return null;
    const ref: ChatMediaRef = { kind: "video", sha256: o.sha256, mediaType: o.mediaType, bytes: o.bytes, width: o.width, height: o.height, durationMs: o.durationMs };
    if (o.poster !== undefined) {
      if (typeof o.poster !== "object" || o.poster === null) return null;
      const p = o.poster as Record<string, unknown>;
      if (!isHex64(p.sha256) || !isCountUpTo(p.bytes, IMAGE_MAX_BYTES)) return null;
      ref.poster = { sha256: p.sha256, bytes: p.bytes };
    }
    return ref;
  }
  return null;
}

/**
 * say 帧里那一格 media 的严格解析：1..9 个，**要么全是图片、要么恰好一段视频**（同 planMediaMessages 的拆法——
 * 客户端本来就这么拆，服务端照同一条规矩收）；一处不对整份回 null（调用方据此拒帧，不降级成「没带媒体」：
 * 静默丢掉等于一句「看这张图」发出去时图没了，而发言人那侧完全无声）。同一个哈希出现两次也拒：
 * 按内容寻址的对象列表里重复只能是客户端的 bug。
 */
export function parseChatMediaRefs(raw: unknown): ChatMediaRef[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MEDIA_MAX_PER_MESSAGE) return null;
  const out: ChatMediaRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = parseMediaRef(item);
    if (ref === null || seen.has(ref.sha256)) return null;
    seen.add(ref.sha256);
    out.push(ref);
  }
  const videos = out.filter((r) => r.kind === "video").length;
  if (videos > 1 || (videos === 1 && out.length !== 1)) return null;
  return out;
}

/** 模型要读的那一行（#1443 拍板第 5 条：模型只看封面帧）。有封面时封面已作为图片附在前面；没封面只能听说 */
export function videoNoteForModel(videos: readonly { durationMs: number; hasPoster: boolean }[]): string | null {
  if (videos.length === 0) return null;
  return videos
    .map((v) => `[发了一段 ${videoDurationLabel(v.durationMs)} 的视频${v.hasPoster ? "，上面那张图是它的封面" : "，没有封面可看"}]`)
    .join("\n");
}

/**
 * 事件里那两格 → 气泡要画的那几样（#1491 P3）：`attachments` 里的图按对象名拼回 chat-media 的路径；视频从 `videos`
 * 来，它的封面是 attachments 里的一张（`poster` 指着），只跟着视频走、不单独当一张图。认不出的（不是 sha256 id、
 * 格式不在白名单——桌面本机的 webp / gif 附件）跳过：画不出来的东西不如不画。
 */
export function chatMediaItemsOf(
  workspaceId: string,
  sessionId: string,
  attachments: readonly { id: string; mediaType: string; bytes: number; name?: string; width?: number; height?: number }[] | undefined,
  videos: readonly { id: string; mediaType: string; bytes: number; width: number; height: number; durationMs: number; poster?: string }[] | undefined,
): ChatMediaItem[] {
  const out: ChatMediaItem[] = [];
  const posters = new Set<string>();
  for (const v of videos ?? []) if (v.poster !== undefined) posters.add(v.poster);
  const pathOf = (id: string, mime: string): string | null => {
    const hex = id.startsWith("sha256:") ? id.slice(7) : "";
    if (!SHA256.test(hex) || extForMime(mime) === null) return null;
    try {
      return chatMediaPath(workspaceId, sessionId, hex, mime);
    } catch {
      return null;
    }
  };
  for (const a of attachments ?? []) {
    if (posters.has(a.id)) continue;
    const path = pathOf(a.id, a.mediaType);
    if (path === null) continue;
    out.push({ kind: "image", path, mediaType: a.mediaType, bytes: a.bytes, width: a.width ?? 0, height: a.height ?? 0 });
  }
  for (const v of videos ?? []) {
    const path = pathOf(v.id, v.mediaType);
    if (path === null) continue;
    const poster = v.poster !== undefined ? pathOf(v.poster, "image/jpeg") : null;
    out.push({
      kind: "video", path, mediaType: v.mediaType, bytes: v.bytes, width: v.width, height: v.height, durationMs: v.durationMs,
      ...(poster !== null ? { poster } : {}),
    });
  }
  return out;
}
