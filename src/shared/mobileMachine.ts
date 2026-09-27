// mobileMachine —— 手机「它们的电脑」那几屏的判据（#1356 A5，spec §5.8）：目录四行、文件、应用、记忆、用量页的
// 手机说法，以及名册搜索里记忆那一半。纯逻辑，屏只画。
//
// **数字全是查得到的**（demo 原话），查不到的一律不画——这一片开工时逐条验过：
// · 磁盘用量不对任何客户端暴露（ADR-0287：`du` 的读数只在 runtime 里当闸，出门的只有超额时那一句旁白）；
// · 文件总数没有（files 帧一次只列一层，ADR-0253）；
// · 「应用等你登录」只活在桌面主进程的内存里（McpHub 的 needs-auth），托管箱还把不 live 的整台滤掉
//   （pxEscrow.buildEscrowDoc）——手机从哪条路都问不出来，所以名册账号钮上那枚点、应用的状态点都不画。
// 界面文案不出现「水獭」「主场」「团队」：桌面 workFilesView / usageScaleNote 那几句是桌面口吻，这里另写；尺寸、
// 时间、百分比的算法照旧复用那几份。

import type { WorkspaceUsage } from "./billing.js";
import { fmtRemainingPercent, liveWindow, usedPercentOf } from "./billingView.js";
import { quotaToneView, type QuotaToneView } from "./mobileAccount.js";
import { rosterTimeLabel } from "./mobileRoster.js";
import type { CsWorkEntry, CsWorkHit, CsWorkNode } from "./remote/cloudSession.js";
import { joinWorkPath } from "./remote/workPath.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import {
  extractWikiLinks, parseIndex, parseWikiPage, validateWikiFields, WIKI_AGENTS_DIR,
  type WikiIndexEntry, type WikiIndexGroup, type WikiPage,
} from "./wiki.js";
import { entryMeta, formatWorkSize } from "./workFilesView.js";
import { usageHeadline, usageWindowText, workspaceTotalMicro, type UsageScale } from "./workspaceUsageView.js";
import { toolsSummary } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

// ── 目录 ──

/** 页顶那一组的组头：几只共用这一台。demo 的「五只共用这一台 · 一直开着」去掉了后半句——容器空闲一阵会停、
    有活再起（ADR-0199），「一直开着」不成立 */
export function machineShareText(ws: WorkspaceSnapshot): string {
  return `${ws.agents.length} 只智能体共用这一台`;
}

export const MACHINE_FOOTER = "这台电脑在云端。一阵子没活干它会自己睡着，有活时再醒——文件都还在。";

export type WikiIndexState =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "ok"; groups: WikiIndexGroup[] }
  | { kind: "error"; message: string; groups: WikiIndexGroup[] | null };

export type UsageLoad =
  | { kind: "loading" }
  | { kind: "ok"; usage: WorkspaceUsage }
  | { kind: "error"; message: string; usage: WorkspaceUsage | null };

export interface MachineRowView {
  key: "files" | "apps" | "wiki" | "usage";
  title: string;
  detail: string;
  /** 右边那一格；null = 这一刻说不出（还在读 / 读不到 / 本来就查不到），不写字 */
  value: string | null;
}

function countText(n: number, unit: string): string {
  return n === 0 ? "还没有" : `${n} ${unit}`;
}

function usageOf(load: UsageLoad): WorkspaceUsage | null {
  return load.kind === "ok" ? load.usage : load.kind === "error" ? load.usage : null;
}

/** 目录那四行。文件那一行**不报数**（没有递归计数）；这周那一格报「占你周额度的百分之几」，分母读不到就不报 */
export function machineRows(o: { apps: number; wiki: WikiIndexState; usage: UsageLoad }): MachineRowView[] {
  const groups = wikiGroupsOf(o.wiki);
  const usage = usageOf(o.usage);
  return [
    { key: "files", title: "文件", detail: "它们干活留下的东西", value: null },
    { key: "apps", title: "应用", detail: "它们能拿你的身份去用的那几个", value: countText(o.apps, "个") },
    {
      key: "wiki", title: "记忆", detail: "它们自己写、互相看得见",
      value: o.wiki.kind === "absent" ? "还没有" : groups === null ? null : countText(wikiPageCount(groups), "页"),
    },
    { key: "usage", title: "这周用了多少", detail: "按智能体分", value: usage === null ? null : usageHeadline(usage).percent },
  ];
}

// ── 记忆 ──

export const WIKI_FOOTER = "你也能改——存了之后，它们下一次开口就按新的来。";
export const WIKI_EMPTY = "它们还没记下什么。干活时记下的口径、习惯会出现在这里。";
export const WIKI_ABSENT = "它们的电脑还没开过——第一次让它们干活时才会建，记忆也在那时候生成。";

/** 读 wiki/index.md 那一格的结局 → 记忆清单的状态。`absent`（电脑还没建起来）与「索引不在」是两回事：后者 =
    建起来了、一页都还没记（桌面 WorkspaceWikiTab 同一个读法）。**只有真读到了才回 ok** */
export function wikiIndexFrom(node: CsWorkNode): WikiIndexState {
  if (node.kind === "absent") return { kind: "absent" };
  if (node.kind === "missing") return { kind: "ok", groups: [] };
  if (node.kind === "file") return { kind: "ok", groups: parseIndex(node.text) };
  return { kind: "error", message: "记忆的索引读不出来。", groups: null };
}

/** 这一次没读到：上一份清单留在原地，错误另起一行（读不到 ≠ 空，同 ADR-0264 决策 8） */
export function wikiIndexAfterError(prev: WikiIndexState, message: string): WikiIndexState {
  return { kind: "error", message, groups: wikiGroupsOf(prev) };
}

export function wikiGroupsOf(s: WikiIndexState): WikiIndexGroup[] | null {
  return s.kind === "ok" ? s.groups : s.kind === "error" ? s.groups : null;
}

export function wikiPageCount(groups: readonly WikiIndexGroup[]): number {
  return new Set(groups.flatMap((g) => g.entries.map((e) => e.path))).size;
}

/** 组头写什么：索引里「各只自己那页」那一组的名字是目录名 `agents`，手机上换成人话；其余照索引（常驻 / 目录名 /
    未分目录）——目录名是它们自己起的，改写就是替它们改了名 */
export function wikiGroupTitle(name: string): string {
  return name === WIKI_AGENTS_DIR ? "各只自己那一页" : name;
}

export type WikiPageLoad = { ok: true; page: WikiPage } | { ok: false; message: string };

export function wikiPageFrom(path: string, node: CsWorkNode): WikiPageLoad {
  if (node.kind === "file") return { ok: true, page: parseWikiPage(path, node.text) };
  if (node.kind === "missing") return { ok: false, message: "这一页不在了，可能刚被删掉或改名了。" };
  if (node.kind === "absent") return { ok: false, message: WIKI_ABSENT };
  return { ok: false, message: "这一页读不出来（不是文本）。" };
}

/** 页头那一行：「开发 · 12:40 · 常驻」。谁写的读页头（updated_by，写的那一刻的名字）；时间用名册那把尺子
    （刚刚 / 12:41 / 昨天 / 周二 / 9 月 3 日）；读不出时间就不写那一段 */
export function wikiMetaLine(page: WikiPage, now: number): string {
  const parts = [page.front.updatedBy.trim() || "—"];
  const ts = Date.parse(page.front.updatedAt);
  if (Number.isFinite(ts)) parts.push(rosterTimeLabel(ts, now));
  if (page.front.pinned) parts.push("常驻");
  return parts.join(" · ");
}

/** 「它提到的」：正文里的 [[链接]]，按索引认出标题；索引里没有的（链坏了 / 还没写）不列，自己链自己不列。
    demo 那一组是「连到这一页的」（反向链接）——那要把每一页都读一遍，files 帧一次只读一个文件，不做 */
export function wikiLinkRows(page: WikiPage, groups: readonly WikiIndexGroup[]): WikiIndexEntry[] {
  const byPath = new Map<string, WikiIndexEntry>();
  for (const g of groups) for (const e of g.entries) if (!byPath.has(e.path)) byPath.set(e.path, e);
  const out: WikiIndexEntry[] = [];
  for (const target of extractWikiLinks(page.body)) {
    if (target === page.path) continue;
    const hit = byPath.get(target);
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/** 名册搜索里记忆那一半：标题 / 摘要 / 路径里含这几个字（不分大小写），按索引里的顺序，同一页只出一次，封顶 limit 条 */
export function wikiMatches(groups: readonly WikiIndexGroup[], query: string, limit = 20): WikiIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const seen = new Set<string>();
  const out: WikiIndexEntry[] = [];
  for (const g of groups) {
    for (const e of g.entries) {
      if (seen.has(e.path)) continue;
      if (![e.title, e.summary, e.path].some((s) => s.toLowerCase().includes(q))) continue;
      seen.add(e.path);
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 名册搜索里记忆那一半此刻说什么：索引还在读 = 「正在读记忆…」；读不到而且手上没有上一份 = 说清这一次只搜了智能体
    （读不到 ≠ 空：不许把「没去找」画成「没找到」）；其余（读到了 / 电脑还没开过 / 读不到但有上一份）= null，照常过滤 */
export function searchMemoryNote(wiki: WikiIndexState): string | null {
  if (wiki.kind === "loading") return "正在读记忆…";
  if (wiki.kind === "error" && wiki.groups === null) return "记忆这一刻读不到，这次只搜了智能体。";
  return null;
}

const FIELD_NAMES: Record<string, string> = { title: "标题", summary: "摘要", sources: "来源" };

/** 改一页之前过一道页头校验（与 wiki 工具、桌面同一份 validateWikiFields）；null = 可以存。
    那份话开头是英文字段名（它也说给模型听），手机上换成中文 */
export function wikiEditError(f: { title: string; summary: string; pinned: boolean; sources: readonly string[] }): string | null {
  const bad = validateWikiFields({ title: f.title, summary: f.summary, pinned: f.pinned, sources: [...f.sources] });
  return bad === null ? null : bad.replace(/^(title|summary|sources) ?/, (_m, k: string) => FIELD_NAMES[k] ?? k);
}

// ── 文件 ──

export const FILES_FOOTER = "文件在云端那台电脑上，下不到手机上；要看哪一份就点开，或者让它们在聊天里念给你。";
export const FILES_SEARCH_PLACEHOLDER = "找文件；打 ? 搜内容";

export type WorkIcon = "folder" | "image" | "file";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i;

export function workIcon(name: string, kind: CsWorkEntry["kind"]): WorkIcon {
  if (kind === "dir") return "folder";
  return IMAGE_EXT.test(name) ? "image" : "file";
}

export interface WorkEntryRowView {
  key: string;
  path: string;
  name: string;
  icon: WorkIcon;
  /** 行的第二格：目录只写时间，文件写大小 · 时间（桌面那一份 entryMeta） */
  meta: string;
  /** 点进去（目录）/ 点开（文件）；other（软链、设备文件）两样都不行 */
  opens: "dir" | "file" | null;
}

/** 一层目录 → 行：目录在前，再按名字（码点序）；路径拼好（joinWorkPath，两端同一个拼法） */
export function workEntryRows(dir: string, entries: readonly CsWorkEntry[], now: number): WorkEntryRowView[] {
  return [...entries]
    .sort((a, b) => {
      if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((e) => {
      const path = joinWorkPath(dir, e.name);
      return {
        key: path, path, name: e.name, icon: workIcon(e.name, e.kind), meta: entryMeta(e, now),
        opens: e.kind === "dir" ? "dir" : e.kind === "file" ? "file" : null,
      };
    });
}

/** 一个文件夹里什么都画不出来时说哪句。**三种「空」不许合成一句**（桌面 workFolderNotice 同一条判据）：电脑还没
    建起来 / 这条路径没了 / 真的是空的 */
export function workFolderText(node: CsWorkNode): string | null {
  if (node.kind === "absent") return "它们的电脑还没开过——第一次让它们干活时才会建。";
  if (node.kind === "missing") return "这个位置现在没有东西，可能刚被删掉或改名了。";
  if (node.kind === "dir" && node.entries.length === 0) return "还是空的。它们做出来的东西会出现在这里。";
  return null;
}

/** 列不全时组尾那一句 */
export function workFolderTruncated(node: CsWorkNode): string | null {
  return node.kind === "dir" && node.truncated && node.entries.length > 0 ? "这一层东西太多，只列了前一部分。" : null;
}

/** 一个文件底下那一句：二进制 / 截断 / 空文件 / 不在了（桌面 workFileNotice 的手机说法）；没什么好说的 = null */
export function workFileText(node: CsWorkNode): string | null {
  if (node.kind === "binary") return `这是一个二进制文件（${formatWorkSize(node.size)}），手机上显示不出内容。`;
  if (node.kind === "file" && node.truncated) return `文件有 ${formatWorkSize(node.size)}，这里只显示了开头一段。`;
  if (node.kind === "file" && node.text === "") return "这是一个空文件。";
  if (node.kind === "missing") return "这个文件现在不在了，可能刚被删掉或改名了。";
  if (node.kind === "absent") return "它们的电脑还没开过——第一次让它们干活时才会建。";
  return null;
}

export function baseName(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? "";
}

export interface WorkHitRowView {
  key: string;
  path: string;
  title: string;
  detail: string;
  icon: WorkIcon;
}

/** 搜索结果 → 行。按内容搜时一个文件可能命中好几行，每行一条（第几行 + 那一行的字）；按名搜时第二行写它在哪个文件夹 */
export function workHitRows(hits: readonly CsWorkHit[]): WorkHitRowView[] {
  return hits.map((h, i) => {
    const slash = h.rel.lastIndexOf("/");
    const dir = slash < 0 ? "" : h.rel.slice(0, slash);
    const title = baseName(h.rel);
    const detail = h.line !== null ? `第 ${h.line} 行：${(h.text ?? "").trim()}` : dir === "" ? "最外层" : dir;
    return { key: `${h.rel}:${h.line ?? ""}:${i}`, path: h.rel, title, detail, icon: workIcon(title, "file") };
  });
}

// ── 应用 ──

export const APPS_EMPTY = "还没有接应用。";
export const APPS_FOOTER = "新的应用要在电脑上的 Mr Otto 里接；要登录的也在那台电脑上登，凭据不经过这个手机。它们此刻连没连上，这里看不出来。";

export interface AppRowView {
  key: string;
  title: string;
  detail: string;
}

/** 接着的那几个应用（workspace_connectors，桌面贡献进来的）。**不画状态**：连没连上、要不要重新登录，手机问不出来
    （见头注）；名字空着退回 serverId；第二行与桌面同一句（toolsSummary） */
export function appRows(ws: WorkspaceSnapshot): AppRowView[] {
  return ws.connectors.map((c) => ({
    key: `${c.hostUid}:${c.serverId}`,
    title: c.label.trim() || c.serverId,
    detail: toolsSummary(c.tools),
  }));
}

// ── 用量页 ──

export const USAGE_EMPTY = "这一周它们还没用额度。";

/** 页顶大数字底下那一行：分母是什么 + 哪一周；知道本周那扇窗时补一句还剩多少——那个数来自账号的额度窗，
    **不是 100 减去上面那个数**（你在电脑上用掉的也算在同一扇窗里） */
export function usageHeroText(usage: WorkspaceUsage, billing: BillingSnapshotView | null, now: number): string {
  const parts = [usage.weekLimitMicro === null ? "这一周它们调了几次模型" : "占你这一周额度的比例", usageWindowText(usage)];
  const week = billing?.me?.windows?.week;
  if (week !== undefined) parts.push(`本周还剩 ${fmtRemainingPercent(liveWindow(week, now))}`);
  return parts.join(" · ");
}

/** 大数字那根条的色档：分母在时按已用判（与账号页两扇窗同一组阈值），不在时不画条也就无所谓色档——一律 neutral */
export function usageTone(usage: WorkspaceUsage): QuotaToneView {
  if (usage.weekLimitMicro === null) return "neutral";
  return quotaToneView(usedPercentOf(workspaceTotalMicro(usage), usage.weekLimitMicro));
}

/** 组尾那句：这些百分比的分母是什么（桌面 usageScaleNote 的手机说法：这几只花的是你的额度，「所有者」就是你） */
export function usageNote(scale: UsageScale): string {
  if (scale.kind === "window") {
    return "百分比 = 占你本周额度的比例，与账号页「本周」那扇窗同一把尺子；条是各自在这几只里的比重。";
  }
  return "读不到你的额度上限（没有活跃订阅，或服务端还不报这一格），所以百分比暂时按这一周它们的合计算——不是占额度的比例。";
}

/** 这一次没读到：上一份用量留着（读不到 ≠ 空） */
export function usageAfterError(prev: UsageLoad, message: string): UsageLoad {
  return { kind: "error", message, usage: usageOf(prev) };
}

/** 请求失败的原话：断网 / 超时说人话，别的原样留（认不出的不猜，#910 的规矩） */
export function usageErrorText(message: string): string {
  return /network request failed|fetch failed|network|timed? ?out/i.test(message)
    ? "连不上服务端——网络不通，或者对面暂时没响应。"
    : message;
}
