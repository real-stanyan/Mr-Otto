// 文档分支(ADR-0046):能按容器签名认出来的文档,先转 Markdown 再走文本那条路。
// 这里跑的是真 anydoc,不 mock —— mock 掉转换器等于只测了自己写的 if。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../src/session/attachments.js";
import { intakeFile, TEXT_MAX_BYTES } from "../../src/main/attachmentIntake.js";

const docx = () => new Uint8Array(readFileSync(join(__dirname, "../fixtures/sample.docx")));

let dir: string;
let store: AttachmentStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otter-doc-"));
  store = new AttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("intakeFile 文档分支", () => {
  it("docx → 转成 Markdown 走文本出口(不入库)", async () => {
    const out = await intakeFile("/home/x/报告.docx", docx(), store);
    expect(out.kind).toBe("text");
    if (out.kind !== "text") return;
    expect(out.name).toBe("报告.docx");
    // 真解析的证据:粗体保住了,表格成了 GFM
    expect(out.content).toContain("**加粗**");
    expect(out.content).toContain("| 名字 | 角色 |");
  });

  it("bytes 是原文件大小,不是转出的 md 长度 —— 转换不该从界面上漏出去", () => {
    const bytes = docx();
    return intakeFile("/x/报告.docx", bytes, store).then((out) => {
      expect(out.kind).toBe("text");
      if (out.kind !== "text") return;
      // 用户丢进来的是这个 docx,界面上就该显示这个大小
      expect(out.bytes).toBe(bytes.byteLength);
      // 而 content 是转出来的 md,两者不是一个数(否则这条测试什么也没钉住)
      expect(new TextEncoder().encode(out.content).byteLength).not.toBe(out.bytes);
    });
  });

  it("纯文本不受影响:bytes 仍然等于内容长度(两者本来就是同一个数)", async () => {
    const text = "# 标题\n正文";
    const raw = new TextEncoder().encode(text);
    const out = await intakeFile("/x/readme.md", raw, store);
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.bytes).toBe(raw.byteLength);
  });

  it("docx 排在 \\0 二进制嗅探之前 —— 否则 zip 容器先被判死", async () => {
    // 这条守的是顺序,不是功能:docx 是 zip,头 8KB 必然含 \0。
    // 一旦有人把文档分支挪到二进制判断后面,这里立刻红
    const bytes = docx();
    expect(bytes.subarray(0, 8192).includes(0)).toBe(true); // 前提:它确实含 \0
    const out = await intakeFile("/x/报告.docx", bytes, store);
    expect(out.kind).toBe("text");
  });

  it("转出的 md 超 100KB → 拒收(判的是 md 的长度,不是原文件的)", async () => {
    // 撑一个正文极长的 docx:原文件压缩后很小,转出来的 md 远超上限
    const big = inflatedDocx("水".repeat(TEXT_MAX_BYTES));
    const out = await intakeFile("/x/big.docx", big, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/100KB|超/);
  });

  it("损坏的 zip 容器 → rejected 带人话理由,不抛", async () => {
    const broken = docx();
    broken.fill(0x41, 40, broken.length); // 签名留着,内容砸烂
    const out = await intakeFile("/x/坏了.docx", broken, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.reason).not.toMatch(/Error|undefined/); // 是人话,不是把异常抛出来
    }
  });

  it("图片型 PDF(无文本层) → rejected 提到 OCR", async () => {
    const out = await intakeFile("/x/扫描件.pdf", imageOnlyPdf(), store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/OCR|扫描/);
  });

  it("认不出容器签名的纯文本(csv/md)不走转换,还是原样文本", async () => {
    // 反向守护:CSV 没有签名,转成表格会撑大体积,把本来收得下的文件顶出上限
    const csv = "name,role\notter,agent\n";
    const out = await intakeFile("/x/t.csv", new TextEncoder().encode(csv), store);
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.content).toBe(csv); // 原样,没变成 GFM 表格
  });
});

/** 造一个正文为 text 的最小 docx(zip 用 store 模式手写,不引依赖) */
function inflatedDocx(text: string): Uint8Array {
  const parts: Array<[string, string]> = [
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  return zipStored(parts);
}

/** 最小 zip 写入器:store 模式(不压缩),够 anydoc 认出容器就行 */
function zipStored(parts: Array<[string, string]>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 合法但没有文本层的 PDF(只有一个空页面)—— anydoc 认得是 pdf,但抽不出字。
    xref 偏移量必须真算,手数出来的 PDF 会被判 malformed,测的就不是这条路了 */
function imageOnlyPdf(): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8/Length 1>>\nstream\n\x00\nendstream",
    "<</Length 24>>\nstream\nq 200 0 0 200 0 0 cm /Im0 Do Q\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff);
}
