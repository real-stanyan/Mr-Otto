// wiki —— 团队 LLM wiki 的纯层（#1140，spec docs/superpowers/specs/2026-09-09-team-llm-wiki-design.md）。
// 三端共用（runtime 工具/服务、桌面设置页、将来手机端），纪律同 memoryStore.ts：不 import fs / docker / supabase。
// 这里只有「页面长什么样、索引怎么生成、什么算合法」；读写容器的事在 services/runtime/src/wikiFs.ts。

import { charCount, parseEntries } from "./memoryStore.js";
import { scanThreat } from "./threatPatterns.js";
import { promptSafe } from "./promptSafe.js";

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

// ── 日志（spec §1.4）───────────────────────────────────────────────────────
export type WikiLogKind = "write" | "remove" | "edit" | "migrate" | "restore" | "seed" | "check" | "external";
const LOG_KINDS: ReadonlySet<string> = new Set(["write", "remove", "edit", "migrate", "restore", "seed", "check", "external"]);
export interface WikiLogEntry {
  at: number;
  kind: WikiLogKind;
  path: string;
  who: string;
  note: string;
}
export const WIKI_NUDGE_WRITES = 20;
export const WIKI_NUDGE_DAYS = 14;
export const WIKI_STALE_DAYS = 60;
export const WIKI_LOG_TAIL_LINES = 50;
export const WIKI_LOG_ROTATE_BYTES = 100 * 1024;

/** UTC，分钟精度——VPS 的钟就是 UTC，SCHEMA 里写明 */
export function formatLogTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
export function logLine(atMs: number, kind: WikiLogKind, path: string, who: string, note: string): string {
  return `## [${formatLogTime(atMs)}] ${kind} | ${singleLine(path)} | ${singleLine(who)} | ${singleLine(note)}`;
}
export function parseLogLines(text: string): WikiLogEntry[] {
  const out: WikiLogEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^## \[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\] (\w+) \| ([^|]*) \| ([^|]*) \| (.*)$/.exec(line);
    if (!m || !LOG_KINDS.has(m[6]!)) continue;
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    out.push({ at, kind: m[6] as WikiLogKind, path: m[7]!.trim(), who: m[8]!.trim(), note: m[9]!.trim() });
  }
  return out;
}

/** 自上一条 check 起写入 ≥ 20，或距上一条 check（没有的话距第一条写入）≥ 14 天 → 一句话；否则 null（spec §7.2） */
export function nudgeFrom(logTail: string, now: number): string | null {
  const entries = parseLogLines(logTail);
  if (entries.length === 0) return null;
  let lastCheck = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.kind === "check") { lastCheck = i; break; }
  const isWrite = (e: WikiLogEntry): boolean => e.kind === "write" || e.kind === "remove" || e.kind === "edit";
  const since = entries.slice(lastCheck + 1).filter(isWrite);
  const anchor = lastCheck >= 0 ? entries[lastCheck]!.at : entries.find(isWrite)?.at;
  const days = anchor === undefined ? 0 : Math.floor((now - anchor) / (24 * 60 * 60 * 1000));
  if (since.length < WIKI_NUDGE_WRITES && days < WIKI_NUDGE_DAYS) return null;
  const why = since.length >= WIKI_NUDGE_WRITES ? `自上次整理以来写入了 ${since.length} 次` : `已 ${days} 天没整理`;
  return `wiki ${why}；有空档时跑 wiki check 并按 SCHEMA.md 的整理步骤处理。`;
}

// ── 迁移与种子（spec §5）────────────────────────────────────────────────────
const SYSTEM_WRITER = "系统";

function bullets(entries: readonly string[]): string {
  return entries.map((e) => `- ${e}`).join("\n") + (entries.length ? "\n" : "");
}

export function migrateTiersToPages(
  rows: readonly { agentId: string; content: string }[],
  names: ReadonlyMap<string, string>,
  nowIso: string,
): WikiPage[] {
  const out: WikiPage[] = [];
  const shared = rows.find((r) => r.agentId === "");
  out.push({
    path: WIKI_TEAM_PATH,
    front: { title: "团队口径", summary: "所有智能体每轮都看得到的团队口径与分工", pinned: true, updatedBy: SYSTEM_WRITER, updatedAt: nowIso, sources: [] },
    body: bullets(parseEntries(shared?.content ?? null)),
  });
  for (const r of rows) {
    if (r.agentId === "") continue;
    const entries = parseEntries(r.content);
    if (entries.length === 0) continue;
    out.push({
      path: agentPagePath(r.agentId),
      front: { title: names.get(r.agentId) ?? r.agentId, summary: "这只智能体自己的工作习惯与踩过的坑", pinned: false, updatedBy: SYSTEM_WRITER, updatedAt: nowIso, sources: [] },
      body: bullets(entries),
    });
  }
  return out;
}

export const DEFAULT_SCHEMA = `# 约定

这个目录是团队的 wiki：由智能体维护、人也能改的一组互链 markdown 页面。时间一律 UTC。

## 1. 页面类型与命名
- 实体页（客户 / 产品 / 供应商 / 人）、概念页（口径 / 定义）、来源摘要（一份文档说了什么）、综合页（把几页合成一个结论）。
- 一层目录、小写英文 kebab：customers/acme.md、concepts/gross-sales.md。标题可以是中文，住页头。
- team.md 是常驻页（所有智能体每轮都看得到），agents/<id>.md 是每只智能体自己的一页（只注入给它自己）。

## 2. 页头
title / summary（索引里就这一行）/ pinned / updated_by / updated_at / sources。updated_by 与 updated_at 由工具盖章。
sources 写「会话 id#seq」或 /work 里的路径——原始材料不复制进来。

## 3. 什么时候记、记哪一页
- 记：业务口径、数据定义、客户约定、稳定的分工、工具怪癖——优先记能减少同事再次纠正你的事。不记：任务进度、一周内会过期的东西。
- 先 wiki_read 搜一下有没有页；有就改那页，别另开一页。一个事实只住一页，用 [[路径]] 链到相关页。
- 团队级口径写 team（常驻预算 2200 字）；只对你成立的写 agents/<你>（1100 字）。pinned 是「每轮都注入」，别轻易点。

## 4. 怎么答
涉及客户、口径、分工、历史决定：先看索引，有对应页就 read 再答；答里引用页路径。答得好的问题回填成一页。

## 5. 整理步骤（人说「整理 wiki」时由管理员跑）
1. wiki check 拿机械报告 2. 修断链、处理孤儿页 3. 逐页看 stale? 标记：更新或删除 4. 找矛盾（同一实体两页说法不同、team 里两条口径打架）5. 合并重复页 6. 把答过的好问题回填成页 7. 再 check 一次收口。
`;

export function schemaPage(nowIso: string): WikiPage {
  return {
    path: WIKI_SCHEMA_PATH,
    front: { title: "约定", summary: "这个 wiki 怎么用：页面类型、页头、什么时候记、整理步骤", pinned: false, updatedBy: SYSTEM_WRITER, updatedAt: nowIso, sources: [] },
    body: DEFAULT_SCHEMA,
  };
}

export function seedPages(nowIso: string): WikiPage[] {
  return [
    schemaPage(nowIso),
    {
      path: WIKI_TEAM_PATH,
      front: { title: "团队口径", summary: "所有智能体每轮都看得到的团队口径与分工", pinned: true, updatedBy: SYSTEM_WRITER, updatedAt: nowIso, sources: [] },
      body: "还没有口径。用 wiki write 写第一条——这一页所有智能体每轮都看得到。\n",
    },
  ];
}

// ── 容器脚本输出的解析（NUL 分记录、TAB 分字段；同 workFiles.ts 的纪律）──────
export interface WikiSnapshotDump {
  index: string;
  pinned: { path: string; text: string }[];
  own: string | null;
  logTail: string;
}

/** 记录以 NUL 结尾；最后一段非空 = 被截断的尾记录 */
function records(stdout: string, onTruncated: "throw" | "drop"): string[] {
  const parts = stdout.split("\0");
  const tail = parts.pop() ?? "";
  if (tail !== "") {
    if (onTruncated === "throw") throw new Error("脚本输出被截断（尾记录没有结尾 NUL）");
  }
  return parts;
}

export function parseSnapshotDump(stdout: string): WikiSnapshotDump {
  const out: WikiSnapshotDump = { index: "", pinned: [], own: null, logTail: "" };
  for (const rec of records(stdout, "throw")) {
    const t1 = rec.indexOf("\t");
    const kind = t1 < 0 ? rec : rec.slice(0, t1);
    const rest = t1 < 0 ? "" : rec.slice(t1 + 1);
    switch (kind) {
      case "index": out.index = rest; break;
      case "own": out.own = rest; break;
      case "own-missing": out.own = null; break;
      case "log": out.logTail = rest; break;
      case "pinned": {
        const t2 = rest.indexOf("\t");
        if (t2 < 0) throw new Error("脚本输出被截断（pinned 记录缺字段）");
        out.pinned.push({ path: rest.slice(0, t2), text: rest.slice(t2 + 1) });
        break;
      }
      default: break;
    }
  }
  return out;
}

function pathPayload(stdout: string): { path: string; payload: string }[] {
  const out: { path: string; payload: string }[] = [];
  for (const rec of records(stdout, "drop")) {
    const t = rec.indexOf("\t");
    if (t < 0) continue;
    out.push({ path: rec.slice(0, t), payload: rec.slice(t + 1) });
  }
  return out;
}
export function parseHeadsDump(stdout: string): { path: string; head: string }[] {
  return pathPayload(stdout).map((r) => ({ path: r.path, head: r.payload }));
}
export function parsePagesDump(stdout: string): { path: string; text: string }[] {
  return pathPayload(stdout).map((r) => ({ path: r.path, text: r.payload }));
}

// ── 体检（spec §7.1）：机械的归代码，语义的归模型 ──────────────────────────
export type WikiCheckRule =
  | "broken-link" | "orphan" | "missing-field" | "pinned-over-budget" | "own-over-budget"
  | "stale" | "threat" | "extraneous" | "journal-drift";
export interface WikiCheckFinding {
  rule: WikiCheckRule;
  path: string;
  detail: string;
}
export interface WikiCheckInput {
  pages: readonly WikiPage[];
  /** 每页落盘的原文（含页头）——journal 漂移按它比 */
  rawTexts: ReadonlyMap<string, string>;
  /** journal 各路径的最新版本；null = journal 这一刻读不到，跳过那条规则 */
  journalHeads: ReadonlyMap<string, string | null> | null;
  /** wiki/ 下不该在的东西（非 md、第二层目录、软链），由 fs 层列出 */
  extraneous: readonly string[];
  now: number;
}
export interface WikiCheckReport {
  findings: WikiCheckFinding[];
  /** 文件与 journal 最新版本不一致的页（bash 绕开工具改的）——调用方补记 external */
  drifted: string[];
  /** journal 还记着、文件已经不在的页——调用方补记 external 删除 */
  removedOutside: string[];
  pinnedChars: number;
}


export function checkWiki(input: WikiCheckInput): WikiCheckReport {
  const findings: WikiCheckFinding[] = [];
  const paths = new Set(input.pages.map((p) => p.path));
  const inbound = new Map<string, number>();
  for (const p of input.pages) {
    for (const target of extractWikiLinks(p.body)) {
      if (!paths.has(target)) findings.push({ rule: "broken-link", path: p.path, detail: `链到不存在的 [[${linkTarget(target)}]]` });
      if (target !== p.path) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  let pinnedChars = 0;
  for (const p of input.pages) {
    const f = p.front;
    if (f.pinned) pinnedChars += charCount(p.body);
    const exemptOrphan = f.pinned || p.path === WIKI_TEAM_PATH || p.path === WIKI_SCHEMA_PATH || agentIdOfPage(p.path) !== null;
    if (!exemptOrphan && !(inbound.get(p.path) ?? 0)) findings.push({ rule: "orphan", path: p.path, detail: "没有任何页链到它" });
    const missing = [f.title.trim() === "" ? "title" : null, f.summary.trim() === "" ? "summary" : null, f.updatedAt.trim() === "" ? "updated_at" : null].filter((x) => x !== null);
    if (missing.length) findings.push({ rule: "missing-field", path: p.path, detail: `页头缺 ${missing.join(" / ")}` });
    const agentId = agentIdOfPage(p.path);
    if (agentId !== null && charCount(p.body) > WIKI_OWN_BUDGET) findings.push({ rule: "own-over-budget", path: p.path, detail: `${charCount(p.body)} 字 > ${WIKI_OWN_BUDGET}` });
    const at = Date.parse(f.updatedAt);
    if (!f.pinned && Number.isFinite(at) && input.now - at >= WIKI_STALE_DAYS * 24 * 60 * 60 * 1000) findings.push({ rule: "stale", path: p.path, detail: `stale? ${Math.floor((input.now - at) / (24 * 60 * 60 * 1000))} 天没动` });
    const hit = scanThreat(p.body);
    if (hit) findings.push({ rule: "threat", path: p.path, detail: `含可疑指令（${hit}），注入时已跳过正文` });
  }
  if (pinnedChars > WIKI_PINNED_BUDGET) findings.push({ rule: "pinned-over-budget", path: WIKI_TEAM_PATH, detail: `常驻合计 ${pinnedChars} 字 > ${WIKI_PINNED_BUDGET}` });
  for (const x of input.extraneous) findings.push({ rule: "extraneous", path: x, detail: "不是一层目录下的 .md 页" });
  const drifted: string[] = [];
  const removedOutside: string[] = [];
  if (input.journalHeads !== null) {
    for (const p of input.pages) {
      const head = input.journalHeads.get(p.path);
      const raw = input.rawTexts.get(p.path);
      if (head === undefined || head === null || head !== raw) {
        drifted.push(p.path);
        findings.push({ rule: "journal-drift", path: p.path, detail: head === undefined || head === null ? "journal 里没有这一版，已补记" : "文件与 journal 最新版本不同，已补记" });
      }
    }
    for (const [path, content] of input.journalHeads) {
      if (content !== null && !paths.has(path)) {
        removedOutside.push(path);
        findings.push({ rule: "journal-drift", path, detail: "文件已不在，journal 还记着，已补记删除" });
      }
    }
  }
  return { findings, drifted, removedOutside, pinnedChars };
}

const RULE_TITLE: Record<WikiCheckRule, string> = {
  "broken-link": "断链", orphan: "孤儿页", "missing-field": "页头缺字段", "pinned-over-budget": "常驻超预算",
  "own-over-budget": "智能体自己那页超预算", stale: "可能过期", threat: "可疑指令", extraneous: "wiki 下的杂物",
  "journal-drift": "journal 漂移",
};

export function renderCheckReport(r: WikiCheckReport): string {
  if (r.findings.length === 0) return `体检完成：没有发现问题。常驻合计 ${r.pinnedChars}/${WIKI_PINNED_BUDGET} 字。`;
  const byRule = new Map<WikiCheckRule, WikiCheckFinding[]>();
  for (const f of r.findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  let out = `体检完成，${r.findings.length} 条发现（常驻合计 ${r.pinnedChars}/${WIKI_PINNED_BUDGET} 字）：\n`;
  for (const [rule, list] of byRule) {
    out += `\n## ${RULE_TITLE[rule]}（${list.length}）\n`;
    for (const f of list) out += `- ${f.path}：${f.detail}\n`;
  }
  return out;
}

// ── 投影（spec §3.2）：system 尾部的那一段 ──────────────────────────────────
export interface WikiSnapshotForPrompt {
  agentId: string;
  agentName: string;
  index: string;
  pinned: { path: string; title: string; body: string }[];
  own: string | null;
  nudge: string | null;
}

/** 静态的约定摘要——SCHEMA.md 的浓缩，只放不会变的机制句（spec §13） */
export const WIKI_PROMPT_INTRO =
  `\n你有这个团队的 wiki（/work/wiki，互链的 markdown 页面），用两把工具维护：wiki_read 查（读页 / 搜索），wiki 记（write / remove / check）。` +
  `记什么：业务口径、数据定义、客户 / 产品 / 供应商这类实体、稳定的分工、工具怪癖——优先记能减少同事再次纠正你的事；不记任务进度、一周内会过期的东西。` +
  `怎么记：一个实体或概念一页，先 wiki_read 搜有没有页，有就改那页别另开；页里用 [[路径]] 链到相关页；sources 写会话 id#seq 或 /work 路径。` +
  `团队级口径写 team（常驻，所有人每轮都看得到，预算 ${WIKI_PINNED_BUDGET} 字），只对你成立的写 agents/<你的 id>（常驻，只注入给你，${WIKI_OWN_BUDGET} 字）。写陈述句不写祈使句。` +
  `怎么查：涉及客户、口径、分工、历史决定时先看下面的索引，有对应页就 wiki_read 读了再答。` +
  `\n机制（被问到时照实说，别脑补）：每次轮到你发言前注入索引 + 常驻页 + 你自己那页，其余页要你自己读，没有按相关性检索；你或别人写的下一次轮到你时可见；成员可在团队设置页「记忆」看和改。\n`;

export function truncateIndexForPrompt(index: string, limit = WIKI_INDEX_INJECT_LIMIT): string {
  if (index.length <= limit) return index;
  const lines = index.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = lines.length - kept.length;
  return `${kept.join("\n")}\n…（索引还有 ${left} 行，用 wiki_read 搜索或读 index.md 看全部）`;
}

export function renderWikiPrompt(s: WikiSnapshotForPrompt): string {
  const self = agentPagePath(s.agentId);
  let out = WIKI_PROMPT_INTRO;
  out += `\n[索引]\n${truncateIndexForPrompt(s.index)}\n`;
  if (s.pinned.length > 0) {
    out += `\n[常驻页]\n`;
    for (const p of s.pinned) out += `### ${promptSafe(p.title)}（${p.path}）\n${p.body}\n`;
  }
  out += `\n[你的页 ${linkTarget(self)}]\n`;
  out += s.own === null ? `你还没有自己那页，用 wiki write ${self} 建（只注入给「${promptSafe(s.agentName)}」）。\n` : `${s.own}\n`;
  if (s.nudge !== null) out += `\n${s.nudge}\n`;
  return out;
}
