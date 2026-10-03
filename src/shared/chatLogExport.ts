// 聊天记录导出（#1446）：把一条聊天的全部原始事件落成 jsonl，丢给别的 AI 去排查这条聊天里的问题。
//
// 两端（桌面 / 手机）共用这一份：序列化与文件名是纯函数；`collectFullLog` 管「先把更早的
// 页翻齐再导出」——聊天走尾巴模式（ADR-0300），进房只拉最新一页，直接导出 store 里那份
// 就是一份缺头的日志，而「缺头」不报错，只会让接手分析的人对着半条会话下结论。
// 团队会话本来就是全量，hasOlder 恒为假，同一条路零页就 complete。
//
// 翻页的三道止损各挡一种空转：一页失败就停（别在断线时反复打网络）、一页没带来新东西而
// hasOlder 仍为真就停（状态与事件对不上，再翻只是原地踏步）、页数封顶（兜住前两道都漏掉的）。
// 停下来都回 partial 而不是抛——导出「读到多少算多少」是人能拍板的事，由调用方问人。

import type { SessionEvent } from "../session/events.js";

/** 原始事件日志，一行一条。无损：拿它能重建任何投影（含轨迹视图本身）。
    原住 replay/trajectoryExport.ts，云会话导出（#1117）与聊天导出共用，抽到这里只有一份实现 */
export function eventsJsonl(events: SessionEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

/** 文件名里的时间戳：20260908-223012（本地时区，与 trajectoryExport 同一把尺） */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** `otto-cloud-3f9a1c0d-20260908-223012.jsonl`。带 cloud 前缀是为了落在下载目录里
    一眼分得清本地轨迹导出（otto-trajectory-*）——两者内容形状不同，混着喂给
    分析脚本会得到一堆解析错误 */
export function cloudLogFilename(sessionId: string, exportedTs: number): string {
  const id = sessionId.slice(0, 8) || "session";
  return `otto-cloud-${id}-${stamp(exportedTs)}.jsonl`;
}

export const PARTIAL_NO_PROGRESS = "没有读到更早的记录";
export const PARTIAL_PAGE_CAP = "翻页次数到了上限";
export const DEFAULT_MAX_PAGES = 2000;

export interface CollectDeps {
  /** 还有没有更早的（读的是翻页之后最新的状态） */
  hasOlder(): boolean;
  loadOlder(): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 此刻已加载的事件条数 */
  count(): number;
  onProgress?(count: number): void;
  maxPages?: number;
}

export type CollectResult =
  | { kind: "complete"; count: number }
  | { kind: "partial"; count: number; message: string };

/** 要导出的是哪一条：智能体私聊只知道是哪只（手机信息页的路由里没有 sessionId），其余按 sessionId */
export type ExportTarget = { kind: "agent"; agentId: string } | { kind: "session"; sessionId: string };

/** 此刻开着的那条会话是不是要导出的这一条，且已经连上并对过账。
    `provisional`（手机）里混着本机缓存，不是服务器那份完整的前缀——不算 */
export function openSessionMatches(
  target: ExportTarget,
  s: {
    sessionId: string;
    state: string;
    provisional?: boolean;
    chat?: { kind: string; agentIds: string[] } | null | undefined;
  } | null,
): boolean {
  if (s === null || s.state !== "ready" || s.provisional === true) return false;
  if (target.kind === "session") return s.sessionId === target.sessionId;
  return s.chat?.kind === "dm" && s.chat.agentIds.includes(target.agentId);
}

/** `cancel` = 人不要这份了（桌面弹窗被 Esc / 点遮罩关掉、手机端离开了页面）：不导出，也不再问 */
export type PartialChoice = "retry" | "export" | "cancel";

/** 导出的整段编排（两端共用）：翻齐 → 没翻齐、或翻齐了但日志中间有缺口，就问人。
    问的是人不是自动重试：失败多半是断线，在断线时自己循环只会白打网络；而有损的日志
    （缺头 / 中间缺一段）该不该交出去由人定。重试从当前已读到的接着翻，不从头。
    缺口（`gapNote`，客户端说「有些事件没能下发」）不是翻页能治的，但**不能当成完整日志悄悄交出去**
    ——接手分析的人对着有洞的日志下结论，而洞本身不报错。
    返回 `"export"` = 该导出了（事件列表由调用方现读，翻页期间还在长）；`"cancel"` = 什么都不导 */
export async function runChatExport(io: {
  collect(): Promise<CollectResult>;
  askPartial(r: { count: number; message: string; gap: boolean }): Promise<PartialChoice>;
  gapNote?(): string | null;
}): Promise<"export" | "cancel"> {
  for (;;) {
    const r = await io.collect();
    let ask: { count: number; message: string; gap: boolean } | null = null;
    if (r.kind === "partial") ask = { count: r.count, message: r.message, gap: false };
    else {
      const gap = io.gapNote?.() ?? null;
      if (gap !== null && gap !== "") ask = { count: r.count, message: gap, gap: true };
    }
    if (ask === null) return "export";
    const c = await io.askPartial(ask);
    if (c !== "retry") return c;
  }
}

/** 弹窗那句话：没翻齐「只读到 N 条，更早的没读到（原因）」，有缺口「这份记录有缺口（原因）」 */
export function partialExportText(count: number, message: string, gap = false): string {
  return gap ? `这份记录有缺口（${message}），共 ${count} 条` : `只读到 ${count} 条，更早的没读到（${message}）`;
}

export const EXPORT_SWITCHED = "聊天已经切换，没有导出";

/** 翻一页的结局：`hasOlder` 是那一页回来之后客户端自己报的「前面还有没有」 */
export type OlderPageResult = { ok: true; hasOlder: boolean } | { ok: false; message: string };

/** 把「翻一页」的动作接成 collectFullLog 要的形状（两端共用）。
    `hasOlder` 优先信刚回来的那一页自己报的——store 里那一格是状态推送带来的，
    与翻页回执谁先到不保证；拿陈旧的真值多翻一页只会撞上无进展的闸，误报成 partial */
export function pagerDeps(io: {
  loadOlderPage(): Promise<OlderPageResult>;
  storeHasOlder(): boolean;
  count(): number;
  onProgress?(count: number): void;
}): CollectDeps {
  let last: boolean | null = null;
  return {
    hasOlder: () => last ?? io.storeHasOlder(),
    async loadOlder() {
      const r = await io.loadOlderPage();
      if (!r.ok) return r;
      last = r.hasOlder;
      return { ok: true };
    },
    count: io.count,
    ...(io.onProgress === undefined ? {} : { onProgress: io.onProgress }),
  };
}

export async function collectFullLog(deps: CollectDeps): Promise<CollectResult> {
  const cap = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let pages = 0;
  while (deps.hasOlder()) {
    if (pages >= cap) return { kind: "partial", count: deps.count(), message: PARTIAL_PAGE_CAP };
    const before = deps.count();
    const r = await deps.loadOlder();
    pages += 1;
    if (!r.ok) return { kind: "partial", count: deps.count(), message: r.message };
    const now = deps.count();
    deps.onProgress?.(now);
    if (now === before && deps.hasOlder()) {
      return { kind: "partial", count: now, message: PARTIAL_NO_PROGRESS };
    }
  }
  return { kind: "complete", count: deps.count() };
}
