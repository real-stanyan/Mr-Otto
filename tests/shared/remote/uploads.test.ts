import { describe, expect, it } from "vitest";

import { b64encode } from "../../../src/shared/remote/b64.js";
import {
  chunkUpload, createUploadPool, UPLOAD_CHUNK_BYTES, type UploadChunk,
} from "../../../src/shared/remote/uploads.js";

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

/** 把一个文件切成协议里的 upload 帧 */
function frames(uploadId: string, name: string, data: Uint8Array): UploadChunk[] {
  const parts = chunkUpload(data);
  return parts.map((d, seq) => ({ uploadId, seq, total: parts.length, name, data: d }));
}

function feed(pool: ReturnType<typeof createUploadPool>, cs: UploadChunk[]): void {
  for (const c of cs) expect(pool.accept(c)).toMatchObject({ ok: true });
}

describe("uploads", () => {
  it("一片的文件传完就能取走,字节一模一样", () => {
    const pool = createUploadPool();
    const data = bytes(1000, 3);
    const cs = frames("u1", "a.png", data);
    expect(cs).toHaveLength(1);
    expect(pool.accept(cs[0]!)).toEqual({ ok: true, done: true });
    expect(pool.take("u1")).toEqual({ name: "a.png", data });
  });

  it("多片按序拼回原样", () => {
    const pool = createUploadPool();
    // 三片多一点,最后一片是残的 —— 拼接的下标算错会在这里露出来
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES * 3 + 17).map((_v, i) => i % 251);
    const cs = frames("u1", "big.bin", data);
    expect(cs).toHaveLength(4);
    feed(pool, cs);
    expect(pool.take("u1")!.data).toEqual(data);
  });

  it("没传完取不走 —— 半个文件绝不能出去", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "big.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(cs[0]!)).toEqual({ ok: true, done: false });
    expect(pool.take("u1")).toBeNull();
  });

  it("不认识的 id 取不走", () => {
    expect(createUploadPool().take("nope")).toBeNull();
  });

  it("非 0 片开不了新条目 —— 否则拼出来的是从中间开始的残文件", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "big.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(cs[1]!)).toEqual({ ok: false, reason: "附件的分片乱序" });
    expect(pool.take("u1")).toBeNull();
  });

  it("跳片 / 重片一律整条作废", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "big.bin", bytes(UPLOAD_CHUNK_BYTES * 3));
    expect(pool.accept(cs[0]!)).toMatchObject({ ok: true });
    expect(pool.accept(cs[2]!)).toMatchObject({ ok: false });
    // 作废之后连第 1 片都接不上了:整条重来,不留半截状态
    expect(pool.accept(cs[1]!)).toEqual({ ok: false, reason: "附件的分片乱序" });
  });

  it("同一个 id 中途换名字 / 换 total 一律作废", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "a.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(cs[0]!)).toMatchObject({ ok: true });
    expect(pool.accept({ ...cs[1]!, name: "b.bin" })).toEqual({ ok: false, reason: "附件的分片对不上" });
  });

  it("单个附件超上限就拒,并且不留残状态", () => {
    const pool = createUploadPool({ maxPending: 4, maxBytes: 200 * 1024, maxTotalBytes: 1024 * 1024 });
    const cs = frames("u1", "big.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(cs[0]!)).toMatchObject({ ok: true });
    expect(pool.accept(cs[1]!)).toEqual({ ok: false, reason: "附件超出单个上限" });
    expect(pool.take("u1")).toBeNull();
  });

  it("一批加起来超上限就拒", () => {
    const pool = createUploadPool({ maxPending: 4, maxBytes: 1024 * 1024, maxTotalBytes: 150 * 1024 });
    feed(pool, frames("u1", "a.bin", bytes(100 * 1024)));
    expect(pool.accept(frames("u2", "b.bin", bytes(100 * 1024))[0]!))
      .toEqual({ ok: false, reason: "这一批附件加起来太大" });
  });

  it("在传的条数有上限", () => {
    const pool = createUploadPool({ maxPending: 1, maxBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 });
    const a = frames("u1", "a.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(a[0]!)).toMatchObject({ ok: true });
    expect(pool.accept(frames("u2", "b.bin", bytes(10))[0]!))
      .toEqual({ ok: false, reason: "同时传的附件太多" });
  });

  it("total 撒谎撑不出内存 —— 超过按 maxBytes 算出来的片数直接拒", () => {
    const pool = createUploadPool();
    expect(pool.accept({ uploadId: "u1", seq: 0, total: 1e9, name: "x", data: b64encode(bytes(1)) }))
      .toEqual({ ok: false, reason: "附件太大" });
  });

  it("片超长直接拒 —— 上限在解码之后按明文字节算", () => {
    const pool = createUploadPool();
    expect(pool.accept({
      uploadId: "u1", seq: 0, total: 1, name: "x", data: b64encode(bytes(UPLOAD_CHUNK_BYTES + 1)),
    })).toEqual({ ok: false, reason: "分片超出上限" });
  });

  it("坏 base64 拒收", () => {
    const pool = createUploadPool();
    expect(pool.accept({ uploadId: "u1", seq: 0, total: 1, name: "x", data: "!!!" }))
      .toEqual({ ok: false, reason: "附件数据不是合法 base64url" });
  });

  it("reset 之后在传的全丢 —— uploadId 是连接级的", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "big.bin", bytes(UPLOAD_CHUNK_BYTES * 2));
    expect(pool.accept(cs[0]!)).toMatchObject({ ok: true });
    pool.reset();
    expect(pool.accept(cs[1]!)).toEqual({ ok: false, reason: "附件的分片乱序" });
  });

  it("take 是取走 —— 同一个 id 不能拿第二次", () => {
    const pool = createUploadPool();
    feed(pool, frames("u1", "a.bin", bytes(10)));
    expect(pool.take("u1")).not.toBeNull();
    expect(pool.take("u1")).toBeNull();
  });

  it("空文件也切出一片 —— 该由桌面那道闸门去拒,不在这里静默变成什么都没发", () => {
    const pool = createUploadPool();
    const cs = frames("u1", "empty.txt", new Uint8Array(0));
    expect(cs).toHaveLength(1);
    expect(pool.accept(cs[0]!)).toEqual({ ok: true, done: true });
    expect(pool.take("u1")).toEqual({ name: "empty.txt", data: new Uint8Array(0) });
  });
});
