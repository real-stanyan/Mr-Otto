// 手机传上来的附件的重组器。
//
// 为什么要分片:中继单帧卡 256 KiB(services/edge/src/edge.ts 的
// MAX_UPLINK_BYTES,超了回 413),而随手一张照片是几 MB。分片不是优化,
// 是能不能传的问题。
//
// 顺序和防重放**不归这里**:密封流(sealedStream.ts)的严格递增计数器已经保证
// 帧不会乱序、不会重放。所以这里只断言"正好是下一片",不自己做接收窗口 ——
// 多一套顺序逻辑就多一处能和密封流打架的地方。
//
// 三条上限每一条都是内存性质,不是礼貌:这些字节来自公网上一台已认证但仍然
// 可能有 bug/被控的手机,没有上限的话一条 `total` 撒谎的帧就能把主进程撑爆。
//
// 纯文件:不许 import node builtin / electron(手机端也 import 这一份来分片)。

import { b64decode, b64encode } from "./b64.js";

/** 一片的**明文**字节上限。这一片还要过 base64(涨 4/3)、JSON 转义、密封开销,
    128 KiB 明文 ≈ 175 KiB 线上,离中继的 256 KiB 有足够余量 */
export const UPLOAD_CHUNK_BYTES = 128 * 1024;

export interface UploadLimits {
  /** 同时在传的附件个数 */
  maxPending: number;
  /** 单个附件的字节数。远程这条路比桌面 ＋ 按钮(图片 10MB)紧:
      公网上传的等待时间是用户在盯着的,而手机端本来就会先把照片压过 */
  maxBytes: number;
  /** 所有在传附件加起来的字节数 */
  maxTotalBytes: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  maxPending: 6,
  maxBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
};

/** upload 帧里与重组有关的那几个字段(和 frames.ts 的 UpFrame 对齐,不重复声明整条) */
export interface UploadChunk {
  uploadId: string;
  seq: number;
  total: number;
  name: string;
  data: string;
}

export interface ReceivedUpload {
  name: string;
  data: Uint8Array;
}

export type AcceptResult = { ok: true; done: boolean } | { ok: false; reason: string };

interface Pending {
  name: string;
  total: number;
  /** 下一片应该是第几片。**这就是全部的顺序状态** */
  next: number;
  parts: Uint8Array[];
  bytes: number;
}

export function createUploadPool(limits: UploadLimits = UPLOAD_LIMITS): {
  accept(c: UploadChunk): AcceptResult;
  /** 取走一个传完的附件。没传完 / 不认识的 id 一律 null —— 半个文件绝不能出去 */
  take(uploadId: string): ReceivedUpload | null;
  /** 这一轮作废(断线/重握手)。在传的全部丢掉:uploadId 是连接级的,
      新连接上手机会重新发一遍 */
  reset(): void;
} {
  const pending = new Map<string, Pending>();
  /** 一个附件最多能有多少片。挡的是 total 撒谎(它决定 parts 数组能长多长) */
  const maxParts = Math.ceil(limits.maxBytes / UPLOAD_CHUNK_BYTES) + 1;

  const totalBytes = (): number => {
    let n = 0;
    for (const p of pending.values()) n += p.bytes;
    return n;
  };

  return {
    accept(c) {
      if (c.total > maxParts) return { ok: false, reason: "附件太大" };
      const chunk = b64decode(c.data);
      if (!chunk) return { ok: false, reason: "附件数据不是合法 base64url" };
      if (chunk.byteLength > UPLOAD_CHUNK_BYTES) return { ok: false, reason: "分片超出上限" };

      let p = pending.get(c.uploadId);
      if (!p) {
        // 只有第 0 片能开一个新的。**非 0 片开新条目是不行的**:那等于接受一个
        // 从中间开始的文件,拼出来的字节是残的,而调用方看到的是"传完了"
        if (c.seq !== 0) return { ok: false, reason: "附件的分片乱序" };
        if (pending.size >= limits.maxPending) return { ok: false, reason: "同时传的附件太多" };
        p = { name: c.name, total: c.total, next: 0, parts: [], bytes: 0 };
        pending.set(c.uploadId, p);
      }
      // 同一个 id 的后续片,三样都必须和开头对得上 —— 对不上说明不是同一个文件
      if (c.seq !== p.next || c.total !== p.total || c.name !== p.name) {
        pending.delete(c.uploadId);
        return { ok: false, reason: "附件的分片对不上" };
      }
      if (p.bytes + chunk.byteLength > limits.maxBytes) {
        pending.delete(c.uploadId);
        return { ok: false, reason: "附件超出单个上限" };
      }
      if (totalBytes() + chunk.byteLength > limits.maxTotalBytes) {
        pending.delete(c.uploadId);
        return { ok: false, reason: "这一批附件加起来太大" };
      }

      p.parts.push(chunk);
      p.bytes += chunk.byteLength;
      p.next += 1;
      return { ok: true, done: p.next === p.total };
    },

    take(uploadId) {
      const p = pending.get(uploadId);
      if (!p || p.next !== p.total) return null;
      pending.delete(uploadId);
      const data = new Uint8Array(p.bytes);
      let at = 0;
      for (const part of p.parts) {
        data.set(part, at);
        at += part.byteLength;
      }
      return { name: p.name, data };
    },

    reset() {
      pending.clear();
    },
  };
}

/** 发送侧:把一个文件切成 upload 帧的 data 字段。和重组器成对,放同一个文件里,
    改了片长两边一起改 —— 分在两处的常量迟早会不一样 */
export function chunkUpload(data: Uint8Array): string[] {
  const out: string[] = [];
  // 空文件也要有一片:零片的 total=0 在协议里是非法的(decodeUpFrame 要求 total>0),
  // 而"选了个空文件"该走桌面那道闸门去拒收,不该在这里静默变成什么都没发
  for (let i = 0; i < data.byteLength || i === 0; i += UPLOAD_CHUNK_BYTES) {
    out.push(b64encode(data.subarray(i, i + UPLOAD_CHUNK_BYTES)));
  }
  return out;
}
