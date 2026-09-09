// wiki —— 团队 LLM wiki 的纯层（#1140，spec docs/superpowers/specs/2026-09-09-team-llm-wiki-design.md）。
// 三端共用（runtime 工具/服务、桌面设置页、将来手机端），纪律同 memoryStore.ts：不 import fs / docker / supabase。
// 这里只有「页面长什么样、索引怎么生成、什么算合法」；读写容器的事在 services/runtime/src/wikiFs.ts。

import { charCount } from "./memoryStore.js";

export const WIKI_DIR = "wiki";
export const WIKI_TMP_DIR = ".tmp";
export const WIKI_INDEX_PATH = "index.md";
export const WIKI_LOG_PATH = "log.md";
export const WIKI_SCHEMA_PATH = "SCHEMA.md";
export const WIKI_TEAM_PATH = "team.md";
export const WIKI_AGENTS_DIR = "agents";
/** 常驻预算 = 今天 SHARED 的上限；自己那页 = 今天 OWN 的上限（spec §2.2）。其余页无上限 */
export const WIKI_PINNED_BUDGET = 2200;
export const WIKI_OWN_BUDGET = 1100;
export const WIKI_INDEX_INJECT_LIMIT = 4000;
export const WIKI_READ_PAGE_LIMIT = 12_000;
export const WIKI_TITLE_MAX = 80;
export const WIKI_SUMMARY_MAX = 140;
const SOURCE_MAX = 200;

const SEGMENT = "[a-z0-9][a-z0-9-]{0,63}";
const PAGE_RE = new RegExp(`^(?:${SEGMENT}/)?${SEGMENT}\\.md$`);
const AGENT_PAGE_RE = new RegExp(`^${WIKI_AGENTS_DIR}/(${SEGMENT})\\.md$`);

export type WikiPathKind = "page" | "tool-owned" | "invalid";

/** 一层目录、小写 kebab（同 ADR-0204 桶名纪律）；SCHEMA.md 是唯一的大写例外。index/log 工具专有 */
export function classifyWikiPath(p: string): WikiPathKind {
  if (p === WIKI_INDEX_PATH || p === WIKI_LOG_PATH) return "tool-owned";
  if (p === WIKI_SCHEMA_PATH) return "page";
  return PAGE_RE.test(p) ? "page" : "invalid";
}
export function isWikiPagePath(p: string): boolean {
  return classifyWikiPath(p) === "page";
}
/** SCHEMA / team 可写不可删（spec §1.1） */
export function isRemovableWikiPath(p: string): boolean {
  return classifyWikiPath(p) === "page" && p !== WIKI_SCHEMA_PATH && p !== WIKI_TEAM_PATH;
}
export function agentPagePath(agentId: string): string {
  return `${WIKI_AGENTS_DIR}/${agentId}.md`;
}
export function agentIdOfPage(p: string): string | null {
  const m = AGENT_PAGE_RE.exec(p);
  return m ? m[1]! : null;
}
export function pageSlug(p: string): string {
  return p.replace(/\.md$/, "").split("/").pop() ?? p;
}
/** `[[customers/acme]]` 里的那一段 = 路径去掉 .md */
export function linkTarget(p: string): string {
  return p.replace(/\.md$/, "");
}

export interface WikiFrontmatter {
  title: string;
  summary: string;
  pinned: boolean;
  updatedBy: string;
  updatedAt: string;
  sources: string[];
}
export interface WikiPage {
  path: string;
  front: WikiFrontmatter;
  body: string;
}

export function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 页头是本仓自己的严格子集（不引 YAML 库）：`key: value` 一行一对，sources 是 flow list。
    读宽：缺 title 退回 slug、缺 summary 记空、未知键忽略、pinned 只认字面 true */
function splitFrontmatter(text: string): { head: string | null; body: string } {
  if (!text.startsWith("---\n")) return { head: null, body: text };
  const rest = text.slice(4);
  const close = rest.indexOf("\n---\n");
  if (close >= 0) return { head: rest.slice(0, close), body: rest.slice(close + 5) };
  if (rest.endsWith("\n---")) return { head: rest.slice(0, -4), body: "" };
  return { head: null, body: text };
}

function parseFlowList(v: string): string[] {
  const s = v.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return s === "" ? [] : [s];
  const inner = s.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === " " || inner[i] === ",")) i++;
    if (i >= inner.length) break;
    if (inner[i] === '"') {
      let j = i + 1;
      let buf = "";
      while (j < inner.length && inner[j] !== '"') {
        if (inner[j] === "\\" && j + 1 < inner.length) { buf += inner[j + 1]; j += 2; continue; }
        buf += inner[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
    } else {
      let j = i;
      while (j < inner.length && inner[j] !== ",") j++;
      out.push(inner.slice(i, j).trim());
      i = j;
    }
  }
  return out.filter((x) => x !== "");
}

function formatFlowList(items: readonly string[]): string {
  const q = (x: string): string => (/[,"\]\[]|^\s|\s$/.test(x) ? JSON.stringify(x) : x);
  return `[${items.map(q).join(", ")}]`;
}

export function parseWikiPage(path: string, text: string): WikiPage {
  const { head, body } = splitFrontmatter(text);
  const front: WikiFrontmatter = { title: pageSlug(path), summary: "", pinned: false, updatedBy: "", updatedAt: "", sources: [] };
  if (head !== null) {
    for (const line of head.split("\n")) {
      const m = /^([a-z_]+):\s?(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      switch (key) {
        case "title": if (value!.trim() !== "") front.title = singleLine(value!); break;
        case "summary": front.summary = singleLine(value!); break;
        case "pinned": front.pinned = value!.trim() === "true"; break;
        case "updated_by": front.updatedBy = singleLine(value!); break;
        case "updated_at": front.updatedAt = value!.trim(); break;
        case "sources": front.sources = parseFlowList(value!); break;
        default: break;
      }
    }
  }
  return { path, front, body };
}

export function serializeWikiPage(page: WikiPage): string {
  const f = page.front;
  const body = page.body.endsWith("\n") || page.body === "" ? page.body : `${page.body}\n`;
  return (
    `---\n` +
    `title: ${singleLine(f.title)}\n` +
    `summary: ${singleLine(f.summary)}\n` +
    `pinned: ${f.pinned ? "true" : "false"}\n` +
    `updated_by: ${singleLine(f.updatedBy)}\n` +
    `updated_at: ${f.updatedAt.trim()}\n` +
    `sources: ${formatFlowList(f.sources)}\n` +
    `---\n` +
    body
  );
}

export interface WikiWriteFields {
  title: string;
  summary: string;
  pinned?: boolean;
  sources?: string[];
}

/** 写严：模型/人给的字段先过这一道。索引行是 `- [[路径]] 标题 — 摘要`，标题里的 `[[`/`]]`/` — ` 会撑破它 */
export function validateWikiFields(f: WikiWriteFields): string | null {
  if (typeof f.title !== "string" || f.title.trim() === "") return "title 必填，且不能是空白";
  if (/[\r\n]/.test(f.title)) return "title 不能含换行";
  if (charCount(f.title) > WIKI_TITLE_MAX) return `title 最多 ${WIKI_TITLE_MAX} 字`;
  if (f.title.includes("[[") || f.title.includes("]]")) return "title 不能含 [[ 或 ]]";
  if (f.title.includes(" — ")) return "title 不能含「 — 」（索引用它分隔标题与摘要）";
  if (typeof f.summary !== "string") return "summary 必填（一句话，可以是空串）";
  if (charCount(singleLine(f.summary)) > WIKI_SUMMARY_MAX) return `summary 最多 ${WIKI_SUMMARY_MAX} 字`;
  if (f.summary.includes("[[") || f.summary.includes("]]")) return "summary 不能含 [[ 或 ]]";
  if (f.sources !== undefined) {
    if (!Array.isArray(f.sources) || f.sources.some((s) => typeof s !== "string")) return "sources 要是字符串数组";
    if (f.sources.some((s) => /[\r\n]/.test(s) || charCount(s) > SOURCE_MAX)) return `sources 每项单行、最多 ${SOURCE_MAX} 字`;
  }
  return null;
}

/** `[[path]]` / `[[path|别名]]` → 页路径（补 .md），保序去重 */
export function extractWikiLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = m[1]!.trim().replace(/^\.\//, "");
    if (target === "") continue;
    out.add(target.endsWith(".md") ? target : `${target}.md`);
  }
  return [...out];
}

export interface WikiIndexEntry {
  path: string;
  title: string;
  summary: string;
  pinned: boolean;
}
export interface WikiIndexGroup {
  name: string;
  entries: WikiIndexEntry[];
}
export const INDEX_PINNED_GROUP = "常驻";
export const INDEX_UNGROUPED = "未分目录";
const INDEX_HEADER = "# 索引\n<!-- 由 wiki 工具生成，别手改；改页头的 title / summary 索引就会跟着变 -->\n";

function groupOf(path: string): string {
  const i = path.indexOf("/");
  return i < 0 ? INDEX_UNGROUPED : path.slice(0, i);
}

/** 常驻 → agents → 目录按字母 → 未分目录；组内按路径；SCHEMA/index/log 不进；pinned 只在常驻组出现 */
export function indexGroups(pages: readonly WikiPage[]): WikiIndexGroup[] {
  const entries: WikiIndexEntry[] = pages
    .filter((p) => classifyWikiPath(p.path) === "page" && p.path !== WIKI_SCHEMA_PATH)
    .map((p) => ({ path: p.path, title: (singleLine(p.front.title) || pageSlug(p.path)).replaceAll(" — ", " – "), summary: singleLine(p.front.summary), pinned: p.front.pinned }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byGroup = new Map<string, WikiIndexEntry[]>();
  for (const e of entries) {
    const g = e.pinned ? INDEX_PINNED_GROUP : groupOf(e.path);
    byGroup.set(g, [...(byGroup.get(g) ?? []), e]);
  }
  const rest = [...byGroup.keys()].filter((g) => g !== INDEX_PINNED_GROUP && g !== WIKI_AGENTS_DIR && g !== INDEX_UNGROUPED).sort();
  const order = [INDEX_PINNED_GROUP, WIKI_AGENTS_DIR, ...rest, INDEX_UNGROUPED];
  return order.filter((g) => byGroup.has(g)).map((g) => ({ name: g, entries: byGroup.get(g)! }));
}

export function renderIndex(pages: readonly WikiPage[]): string {
  let out = INDEX_HEADER;
  for (const g of indexGroups(pages)) {
    out += `\n## ${g.name}\n`;
    for (const e of g.entries) {
      out += e.summary === "" ? `- [[${linkTarget(e.path)}]] ${e.title}\n` : `- [[${linkTarget(e.path)}]] ${e.title} — ${e.summary}\n`;
    }
  }
  return out;
}

/** renderIndex 的逆：桌面 tab 靠它把 index.md 画成分组行 */
export function parseIndex(text: string): WikiIndexGroup[] {
  const groups: WikiIndexGroup[] = [];
  let current: WikiIndexGroup | null = null;
  for (const line of text.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) {
      current = { name: h[1]!.trim(), entries: [] };
      groups.push(current);
      continue;
    }
    const m = /^- \[\[([^\]]+)\]\] (.*)$/.exec(line);
    if (!m || !current) continue;
    const path = `${m[1]!}.md`;
    const sep = m[2]!.indexOf(" — ");
    const title = sep < 0 ? m[2]! : m[2]!.slice(0, sep);
    const summary = sep < 0 ? "" : m[2]!.slice(sep + 3);
    current.entries.push({ path, title, summary, pinned: current.name === INDEX_PINNED_GROUP });
  }
  return groups;
}
