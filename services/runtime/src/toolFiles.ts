// 云会话里工具交给人的文件（#1683：create_document 做的 PDF / Word / Excel / PPT，send_file 发的工作区文件）。
// 与 toolImages.ts 同一条路的文件版：工具交字节 → 这里传进 Storage 的 `chat-media/<团队>/<会话>/<sha256>.<ext>`
// → tool_result.files 只记 ref，手机按 ref 拼路径、签名、点开。
//
// 与图不同的两处：
//   · 不落附件库：附件库只收图（嗅探格式），文件原件本来就在工作区里（outputs/、inbox/），要再发一遍从那里读。
//   · 群座位要把文件跟着回话送进群（同图），得再传一份到群的目录——这里留一份最近的字节（recent），
//     座位那边按 ref 取。服务重启就没了：那时群里少一份文件，座位里那份还在（同图的已知天花板）。
//
// 失败的立场同 toolImages：传不上去的那份**跳过**、不炸工具调用；但模型那一轮的 output 已经说了「发到聊天里了」，
// 所以跳过时在 output 末尾补一句实话（fileRefs 少了哪份，模型下一句就该说清）。
import { createHash } from "node:crypto";
import type { ChatFileRef } from "../../../src/session/events.js";
import type { ToolMiddleware } from "../../../src/loop/middleware.js";
import type { ToolFile } from "../../../src/tools/tool.js";
import { CHAT_MEDIA_BUCKET, FILE_MAX_BYTES, chatMediaPath, cleanFileName, isDocMime } from "../../../src/shared/chatMedia.js";
import type { MediaUpload } from "./toolImages.js";

export interface ToolFilesPort {
  upload: MediaUpload;
  log?: (msg: string) => void;
}

/** 最近交出去的文件字节（座位把文件送进群时取）。按 ref id 存，最多留这么多份 / 这么多字节 */
const RECENT_MAX = 16;
const RECENT_MAX_BYTES = 64 * 1024 * 1024;

export interface RecentFiles {
  put(id: string, f: ToolFile): void;
  get(id: string): ToolFile | null;
}

export function createRecentFiles(): RecentFiles {
  const m = new Map<string, ToolFile>();
  return {
    put(id, f) {
      m.delete(id);
      m.set(id, f);
      let total = 0;
      for (const v of m.values()) total += v.data.byteLength;
      while (m.size > RECENT_MAX || total > RECENT_MAX_BYTES) {
        const first = m.keys().next().value;
        if (first === undefined) break;
        total -= m.get(first)!.data.byteLength;
        m.delete(first);
      }
    },
    get: (id) => m.get(id) ?? null,
  };
}

/** 一批文件传进 `chat-media/<团队>/<会话>/<hex>.<ext>`，回传成功的那几份的 ref。格式不在白名单 / 超 20MB / 网络失败的跳过 */
export async function publishToolFiles(
  port: ToolFilesPort,
  workspaceId: string,
  sessionId: string,
  files: readonly ToolFile[],
  recent?: RecentFiles,
): Promise<ChatFileRef[]> {
  const refs: ChatFileRef[] = [];
  for (const f of files) {
    if (!isDocMime(f.mimeType) || f.data.byteLength === 0 || f.data.byteLength > FILE_MAX_BYTES) {
      port.log?.(`工具交出的文件不收（${f.mimeType}，${f.data.byteLength} 字节），跳过`);
      continue;
    }
    const hex = createHash("sha256").update(f.data).digest("hex");
    try {
      await port.upload(CHAT_MEDIA_BUCKET, chatMediaPath(workspaceId, sessionId, hex, f.mimeType), f.data, f.mimeType);
    } catch (err) {
      port.log?.(`工具交出的文件传不上去（session=${sessionId}），跳过：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const ref: ChatFileRef = { id: `sha256:${hex}`, name: cleanFileName(f.name) ?? "file", mediaType: f.mimeType, bytes: f.data.byteLength };
    recent?.put(ref.id, f);
    refs.push(ref);
  }
  return refs;
}

export function createToolFileIntakeMiddleware(
  port: ToolFilesPort,
  where: { workspaceId: string; sessionId: string },
  recent?: RecentFiles,
): ToolMiddleware {
  return async (ctx, next) => {
    const outcome = await next();
    if (outcome.status !== "ok") return outcome;
    const files = outcome.files ?? [];
    if (files.length === 0) return outcome;
    const refs = await publishToolFiles(port, where.workspaceId, where.sessionId, files, recent);
    const lost = files.length - refs.length;
    const output = lost > 0 ? `${outcome.output}\n（注意：有 ${lost} 份文件没能发到聊天里——网络或格式问题。跟用户说实话，文件还在工作区里。）` : outcome.output;
    return { ...outcome, output, ...(refs.length > 0 ? { fileRefs: refs } : {}) };
  };
}
