// 工具调用 → 可展示产物(来源链接 / 文件卡)的抠取。
//
// 为什么单独一个文件:toThreadMessages 是"事件流 → 消息流"的骨架,而这里是
// "一条工具调用到底产出了什么给人看"的启发式。后者靠猜(云端返回的文本没有
// 契约,见下面 extractSources 的注释),会长、会改、要单独逼边界——混进骨架里
// 会让那份投影的主线读不出来。
//
// 纯函数,不碰 React、不碰 IPC:和 toThreadMessages 同一条纪律。

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ToolCallRequest, ToolResultEvent } from "../../../session/events.js";

/** assistant-ui 的 content part 联合(只取本仓用得到的那几支)。
    定义放这里而不是 toThreadMessages:那边要 import 本文件的函数,
    类型再反向 import 回去就成环了 */
export type Part = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

type SourcePart = Extract<Part, { type: "source" }>;
type FilePart = Extract<Part, { type: "file" }>;

/** 一条来源:url + 展示用标题。标题在这一层就定好(没有 markdown 链接文案时
    退回域名)—— 渲染组件因此不需要自己再算一遍域名 */
interface Source {
  url: string;
  title: string;
}

/** 同时吃两种写法:markdown 链接 `[标题](http…)` 和裸 URL。
    交替分支里链接在前:同一个位置上正则优先试左边,`[` 处链接分支会把整段吃掉,
    里面那个 URL 不会被裸 URL 分支重复捞一遍 */
const LINK_OR_URL = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`\]]+)/g;

/** 裸 URL 后面粘的标点不是地址的一部分(句末的 。, 、) 之类)。
    括号只削右半边:维基百科那种 `..._(disambiguation)` 的右括号是地址自带的,
    所以只在左右不配平时才削 */
function trimTrailing(url: string): string {
  let s = url.replace(/[.,;:!?、。，；：!?]+$/u, "");
  while (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) {
    s = s.slice(0, -1);
  }
  return s;
}

/** 域名(去掉 www.)。地址解析不了就原样退回 —— 这里不该抛 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 一次搜索最多挂几条来源。云端偶尔会把整页正文塞回来,不设上限的话
    一条工具调用能刷出几十个 chip,把回复顶出屏外 */
const MAX_SOURCES = 10;

/** 从一段自由文本里宽松地捞 URL。
    **宽松是刻意的**:web_search 的输出经 anysearch 只是把云端返回的若干文本段拼接
    (src/tools/anysearch.ts),本仓对格式没有任何保证 —— 今天像 markdown,明天可能
    是纯文本列表。所以不解析结构,只认"看起来是个网址"。捞不到就返回空数组,
    调用方据此整条不渲染:宁可少显示,也不显示一堆解析垃圾 */
export function extractSources(text: string): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(LINK_OR_URL)) {
    const url = trimTrailing(m[2] ?? m[3] ?? "");
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    const label = (m[1] ?? "").trim();
    out.push({ url, title: label === "" ? domainOf(url) : label });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** markdown 正文的第一个标题行 —— web_extract 抓回来的整页正文用它当标题。
    只认头几行:正文里后面的 `# ` 是章节,不是这一页叫什么 */
function firstHeading(text: string): string | undefined {
  for (const line of text.split("\n", 5)) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[1].length <= 120) return m[1];
  }
  return undefined;
}

/** 联网类工具的一次调用 → 来源 part。
    - web_search:输出是一堆结果,从里面捞 URL
    - web_extract:输出是**某一页的正文**,里面的链接是那一页自己的导航,不是来源 ——
      来源就是被抓的那一个地址(args.url),标题优先取正文第一个标题行
    失败/被拒/还没回来的调用不产来源:那不是"查到的东西" */
export function sourcePartsFor(call: ToolCallRequest, result: ToolResultEvent | undefined): Part[] {
  if (result === undefined || result.status !== "ok") return [];

  if (call.name === "web_extract") {
    const url = (call.args as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return [];
    return [source(url, firstHeading(result.output) ?? domainOf(url))];
  }

  if (call.name === "web_search") {
    return extractSources(result.output).map((s) => source(s.url, s.title));
  }

  return [];
}

/** id 用地址本身:同一轮里同一个地址只会出现一次(extractSources 已去重),
    跨消息重复也无妨 —— assistant-ui 只拿它当 React key 用 */
function source(url: string, title: string): SourcePart {
  return { type: "source", sourceType: "url", id: url, url, title };
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  svg: "image/svg+xml",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
};

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "text/plain";
}

/** 路径的最后一段。分隔符两种都认:工作区是 POSIX 路径,但日志里可能有 Windows 写法 */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** 超过这个大小就不出文件卡(仍然有工具行)。
    卡片的用处是"看一眼 / 存下来刚写的东西";再大就不是这张卡该承担的东西了,
    而 data: URI 要把正文整个 base64 一遍,投影每落一条事件就重跑一次 —— 不设上限
    等于让一次大写盘长期拖慢整条渲染链 */
const MAX_FILE_CARD_BYTES = 256 * 1024;

/** UTF-8 安全的 base64:btoa 只吃 latin1,中文直接抛 InvalidCharacterError */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** write_file 的一次成功调用 → 一张文件卡。
    只认写成功的:被拒/出错时盘上根本没有这个文件,给张能下载的卡是在撒谎。
    数据直接带在 part 里(base64),不走 IPC 回读 —— 内容本来就在事件日志的
    args 里躺着,再去问一次盘反而可能读到之后被改过的版本 */
export function filePartFor(
  call: ToolCallRequest,
  result: ToolResultEvent | undefined,
  /** 实际执行用的参数(ADR-0041:人在审批时可能只保留了一部分改动)。
      不给 = 原样执行。这张卡说的是"写出去的文件",拿模型请求的那份来画
      就是在替模型说话 —— 大小和内容都会和磁盘上的对不上 */
  executedArgs?: unknown
): Part[] {
  if (call.name !== "write_file") return [];
  if (result === undefined || result.status !== "ok") return [];

  const args = (executedArgs ?? call.args) as { path?: unknown; content?: unknown } | null;
  const path = args?.path;
  const content = args?.content;
  if (typeof path !== "string" || path === "" || typeof content !== "string") return [];
  if (content.length > MAX_FILE_CARD_BYTES) return [];

  const part: FilePart = {
    type: "file",
    filename: basename(path),
    mimeType: mimeOf(path),
    data: toBase64(content),
  };
  return [part];
}
