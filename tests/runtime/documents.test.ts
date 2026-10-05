// create_document / read_document / send_file 与它们底下的渲染器（#1683）。
// 做出来的文件用 anydoc（桌面附件、云端 read_document 同一个转换器）读回来核字——「打得开、字对」才算做出来了。
import { existsSync, readFileSync } from "node:fs";
import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createDocumentTools, outputName } from "../../services/runtime/src/documentTools.js";
import { evaluateFormula, evaluateSheet } from "../../services/runtime/src/documents/formula.js";
import { parseInline, parseMarkdownLite } from "../../services/runtime/src/documents/markdownLite.js";
import { renderCsv, renderDocx, renderPptx, renderXlsx } from "../../services/runtime/src/documents/office.js";
import { DocumentError, renderPdf, type PdfFonts } from "../../services/runtime/src/documents/pdf.js";
import { cjkVariantOf, splitByScript } from "../../services/runtime/src/documents/scripts.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const noFonts: PdfFonts = { get: () => null };

async function textOf(data: Uint8Array): Promise<string> {
  const f = formatFromBytes(data);
  if (f === null) throw new Error("anydoc 认不出格式");
  return toMarkdownBytes(data, f);
}

function memWorld(seed: Record<string, Uint8Array> = {}): ExecutionWorld & { files: Map<string, Uint8Array> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    fs: {
      read: async (p) => new TextDecoder().decode(files.get(p) ?? new Uint8Array()),
      write: async (p, c) => void files.set(p, new TextEncoder().encode(c)),
      readBytes: async (p) => {
        const d = files.get(p);
        if (d === undefined) throw new Error(`没有 ${p}`);
        return d;
      },
      writeBytes: async (p, d) => void files.set(p, d),
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  };
}

describe("小号 Markdown", () => {
  it("标题 / 段落 / 列表 / 表格 / 引用 / 分隔线", () => {
    const b = parseMarkdownLite("# 报告\n\n第一段\n接着一行\n\n- 甲\n- **乙**\n\n1. one\n2. two\n\n| 名 | 数 |\n|---|---|\n| a | 1 |\n\n> 注意\n\n---");
    expect(b.map((x) => x.kind)).toEqual(["heading", "paragraph", "list", "list", "table", "quote", "rule"]);
    expect(b[2]).toMatchObject({ ordered: false, items: [[{ text: "甲", bold: false }], [{ text: "乙", bold: true }]] });
    expect(b[4]).toEqual({ kind: "table", rows: [["名", "数"], ["a", "1"]] });
  });
  it("「3.5 百万」不是有序列表；链接、代码、斜体剥成字", () => {
    expect(parseMarkdownLite("3.5 million users")[0]!.kind).toBe("paragraph");
    expect(parseInline("看 [官网](https://x.com) 和 `npm` 的 *说明*").map((x) => x.text).join("")).toBe("看 官网（https://x.com） 和 npm 的 说明");
  });
});

describe("公式求值", () => {
  const rows = [["项", "金额"], ["房租", 2400], ["水电", 156.5], ["网", 60], ["合计", "=SUM(B2:B4)"], ["人均", "=ROUND(B5/2,2)"]];
  it("SUM / ROUND / 引用别的公式格", () => {
    const r = evaluateSheet(rows);
    expect(r.get("4,1")).toBe(2616.5);
    expect(r.get("5,1")).toBe(1308.25);
  });
  it("认不出的函数不猜", () => {
    expect(evaluateFormula("=VLOOKUP(A1,B:C,2)", () => null)).toBeNull();
    expect(evaluateFormula("=IF(2>1,\"yes\",\"no\")", () => null)).toBe("yes");
    expect(evaluateFormula("=1/0", () => null)).toBeNull();
  });
});

describe("文字系统", () => {
  it("按文字切段、认日韩繁简", () => {
    expect(splitByScript("Hello 世界 ok").map((r) => r.script)).toEqual(["latin", "cjk", "latin"]);
    expect(cjkVariantOf("会議の資料")).toBe("jp");
    expect(cjkVariantOf("회의 자료")).toBe("kr");
    expect(cjkVariantOf("這個會議")).toBe("tc");
    expect(cjkVariantOf("这个会议")).toBe("sc");
  });
});

describe("渲染器：做出来、读回来字对", () => {
  it("xlsx：表头、数字、公式连结果一起写进去", async () => {
    const r = await renderXlsx([{ name: "Bills/Oct", rows: [["Item", "Amount"], ["Rent", 2400], ["Power", 156.5], ["Total", "=SUM(B2:B3)"]], formats: [null, "#,##0.00"] }]);
    expect(r.computed).toEqual([{ sheet: "Bills Oct", cell: "B4", value: 2556.5 }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(r.data) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Bills Oct")!;
    expect(ws.getCell("B2").value).toBe(2400);
    expect(ws.getCell("B4").value).toMatchObject({ formula: "SUM(B2:B3)", result: 2556.5 });
  });
  it("csv：BOM + 公式写结果 + 逗号加引号", () => {
    const s = new TextDecoder("utf-8", { ignoreBOM: true }).decode(renderCsv({ name: "x", rows: [["a", "b,c"], [1, "=A2*2"]] }));
    expect(s).toBe("\uFEFFa,\"b,c\"\r\n1,2\r\n");
  });
  it("docx：中文与表格读得回来", async () => {
    const data = await renderDocx({ title: "季度汇报", blocks: parseMarkdownLite("## 结论\n\n收入 **增长 12%**。\n\n| 月 | 收入 |\n|---|---|\n| 7 月 | 100 |") });
    const t = await textOf(data);
    expect(t).toContain("季度汇报");
    expect(t).toContain("增长 12%");
    expect(t).toContain("7 月");
  });
  it("pptx：封面 + 要点页 + 表格页读得回来", async () => {
    const data = await renderPptx({ title: "Q3 Review", slides: [{ title: "Q3 Review", subtitle: "Kumo Tech" }, { title: "Highlights", bullets: ["Revenue +12%", "Churn 2.1%"] }, { title: "By region", table: [["Region", "Rev"], ["APAC", 120]] }] });
    const t = await textOf(data);
    for (const s of ["Q3 Review", "Highlights", "Revenue +12%", "APAC"]) expect(t).toContain(s);
  });
  it("pdf：只有西文时没有字体也出得来（Helvetica），读得回字", async () => {
    const data = await renderPdf({ title: "Packing list", blocks: parseMarkdownLite("- Passport\n- Charger\n\n| Item | Qty |\n|---|---|\n| Socks | 5 |"), fonts: noFonts });
    expect(new TextDecoder().decode(data.subarray(0, 5))).toBe("%PDF-");
    const t = await textOf(data);
    expect(t).toContain("Passport");
    expect(t).toContain("Socks");
  });
  it("pdf：有中文却没有中文字体 → 说清楚、建议改做 Word，不出一页豆腐块", async () => {
    await expect(renderPdf({ title: "报价单", blocks: [], fonts: noFonts })).rejects.toThrow(DocumentError);
    await expect(renderPdf({ title: "报价单", blocks: [], fonts: noFonts })).rejects.toThrow(/Word/);
  });
  const yahei = "C:/Windows/Fonts/msyh.ttc";
  const noto = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  const cjkPath = existsSync(yahei) ? { p: yahei, family: "MicrosoftYaHei" } : existsSync(noto) ? { p: noto, family: "NotoSansCJKsc-Regular" } : null;
  it.runIf(cjkPath !== null)("pdf：本机有中文字体时中英混排读得回来", async () => {
    const data = readFileSync(cjkPath!.p);
    const fonts: PdfFonts = { get: (s) => (s === "cjk" ? { data, family: cjkPath!.family } : null) };
    const pdf = await renderPdf({ title: "上海出差 Shanghai trip", blocks: parseMarkdownLite("- 护照 passport\n- 充电器"), fonts });
    const t = await textOf(pdf);
    expect(t).toContain("上海出差");
    expect(t).toContain("passport");
  }, 30_000);
});

describe("三把刀", () => {
  const [create, read, send] = createDocumentTools({ fonts: noFonts, toText: textOf });
  it("create_document：存进 outputs/、交出文件、xlsx 把算出来的数回给模型核", async () => {
    const w = memWorld();
    const out = await create!.run({ format: "xlsx", filename: "Roommate bills", sheets: [{ name: "Oct", rows: [["Item", "Amount"], ["Rent", 2400], ["Total", "=SUM(B2:B2)"]] }] }, w);
    if (typeof out === "string") throw new Error("应当交出文件");
    expect(out.files?.[0]?.name).toBe("Roommate bills.xlsx");
    expect(w.files.has("outputs/Roommate bills.xlsx")).toBe(true);
    expect(out.output).toContain("Oct!B3 = 2,400");
  });
  it("create_document：格式写错、正文是空的都说清楚怎么改", async () => {
    await expect(create!.run({ format: "doc", filename: "x" }, memWorld())).rejects.toThrow(/pdf \/ docx/);
    await expect(create!.run({ format: "pdf", filename: "x" }, memWorld())).rejects.toThrow(/content/);
  });
  it("文件名：剥路径、扩展名按格式改对", () => {
    expect(outputName("../../etc/报告.docx", "pdf", undefined)).toBe("报告.pdf");
    expect(outputName("", "pptx", "Q3 汇报")).toBe("Q3 汇报.pptx");
  });
  it("read_document：Word 转文字、分段读", async () => {
    const docx = await renderDocx({ blocks: parseMarkdownLite("Hello world, this is a test document.") });
    const w = memWorld({ "inbox/a.docx": docx });
    const t = await read!.run({ path: "inbox/a.docx", max_chars: 5 }, w);
    expect(t).toMatch(/^Hello/);
    expect(t).toContain("offset 设成 5");
  });
  it("send_file：工作区文件交出去；图片走图；不认的格式说清", async () => {
    const w = memWorld({ "outputs/q.pdf": new TextEncoder().encode("%PDF-1.4 x"), "a.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), "x.zip": new Uint8Array([1, 2, 3]) });
    const f = await send!.run({ path: "outputs/q.pdf" }, w);
    expect(typeof f !== "string" && f.files?.[0]).toMatchObject({ name: "q.pdf", mimeType: "application/pdf" });
    const i = await send!.run({ path: "a.png" }, w);
    expect(typeof i !== "string" && i.images?.[0]?.mimeType).toBe("image/png");
    await expect(send!.run({ path: "x.zip" }, w)).rejects.toThrow(/发不了/);
  });
});
