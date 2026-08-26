// 工具调用 → 可展示产物(来源链接 / 读回来的网页)的抠取。
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
export function domainOf(url: string): string {
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

/** browser_read / web_extract 读回来的一页 → 地址 + 正文。
    两条工具的输出都是 `# 标题\n地址\n\n正文…`（见 tools/browserRead.ts）,
    但格式没有任何保证（web_extract 走的是第三方 API）——所以只当**约定**看:
    第一行长得像 http(s) 就当地址，认不出来就退回参数里的 url，两头都没有就不显示地址。 */
export function extractPage(
  result: string,
  argUrl: unknown,
): { url: string | null; title: string | null; body: string } {
  const lines = result.split("\n");
  const title = lines[0]?.startsWith("# ") ? lines[0].slice(2).trim() : null;
  const second = lines[1]?.trim() ?? "";
  const fromBody = /^https?:\/\/\S+$/.test(second) ? second : null;
  const url = fromBody ?? (typeof argUrl === "string" && argUrl !== "" ? argUrl : null);
  // 把已经进了卡头的两行从正文里摘掉，免得地址在卡上出现两遍
  const body = (fromBody === null ? (title === null ? lines : lines.slice(1)) : lines.slice(2))
    .join("\n")
    .trim();
  return { url, title, body };
}
