import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../src/session/attachments.js";
import { intakeFile, TEXT_MAX_BYTES } from "../../src/main/attachmentIntake.js";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

let dir: string;
let store: AttachmentStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otter-intake-"));
  store = new AttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("intakeFile 分类", async () => {
  it("图片 → 入库 + previewDataUrl(data URL 形状)", async () => {
    const out = await intakeFile("/tmp/photos/cat.png", png(), store);
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
    const out = await intakeFile("/home/x/notes/readme.md", new TextEncoder().encode(text), store);
    expect(out).toEqual({
      kind: "text", name: "readme.md", content: text,
      bytes: new TextEncoder().encode(text).byteLength,
    });
  });

  it("头 8KB 含 \\0 → 判二进制拒收", async () => {
    const bin = new Uint8Array(100);
    bin.set(new TextEncoder().encode("MZ"), 0); // 不是图片 magic
    bin[50] = 0;
    const out = await intakeFile("/x/prog.exe", bin, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/二进制/);
  });

  it("文本超 100KB 拒收", async () => {
    const big = new Uint8Array(TEXT_MAX_BYTES + 1).fill(0x61); // 全 'a'
    const out = await intakeFile("/x/big.txt", big, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/100KB|超/);
  });

  it("图片超限 → rejected(store.save 的拒绝转分类结果,不抛)", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    const out = await intakeFile("/x/huge.png", big, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/10MB|超/);
  });
});
