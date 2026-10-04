// tusUpload —— 大文件分片续传（#1480）：建上传、按 6MB 一片 PATCH、断了 HEAD 问进度接着传、不可重试的直接报。
import { describe, expect, it } from "vitest";
import { TUS_CHUNK_BYTES, TUS_RETRIES, TusError, base64Utf8, tusUpload, uploadMetadata, type TusDeps, type TusResponse } from "../../src/shared/tusUpload.js";

const resp = (status: number, headers: Record<string, string> = {}, text = ""): TusResponse => ({
  status,
  header: (n) => headers[n.toLowerCase()] ?? null,
  text: async () => text,
});

function rig(size: number, script: (call: { method: string; url: string; headers: Record<string, string>; bytes: number }, server: { offset: number }) => TusResponse | "throw") {
  const calls: { method: string; url: string; headers: Record<string, string>; bytes: number }[] = [];
  const server = { offset: 0 };
  const progress: number[] = [];
  const deps: TusDeps = {
    endpoint: "https://x.supabase.co/storage/v1/upload/resumable",
    headers: { authorization: "Bearer jwt", apikey: "anon", "x-upsert": "false" },
    metadata: { bucketName: "dm-media", objectName: "a/b/c.mov", contentType: "video/quicktime", cacheControl: "3600" },
    size,
    readChunk: (o, l) => new Uint8Array(l).fill(o % 251),
    fetch: async (url, init) => {
      const call = { method: init.method, url, headers: init.headers, bytes: init.body?.byteLength ?? 0 };
      calls.push(call);
      const r = script(call, server);
      if (r === "throw") throw new Error("The network connection was lost");
      return r;
    },
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
  };
  return { deps, calls, server, progress };
}

const happy = (call: { method: string; headers: Record<string, string>; bytes: number }, server: { offset: number }): TusResponse => {
  if (call.method === "POST") return resp(201, { location: "/storage/v1/upload/resumable/abc" });
  if (call.method === "PATCH") {
    server.offset += call.bytes;
    return resp(204, { "upload-offset": String(server.offset) });
  }
  return resp(200, { "upload-offset": String(server.offset) });
};

describe("tusUpload", () => {
  it("13MB：建一个上传、按 6MB 切三片 PATCH，Location 相对地址补成绝对的", async () => {
    const size = 13 * 1024 * 1024;
    const r = rig(size, happy);
    await tusUpload(r.deps);
    expect(r.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
    expect(r.calls[0]!.headers["Upload-Length"]).toBe(String(size));
    expect(r.calls[0]!.headers["Tus-Resumable"]).toBe("1.0.0");
    expect(r.calls[1]!.url).toBe("https://x.supabase.co/storage/v1/upload/resumable/abc");
    expect(r.calls.slice(1).map((c) => c.bytes)).toEqual([TUS_CHUNK_BYTES, TUS_CHUNK_BYTES, size - 2 * TUS_CHUNK_BYTES]);
    expect(r.calls[2]!.headers["Upload-Offset"]).toBe(String(TUS_CHUNK_BYTES));
    expect(r.progress.at(-1)).toBe(size);
  });

  it("断在中间：HEAD 问清服务器收到哪儿，从那儿接着传", async () => {
    const size = 13 * 1024 * 1024;
    let dropped = false;
    const r = rig(size, (call, server) => {
      if (call.method === "PATCH" && server.offset === TUS_CHUNK_BYTES && !dropped) {
        dropped = true;
        server.offset += 1000; // 服务器收了一部分就断了
        return "throw";
      }
      return happy(call, server);
    });
    await tusUpload(r.deps);
    const heads = r.calls.filter((c) => c.method === "HEAD");
    expect(heads).toHaveLength(1);
    const afterHead = r.calls[r.calls.indexOf(heads[0]!) + 1]!;
    expect(afterHead.headers["Upload-Offset"]).toBe(String(TUS_CHUNK_BYTES + 1000));
    expect(r.server.offset).toBe(size);
  });

  it("一直断：重试 TUS_RETRIES 次后放弃，说人话", async () => {
    const r = rig(1000, (call, server) => (call.method === "PATCH" ? "throw" : happy(call, server)));
    await expect(tusUpload(r.deps)).rejects.toThrow(/网络不稳/);
    expect(r.calls.filter((c) => c.method === "PATCH")).toHaveLength(TUS_RETRIES + 1);
  });

  it("不可重试的拒绝（403 策略 / 413 太大）：当场报，不重试", async () => {
    const r = rig(1000, (call) => (call.method === "POST" ? resp(201, { location: "https://x/up/1" }) : resp(403, {}, "new row violates row-level security policy")));
    await expect(tusUpload(r.deps)).rejects.toBeInstanceOf(TusError);
    expect(r.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("建不了上传：报服务器原话", async () => {
    const r = rig(1000, () => resp(400, {}, "Bucket not found"));
    await expect(tusUpload(r.deps)).rejects.toThrow("Bucket not found");
  });
});

describe("Upload-Metadata", () => {
  it("base64 与 node 的 Buffer 逐字相同（含中文）", () => {
    for (const s of ["dm-media", "a/b/c.mov", "video/quicktime", "朋友/视频.mov", "", "ab", "abc"]) {
      expect(base64Utf8(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
    }
  });
  it("键值对逗号分隔，缺的字段不写", () => {
    expect(uploadMetadata({ bucketName: "b", objectName: "o", contentType: "image/jpeg" })).toBe(`bucketName ${base64Utf8("b")},objectName ${base64Utf8("o")},contentType ${base64Utf8("image/jpeg")}`);
  });
});
