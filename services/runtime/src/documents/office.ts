// create_document 的 Word / Excel / PPT 三支（#1683）。三种都不嵌字体：看文件的那台设备用自己的字体
// （scripts.officeFontFor 只给个提示，中文给雅黑、日文给游ゴシック、韩文给맑은 고딕），所以服务器上有没有字体都出得来——
// 这也是 PDF 出不来时让模型改做 Word 的理由。
import ExcelJS from "exceljs";
import PptxGenJSImport from "pptxgenjs";
import {
  BorderStyle, Document, HeadingLevel, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { evaluateSheet, colName, type CellValue } from "./formula.js";
import { inlineText, type Block, type Inline } from "./markdownLite.js";
import { officeFontFor } from "./scripts.js";

const ACCENT = "2F5D8A";

// pptxgenjs 的类型按 CJS 模块给（default 套一层），运行时走 exports.import 的 ES 构建、default 就是类本身：两种都认
type PptxCtor = typeof PptxGenJSImport.default;
const PptxGenJS: PptxCtor = (PptxGenJSImport as unknown as { default?: PptxCtor }).default ?? (PptxGenJSImport as unknown as PptxCtor);

// ── Word ────────────────────────────────────────────────────────────────

export async function renderDocx(o: { title?: string; blocks: readonly Block[] }): Promise<Uint8Array> {
  const all = [o.title ?? "", ...o.blocks.map((b) => (b.kind === "table" ? b.rows.flat().join(" ") : b.kind === "list" ? b.items.map(inlineText).join(" ") : b.kind === "rule" ? "" : inlineText(b.text)))].join("\n");
  const f = officeFontFor(all);
  const font = { ascii: f.latin, hAnsi: f.latin, ...(f.eastAsia !== undefined ? { eastAsia: f.eastAsia } : {}) };
  const runs = (xs: readonly Inline[], extra: { bold?: boolean; color?: string; italics?: boolean; size?: number } = {}): TextRun[] =>
    xs.map((x) => new TextRun({ text: x.text, bold: x.bold || extra.bold === true, font, ...(extra.color ? { color: extra.color } : {}), ...(extra.italics ? { italics: true } : {}), ...(extra.size ? { size: extra.size } : {}) }));
  const children: (Paragraph | Table)[] = [];
  if (o.title !== undefined && o.title.trim() !== "") {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: o.title, font, bold: true, color: ACCENT })], spacing: { after: 240 } }));
  }
  for (const b of o.blocks) {
    switch (b.kind) {
      case "heading":
        children.push(new Paragraph({ heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, children: runs(b.text, { bold: true }), spacing: { before: 240, after: 120 } }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(b.text), spacing: { after: 160, line: 300 } }));
        break;
      case "quote":
        children.push(new Paragraph({ children: runs(b.text, { italics: true, color: "555555" }), indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CBD5E1", space: 8 } }, spacing: { after: 160 } }));
        break;
      case "rule":
        children.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1", space: 1 } }, spacing: { after: 160 } }));
        break;
      case "list":
        b.items.forEach((item, i) => {
          children.push(
            b.ordered
              ? new Paragraph({ children: [new TextRun({ text: `${i + 1}. `, font }), ...runs(item)], indent: { left: 360, hanging: 260 }, spacing: { after: 80 } })
              : new Paragraph({ children: runs(item), bullet: { level: 0 }, spacing: { after: 80 } })
          );
        });
        break;
      case "table": {
        const cols = Math.max(...b.rows.map((r) => r.length));
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.rows.map((row, ri) =>
              new TableRow({
                tableHeader: ri === 0,
                children: Array.from({ length: cols }, (_v, c) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: row[c] ?? "", bold: ri === 0 && b.rows.length > 1, font })] })],
                    ...(ri === 0 && b.rows.length > 1 ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: "E8EEF5" } } : {}),
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                  })
                ),
              })
            ),
          })
        );
        children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
    }
  }
  const doc = new Document({
    creator: "Mr Otto",
    title: o.title ?? "Document",
    styles: { default: { document: { run: { font, size: 22 } } } },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// ── Excel ───────────────────────────────────────────────────────────────

export interface SheetSpec {
  name: string;
  rows: CellValue[][];
  /** 第一行是表头（加粗、底色、冻结、筛选）。缺席 = true */
  header?: boolean;
  /** 每列的数字格式（"#,##0.00"、"0%"、"yyyy-mm-dd"），null = 不设 */
  formats?: (string | null)[];
  /** 每列宽（字符数）；缺席按内容估 */
  widths?: number[];
}

export interface XlsxResult {
  data: Uint8Array;
  /** 算出来的公式结果，回给模型核一遍（「B12 = 1,234.50」） */
  computed: { sheet: string; cell: string; value: number | string | boolean }[];
}

/** 中日韩字按两个字符宽算 */
const visualLen = (s: string): number => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

/** Excel 的表名规矩：≤ 31 个字、不许 : \ / ? * [ ]、不许重名 */
function sheetName(raw: string, used: Set<string>, i: number): string {
  let s = raw.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
  let k = 2;
  while (used.has(s.toLowerCase())) s = `${s.slice(0, 28)} ${k++}`;
  used.add(s.toLowerCase());
  return s;
}

export async function renderXlsx(sheets: readonly SheetSpec[]): Promise<XlsxResult> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mr Otto";
  const used = new Set<string>();
  const computed: XlsxResult["computed"] = [];
  sheets.forEach((spec, si) => {
    const name = sheetName(spec.name, used, si);
    const ws = wb.addWorksheet(name);
    const header = spec.header !== false && spec.rows.length > 1;
    const results = evaluateSheet(spec.rows);
    const cols = Math.max(0, ...spec.rows.map((r) => r.length));
    spec.rows.forEach((row, r) => {
      const xr = ws.getRow(r + 1);
      row.forEach((v, c) => {
        const cell = xr.getCell(c + 1);
        if (typeof v === "string" && v.startsWith("=")) {
          const res = results.get(`${r},${c}`);
          cell.value = res === undefined ? { formula: v.slice(1) } : ({ formula: v.slice(1), result: res } as ExcelJS.CellFormulaValue);
          if (res !== undefined) computed.push({ sheet: name, cell: `${colName(c)}${r + 1}`, value: res });
        } else {
          cell.value = v;
        }
        const fmt = spec.formats?.[c];
        if (fmt && !(header && r === 0)) cell.numFmt = fmt;
      });
      if (header && r === 0) {
        xr.font = { bold: true, color: { argb: "FFFFFFFF" } };
        xr.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ACCENT}` } };
          cell.alignment = { vertical: "middle" };
        });
      }
    });
    for (let c = 0; c < cols; c++) {
      const w = spec.widths?.[c] ?? Math.min(50, Math.max(8, ...spec.rows.map((r) => {
        const v = r[c];
        return v === null || v === undefined ? 0 : typeof v === "string" && v.startsWith("=") ? 10 : visualLen(String(v)) + 2;
      })));
      ws.getColumn(c + 1).width = w;
    }
    if (header) {
      ws.views = [{ state: "frozen", ySplit: 1 }];
      if (cols > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols } };
    }
  });
  const buf = await wb.xlsx.writeBuffer();
  return { data: new Uint8Array(buf as ArrayBuffer), computed };
}

/** CSV：只取第一张表；公式格写算出来的值（算不出写公式原文），字段按 RFC 4180 加引号，前面加 BOM 让 Excel 认出 UTF-8 */
export function renderCsv(sheet: SheetSpec): Uint8Array {
  const results = evaluateSheet(sheet.rows);
  const esc = (v: CellValue, r: number, c: number): string => {
    let s = v === null ? "" : typeof v === "string" && v.startsWith("=") ? String(results.get(`${r},${c}`) ?? v) : String(v);
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = sheet.rows.map((row, r) => row.map((v, c) => esc(v, r, c)).join(",")).join("\r\n");
  return new TextEncoder().encode(`﻿${body}\r\n`);
}

// ── PPT ─────────────────────────────────────────────────────────────────

export interface SlideSpec {
  title: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: CellValue[][];
  notes?: string;
}

export async function renderPptx(o: { title?: string; slides: readonly SlideSpec[] }): Promise<Uint8Array> {
  const all = [o.title ?? "", ...o.slides.flatMap((s) => [s.title, s.subtitle ?? "", ...(s.bullets ?? []), s.text ?? "", ...(s.table ?? []).flat().map((v) => String(v ?? ""))])].join("\n");
  const f = officeFontFor(all);
  const face = f.eastAsia ?? f.latin;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 英寸
  pptx.title = o.title ?? o.slides[0]?.title ?? "Slides";
  pptx.author = "Mr Otto";
  const W = 13.33;
  o.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    const isCover = i === 0 && (s.bullets ?? []).length === 0 && s.table === undefined && (s.text ?? "") === "";
    if (isCover) {
      slide.background = { color: ACCENT };
      slide.addText(s.title, { x: 0.8, y: 2.4, w: W - 1.6, h: 1.4, fontFace: face, fontSize: 40, bold: true, color: "FFFFFF", fit: "shrink" });
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.8, y: 3.9, w: W - 1.6, h: 0.8, fontFace: face, fontSize: 20, color: "DCE6F0" });
    } else {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.12, fill: { color: ACCENT }, line: { color: ACCENT } });
      slide.addText(s.title, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontFace: face, fontSize: 28, bold: true, color: "1F2937", fit: "shrink" });
      let y = 1.4;
      if (s.subtitle) {
        slide.addText(s.subtitle, { x: 0.6, y: 1.15, w: W - 1.2, h: 0.5, fontFace: face, fontSize: 16, color: "6B7280" });
        y = 1.75;
      }
      const hasTable = s.table !== undefined && s.table.length > 0;
      const bodyH = 7.5 - y - 0.6;
      if (s.bullets && s.bullets.length > 0) {
        slide.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: true, paraSpaceAfter: 8 } })),
          { x: 0.7, y, w: hasTable ? (W - 1.4) / 2 - 0.2 : W - 1.4, h: bodyH, fontFace: face, fontSize: 20, color: "374151", valign: "top", fit: "shrink" }
        );
      } else if (s.text) {
        slide.addText(s.text, { x: 0.7, y, w: hasTable ? (W - 1.4) / 2 - 0.2 : W - 1.4, h: bodyH, fontFace: face, fontSize: 20, color: "374151", valign: "top", fit: "shrink" });
      }
      if (hasTable) {
        const side = (s.bullets && s.bullets.length > 0) || s.text;
        const rows = s.table!.map((row, ri) =>
          row.map((v) => ({ text: v === null ? "" : String(v), options: ri === 0 ? { bold: true, color: "FFFFFF", fill: { color: ACCENT } } : {} }))
        );
        slide.addTable(rows, {
          x: side ? W / 2 + 0.1 : 0.7, y, w: side ? W / 2 - 0.8 : W - 1.4,
          fontFace: face, fontSize: 14, color: "1F2937", border: { type: "solid", pt: 0.5, color: "CBD5E1" }, autoPage: false,
        });
      }
      slide.slideNumber = { x: W - 1.0, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: "9CA3AF" };
    }
    if (s.notes) slide.addNotes(s.notes);
  });
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(out);
}

