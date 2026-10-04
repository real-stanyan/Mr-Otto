// tusUpload —— 往 Supabase Storage 传大文件：TUS 可续传上传（#1480）。
//
// 为什么：相册里选的视频常是原片（几十 MB 的 4K HEVC——iOS 新版相册选择器不理会「导出成 720p」那个参数），整个文件
// 一个 PUT 传，途中网络抖一下就整体失败（真机报 NSURLErrorNetworkConnectionLost）。Supabase 官方对 >6MB 的文件
// 也是建议走 TUS：先 POST 建一个上传、再一片一片 PATCH，断了 HEAD 问清服务器收到哪儿、从那儿接着传。
// Supabase 要求每片正好 6MB（最后一片除外）。
//
// 纯编排：网络（fetch）、读块（readChunk）、睡眠都注入，进 vitest。权限由 Supabase 按调用者的 JWT 判 Storage 的
// insert 策略（0052），与签名上传地址那一条路同一道闸。
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
/** 单片失败最多重试几次（每次先 HEAD 问清服务器的进度） */
export const TUS_RETRIES = 4;

export interface TusResponse {
  status: number;
  header(name: string): string | null;
  text(): Promise<string>;
}

export interface TusDeps {
  /** 例如 `${SUPABASE_URL}/storage/v1/upload/resumable` */
  endpoint: string;
  /** authorization（用户 JWT）/ apikey / x-upsert 等 */
  headers: Record<string, string>;
  metadata: { bucketName: string; objectName: string; contentType: string; cacheControl?: string };
  size: number;
  /** 从 offset 起读 length 个字节（最后一片可以更短） */
  readChunk(offset: number, length: number): Uint8Array;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer }): Promise<TusResponse>;
  sleep?(ms: number): Promise<void>;
  onProgress?(sent: number): void;
}

/** UTF-8 字符串 → base64（Upload-Metadata 的值要 base64；不依赖 Buffer / btoa，RN 与 node 都能跑） */
export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += T[a >> 2]! + T[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : T[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : T[c & 63]!;
  }
  return out;
}

export function uploadMetadata(m: TusDeps["metadata"]): string {
  return Object.entries(m)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k} ${base64Utf8(v)}`)
    .join(",");
}

/** 这次回复算不算「值得再试」：网络断了、5xx、409（偏移对不上）、423（锁着）、429 */
function retryable(status: number): boolean {
  return status >= 500 || status === 409 || status === 423 || status === 429 || status === 0;
}

export class TusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function absolute(location: string, endpoint: string): string {
  if (/^https?:\/\//.test(location)) return location;
  const u = new URL(endpoint);
  return `${u.origin}${location.startsWith("/") ? "" : "/"}${location}`;
}

const TUS = { "Tus-Resumable": "1.0.0" };

export async function tusUpload(d: TusDeps): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const create = await d.fetch(d.endpoint, {
    method: "POST",
    headers: { ...d.headers, ...TUS, "Upload-Length": String(d.size), "Upload-Metadata": uploadMetadata(d.metadata) },
  });
  const loc = create.header("location");
  if (create.status !== 201 || loc === null) throw new TusError(create.status, (await create.text().catch(() => "")) || `建不了上传（${create.status}）`);
  const url = absolute(loc, d.endpoint);

  let offset = 0;
  let failures = 0;
  while (offset < d.size) {
    const len = Math.min(TUS_CHUNK_BYTES, d.size - offset);
    let res: TusResponse | null = null;
    try {
      const chunk = d.readChunk(offset, len);
      const body = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      res = await d.fetch(url, {
        method: "PATCH",
        headers: { ...d.headers, ...TUS, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        body,
      });
    } catch {
      res = null; // 网络断了：按可重试处理
    }
    if (res !== null && res.status >= 200 && res.status < 300) {
      const next = Number(res.header("upload-offset"));
      offset = Number.isFinite(next) && next > offset ? next : offset + len;
      failures = 0;
      d.onProgress?.(offset);
      continue;
    }
    if (res !== null && !retryable(res.status)) throw new TusError(res.status, (await res.text().catch(() => "")) || `上传被拒（${res.status}）`);
    failures += 1;
    if (failures > TUS_RETRIES) throw new TusError(res?.status ?? 0, "网络不稳，传了几次都没传完");
    await sleep(500 * 2 ** (failures - 1));
    // 问清服务器收到了哪儿，从那儿接着传（断在半片里时服务器可能收了一部分）
    try {
      const head = await d.fetch(url, { method: "HEAD", headers: { ...d.headers, ...TUS } });
      const at = Number(head.header("upload-offset"));
      if (head.status >= 200 && head.status < 300 && Number.isFinite(at)) offset = at;
    } catch {
      // HEAD 也失败：下一轮按原来的偏移再试一次
    }
  }
}
