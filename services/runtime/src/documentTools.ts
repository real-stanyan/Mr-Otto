// 文件三把刀（#1683，维护者 2026-10-06：「Agent 生成 PDF，PPT，Excel 等文件」「App 可以分享文件」）：
//   · create_document —— 做一份文件交给人：PDF / Word / Excel / PPT / CSV / Markdown。存进工作区 outputs/，
//     字节交给 toolFiles 中间件传进 chat-media，手机上是一张点得开的文件卡。
//   · read_document   —— 读工作区里的文件（人发来的存在 inbox/）：PDF / Word / Excel / PPT 转成文字（anydoc），
//     文本类直接读。人发来的那份收的时候已经转过一次、整段给了模型；这把刀给「太长只给了开头」「之前发的那份」用。
//   · send_file       —— 把工作区里已有的文件发到聊天里（之前做过的那份、bash 生成的、别人发来又要转给谁的）。
//
// 工具只依赖 ExecutionWorld（硬规则）：读写走 world.fs.readBytes / writeBytes；字体与转文字由调用方注入（daemon 读系统字体、
// 接 anydoc）。world 没有二进制读写、或没装 toolFiles 中间件时整组不挂（装配根管）——不然模型说「发给你了」而人什么都没收到。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { DOCX_MIME, FILE_MAX_BYTES, PPTX_MIME, XLSX_MIME, cleanFileName, docMimeForName, fileSizeLabel } from "../../../src/shared/chatMedia.js";
import type { CellValue } from "./documents/formula.js";
import { parseMarkdownLite } from "./documents/markdownLite.js";
import { renderCsv, renderDocx, renderPptx, renderXlsx, type SheetSpec, type SlideSpec } from "./documents/office.js";
import { DocumentError, renderPdf, type PdfFonts } from "./documents/pdf.js";

export const CREATE_DOCUMENT_TOOL_NAME = "create_document";
export const READ_DOCUMENT_TOOL_NAME = "read_document";
export const SEND_FILE_TOOL_NAME = "send_file";

export interface DocumentToolsPort {
  fonts: PdfFonts;
  /** PDF / Word / Excel / PPT 转 Markdown（daemon 接 anydoc）。缺席 = read_document 只读得了文本类 */
  toText?: (data: Uint8Array) => Promise<string>;
}

/** 做出来的文件放哪 */
export const OUTPUT_DIR = "outputs";

const FORMATS = ["pdf", "docx", "xlsx", "pptx", "csv", "md"] as const;
type Format = (typeof FORMATS)[number];
const MIME: Record<Format, string> = { pdf: "application/pdf", docx: DOCX_MIME, xlsx: XLSX_MIME, pptx: PPTX_MIME, csv: "text/csv", md: "text/markdown" };

const CONTENT_MAX = 200_000;
const ROWS_MAX = 5_000;
const SHEETS_MAX = 20;
const SLIDES_MAX = 60;

function needBytes(world: ExecutionWorld): { read: (p: string) => Promise<Uint8Array>; write: (p: string, d: Uint8Array) => Promise<void> } {
  const r = world.fs.readBytes;
  const w = world.fs.writeBytes;
  if (r === undefined || w === undefined) throw new Error("这个环境读写不了文件。");
  return { read: r.bind(world.fs), write: w.bind(world.fs) };
}

const isCell = (v: unknown): v is CellValue => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** 模型给的表格：每行是数组；格子只收字符串 / 数字 / 布尔 / null，别的（对象）转成字符串，不整份拒 */
function cellsOf(raw: unknown, what: string): CellValue[][] {
  if (!Array.isArray(raw)) throw new Error(`${what} 要是二维数组：[["表头1","表头2"],["值",123]]`);
  if (raw.length > ROWS_MAX) throw new Error(`${what} 最多 ${ROWS_MAX} 行`);
  return raw.map((row) => (Array.isArray(row) ? row : [row]).map((v) => (isCell(v) ? v : JSON.stringify(v))));
}

/** 文件名：用模型给的（剥路径、截长），扩展名按格式补齐 / 改对 */
export function outputName(raw: unknown, format: Format, title: string | undefined): string {
  const base0 = typeof raw === "string" && raw.trim() !== "" ? raw : title ?? "document";
  const base = (cleanFileName(base0) ?? "document").replace(/\.(pdf|docx?|xlsx?|pptx?|csv|md|markdown|txt)$/i, "");
  return cleanFileName(`${base}.${format}`) ?? `document.${format}`;
}

export function createDocumentTools(port: DocumentToolsPort): Tool[] {
  const createDocument: Tool = {
    def: {
      name: CREATE_DOCUMENT_TOOL_NAME,
      description:
        "做一份文件交给用户：pdf（报告、清单、信、行程单）、docx（要别人再改的文档）、xlsx（账、预算、名单、排班——要算的用公式）、" +
        "pptx（汇报、提案）、csv、md。做好存进工作区 outputs/，同时作为文件发到这个聊天里，用户点开就能看——不用再把全文贴进回话，一句话说做好了、里面有什么就行。" +
        "文件里的字用用户说话的语言。pdf 印不了某种文字时会报错，那就改做 docx。",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: [...FORMATS], description: "文件格式" },
          filename: { type: "string", description: "文件名（不用带扩展名），用用户的语言起，如「Q3 销售汇总」「Lisbon packing list」" },
          title: { type: "string", description: "标题：pdf / docx 印在第一行，pptx 没给 slides[0] 时当封面" },
          content: {
            type: "string",
            description: "pdf / docx / md 的正文，小号 Markdown：# ## ### 标题、空行分段、- 列表、1. 列表、| 表头 | 表头 | 表格、> 引用、**加粗**、--- 分隔线",
          },
          sheets: {
            type: "array",
            description: "xlsx / csv：每张表 { name, rows }，rows 第一行是表头，数字写成数字（别写成字符串），要算的写公式字符串如 \"=SUM(B2:B9)\"；csv 只取第一张",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                rows: { type: "array", items: { type: "array", items: {} } },
                formats: { type: "array", items: { type: ["string", "null"] }, description: "每列数字格式，如 \"#,##0.00\"、\"0%\"、\"yyyy-mm-dd\"，不设写 null" },
                widths: { type: "array", items: { type: "number" }, description: "每列宽（字符数），不给就按内容估" },
              },
              required: ["name", "rows"],
            },
          },
          slides: {
            type: "array",
            description: "pptx：每页一个 { title, subtitle?, bullets?, text?, table?, notes? }；第一页只给 title（+subtitle）就是封面。一页 3–6 条要点",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                subtitle: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                text: { type: "string" },
                table: { type: "array", items: { type: "array", items: {} } },
                notes: { type: "string", description: "演讲者备注" },
              },
              required: ["title"],
            },
          },
        },
        required: ["format", "filename"],
      },
    },
    requiresApproval: false,
    async run(args, world) {
      const a = (args ?? {}) as Record<string, unknown>;
      const format = (typeof a.format === "string" ? a.format.toLowerCase().replace(/^\./, "") : "") as Format;
      if (!(FORMATS as readonly string[]).includes(format)) throw new Error(`format 要是 ${FORMATS.join(" / ")} 之一`);
      const title = typeof a.title === "string" && a.title.trim() !== "" ? a.title.trim() : undefined;
      const name = outputName(a.filename, format, title);
      const io = needBytes(world);
      let data: Uint8Array;
      let extra = "";
      if (format === "pdf" || format === "docx" || format === "md") {
        const content = typeof a.content === "string" ? a.content : "";
        if (content.trim() === "" && title === undefined) throw new Error("content 是空的：pdf / docx / md 要写正文（小号 Markdown）");
        if (content.length > CONTENT_MAX) throw new Error(`content 太长（最多 ${CONTENT_MAX} 字）`);
        if (format === "md") {
          data = new TextEncoder().encode(title !== undefined ? `# ${title}\n\n${content}\n` : `${content}\n`);
        } else {
          const blocks = parseMarkdownLite(content);
          try {
            data = format === "pdf" ? await renderPdf({ ...(title !== undefined ? { title } : {}), blocks, fonts: port.fonts }) : await renderDocx({ ...(title !== undefined ? { title } : {}), blocks });
          } catch (err) {
            if (err instanceof DocumentError) throw err;
            throw new Error(`${format} 没做出来：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (format === "xlsx" || format === "csv") {
        const raw = Array.isArray(a.sheets) ? a.sheets : a.rows !== undefined ? [{ name: title ?? "Sheet1", rows: a.rows }] : [];
        if (raw.length === 0) throw new Error("sheets 是空的：xlsx / csv 要给 sheets: [{ name, rows: [[表头…],[值…]] }]");
        if (raw.length > SHEETS_MAX) throw new Error(`最多 ${SHEETS_MAX} 张表`);
        const sheets: SheetSpec[] = raw.map((s: unknown, i: number) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return {
            name: typeof o.name === "string" ? o.name : `Sheet${i + 1}`,
            rows: cellsOf(o.rows, `sheets[${i}].rows`),
            ...(Array.isArray(o.formats) ? { formats: o.formats.map((f) => (typeof f === "string" ? f : null)) } : {}),
            ...(Array.isArray(o.widths) ? { widths: o.widths.filter((w): w is number => typeof w === "number") } : {}),
          };
        });
        if (format === "csv") {
          data = renderCsv(sheets[0]!);
        } else {
          const r = await renderXlsx(sheets);
          data = r.data;
          if (r.computed.length > 0) {
            const shown = r.computed.slice(0, 12).map((c) => `${c.sheet}!${c.cell} = ${typeof c.value === "number" ? c.value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(c.value)}`);
            extra = `\n公式算出来是：${shown.join("；")}${r.computed.length > 12 ? ` …（共 ${r.computed.length} 格）` : ""}。核一下对不对。`;
          }
        }
        extra = `\n${sheets.map((s) => `「${s.name}」${s.rows.length} 行`).join("、")}${extra}`;
      } else {
        const raw = Array.isArray(a.slides) ? a.slides : [];
        if (raw.length === 0 && title === undefined) throw new Error("slides 是空的：pptx 要给 slides: [{ title, bullets: [...] }]");
        if (raw.length > SLIDES_MAX) throw new Error(`最多 ${SLIDES_MAX} 页`);
        const slides: SlideSpec[] = raw.map((s: unknown, i: number) => {
          const o = (s ?? {}) as Record<string, unknown>;
          const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
          const t = str(o.title) ?? `${i + 1}`;
          return {
            title: t,
            ...(str(o.subtitle) !== undefined ? { subtitle: str(o.subtitle)! } : {}),
            ...(Array.isArray(o.bullets) ? { bullets: o.bullets.map((b) => String(b)) } : {}),
            ...(str(o.text) !== undefined ? { text: str(o.text)! } : {}),
            ...(o.table !== undefined ? { table: cellsOf(o.table, `slides[${i}].table`) } : {}),
            ...(str(o.notes) !== undefined ? { notes: str(o.notes)! } : {}),
          };
        });
        if (slides.length === 0 || (title !== undefined && slides[0]!.title !== title && ((slides[0]!.bullets ?? []).length > 0 || slides[0]!.table !== undefined))) {
          slides.unshift({ title: title ?? name });
        }
        data = await renderPptx({ ...(title !== undefined ? { title } : {}), slides });
        extra = `\n共 ${slides.length} 页`;
      }
      if (data.byteLength > FILE_MAX_BYTES) throw new Error(`做出来 ${fileSizeLabel(data.byteLength)}，超过 20MB，发不了——拆成几份或删掉一些内容`);
      const path = `${OUTPUT_DIR}/${name}`;
      await io.write(path, data);
      return {
        output: `做好了：${path}（${fileSizeLabel(data.byteLength)}），已经作为文件发到聊天里，用户点开就能看。${extra}\n回话里一句话说做好了、里面有什么，别把内容再贴一遍。`,
        files: [{ data, mimeType: MIME[format], name }],
      };
    },
  };

  const readDocument: Tool = {
    def: {
      name: READ_DOCUMENT_TOOL_NAME,
      description:
        "读工作区里的一份文件（PDF / Word / Excel / PPT 转成文字，txt / csv / md 直接读）。人在聊天里发来的文件存在 inbox/ 下。" +
        "太长时分段读：offset 是从第几个字开始。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区里的路径，如 inbox/合同.pdf" },
          offset: { type: "number", description: "从第几个字开始（默认 0）" },
          max_chars: { type: "number", description: "这次最多读多少字（默认 20000，最多 60000）" },
        },
        required: ["path"],
      },
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(args, world) {
      const a = (args ?? {}) as Record<string, unknown>;
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (path === "") throw new Error("path 要给：工作区里的路径，如 inbox/合同.pdf");
      const io = needBytes(world);
      const data = await io.read(path);
      const mime = docMimeForName(path);
      let text: string;
      if (mime === "text/plain" || mime === "text/csv" || mime === "text/markdown" || mime === null) {
        if (mime === null && data.subarray(0, 8192).includes(0)) throw new Error("这不是文字能读的文件（也不是 PDF / Word / Excel / PPT）");
        text = new TextDecoder().decode(data).replace(/^﻿/, "");
      } else {
        if (port.toText === undefined) throw new Error("这个环境转不了这种文件");
        try {
          text = await port.toText(data);
        } catch (err) {
          const code = (err as { code?: string }).code;
          throw new Error(
            code === "unsupported" && mime === "application/pdf" ? "这个 PDF 没有文字层（扫描件 / 图片），读不出字" :
            code === "encrypted" ? "文件有密码保护，读不了" : `读不出来：${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      const offset = typeof a.offset === "number" && a.offset > 0 ? Math.floor(a.offset) : 0;
      const max = Math.min(60_000, typeof a.max_chars === "number" && a.max_chars > 0 ? Math.floor(a.max_chars) : 20_000);
      const slice = text.slice(offset, offset + max);
      const end = offset + slice.length;
      const tail = end < text.length ? `\n\n（共 ${text.length} 字，这是第 ${offset}–${end} 字；往后读把 offset 设成 ${end}）` : text.length > max ? `\n\n（共 ${text.length} 字，读到结尾了）` : "";
      return `${slice}${tail}`;
    },
  };

  const sendFile: Tool = {
    def: {
      name: SEND_FILE_TOOL_NAME,
      description:
        "把工作区里已有的一份文件发到这个聊天里（PDF / Word / Excel / PPT / txt / csv / md，或 png / jpg 图片），用户点开就能看。" +
        "新做一份用 create_document（它自己会发），这把是给已经在工作区里的文件用的。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区里的路径，如 outputs/报价单.pdf" },
          name: { type: "string", description: "给用户看的文件名（不给就用原名）" },
        },
        required: ["path"],
      },
    },
    requiresApproval: false,
    async run(args, world) {
      const a = (args ?? {}) as Record<string, unknown>;
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (path === "") throw new Error("path 要给：工作区里的路径");
      const io = needBytes(world);
      const data = await io.read(path);
      if (data.byteLength === 0) throw new Error("这个文件是空的");
      if (data.byteLength > FILE_MAX_BYTES) throw new Error(`文件 ${fileSizeLabel(data.byteLength)}，超过 20MB，发不了`);
      const shown = cleanFileName(typeof a.name === "string" && a.name.trim() !== "" ? a.name : path) ?? "file";
      const isPng = data[0] === 0x89 && data[1] === 0x50;
      const isJpeg = data[0] === 0xff && data[1] === 0xd8;
      if (isPng || isJpeg) {
        return { output: `已发到聊天里：${shown}（${fileSizeLabel(data.byteLength)}，图片）`, images: [{ data, mimeType: isPng ? "image/png" : "image/jpeg" }] };
      }
      const mime = docMimeForName(shown) ?? docMimeForName(path);
      if (mime === null) throw new Error("这种文件发不了：只发 PDF、Word（docx）、Excel（xlsx）、PPT（pptx）、txt、csv、md 和 png / jpg 图片");
      const name = docMimeForName(shown) === null ? `${shown}${/\.[A-Za-z0-9]+$/.exec(path)?.[0] ?? ""}` : shown;
      return { output: `已发到聊天里：${name}（${fileSizeLabel(data.byteLength)}）`, files: [{ data, mimeType: mime, name }] };
    },
  };

  return [createDocument, readDocument, sendFile];
}
