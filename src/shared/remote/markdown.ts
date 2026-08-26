// 手机端渲染助手正文用的**极小** markdown 解析。
//
// 为什么自己写而不是引一个库:手机端已经刻意不引 native 依赖(加一个就得重新
// build + 装机,见 mobile/README.md),而 RN 的 markdown 库要么带 native 模块、
// 要么把整棵 HTML 树塞进 WebView。这里要的东西少到一百来行就够:
// 围栏代码块、标题、列表、粗体、行内 code —— 桌面回复里实际出现的就这些。
//
// **只做块级 + 两种行内标记,不做链接/图片/表格/引用。** 认不出来的就是普通文字,
// 而不是报错或吞掉:一段没渲染成粗体的正文仍然可读,一段被吞掉的不可读。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份)。

/** 行内片段。code 和 bold 不叠加 —— 真 markdown 里反引号也压过星号 */
export interface Span {
  text: string;
  code?: true;
  bold?: true;
}

export type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "bullet"; spans: Span[] }
  | { kind: "ordered"; marker: string; spans: Span[] }
  | { kind: "para"; spans: Span[] };

export function parseMarkdown(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      // 没有收尾围栏的代码块**照样成块**,一直吃到结尾:流式输出里最后一块
      // 永远是没收尾的,当成普通文字渲染会让代码在正文里散开
      const lang = (fence[1] ?? "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // 跳过收尾围栏(没有就是跳过结尾,无害)
      out.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    i += 1;
    // 空行只做分隔,不产出块 —— 段间距由渲染层的 gap 给
    if (!line.trim()) continue;

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, spans: inline(h[2] ?? "") });
      continue;
    }
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (b) {
      out.push({ kind: "bullet", spans: inline(b[1] ?? "") });
      continue;
    }
    const o = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (o) {
      out.push({ kind: "ordered", marker: o[1]!, spans: inline(o[2] ?? "") });
      continue;
    }
    out.push({ kind: "para", spans: inline(line) });
  }
  return out;
}

/** 行内:先切反引号(code 压过 bold,和真 markdown 一致),剩下的再切 `**` */
export function inline(src: string): Span[] {
  const out: Span[] = [];
  // 反引号必须成对。落单的那个是普通字符,不是"从这里到结尾都是 code"
  const parts = src.split("`");
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i] ?? "";
    const isCode = i % 2 === 1 && i < parts.length - 1;
    if (isCode) {
      if (chunk) out.push({ text: chunk, code: true });
    } else {
      // 落单的反引号要还回去,否则文字里凭空少一个字符
      const text = i % 2 === 1 ? "`" + chunk : chunk;
      out.push(...bold(text));
    }
  }
  return merge(out.filter((s) => s.text !== ""));
}

/** 相邻的普通文字并成一段。落单的反引号/星号会把一句话切成好几个 span,
    不并的话渲染层要靠 <Text> 的拼接兜底,而换行断点会落在意想不到的地方 */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && !last.code && !last.bold && !s.code && !s.bold) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

function bold(src: string): Span[] {
  const out: Span[] = [];
  const parts = src.split("**");
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i] ?? "";
    if (i % 2 === 1 && i < parts.length - 1) {
      if (chunk) out.push({ text: chunk, bold: true });
    } else {
      out.push({ text: i % 2 === 1 ? "**" + chunk : chunk });
    }
  }
  return out;
}
