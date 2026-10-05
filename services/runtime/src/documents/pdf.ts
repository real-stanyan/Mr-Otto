// create_document 的 PDF 那一支（#1683）。pdfkit 画，字体按字挑（scripts.ts）：
//
// · 西文：有 Unicode 西文字体（Noto Sans / DejaVu / Arial）就用它——越南语的 ư ơ ạ、德语的 ß、各种箭头勾叉
//   Helvetica（PDF 内置的那十四款）都印不出来；没有就退到中日韩字体（它们也带全套西文），再没有才用 Helvetica。
// · 中日韩 / 泰文 / 天城文：**没有字体就不出这份 PDF**，抛 DocumentError 说清楚、建议改做 Word——印出一页豆腐块
//   交给人，比说「这台机器印不了中文，给你 Word」糟得多（Word 不嵌字体，看的那台设备自己有）。
//
// 字体字节由调用方注入（PdfFonts）：工具层不碰 fs（硬规则），daemon 从系统字体目录读。
import PDFDocument from "pdfkit";
import type { Block, Inline } from "./markdownLite.js";
import { cjkVariantOf, scriptsIn, splitByScript, type CjkVariant, type Script } from "./scripts.js";

export class DocumentError extends Error {}

export interface PdfFont {
  data: Uint8Array;
  /** 字体集（.ttc）里要哪一款的 PostScript 名；单款字体文件不填 */
  family?: string;
}

export interface PdfFonts {
  get(script: Script, o: { bold: boolean; variant?: CjkVariant }): PdfFont | null;
}

const PAGE_MARGIN = 56;
const ACCENT = "#2F5D8A";
const MUTED = "#6B7280";

type FontKey = string;

function allText(title: string | undefined, blocks: readonly Block[]): string {
  const parts: string[] = [title ?? ""];
  for (const b of blocks) {
    if (b.kind === "table") parts.push(b.rows.flat().join(" "));
    else if (b.kind === "list") parts.push(b.items.map((i) => i.map((x) => x.text).join("")).join(" "));
    else if (b.kind !== "rule") parts.push(b.text.map((x) => x.text).join(""));
  }
  return parts.join("\n");
}

const SCRIPT_NAME: Record<Exclude<Script, "latin">, string> = { cjk: "中日韩文字", thai: "泰文", deva: "印地文（天城文）" };

export async function renderPdf(o: { title?: string; blocks: readonly Block[]; fonts: PdfFonts }): Promise<Uint8Array> {
  const text = allText(o.title, o.blocks);
  const scripts = scriptsIn(text);
  const variant = cjkVariantOf(text);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    info: { Title: o.title ?? "Document", Creator: "Mr Otto" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res, rej) => {
    doc.on("end", () => res());
    doc.on("error", (e: unknown) => rej(e));
  });

  // ── 字体：每种文字一正一粗，注册成 <文字><R|B> ──────────────────────────
  const registered = new Map<FontKey, string>();
  const register = (key: FontKey, f: PdfFont | null): boolean => {
    if (f === null) return false;
    try {
      const buf = Buffer.from(f.data);
      if (f.family !== undefined) doc.registerFont(key, buf, f.family);
      else doc.registerFont(key, buf);
      // 立刻用一下：字体集里没有这个名字时 pdfkit 在 font() 那一刻才抛
      doc.font(key);
      registered.set(key, key);
      return true;
    } catch {
      return false;
    }
  };
  for (const s of ["cjk", "thai", "deva"] as const) {
    if (!scripts.has(s)) continue;
    const ok = register(`${s}R`, o.fonts.get(s, { bold: false, variant }));
    if (!ok) throw new DocumentError(`这台服务器上没有能印${SCRIPT_NAME[s]}的字体，PDF 出不来——改做 Word（docx）吧，看的那台设备会用自己的字体。`);
    if (!register(`${s}B`, o.fonts.get(s, { bold: true, variant }))) registered.set(`${s}B`, `${s}R`);
  }
  if (register("latinR", o.fonts.get("latin", { bold: false }))) {
    if (!register("latinB", o.fonts.get("latin", { bold: true }))) registered.set("latinB", "latinR");
  } else if (registered.has("cjkR")) {
    // 没有 Unicode 西文字体：中日韩字体自带全套西文，比 Helvetica 认得的字多
    registered.set("latinR", "cjkR");
    registered.set("latinB", registered.get("cjkB")!);
  } else {
    registered.set("latinR", "Helvetica");
    registered.set("latinB", "Helvetica-Bold");
  }
  const fontFor = (s: Script, bold: boolean): string => registered.get(`${s}${bold ? "B" : "R"}`) ?? registered.get(`latin${bold ? "B" : "R"}`)!;
  // Helvetica 印不出的字（没有 Unicode 西文字体时）：换成问号，好过一个乱码
  const helv = registered.get("latinR") === "Helvetica";
  // emoji 哪款 PDF 字体都没有（彩色字形 pdfkit 也画不了）：印出来是一个方框，干脆去掉（#1683 模拟：「🏔️ Tahoe Trip」）
  const noEmoji = (s: string): string => s.replace(/\p{Extended_Pictographic}|[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]|[\u{1F1E6}-\u{1F1FF}]/gu, "");
  const safe = (s: string): string => (helv ? noEmoji(s).replace(/[^\u0000-ÿ–—‘’“”•…€]/g, "?") : noEmoji(s));

  const left = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const bottom = (): number => doc.page.height - PAGE_MARGIN;

  /** 一段带粗细的文字，按文字切段换字体，接着写（continued） */
  const rich = (xs: readonly Inline[], size: number, o2: { x?: number; width?: number; color?: string; boldAll?: boolean; lineGap?: number } = {}): void => {
    const runs: { font: string; text: string }[] = [];
    for (const x of xs) for (const r of splitByScript(x.text)) runs.push({ font: fontFor(r.script, x.bold || o2.boldAll === true), text: safe(r.text) });
    if (runs.length === 0) return;
    doc.fillColor(o2.color ?? "#111827");
    runs.forEach((r, i) => {
      const opts = { continued: i < runs.length - 1, width: o2.width ?? width, lineGap: o2.lineGap ?? 3 };
      doc.font(r.font).fontSize(size);
      if (i === 0 && o2.x !== undefined) doc.text(r.text, o2.x, doc.y, opts);
      else doc.text(r.text, opts);
    });
    doc.x = left;
  };
  const plain = (t: string): Inline[] => [{ text: t, bold: false }];
  const ensureRoom = (h: number): void => {
    if (doc.y + h > bottom()) doc.addPage();
  };

  if (o.title !== undefined && o.title.trim() !== "") {
    rich(plain(o.title), 22, { boldAll: true });
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(ACCENT).stroke();
    doc.moveDown(0.8);
  }

  for (const b of o.blocks) {
    switch (b.kind) {
      case "heading": {
        const size = b.level === 1 ? 17 : b.level === 2 ? 14 : 12;
        ensureRoom(size * 3);
        doc.moveDown(0.4);
        rich(b.text, size, { boldAll: true, color: b.level === 1 ? ACCENT : "#111827" });
        doc.moveDown(0.3);
        break;
      }
      case "paragraph":
        rich(b.text, 11);
        doc.moveDown(0.6);
        break;
      case "quote": {
        const y0 = doc.y;
        rich(b.text, 11, { x: left + 14, width: width - 14, color: MUTED });
        doc.moveTo(left + 4, y0).lineTo(left + 4, doc.y).lineWidth(2).strokeColor("#CBD5E1").stroke();
        doc.moveDown(0.6);
        break;
      }
      case "rule":
        doc.moveDown(0.3);
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.5).strokeColor("#CBD5E1").stroke();
        doc.moveDown(0.6);
        break;
      case "list": {
        b.items.forEach((item, idx) => {
          ensureRoom(20);
          const y = doc.y;
          doc.font(fontFor("latin", false)).fontSize(11).fillColor("#111827");
          doc.text(b.ordered ? `${idx + 1}.` : "•", left + 4, y, { width: 18 });
          doc.y = y;
          rich(item, 11, { x: left + 22, width: width - 22 });
          doc.moveDown(0.2);
        });
        doc.moveDown(0.4);
        break;
      }
      case "table": {
        const cols = Math.max(...b.rows.map((r) => r.length));
        // 列宽按每列最长的那格分（中日韩字算两个），每列至少占 1/(列数*2)
        const weight = Array.from({ length: cols }, (_v, c) =>
          Math.max(4, ...b.rows.map((r) => [...(r[c] ?? "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)))
        );
        const total = weight.reduce((a, x) => a + x, 0);
        const minW = width / (cols * 2);
        let ws = weight.map((w) => Math.max(minW, (w / total) * width));
        const k = width / ws.reduce((a, x) => a + x, 0);
        ws = ws.map((w) => w * k);
        const pad = 5;
        b.rows.forEach((row, ri) => {
          const header = ri === 0 && b.rows.length > 1;
          const cellFont = (t: string): string => {
            const s = splitByScript(t).find((r) => r.script !== "latin")?.script ?? "latin";
            return fontFor(s, header);
          };
          const heights = Array.from({ length: cols }, (_v, c) => {
            const t = safe(row[c] ?? "");
            doc.font(cellFont(t)).fontSize(10);
            return doc.heightOfString(t === "" ? " " : t, { width: ws[c]! - pad * 2 });
          });
          const h = Math.max(...heights) + pad * 2;
          ensureRoom(h);
          const y = doc.y;
          let x = left;
          for (let c = 0; c < cols; c++) {
            const t = safe(row[c] ?? "");
            if (header) doc.rect(x, y, ws[c]!, h).fillColor("#E8EEF5").fill();
            doc.rect(x, y, ws[c]!, h).lineWidth(0.5).strokeColor("#CBD5E1").stroke();
            // 单元格内按文字切段（一格里中英混排）
            const runs = splitByScript(t);
            doc.fillColor("#111827");
            runs.forEach((r, i) => {
              doc.font(fontFor(r.script, header)).fontSize(10);
              const opts = { width: ws[c]! - pad * 2, continued: i < runs.length - 1, lineGap: 1 };
              if (i === 0) doc.text(r.text, x + pad, y + pad, opts);
              else doc.text(r.text, opts);
            });
            x += ws[c]!;
          }
          doc.x = left;
          doc.y = y + h;
        });
        doc.moveDown(0.8);
        break;
      }
    }
  }

  // 页码：「2 / 5」，最后统一补（bufferPages）
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(fontFor("latin", false)).fontSize(9).fillColor(MUTED);
    // 写在页边距里：先把底边距临时放开，不然 pdfkit 以为写出界了会自己加一页
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.text(`${i + 1} / ${range.count}`, left, doc.page.height - PAGE_MARGIN / 2 - 6, { width, align: "center", lineBreak: false });
    doc.page.margins.bottom = m;
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
