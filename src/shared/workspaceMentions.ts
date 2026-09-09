// 「谁在团队里 @ 了我」的收件箱（#1064）—— 形状与聚合，三处共用一份：
// runtime 按这个形状往 Supabase 写、主进程按它读、渲染层按它算角标。
//
// ── 为什么要有这张表 ────────────────────────────────────────────────────
// 云会话的权威日志在 VPS 上，桌面**够不着**：要先开一条那个团队的会话房才读得到
// （frameHandler 的 backlog）。而角标必须在一条会话都没开的时候就画得出来——
// 「你不在的时候有人喊你」这件事，恰恰只发生在你没开着它的时候。所以这张表是
// 日志的一份**投影**（`user_message{fromUid}` + 那一刻这句话点到的成员），
// 日志仍然是唯一事实来源：这张表整个丢掉，重放日志能重新算出来。
//
// ── 一行 = 一次点名，不是一条消息 ──────────────────────────────────────
// 主键 `(uid, sessionId, seq)`：同一条开场白被重写一次（daemon 重启补跑 / 重试）
// 就是同一行，天然幂等，不需要另造一个去重键。

/** Supabase `workspace_mentions` 的一行，字段名已转成本仓的驼峰口径 */
export interface WorkspaceMentionRow {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** 那条 `user_message` 在这条会话日志里的 seq。与 uid/sessionId 一起是主键 */
  readonly seq: number;
  /** 被 @ 的人 */
  readonly uid: string;
  /** 写下那个 @ 的人 */
  readonly fromUid: string;
  /** 写的时候他叫什么。**落一份快照不现查**：通知正文要它，而
      `profiles.name` 是会变的——改了名之后回头看，"那天是谁喊我"应该
      还是那天那个名字（同 usage_event 按 agent_id 记账、不记名字的反面：
      那边要的是"改名不断账"，这边要的是"当时的措辞不被改写"） */
  readonly fromLabel: string;
  /** 正文摘要，通知正文用（`mentionExcerpt` 截好才落库） */
  readonly excerpt: string;
  readonly createdTs: number;
  /** 读过了没有。`markMentionsRead` 把整条会话的置成已读 */
  readonly read: boolean;
}

/** 落库的正文摘要上限。通知中心显示不了这么多（friendNotifier 的 BODY_MAX 是
    120），留出余量是为了让**列表里**那一行以后也能用同一格，不必再回头改表 */
export const MENTION_EXCERPT_MAX = 200;

/** 正文 → 落库的摘要。压平空白 + 截断，与 friendNotifier.truncate 同一条口径
    （那边是渲染前再截一次到 120，两道截断叠加是幂等的） */
export function mentionExcerpt(text: string, max = MENTION_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 未读条数：总数一份，按团队、按会话各一份。
 *
 * **三份都要**：团队自己独占一栏之后（#1087），人站在任务/项目栏时整份清单
 * 都不在屏幕上，只有切换器那一格能说话，而它认识的只有 `total`；组头收起来的
 * 时候会话行不在屏幕上，只有组头那一格能说话；展开之后又必须指出是**哪一条**
 * 会话，否则人得一条条点开找。
 *
 * `total` 是这里算的不是调用方 `filter(r => !r.read).length` 出来的：「哪一条算
 * 未读」只能有一份判据，抄第二遍的那天两处会各自演化。
 *
 * 已读的行照旧留在入参里（`markMentionsRead` 只翻 `read`，不删行）——删了的话
 * 「这条会话里有没有人喊过我」这个问题就再也答不出来了，而那正是以后要做的
 * 「@ 我的」清单唯一的数据源。 */
export function unreadMentionCounts(rows: readonly WorkspaceMentionRow[]): {
  total: number;
  byWorkspace: Record<string, number>;
  bySession: Record<string, number>;
} {
  const byWorkspace: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    if (r.read) continue;
    total += 1;
    byWorkspace[r.workspaceId] = (byWorkspace[r.workspaceId] ?? 0) + 1;
    bySession[r.sessionId] = (bySession[r.sessionId] ?? 0) + 1;
  }
  return { total, byWorkspace, bySession };
}

/** 一条 realtime 推上来的新行并进手上这份清单。
 *
 * **按主键去重不按数组长度**：realtime 断线重连之后 Supabase 可能把同一条
 * INSERT 再推一次，而"未读 +1"是个累加动作——不去重的话一次网络抖动就把角标
 * 从 1 变成 2，人点进去只找得到一条。后到的那份覆盖旧的（同一主键的内容只可能
 * 是同一条，覆盖是安全的），顺序按 seq 升序，跨会话再按时间。 */
export function mergeMentionRow(
  rows: readonly WorkspaceMentionRow[],
  row: WorkspaceMentionRow
): WorkspaceMentionRow[] {
  const out = rows.filter(
    (r) => !(r.uid === row.uid && r.sessionId === row.sessionId && r.seq === row.seq)
  );
  out.push(row);
  out.sort((a, b) => a.createdTs - b.createdTs || a.seq - b.seq);
  return out;
}

/** 把一条会话的未读全部置成已读（进了那间房 = 看见了）。
 *
 * **没变化就把原数组原样还回去**：这一格挂在 zustand 的 state 上，而
 * `openCloudSession` 每次都会调它——造一个内容相同的新数组等于让整个侧栏
 * 白重渲染一遍（引用相等是那些 selector 唯一的判据）。 */
export function markSessionRead(
  rows: readonly WorkspaceMentionRow[],
  sessionId: string
): readonly WorkspaceMentionRow[] {
  if (!rows.some((r) => r.sessionId === sessionId && !r.read)) return rows;
  return rows.map((r) => (r.sessionId === sessionId && !r.read ? { ...r, read: true } : r));
}
