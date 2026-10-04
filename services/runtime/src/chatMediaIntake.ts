// 云会话里发的图片 / 视频进 runtime（#1491，#1443 P2）：say 帧只带引用（ChatMediaRef），文件本体在 Storage 的
// `chat-media`。这里把引用变成事件里那两格——`attachments`（模型要看的图：图片本体 + 视频封面）与 `videos`
// （界面要画的视频引用）——顺带把该拒的拒掉。
//
// 三条纪律：
// · **路径自己拼**（chatMediaPath：`<团队>/<会话>/<sha256>.<ext>`），不收客户端给的路径——引用指到别的会话目录
//   是 RLS 管不到的事（它只判「读的人读不读得到」）。
// · **下载后复算 sha256 对一遍**：对象名就是客户端声称的哈希，名不副实（抢先用某个哈希当名字放了别的字节，
//   #1475 第 7 条）一个字节不进附件库；大小也要与声称的一致。
// · **视频本体不下载**：模型看不了视频（拍板第 5 条：只看封面），50MB 下到 runtime 磁盘上只是占地方；
//   客户端自己签名去放。封面按图片收。
//
// 收进来的图走 AttachmentStore.save（同桌面本机附件：嗅探格式、10MB 上限、按内容寻址落盘）——附件库是
// runtime 本机磁盘上的缓存，id 与 Storage 对象名同一个 hex，丢了可以从 Storage 重下（P6 之前没写重下）。
import { createHash } from "node:crypto";
import type { AttachmentStore } from "../../../src/session/attachments.js";
import type { ChatVideoRef, UserAttachmentRef } from "../../../src/session/events.js";
import { CHAT_MEDIA_BUCKET, chatMediaPath, type ChatMediaRef } from "../../../src/shared/chatMedia.js";

export interface ChatMediaIntakeDeps {
  /** 从 bucket 里取一个对象的字节；不存在 / 读不到就抛 */
  download: (bucket: string, path: string) => Promise<Uint8Array>;
  /** 这个团队的附件库 */
  storeFor: (workspaceId: string) => AttachmentStore;
}

export interface IntakenMedia {
  attachments: UserAttachmentRef[];
  videos: ChatVideoRef[];
}

/** 说给发言人听的拒绝（同 SayRejectedError 的用法：措辞就是给他看的） */
export class ChatMediaRejectedError extends Error {}

function sha256hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createChatMediaIntake(deps: ChatMediaIntakeDeps): {
  intake: (workspaceId: string, sessionId: string, refs: readonly ChatMediaRef[]) => Promise<IntakenMedia>;
} {
  async function fetchImage(
    workspaceId: string, sessionId: string, sha256: string, bytes: number, mediaType: string, what: string
  ): Promise<UserAttachmentRef> {
    const path = chatMediaPath(workspaceId, sessionId, sha256, mediaType);
    let data: Uint8Array;
    try {
      data = await deps.download(CHAT_MEDIA_BUCKET, path);
    } catch {
      throw new ChatMediaRejectedError(`${what}还没传完或已经不在了，再发一次试试`);
    }
    if (data.byteLength !== bytes || sha256hex(data) !== sha256) {
      throw new ChatMediaRejectedError(`${what}的内容和声称的对不上，没发出去`);
    }
    try {
      return deps.storeFor(workspaceId).save(data);
    } catch (err) {
      throw new ChatMediaRejectedError(`${what}收不了：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    async intake(workspaceId, sessionId, refs) {
      const attachments: UserAttachmentRef[] = [];
      const videos: ChatVideoRef[] = [];
      let n = 0;
      for (const r of refs) {
        n += 1;
        if (r.kind === "image") {
          const ref = await fetchImage(workspaceId, sessionId, r.sha256, r.bytes, r.mediaType, `第 ${n} 张图`);
          attachments.push({ ...ref, width: r.width, height: r.height });
          continue;
        }
        const video: ChatVideoRef = {
          id: `sha256:${r.sha256}`, mediaType: r.mediaType, bytes: r.bytes, width: r.width, height: r.height, durationMs: r.durationMs ?? 0,
        };
        if (r.poster !== undefined) {
          const poster = await fetchImage(workspaceId, sessionId, r.poster.sha256, r.poster.bytes, "image/jpeg", "视频封面");
          attachments.push({ ...poster, name: "视频封面", width: r.width, height: r.height });
          video.poster = poster.id;
        }
        videos.push(video);
      }
      return { attachments, videos };
    },
  };
}
