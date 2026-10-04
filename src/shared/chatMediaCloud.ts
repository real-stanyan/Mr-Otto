// 云会话里发图片 / 视频的手机一半（#1491 P3，ADR-0348）：挑好的几样 → 逐个算 sha256、传进 `chat-media`
// （路径 = chatMediaPath，按内容寻址）→ 把引用塞进 say 帧。纯编排，算哈希 / 读大小 / 上传 / 发送都由调用方注入，
// 进 vitest。
//
// · **同一个对象已经在了就算传成功**：按内容寻址，同一张图第二次发（或上次发到一半）对象名相同，Storage 回
//   「已存在」（x-upsert: false 不覆盖）——那正是我们要的字节。
// · 失败不收已传的：客户端对 chat-media 没有删除策略（0052），孤儿留给 P6 收。
// · 引用最后再过一遍 parseChatMediaRefs：发出去的和 runtime 收的是同一份判据，在这里就拦住比让服务端拒帧好。
import { CHAT_MEDIA_BUCKET, chatMediaPath, parseChatMediaRefs, type ChatMediaRef, type ImageMime, type PreparedMedia, type VideoMime } from "./chatMedia.js";

export interface CloudMediaDeps<Ack> {
  /** 一个本机文件的 sha256（小写十六进制） */
  hash: (uri: string) => string;
  /** 一个本机文件多少字节 */
  fileSize: (uri: string) => number;
  upload: (bucket: string, path: string, uri: string, mime: string) => Promise<void>;
  /** 引用都齐了：发 say */
  send: (refs: ChatMediaRef[]) => Promise<Ack>;
  /** 0..1，每传完一样走一步 */
  onProgress?: (fraction: number) => void;
}

/** Storage 说这个对象已经在了（按内容寻址：同样的字节） */
export function alreadyThere(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /already exists|Duplicate/i.test(m);
}

export async function sendCloudMedia<Ack>(
  workspaceId: string, sessionId: string, items: readonly PreparedMedia[], deps: CloudMediaDeps<Ack>
): Promise<Ack> {
  // 语音（#1492）这一期只在朋友私聊里：云会话的引用（ChatMediaRef）还没有 audio 这一种
  if (items.some((it) => it.kind === "audio")) throw new Error("群里暂时发不了语音消息");
  const steps = items.reduce((n, it) => n + 1 + (it.kind === "video" && it.posterUri !== undefined ? 1 : 0), 0);
  let done = 0;
  const put = async (uri: string, mime: string, fallbackBytes: number): Promise<{ sha256: string; bytes: number }> => {
    const sha256 = deps.hash(uri);
    const path = chatMediaPath(workspaceId, sessionId, sha256, mime);
    try {
      await deps.upload(CHAT_MEDIA_BUCKET, path, uri, mime);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
    }
    done += 1;
    deps.onProgress?.(done / steps);
    return { sha256, bytes: deps.fileSize(uri) || fallbackBytes };
  };

  const refs: ChatMediaRef[] = [];
  for (const it of items) {
    const main = await put(it.uri, it.mediaType, it.bytes);
    const base = { sha256: main.sha256, bytes: main.bytes, width: Math.max(0, Math.round(it.width)), height: Math.max(0, Math.round(it.height)) };
    if (it.kind === "image") {
      refs.push({ kind: "image", mediaType: it.mediaType as ImageMime, ...base });
      continue;
    }
    const ref: ChatMediaRef = { kind: "video", mediaType: it.mediaType as VideoMime, ...base, durationMs: Math.max(1, Math.round(it.durationMs ?? 1)) };
    if (it.posterUri !== undefined) {
      const p = await put(it.posterUri, "image/jpeg", 0);
      ref.poster = { sha256: p.sha256, bytes: p.bytes };
    }
    refs.push(ref);
  }
  const parsed = parseChatMediaRefs(refs);
  if (parsed === null) throw new Error("这几样的引用不合规矩，没发出去");
  return deps.send(parsed);
}
