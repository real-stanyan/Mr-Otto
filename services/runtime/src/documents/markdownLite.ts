// create_document 的正文格式（#1683）：模型写的是一份「小号 Markdown」，PDF 与 Word 两个渲染器共用这一份解析。
//
// 只认这几种块：# / ## / ### 标题、段落、- / * / • 列表、1. 有序列表、| 表格 |、> 引用、--- 分隔线。
// 行内只认 **加粗**；`代码`、*斜体*、[文字](链接) 剥成纯文字——模型常顺手写这些，原样印出来是一串星号和括号，
// 而做一份能交给人的文件，要的是「它想说的字」，不是 Markdown 的全集。
// 纯函数，不碰 IO。

export type Inline = { text: string; bold: boolean };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: Inline[] }
  | { kind: "paragraph"; text: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; rows: string[][] }
  | { kind: "quote"; text: Inline[] }
  | { kind: "rule" };

/** 行内：**加粗** 切段，其余记号剥掉 */
export function parseInline(raw: string): Inline[] {
  const plain = (s: string): string =>
    s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => (t === u ? t : `${t}（${u}）`))
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1$2")
      .replace(/__([^_]+)__/g, "$1");
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ text: plain(raw.slice(last, m.index)), bold: false });
    out.push({ text: plain(m[1]!), bold: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ text: plain(raw.slice(last)), bold: false });
  return out.filter((s) => s.text !== "");
}

export function inlineText(xs: readonly Inline[]): string {
  return xs.map((x) => x.text).join("");
}

/** 有序列表项：「1. 」「2) 」要跟空白（「3.5 百万」不是列表），「1、」不必 */
const OL = /^\d+(?:[.)]\s+|、\s*)(.*)$/;

const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => inlineText(parseInline(c.trim())));
}

export function parseMarkdownLite(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "paragraph", text: parseInline(para.join(" ")) });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === "") { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: Math.min(3, h[1]!.length) as 1 | 2 | 3, text: parseInline(h[2]!.replace(/\s+#+$/, "")) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ kind: "rule" }); continue; }
    if (t.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const r = lines[i]!.trim();
        if (!TABLE_SEP.test(r)) rows.push(splitRow(r));
        i++;
      }
      i--;
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    const ul = /^[-*•+]\s+(.*)$/.exec(t);
    const ol = OL.exec(t);
    if (ul || ol) {
      flush();
      const ordered = ol !== null && ul === null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const s = lines[i]!.trim();
        const m = ordered ? OL.exec(s) : /^[-*•+]\s+(.*)$/.exec(s);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        q.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push({ kind: "quote", text: parseInline(q.join(" ")) });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}
