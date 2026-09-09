// services/runtime/src/wikiFs.ts
// wikiFs —— 团队 wiki 在容器里的落点（#1140，spec §2.4 / §3.3）。
// 分工同 workFiles.ts：这里只有**脚本**和**它输出的解析**；docker 的字一个不碰（world 是注入的）。
// 脚本一律 String.raw 拼接——普通模板串里的 `\0` 是一个真 NUL 字节，execve 到那儿就截断（#1066）；
// 且脚本里不许出现 `${`（模板会插值）——变量用 "$name" 或 $(...)。
// tests/runtime/wikiScripts.test.ts 钉住「built 出来的脚本里除换行外没有裸控制字符」。

import type { ExecutionWorld, ExecOptions } from "../../../src/world/executionWorld.js";
import { parseRgJson } from "../../../src/shared/files.js";
import { byteCount } from "../../../src/shared/memoryStore.js";
import {
  WIKI_AGENTS_DIR, WIKI_DIR, WIKI_INDEX_PATH, WIKI_LOG_PATH, WIKI_LOG_ROTATE_BYTES, WIKI_LOG_TAIL_LINES, WIKI_TMP_DIR,
  agentPagePath, isWikiPagePath, isWikiSegment, parseHeadsDump, parsePagesDump, parseSnapshotDump, type WikiSnapshotDump,
} from "../../../src/shared/wiki.js";

export interface WikiSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface WikiFs {
  state(): Promise<"absent" | "present">;
  init(): Promise<void>;
  /** null = 页不存在。`bytes` 是文件的真实大小（`wc -c`，在 `head -c` 封顶**之前**量，
      #1210）——text 可能被砍过，报「这页多大」时只有 bytes 是实话 */
  readPage(path: string): Promise<{ text: string; bytes: number } | null>;
  writePage(path: string, text: string): Promise<void>;
  removePage(path: string): Promise<void>;
  listHeads(): Promise<{ path: string; head: string }[]>;
  /** 每页的**全文或前 64 KiB**；`truncated` 说的就是哪一种——check 靠它决定比不比 journal */
  listPages(): Promise<{ path: string; text: string; truncated: boolean }[]>;
  listExtraneous(): Promise<string[]>;
  appendLog(line: string): Promise<void>;
  search(query: string): Promise<WikiSearchHit[]>;
  snapshot(agentId: string): Promise<WikiSnapshotDump>;
}

const ROOT = `/work/${WIKI_DIR}`;
const ROTATED_LOG_RE = /^log-\d{8}-\d{6}\.md$/;
const EXEC_TIMEOUT_MS = 30_000;

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
function abs(path: string): string {
  return `${ROOT}/${path}`;
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

// ── 脚本 ─────────────────────────────────────────────────────────────────
export function buildWikiStateScript(): string {
  return String.raw`if [ -d /work/wiki ]; then printf 'present\n'; else printf 'absent\n'; fi`;
}
export function buildWikiInitScript(): string {
  return `mkdir -p -- ${shellQuote(`${ROOT}/${WIKI_TMP_DIR}`)} ${shellQuote(`${ROOT}/${WIKI_AGENTS_DIR}`)}`;
}
export function buildWikiReadScript(path: string): string {
  return [
    "set -u",
    `f=${shellQuote(abs(path))}`,
    // 真实大小要在 head -c **之前**量（同 listPages 的截断标志）：砍完之后没有任何办法
    // 分辨「这页正好 200000 字节」与「被砍了」，报数只能按 bytes 报（#1210）
    String.raw`if [ -f "$f" ]; then printf 'ok\t%s\n' "$(wc -c < "$f")"; head -c 200000 -- "$f"; else printf 'missing\n'; fi`,
  ].join("\n");
}
export function buildWikiMoveScript(tmpRel: string, path: string): string {
  return `mkdir -p -- ${shellQuote(dirOf(abs(path)))} && mv -f -- ${shellQuote(abs(tmpRel))} ${shellQuote(abs(path))}`;
}
export function buildWikiRemoveScript(path: string): string {
  return `rm -f -- ${shellQuote(abs(path))}`;
}
/** 每页：`路径\t页头（不含 --- 行）\0`。index/log/log-* 跳过。awk：第一行不是 --- 就什么都不印 */
export function buildWikiHeadsScript(): string {
  return [
    "set -u",
    "cd /work/wiki || exit 3",
    String.raw`find . -path ./.tmp -prune -o -type f -name '*.md' -printf '%P\0' | while IFS= read -r -d '' rel; do`,
    String.raw`  case "$rel" in index.md|log.md|log-*.md) continue;; esac`,
    String.raw`  printf '%s\t' "$rel"`,
    String.raw`  awk 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit} NR>1{print}' "$rel" | head -c 4096`,
    String.raw`  printf '\0'`,
    "done",
  ].join("\n");
}
export function buildWikiPagesScript(): string {
  return [
    "set -u",
    "cd /work/wiki || exit 3",
    String.raw`find . -path ./.tmp -prune -o -type f -name '*.md' -printf '%P\0' | while IFS= read -r -d '' rel; do`,
    String.raw`  case "$rel" in index.md|log.md|log-*.md) continue;; esac`,
    // 截断标志要在 `head -c` **之前**量：砍完之后没有任何办法分辨「这页正好 64 KiB」与「被砍了」
    String.raw`  if [ "$(wc -c < "$rel")" -gt 65536 ]; then printf '%s\tt\t' "$rel"; else printf '%s\tf\t' "$rel"; fi`,
    String.raw`  head -c 65536 -- "$rel"`,
    String.raw`  printf '\0'`,
    "done",
  ].join("\n");
}
export function buildWikiExtraneousScript(): string {
  return ["set -u", "cd /work/wiki || exit 3", String.raw`find . -mindepth 1 -path ./.tmp -prune -o -printf '%P\t%y\0'`].join("\n");
}
export function buildWikiLogAppendScript(): string {
  return [
    "set -u",
    `f=${shellQuote(abs(WIKI_LOG_PATH))}`,
    String.raw`if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt ` + String(WIKI_LOG_ROTATE_BYTES) + String.raw` ]; then mv -f -- "$f" "/work/wiki/log-$(date -u +%Y%m%d-%H%M%S).md"; fi`,
    String.raw`cat >> "$f"`,
  ].join("\n");
}
/** 最后一行 `rc\t<退出码>`——管道之后 `$?` 是 head 的，退出码要单独带回来（ADR-0253 的教训） */
export function buildWikiSearchScript(query: string): string {
  return [
    "cd /work/wiki || exit 3",
    `rg --json -n -i --max-count 3 -g '!.tmp' -e ${shellQuote(query)} .`,
    String.raw`printf 'rc\t%s\n' "$?"`,
  ].join("\n");
}
/** 一次 exec 打出：index / 每个 pinned 页 / 自己那页（或 own-missing）/ log 尾 50 行（spec §3.3） */
export function buildWikiSnapshotScript(agentId: string): string {
  return [
    "set -u",
    "cd /work/wiki || exit 3",
    String.raw`printf 'index\t'; if [ -f index.md ]; then cat index.md; fi; printf '\0'`,
    String.raw`find . -path ./.tmp -prune -o -type f -name '*.md' -printf '%P\0' | while IFS= read -r -d '' rel; do`,
    String.raw`  case "$rel" in index.md|log.md|log-*.md|SCHEMA.md) continue;; esac`,
    String.raw`  if awk 'NR==1 && $0!="---"{exit 1} NR>1 && $0=="---"{exit 1} NR>1 && $0=="pinned: true"{f=1; exit 0} END{exit f?0:1}' "$rel"; then`,
    String.raw`    printf 'pinned\t%s\t' "$rel"; head -c 65536 -- "$rel"; printf '\0'`,
    "  fi",
    "done",
    `own=${shellQuote(agentPagePath(agentId))}`,
    String.raw`if [ -f "$own" ]; then printf 'own\t'; head -c 65536 -- "$own"; printf '\0'; else printf 'own-missing\0'; fi`,
    String.raw`printf 'log\t'; if [ -f log.md ]; then tail -n ` + String(WIKI_LOG_TAIL_LINES) + String.raw` log.md; fi; printf '\0'`,
  ].join("\n");
}

// ── 杂物判据（两个实现共用一份，#1211）─────────────────────────────────────
/** find 输出的一条记录：相对路径 + 类型字母（`%y`：f 文件 / d 目录 / l 软链…） */
export interface WikiFsEntry {
  rel: string;
  type: string;
}

/**
 * wiki/ 下什么算杂物。文件一条规则；目录分两层：
 * - **顶层目录**：`agents` 与 `.tmp` 是工具自己的，跳过；其余**名字不满足 slug 规则、
 *   或里头一个合法页都没有**才算杂物（`customers/` 这种一层分组目录是合法形态，
 *   不能照名字一刀切）。旧判据只管含 `/` 的目录，于是 `wiki/node_modules/` 这种
 *   顶层杂物永远不进 check 报告。
 * - **第二层及更深**：一律杂物（页只活在一层目录下）。
 * 内存实现没有目录条目（Map 里只有文件），「空目录」那一半它观测不到——天花板，
 * 不是漏做。
 */
export function collectExtraneous(entries: readonly WikiFsEntry[]): string[] {
  const out: string[] = [];
  const dirsWithPage = new Set<string>();
  for (const e of entries) {
    if (e.type === "f" && isWikiPagePath(e.rel) && e.rel.includes("/")) {
      dirsWithPage.add(e.rel.slice(0, e.rel.indexOf("/")));
    }
  }
  for (const { rel, type } of entries) {
    if (type === "d") {
      if (rel === WIKI_TMP_DIR || rel === WIKI_AGENTS_DIR) continue;
      if (!rel.includes("/")) {
        if (!isWikiSegment(rel) || !dirsWithPage.has(rel)) out.push(rel);
        continue;
      }
      out.push(rel);
      continue;
    }
    if (type !== "f") { out.push(rel); continue; }
    if (isWikiPagePath(rel) || isLogLike(rel) || rel.startsWith(`${WIKI_TMP_DIR}/`)) continue;
    out.push(rel);
  }
  return out;
}

// ── 容器实现 ──────────────────────────────────────────────────────────────
export function createContainerWikiFs(world: Pick<ExecutionWorld, "fs" | "exec">, opts: { now?: () => number } = {}): WikiFs {
  const now = opts.now ?? Date.now;
  let tmpSeq = 0;
  async function run(script: string, o: ExecOptions = {}): Promise<string> {
    const r = await world.exec(script, { timeoutMs: EXEC_TIMEOUT_MS, ...o });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `wiki 脚本失败（exit ${r.exitCode}）`);
    return r.stdout;
  }
  return {
    async state() {
      return (await run(buildWikiStateScript())).trim() === "present" ? "present" : "absent";
    },
    async init() {
      await run(buildWikiInitScript());
    },
    async readPage(path) {
      const out = await run(buildWikiReadScript(path));
      const nl = out.indexOf("\n");
      const head = nl < 0 ? out : out.slice(0, nl);
      if (head === "missing") return null;
      const m = /^ok\t(\d+)$/.exec(head);
      if (!m) throw new Error(`读 ${path} 的输出看不懂`);
      return { text: out.slice(nl + 1), bytes: Number(m[1]) };
    },
    async writePage(path, text) {
      const tmpRel = `${WIKI_TMP_DIR}/w-${now()}-${tmpSeq++}.md`;
      await world.fs.write(`${WIKI_DIR}/${tmpRel}`, text);
      await run(buildWikiMoveScript(tmpRel, path));
    },
    async removePage(path) {
      await run(buildWikiRemoveScript(path));
    },
    async listHeads() {
      // awk 的默认 ORS 让每行 head 后面都带着换行，且脚本在遇到收尾的 `---`
      // 就 exit，没机会去掉最后那个 \n（真机字节验过：`... 3a 20 5b 5d 0a`）。
      // 内存实现的 headOf() 用 join("\n") 不产生这条尾巴——这里补一刀让两个
      // 实现和 brief 的契约一致，awk 那段脚本本身不动（#1140 复审 finding 1）
      return parseHeadsDump(await run(buildWikiHeadsScript())).map((h) => ({ path: h.path, head: h.head.replace(/\n$/, "") }));
    },
    async listPages() {
      return parsePagesDump(await run(buildWikiPagesScript()));
    },
    async listExtraneous() {
      const entries: WikiFsEntry[] = [];
      for (const rec of (await run(buildWikiExtraneousScript())).split("\0")) {
        const t = rec.lastIndexOf("\t");
        if (t < 0) continue;
        entries.push({ rel: rec.slice(0, t), type: rec.slice(t + 1) });
      }
      return collectExtraneous(entries);
    },
    async appendLog(line) {
      await run(buildWikiLogAppendScript(), { stdin: `${line}\n` });
    },
    async search(query) {
      const out = await run(buildWikiSearchScript(query));
      const lines = out.split("\n").filter((l) => l !== "");
      const last = lines.pop() ?? "";
      const m = /^rc\t(\d+)$/.exec(last);
      if (!m) throw new Error("搜索输出缺退出码");
      const rc = Number(m[1]);
      if (rc === 1) return [];
      if (rc === 127) throw new Error("容器里没有 ripgrep，搜不了");
      if (rc !== 0) throw new Error(`搜索失败（rg exit ${rc}）`);
      return parseRgJson(lines.join("\n")).map((h) => ({ path: h.rel.replace(/^\.\//, ""), line: h.line ?? 0, text: h.text ?? "" }));
    },
    async snapshot(agentId) {
      return parseSnapshotDump(await run(buildWikiSnapshotScript(agentId)));
    },
  };
}

// ── 内存实现（测试 / 冒烟）：语义与容器版逐条对齐 ────────────────────────────
function headOf(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return out.join("\n");
    out.push(lines[i]!);
  }
  return out.join("\n");
}
const isLogLike = (p: string): boolean => p === WIKI_INDEX_PATH || p === WIKI_LOG_PATH || ROTATED_LOG_RE.test(p);

export function createMemoryWikiFs(seed: Record<string, string> = {}): WikiFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  let present = files.size > 0;
  const pages = (): string[] => [...files.keys()].filter((p) => p.endsWith(".md") && !isLogLike(p) && !p.startsWith(`${WIKI_TMP_DIR}/`)).sort();
  return {
    files,
    async state() { return present ? "present" : "absent"; },
    async init() { present = true; },
    async readPage(path) {
      const text = files.get(path);
      return text === undefined ? null : { text, bytes: byteCount(text) };
    },
    async writePage(path, text) { files.set(path, text); },
    async removePage(path) { files.delete(path); },
    async listHeads() { return pages().map((p) => ({ path: p, head: headOf(files.get(p)!) ?? "" })); },
    // 内存版不截断（没有 head -c 这一步），所以恒 false——与容器版语义对齐，不是省略
    async listPages() { return pages().map((p) => ({ path: p, text: files.get(p)!, truncated: false })); },
    // 与容器版共用 collectExtraneous。内存版没有目录条目（Map 里只有文件），
    // 顶层空目录那一半规则观测不到——collectExtraneous 头注里写明的天花板
    async listExtraneous() { return collectExtraneous([...files.keys()].map((rel) => ({ rel, type: "f" }))); },
    async appendLog(line) {
      const cur = files.get(WIKI_LOG_PATH) ?? "";
      if (new TextEncoder().encode(cur).length > WIKI_LOG_ROTATE_BYTES) {
        files.set(`log-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 8)}-${new Date().toISOString().replace(/[-:T]/g, "").slice(8, 14)}.md`, cur);
        files.set(WIKI_LOG_PATH, `${line}\n`);
        return;
      }
      files.set(WIKI_LOG_PATH, `${cur}${line}\n`);
    },
    async search(query) {
      const q = query.toLowerCase();
      const out: WikiSearchHit[] = [];
      for (const p of pages()) {
        let n = 0;
        files.get(p)!.split("\n").forEach((text, i) => {
          if (n < 3 && text.toLowerCase().includes(q)) { out.push({ path: p, line: i + 1, text }); n++; }
        });
      }
      return out;
    },
    async snapshot(agentId) {
      const pinned = pages()
        .filter((p) => p !== "SCHEMA.md" && (headOf(files.get(p)!) ?? "").split("\n").includes("pinned: true"))
        .map((p) => ({ path: p, text: files.get(p)! }));
      const log = files.get(WIKI_LOG_PATH) ?? "";
      return { index: files.get(WIKI_INDEX_PATH) ?? "", pinned, own: files.get(agentPagePath(agentId)) ?? null, logTail: log.split("\n").slice(-WIKI_LOG_TAIL_LINES).join("\n") };
    },
  };
}
