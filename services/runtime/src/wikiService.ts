// services/runtime/src/wikiService.ts
// wikiService —— 团队 wiki 的本体（#1140，spec §2 / §3.3 / §5 / §7）。工具（wikiTool.ts）与桌面帧
// （frameHandler 的 wiki_write）共用这一份：人改的和 agent 改的过同一道门。
// 只依赖注入的 WikiFs / WikiJournal，不碰 fs / docker / supabase（硬规则）。
// 互斥：进程内 withMemoryFileLock(wikiLockKey)——daemon 级，工具路径与帧路径同一把锁。

import { withMemoryFileLock, charCount } from "../../../src/shared/memoryStore.js";
import { scanThreat } from "../../../src/shared/threatPatterns.js";
import {
  WIKI_INDEX_PATH, WIKI_OWN_BUDGET, WIKI_PINNED_BUDGET, WIKI_READ_PAGE_LIMIT, WIKI_TEAM_PATH,
  agentIdOfPage, bodyCharCount, checkWiki, classifyWikiPath, isRemovableWikiPath, logLine, migrateTiersToPages, nudgeFrom, parseWikiPage,
  renderCheckReport, renderIndex, schemaPage, seedPages, serializeWikiPage, singleLine, validateWikiFields,
  type WikiLogKind, type WikiPage,
} from "../../../src/shared/wiki.js";
import type { WikiFs } from "./wikiFs.js";
import type { WikiJournal, WikiJournalKind } from "./wikiJournal.js";

export interface WikiAuthor {
  kind: "agent" | "member";
  id: string;
  label: string;
}
export interface WikiWriteArgs {
  path: string;
  title: string;
  summary: string;
  body: string;
  pinned?: boolean;
  sources?: string[];
}
export interface WikiSnapshotForAgent {
  index: string;
  pinned: { path: string; title: string; body: string }[];
  own: string | null;
  nudge: string | null;
}
export interface WikiServiceDeps {
  workspaceId: string;
  fs: WikiFs;
  journal: WikiJournal;
  /** workspace_memories 的存量行（迁移专用）；抛错按空处理 */
  legacyMemories: () => Promise<{ agentId: string; content: string }[]>;
  agentNames: () => Promise<Map<string, string>>;
  /** 容器此刻在不在跑（spec §3.3 的缓存规则） */
  isRunning: () => Promise<boolean>;
  now?: () => number;
  log?: (m: string) => void;
}
export type WikiEnsureOutcome = "present" | "restored" | "migrated" | "seeded";
export interface WikiService {
  ensure(): Promise<WikiEnsureOutcome>;
  snapshot(agentId: string, opts: { nudge: boolean }): Promise<WikiSnapshotForAgent>;
  invalidateSnapshot(): void;
  read(paths: string[]): Promise<{ path: string; text: string | null; truncated: boolean }[]>;
  search(query: string): Promise<{ path: string; line: number; text: string }[]>;
  write(args: WikiWriteArgs, author: WikiAuthor): Promise<{ path: string; chars: number }>;
  remove(path: string, author: WikiAuthor): Promise<void>;
  check(author: WikiAuthor): Promise<string>;
}

export function wikiLockKey(workspaceId: string): string {
  return `wiki:${workspaceId}`;
}

const SYSTEM = { id: "", label: "系统" };

export function createWikiService(deps: WikiServiceDeps): WikiService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const nowIso = (): string => new Date(now()).toISOString();
  /** 本进程里已经确认过 wiki/ 存在——ensure 只探一次（探测本身会碰容器，spec §3.3） */
  let ensured = false;
  const snapshotCache = new Map<string, WikiSnapshotForAgent>();

  async function journalAppend(kind: WikiJournalKind, path: string, content: string | null, who: { kind: "agent" | "member" | "system" | "external"; id: string; label: string }): Promise<void> {
    try {
      await deps.journal.append(deps.workspaceId, { path, content, kind, authorKind: who.kind, authorId: who.id, authorLabel: who.label });
    } catch (err) {
      // 文件已经落了盘，那才是事实；journal 是备份，写失败由 check 补记（spec §2.5）
      log(`wiki journal 写入失败（workspace=${deps.workspaceId} path=${path}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function regenIndex(): Promise<void> {
    const heads = await deps.fs.listHeads();
    const pages: WikiPage[] = heads.map((h) => parseWikiPage(h.path, `---\n${h.head}\n---\n`));
    await deps.fs.writePage(WIKI_INDEX_PATH, renderIndex(pages));
  }

  async function appendLog(kind: WikiLogKind, path: string, who: string, note: string): Promise<void> {
    await deps.fs.appendLog(logLine(now(), kind, path, who, note));
  }

  async function writeAll(pages: WikiPage[], kind: WikiJournalKind & WikiLogKind, journalIt: boolean): Promise<void> {
    for (const p of pages) {
      const text = serializeWikiPage(p);
      await deps.fs.writePage(p.path, text);
      if (journalIt) await journalAppend(kind, p.path, text, { kind: "system", ...SYSTEM });
    }
    await regenIndex();
    await appendLog(kind, "", SYSTEM.label, `${pages.length} 页`);
  }

  async function ensure(): Promise<WikiEnsureOutcome> {
    if (ensured) return "present";
    return withMemoryFileLock(wikiLockKey(deps.workspaceId), async () => {
      if (ensured) return "present";
      if ((await deps.fs.state()) === "present") { ensured = true; return "present"; }
      await deps.fs.init();
      let heads = new Map<string, { content: string | null; seq: number }>();
      try { heads = await deps.journal.heads(deps.workspaceId); } catch (err) { log(`wiki journal 读取失败，按空处理：${String(err)}`); }
      if (heads.size > 0) {
        for (const [path, h] of heads) if (h.content !== null) await deps.fs.writePage(path, h.content);
        await regenIndex();
        await appendLog("restore", "", SYSTEM.label, `从 journal 恢复 ${[...heads.values()].filter((h) => h.content !== null).length} 页`);
        ensured = true;
        return "restored";
      }
      let legacy: { agentId: string; content: string }[] = [];
      try { legacy = await deps.legacyMemories(); } catch (err) { log(`workspace_memories 读取失败，按空处理：${String(err)}`); }
      if (legacy.some((r) => r.content.trim() !== "")) {
        const names = await deps.agentNames().catch(() => new Map<string, string>());
        await writeAll([schemaPage(nowIso()), ...migrateTiersToPages(legacy, names, nowIso())], "migrate", true);
        ensured = true;
        return "migrated";
      }
      await writeAll(seedPages(nowIso()), "seed", true);
      ensured = true;
      return "seeded";
    });
  }

  function guardBody(path: string, body: string): string {
    const hit = scanThreat(body);
    return hit ? `（此页含可疑指令（${hit}），已跳过注入正文；跑 wiki check 看详情：${path}）` : body;
  }

  async function snapshot(agentId: string, opts: { nudge: boolean }): Promise<WikiSnapshotForAgent> {
    // 容器停着 = 卷没变（所有写者都在容器里跑），有缓存就不读（spec §3.3）
    const cached = snapshotCache.get(agentId);
    if (cached && !(await deps.isRunning())) return { ...cached, nudge: opts.nudge ? cached.nudge : null };
    const dump = await deps.fs.snapshot(agentId);
    const pinned = dump.pinned.map((p) => {
      const page = parseWikiPage(p.path, p.text);
      return { path: p.path, title: page.front.title, body: guardBody(p.path, page.body) };
    });
    const own = dump.own === null ? null : guardBody(`agents/${agentId}.md`, parseWikiPage(`agents/${agentId}.md`, dump.own).body);
    const snap: WikiSnapshotForAgent = { index: dump.index, pinned, own, nudge: nudgeFrom(dump.logTail, now()) };
    snapshotCache.set(agentId, snap);
    return { ...snap, nudge: opts.nudge ? snap.nudge : null };
  }

  function invalidateSnapshot(): void {
    snapshotCache.clear();
  }

  async function read(paths: string[]): Promise<{ path: string; text: string | null; truncated: boolean }[]> {
    const out: { path: string; text: string | null; truncated: boolean }[] = [];
    for (const path of paths) {
      if (classifyWikiPath(path) === "invalid") throw new Error(`路径不合法：${path}（一层目录、小写 kebab、.md）`);
      const text = await deps.fs.readPage(path);
      if (text === null) { out.push({ path, text: null, truncated: false }); continue; }
      const truncated = charCount(text) > WIKI_READ_PAGE_LIMIT;
      out.push({ path, text: truncated ? `${[...text].slice(0, WIKI_READ_PAGE_LIMIT).join("")}\n…（已截断，这页有 ${charCount(text)} 字）` : text, truncated });
    }
    return out;
  }

  async function currentPinned(exclude: string): Promise<{ path: string; chars: number }[]> {
    const dump = await deps.fs.snapshot("");
    // bodyCharCount 是唯一的算法（复审 fix round 1，#1140）：写入闸的 chars/beforeChars 与这里
    // 用同一把尺子，见 src/shared/wiki.ts 的 bodyCharCount 注释
    return dump.pinned.filter((p) => p.path !== exclude).map((p) => ({ path: p.path, chars: bodyCharCount(parseWikiPage(p.path, p.text).body) }));
  }

  async function write(args: WikiWriteArgs, author: WikiAuthor): Promise<{ path: string; chars: number }> {
    const kind = classifyWikiPath(args.path);
    if (kind === "invalid") throw new Error(`路径不合法：${args.path}（一层目录、小写 kebab、.md，例如 customers/acme.md）`);
    if (kind === "tool-owned") throw new Error(`${args.path} 是工具专有的（index 由工具生成、log 只追加），不能直接写`);
    const fieldErr = validateWikiFields({
      title: args.title,
      summary: args.summary,
      ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
      ...(args.sources !== undefined ? { sources: args.sources } : {}),
    });
    if (fieldErr) throw new Error(fieldErr);
    if (typeof args.body !== "string") throw new Error("content 必填（整页正文，markdown）");
    for (const [label, text] of [["正文", args.body], ["title", args.title], ["summary", args.summary]] as const) {
      const hit = scanThreat(text);
      if (hit) throw new Error(`${label}含可疑指令（${hit}），拒绝写入`);
    }
    const pageAgent = agentIdOfPage(args.path);
    if (pageAgent !== null && author.kind === "agent" && author.id !== pageAgent) {
      throw new Error(`${args.path} 只有智能体「${pageAgent}」自己（或成员在设置页）能写`);
    }
    const pinned = args.path === WIKI_TEAM_PATH ? true : args.pinned === true;
    const chars = bodyCharCount(args.body);
    return withMemoryFileLock(wikiLockKey(deps.workspaceId), async () => {
      const before = await deps.fs.readPage(args.path);
      const beforePage = before === null ? null : parseWikiPage(args.path, before);
      const beforeChars = beforePage === null ? 0 : bodyCharCount(beforePage.body);
      // 自己那页的闸：那一页就是预算本身，「超限且没变小才拒」按本页比是对的
      const shrinking = before !== null && chars < beforeChars;
      if (pageAgent !== null && chars > WIKI_OWN_BUDGET && !shrinking) {
        throw new Error(`${args.path} 是智能体自己那页，上限 ${WIKI_OWN_BUDGET} 字，这次 ${chars} 字。精简后再写`);
      }
      if (pinned) {
        // 常驻的闸守的是**合计**，而 currentPinned 把本页排除在外——所以「变没变小」也必须按合计比
        // （终审 Important 1）：按本页比时，「不常驻写 5001 字 → 改成常驻 5000 字」两步就把 5000 字
        // 塞进了 2200 的预算里，每一步单看都合法。本页原来不常驻的话，它一个字都不在 prevTotal 里
        const others = await currentPinned(args.path);
        const othersSum = others.reduce((s, p) => s + p.chars, 0);
        const prevTotal = othersSum + (beforePage !== null && beforePage.front.pinned ? beforeChars : 0);
        const total = othersSum + chars;
        if (total > WIKI_PINNED_BUDGET && !(total < prevTotal)) {
          const list = others.map((p) => `${p.path}（${p.chars} 字）`).join("、");
          throw new Error(`常驻页合计 ${total} 字，超过预算 ${WIKI_PINNED_BUDGET}。现有常驻页：${list || "无"}。先取消别的页的 pinned 或精简这一页`);
        }
      }
      const page: WikiPage = {
        path: args.path,
        front: { title: singleLine(args.title), summary: singleLine(args.summary), pinned, updatedBy: singleLine(author.label), updatedAt: nowIso(), sources: args.sources ?? [] },
        body: args.body,
      };
      const text = serializeWikiPage(page);
      await deps.fs.writePage(args.path, text);
      await regenIndex();
      const logKind: WikiLogKind = author.kind === "member" ? "edit" : "write";
      await appendLog(logKind, args.path, author.label, page.front.title);
      await journalAppend(logKind, args.path, text, author);
      invalidateSnapshot();
      return { path: args.path, chars };
    });
  }

  async function remove(path: string, author: WikiAuthor): Promise<void> {
    if (classifyWikiPath(path) === "invalid") throw new Error(`路径不合法：${path}`);
    if (!isRemovableWikiPath(path)) throw new Error(`${path} 不可删（index / log 工具专有，SCHEMA.md 与 team.md 是保留页）`);
    const pageAgent = agentIdOfPage(path);
    if (pageAgent !== null && author.kind === "agent" && author.id !== pageAgent) throw new Error(`${path} 只有智能体「${pageAgent}」自己（或成员）能删`);
    await withMemoryFileLock(wikiLockKey(deps.workspaceId), async () => {
      await deps.fs.removePage(path);
      await regenIndex();
      await appendLog("remove", path, author.label, "");
      await journalAppend("remove", path, null, author);
      invalidateSnapshot();
    });
  }

  async function check(author: WikiAuthor): Promise<string> {
    return withMemoryFileLock(wikiLockKey(deps.workspaceId), async () => {
      const raw = await deps.fs.listPages();
      const pages = raw.map((p) => parseWikiPage(p.path, p.text));
      const rawTexts = new Map(raw.map((p) => [p.path, p.text]));
      let heads: Map<string, string | null> | null = null;
      try {
        heads = new Map([...(await deps.journal.heads(deps.workspaceId))].map(([k, v]) => [k, v.content]));
      } catch (err) {
        log(`wiki journal 读取失败，本次 check 跳过漂移规则：${String(err)}`);
      }
      // 截断的页不进 drifted（checkWiki 里），所以下面那圈 external 补记天然碰不到它们——
      // 补记的内容会是 head -c 砍剩的半页，而 ensure 的恢复会把它当全文写回去
      const truncated = new Set(raw.filter((p) => p.truncated).map((p) => p.path));
      const report = checkWiki({ pages, rawTexts, journalHeads: heads, truncated, extraneous: await deps.fs.listExtraneous(), now: now() });
      for (const path of report.drifted) await journalAppend("external", path, rawTexts.get(path) ?? null, { kind: "external", id: "", label: "external" });
      for (const path of report.removedOutside) await journalAppend("external", path, null, { kind: "external", id: "", label: "external" });
      await regenIndex();
      await appendLog("check", "", author.label, `${report.findings.length} 条发现`);
      invalidateSnapshot();
      return renderCheckReport(report);
    });
  }

  return {
    ensure,
    snapshot,
    invalidateSnapshot,
    read,
    search: (q) => deps.fs.search(q),
    write,
    remove,
    check,
  };
}
