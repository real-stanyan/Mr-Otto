// session_search — 跨会话回忆。对标 hermes tools/session_search_tool.py：四种形态由参数推断，
// 零 LLM 调用；过去做过什么去查，不存进记忆（ADR-0060 的另一半）。
// 只认 world.history（硬规则）；索引本身在 EventStore（派生、可重建）。
import type { Tool } from "./tool.js";
import type { ExecutionWorld, HistoryHit } from "../world/executionWorld.js";
import type { SessionEvent } from "../session/events.js";
import { deriveMessages, COMPACT_COMPRESSION } from "../session/deriveMessages.js";
import {
  SESSION_SEARCH_RESULT_MARK,
  type SessionSearchMode,
  type SessionSearchResult,
} from "../shared/sessionSearch.js";

export { parseSessionSearchResult } from "../shared/sessionSearch.js";
export type { SessionSearchMode, SessionSearchResult } from "../shared/sessionSearch.js";

export const SESSION_SEARCH_TOOL_NAME = "session_search";
const MAX_SESSIONS = 8;
const TOP_WINDOW = 5;
const BOOKEND = 3;
const SNIPPET = 300;
const READ_CAP = 12_000;
const DISCOVERY_LIMIT = 300;

export function inferMode(a: Record<string, unknown>): SessionSearchMode {
  if (typeof a["query"] === "string" && a["query"].trim()) return "discovery";
  if (typeof a["session_id"] === "string") return typeof a["around_seq"] === "number" ? "scroll" : "read";
  return "browse";
}

function clip(s: string, n = SNIPPET): string {
  return [...s].length > n ? [...s].slice(0, n).join("") + `…[截断，原长 ${[...s].length}]` : s;
}
function textOf(e: SessionEvent): string | null {
  if (e.type === "user_message" || e.type === "assistant_message") return e.content;
  if (e.type === "tool_result") return e.output;
  return null;
}
function role(type: string): string {
  return type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
}
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderEvents(events: SessionEvent[]): string {
  return events
    .map((e) => {
      const t = textOf(e);
      return t === null ? null : `[#${e.seq}] ${role(e.type)}: ${clip(t)}`;
    })
    .filter((x): x is string => x !== null)
    .join("\n");
}
/** 与 store.sessions()（BROWSE 走的那条路，见 store.ts）同一条标题规则：
    手动改名（最后一条 session_renamed 胜出）压过自动标题；没改名才退回
    第一条 user_message 首行。discovery 的 source 和 READ 的 document.title
    原来只认第一条 user_message，改过名的会话在这两处显示的标题和 BROWSE
    对不上——三处标题投影必须是同一条规则，不然模型看到的是三个不同的名字 */
function titleOf(events: SessionEvent[]): string {
  const renamed = [...events].reverse().find((e): e is Extract<SessionEvent, { type: "session_renamed" }> =>
    e.type === "session_renamed"
  );
  if (renamed && renamed.title.trim()) return renamed.title.trim().slice(0, 60);
  const autotitled = [...events].reverse().find((e): e is Extract<SessionEvent, { type: "session_autotitled" }> =>
    e.type === "session_autotitled"
  );
  if (autotitled && autotitled.title.trim()) return autotitled.title.trim().slice(0, 60);
  const first = events.find((e) => e.type === "user_message");
  return first && first.type === "user_message" ? first.content.split("\n")[0]!.trim().slice(0, 60) : "(无标题)";
}
function tail(s: string, cap: number): string {
  const cps = [...s];
  return cps.length <= cap ? s : `…[前 ${cps.length - cap} 字符已省略]\n` + cps.slice(-cap).join("");
}

export function createSessionSearchTool(): Tool {
  async function run(args: unknown, world: ExecutionWorld): Promise<string> {
    const h = world.history;
    if (!h) throw new Error("这个世界没有历史会话查询能力");
    const a = (args ?? {}) as Record<string, unknown>;
    const mode = inferMode(a);

    if (mode === "browse") {
      const list = h.recent(20);
      const body = list.length
        ? list
            .map((s) => `- ${s.sessionId} · ${s.title ?? "(无标题)"} · ${fmtTs(s.startedTs)} · ${s.userTurns} 轮 · ${s.workspace ?? ""}`)
            .join("\n")
        : "没有历史会话。";
      return `最近 ${list.length} 个会话（传 session_id 读整段，或 query 全文检索）：\n${body}\n${SESSION_SEARCH_RESULT_MARK}${JSON.stringify({ mode })}-->`;
    }

    if (mode === "read") {
      const id = a["session_id"] as string;
      const events = h.load(id);
      if (events.length === 0) throw new Error(`没有 id 为「${id}」的会话`);
      const msgs = deriveMessages(events, COMPACT_COMPRESSION).filter((m) => m.role !== "system");
      const body = msgs.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[多模态]"}`).join("\n\n");
      const userTurns = events.filter((e) => e.type === "user_message");
      const anchors = userTurns.map((e, i) => ({
        page: i + 1,
        label: clip((e as { content: string }).content.split("\n")[0]!, 40),
      }));
      const result: SessionSearchResult = {
        mode,
        document: { sessionId: id, title: titleOf(events), pages: userTurns.length, anchors },
      };
      return `会话 ${id}「${titleOf(events)}」，${userTurns.length} 轮：\n${tail(body, READ_CAP)}\n${SESSION_SEARCH_RESULT_MARK}${JSON.stringify(result)}-->`;
    }

    if (mode === "scroll") {
      const id = a["session_id"] as string;
      const around = a["around_seq"] as number;
      const win = typeof a["window"] === "number" ? a["window"] : TOP_WINDOW;
      const events = h.window(id, around - win, around + win);
      if (events.length === 0) throw new Error(`没有 id 为「${id}」的会话，或 seq ${around} 附近没有事件`);
      return `会话 ${id} 第 ${around} 条附近（±${win}）：\n${renderEvents(events)}\n${SESSION_SEARCH_RESULT_MARK}${JSON.stringify({ mode })}-->`;
    }

    // discovery
    const query = (a["query"] as string).trim();
    const hits = h.search(query, { limit: DISCOVERY_LIMIT });
    // 按 session 去重：保留每个 session 分最高的那条（hits 已按分排序）
    const best = new Map<string, HistoryHit>();
    for (const hit of hits) if (!best.has(hit.sessionId)) best.set(hit.sessionId, hit);
    const top = [...best.values()].slice(0, MAX_SESSIONS);
    if (top.length === 0) {
      return `没有找到包含「${query}」的历史会话。换个词试试，或不带参数调用列出最近会话。\n${SESSION_SEARCH_RESULT_MARK}${JSON.stringify({ mode, query, chunks: [] })}-->`;
    }
    const sections: string[] = [];
    const chunks: NonNullable<SessionSearchResult["chunks"]> = [];
    top.forEach((hit, rank) => {
      // 只有榜首要正文（±5 + 首尾各 3），只有它值得整段 load；其余会话只要
      // 标题（h.title 的 SQL 投影，规则同 titleOf）和命中行的时间戳
      // （单行 PK 查询）——原来为这两个数各付一整段 JSON.parse（issue #279）
      const all = rank === 0 ? h.load(hit.sessionId) : null;
      const title = all ? titleOf(all) : (h.title(hit.sessionId)?.slice(0, 60) ?? "(无标题)");
      const hitTs = all
        ? (all.find((e) => e.seq === hit.seq)?.ts ?? all[0]?.ts ?? 0)
        : (h.window(hit.sessionId, hit.seq, hit.seq)[0]?.ts ?? 0);
      chunks.push({
        id: `${hit.sessionId}#${hit.seq}`,
        sessionId: hit.sessionId,
        seq: hit.seq,
        source: title,
        locator: `${fmtTs(hitTs)} · #${hit.seq}`,
        // 卡片两行截断，比正文的 SNIPPET(300) 短是有意的：discovery 命中列表要一眼扫过去，不是逐字读
        text: clip(hit.text, 160),
        score: hit.score,
      });
      if (all) {
        // 第一名：命中 ±5 + 首尾各 3（hermes 的 adaptive hydration）。
        // ±5 按"消息条数"数，不按原始 seq 数——seq 里混着 turn_ended/tool_call
        // 这类无文本的路标事件，按 seq ±5 会被它们稀释，实际看到的有文本消息
        // 可能不到 5 条。先在 byText（已经滤掉无文本事件）里定位命中的下标，
        // 再按下标 ±TOP_WINDOW 切片，保证窗口两侧各是 TOP_WINDOW 条真消息
        const byText = all.filter((e) => textOf(e) !== null);
        const head = byText.slice(0, BOOKEND);
        const tailE = byText.slice(-BOOKEND);
        const hitIdx = byText.findIndex((e) => e.seq === hit.seq);
        const mid = hitIdx < 0 ? [] : byText.slice(Math.max(0, hitIdx - TOP_WINDOW), hitIdx + TOP_WINDOW + 1);
        const seen = new Set<number>();
        const merged = [...head, ...mid, ...tailE]
          .filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)))
          .sort((x, y) => x.seq - y.seq);
        sections.push(`## ${hit.sessionId}「${title}」（最相关，命中 #${hit.seq}）\n${renderEvents(merged)}`);
      } else {
        sections.push(`## ${hit.sessionId}「${title}」（命中 #${hit.seq}）\n[#${hit.seq}] ${role(hit.type)}: ${clip(hit.text)}`);
      }
    });
    const result: SessionSearchResult = { mode, query, chunks };
    return `「${query}」命中 ${best.size} 个会话（展示前 ${top.length}）。要看某段前后用 session_id + around_seq，整段用 session_id：\n\n${sections.join("\n\n")}\n${SESSION_SEARCH_RESULT_MARK}${JSON.stringify(result)}-->`;
  }

  return {
    def: {
      name: SESSION_SEARCH_TOOL_NAME,
      description:
        "查历史会话（不含当前会话）。过去做过什么、进度到哪、当时怎么决定的，用这个查，别存进记忆。" +
        "四种用法：query = 全文检索；session_id = 读整段；session_id + around_seq = 看某条前后；不带参数 = 列最近会话。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词（≥3 字符走全文索引，更短走子串匹配）" },
          session_id: { type: "string", description: "要读的会话 id" },
          around_seq: { type: "number", description: "配合 session_id：看这条事件前后" },
          window: { type: "number", description: "配合 around_seq：前后各取几条，默认 5" },
        },
      },
    },
    requiresApproval: false,
    parallelSafe: true, // 只读历史日志,无共享状态(issue #283 ③)
    run,
  };
}
