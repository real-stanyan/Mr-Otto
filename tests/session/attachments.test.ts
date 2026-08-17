import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentStore,
  detectImageType,
  stripToBasename,
  IMAGE_MAX_BYTES,
} from "../../src/session/attachments.js";

// 最小合法 magic bytes 前缀 + 填充——嗅探只看头,不解码全图
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5]);
const webp = () => {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return b;
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "otter-att-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("detectImageType", () => {
  it("认全四种格式", () => {
    expect(detectImageType(png())).toBe("image/png");
    expect(detectImageType(jpeg())).toBe("image/jpeg");
    expect(detectImageType(gif())).toBe("image/gif");
    expect(detectImageType(webp())).toBe("image/webp");
  });
  it("非图片返回 null", () => {
    expect(detectImageType(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectImageType(new Uint8Array(0))).toBeNull();
  });
});

describe("stripToBasename", () => {
  it("剥 POSIX 与 Windows 路径", () => {
    expect(stripToBasename("/Users/x/secret/cat.png")).toBe("cat.png");
    expect(stripToBasename("C:\\Users\\x\\cat.png")).toBe("cat.png");
  });
  it("空串/纯路径返回 undefined", () => {
    expect(stripToBasename("")).toBeUndefined();
    expect(stripToBasename("/a/b/")).toBeUndefined();
  });
});

describe("AttachmentStore", () => {
  it("save→read 往返,id 是 sha256 形状,ref 字段齐", () => {
    const store = new AttachmentStore(dir);
    const ref = store.save(png(), "cat.png");
    expect(ref.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ref.mediaType).toBe("image/png");
    expect(ref.bytes).toBe(png().byteLength);
    expect(ref.name).toBe("cat.png");
    expect(Array.from(store.read(ref.id))).toEqual(Array.from(png()));
  });

  it("同内容去重:两次 save 同一 id,库里只有一个文件", () => {
    const store = new AttachmentStore(dir);
    const a = store.save(png(), "a.png");
    const b = store.save(png(), "b.png");
    expect(a.id).toBe(b.id);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("name 剥路径后入 ref;无 name 则缺席", () => {
    const store = new AttachmentStore(dir);
    expect(store.save(png(), "/tmp/secret/cat.png").name).toBe("cat.png");
    expect(store.save(jpeg()).name).toBeUndefined();
  });

  it("非图片字节拒收", () => {
    const store = new AttachmentStore(dir);
    expect(() => store.save(new TextEncoder().encode("plain text"))).toThrow(/png|jpeg|webp|gif/);
  });

  it("超过 IMAGE_MAX_BYTES 拒收", () => {
    const store = new AttachmentStore(dir);
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    expect(() => store.save(big)).toThrow(/10MB|超/);
  });

  it("read 不认非法 id(路径穿越无门)", () => {
    const store = new AttachmentStore(dir);
    expect(() => store.read("../../etc/passwd")).toThrow();
    expect(() => store.read("sha256:zzzz")).toThrow();
  });

  it("文件 0600,目录 0700", () => {
    const store = new AttachmentStore(dir);
    const ref = store.save(png());
    const hex = ref.id.slice("sha256:".length);
    expect(statSync(join(dir, hex)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
