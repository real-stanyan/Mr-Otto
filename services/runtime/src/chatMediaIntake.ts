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
import type { ChatFileRef, ChatVideoRef, UserAttachmentRef } from "../../../src/session/events.js";
import { CHAT_MEDIA_BUCKET, chatMediaPath, cleanFileName, type ChatMediaRef } from "../../../src/shared/chatMedia.js";

/** 人发来的文件转成文字后，最多给模型多少（同桌面附件 TEXT_MAX_BYTES 的量级）。超了只给开头，说清用 read_document 往下读 */
export const FILE_TEXT_MAX_CHARS = 60_000;
/** 人发来的文件存进工作区的哪个目录 */
export const INBOX_DIR = "inbox";

export interface ChatMediaIntakeDeps {
  /** 从 bucket 里取一个对象的字节；不存在 / 读不到就抛 */
  download: (bucket: string, path: string) => Promise<Uint8Array>;
  /** 这个团队的附件库 */
  storeFor: (workspaceId: string) => AttachmentStore;
  /** 文件（#1683）：原件存进这个团队的工作区（回存下的路径）。缺席 = 这台收不了文件 */
  saveFile?: (workspaceId: string, path: string, data: Uint8Array) => Promise<void>;
  /** 文件转文字（anydoc）。缺席 / 抛错 = 只存原件、告诉模型读不出（textError） */
  toText?: (data: Uint8Array) => Promise<string>;
}

export interface IntakenMedia {
  attachments: UserAttachmentRef[];
  videos: ChatVideoRef[];
  files: ChatFileRef[];
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
      const files: ChatFileRef[] = [];
      let n = 0;
      for (const r of refs) {
        n += 1;
        if (r.kind === "file") {
          files.push(await intakeFile(workspaceId, sessionId, r));
          continue;
        }
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
      return { attachments, videos, files };
    },
  };

  /** 文件（#1683）：下载 → 复算哈希 → 原件存进工作区 inbox/ → 转文字。存不进 / 转不出都不拒这句话：
      人发的文件模型至少知道「发来了一份叫 X 的文件」，转不出写清原因（扫描件、加密）；只有下不来 / 对不上才拒 */
  async function intakeFile(workspaceId: string, sessionId: string, r: ChatMediaRef): Promise<ChatFileRef> {
    const name = cleanFileName(r.name ?? "") ?? "file";
    if (deps.saveFile === undefined) throw new ChatMediaRejectedError("这台服务器还收不了文件");
    const path = chatMediaPath(workspaceId, sessionId, r.sha256, r.mediaType);
    let data: Uint8Array;
    try {
      data = await deps.download(CHAT_MEDIA_BUCKET, path);
    } catch {
      throw new ChatMediaRejectedError(`「${name}」还没传完或已经不在了，再发一次试试`);
    }
    if (data.byteLength !== r.bytes || sha256hex(data) !== r.sha256) {
      throw new ChatMediaRejectedError(`「${name}」的内容和声称的对不上，没发出去`);
    }
    const ref: ChatFileRef = { id: `sha256:${r.sha256}`, name, mediaType: r.mediaType, bytes: r.bytes };
    const at = `${INBOX_DIR}/${name}`;
    try {
      await deps.saveFile(workspaceId, at, data);
      ref.path = at;
    } catch {
      // 工作区存不进（沙箱没起来）：文字照转，模型只是拿不到原件
    }
    const textual = r.mediaType === "text/plain" || r.mediaType === "text/csv" || r.mediaType === "text/markdown";
    try {
      const text = textual ? new TextDecoder().decode(data).replace(/^\uFEFF/, "") : deps.toText !== undefined ? await deps.toText(data) : null;
      if (text === null) ref.textError = "这台服务器转不了这种文件";
      else if (text.trim() === "") ref.textError = r.mediaType === "application/pdf" ? "这个 PDF 没有文字层（扫描件 / 图片）" : "文件里没有文字";
      else if (text.length > FILE_TEXT_MAX_CHARS) {
        ref.text = `${text.slice(0, FILE_TEXT_MAX_CHARS)}\n…（共 ${text.length} 字，这里只有开头 ${FILE_TEXT_MAX_CHARS} 字；往下读用 read_document，offset ${FILE_TEXT_MAX_CHARS}）`;
      } else ref.text = text;
    } catch (err) {
      const code = (err as { code?: string }).code;
      ref.textError =
        code === "unsupported" && r.mediaType === "application/pdf" ? "这个 PDF 没有文字层（扫描件 / 图片）" :
        code === "encrypted" ? "文件有密码保护" : "文件读不出来，可能已损坏";
    }
    return ref;
  }
}
