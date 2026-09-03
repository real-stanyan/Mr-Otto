import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { AttachmentStore } from "../../src/session/attachments.js";
import { intakeFile, TEXT_MAX_BYTES } from "../../src/main/attachmentIntake.js";
import { IMAGE_FIT_TARGET_BYTES, type FitEncoder } from "../../src/shared/imageFit.js";
import { tempDir } from "../helpers/tempDir.js";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

/** "这个格式解不了" —— webp/gif 在桌面真实编解码器里就是这条路 */
const noFit: FitEncoder = async () => null;

/** 每一级都缩一半的假编解码器,产出是货真价实的 JPEG 签名(store 按签名认) */
const jpegAt = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff], 0);
  return b;
};

let dir: string;
let store: AttachmentStore;
beforeEach(() => {
  dir = tempDir("otter-intake-");
  store = new AttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("intakeFile 分类", async () => {
  it("图片 → 入库 + previewDataUrl(data URL 形状)", async () => {
    const out = await intakeFile("/tmp/photos/cat.png", png(), store, noFit);
    expect(out.kind).toBe("image");
    if (out.kind !== "image") return;
    expect(out.ref.mediaType).toBe("image/png");
    expect(out.ref.name).toBe("cat.png");
    expect(out.previewDataUrl).toBe(
      `data:image/png;base64,${Buffer.from(png()).toString("base64")}`
    );
    expect(Array.from(store.read(out.ref.id))).toEqual(Array.from(png()));
  });

  it("文本文件 → 内容 + basename + bytes(不入库)", async () => {
    const text = "# 标题\n正文";
    const out = await intakeFile("/home/x/notes/readme.md", new TextEncoder().encode(text), store, noFit);
    expect(out).toEqual({
      kind: "text", name: "readme.md", content: text,
      bytes: new TextEncoder().encode(text).byteLength,
    });
  });

  it("头 8KB 含 \\0 → 判二进制拒收", async () => {
    const bin = new Uint8Array(100);
    bin.set(new TextEncoder().encode("MZ"), 0); // 不是图片 magic
    bin[50] = 0;
    const out = await intakeFile("/x/prog.exe", bin, store, noFit);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/二进制/);
  });

  it("文本超 100KB 拒收", async () => {
    const big = new Uint8Array(TEXT_MAX_BYTES + 1).fill(0x61); // 全 'a'
    const out = await intakeFile("/x/big.txt", big, store, noFit);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/100KB|超/);
  });

  it("超限图片 → 缩过再入库:名字改 .jpg,ref 认成 jpeg,预览用缩后的字节", async () => {
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    const shrunk = jpegAt(1024);
    const encode: FitEncoder = async (_d, edge) =>
      // 顶格那一级还是超,第二级才过 —— 阶梯要真的往下走
      edge === 2048 ? jpegAt(IMAGE_FIT_TARGET_BYTES + 1) : shrunk;

    const out = await intakeFile("/x/huge.png", big, store, encode);
    expect(out.kind).toBe("image");
    if (out.kind !== "image") return;
    expect(out.ref.name).toBe("huge.jpg");
    expect(out.ref.mediaType).toBe("image/jpeg");
    expect(out.ref.bytes).toBe(shrunk.byteLength);
    expect(out.previewDataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(Array.from(store.read(out.ref.id))).toEqual(Array.from(shrunk));
  });

  it("压到阶梯最底一级仍然超 → rejected,报最小那一版的真实字节数", async () => {
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    const out = await intakeFile("/x/huge.png", big, store, async () =>
      jpegAt(5 * 1024 * 1024)
    );
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/5\.0MB/);
  });

  it("格式解不了 + 超 10MB → rejected,理由说的是「压不动这个格式」不是干巴巴一句太大", async () => {
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set([0x52, 0x49, 0x46, 0x46], 0);
    big.set([0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
    const out = await intakeFile("/x/huge.webp", big, store, noFit);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/压不动这个格式/);
  });

  it("格式解不了但没超 10MB → 原样入库(今天能传的,明天照样能传)", async () => {
    const webp = new Uint8Array(5 * 1024 * 1024);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    const out = await intakeFile("/x/ok.webp", webp, store, noFit);
    expect(out.kind).toBe("image");
    if (out.kind !== "image") return;
    expect(out.ref.mediaType).toBe("image/webp");
    expect(out.ref.bytes).toBe(webp.byteLength);
  });
});
