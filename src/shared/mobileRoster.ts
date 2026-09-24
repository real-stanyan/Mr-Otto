// mobileRoster —— 手机名册那一列（#1356 A1，spec §5.2）。判据全在这里（进 vitest），
// mobile/src/roster/ 只画。
//
// 与桌面 agentRoster.ts 的一处**故意不同**：桌面单只按名册顺序（通讯录）、群按活动；
// 手机把单只与群混在一起、一律按最近一次动静降序（demo 定的，spec §5.2）。
// 行的底层数据仍然来自桌面那两个函数（`rosterRows` / `groupRows`）：「哪条私聊算
// 这只的」「群名单与现存名册求交集、顺序跟名册走」这两条判据只能有一份。

import { agentFaceSlot } from "./agentAvatar.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { dayLabelOf } from "./dayLabel.js";
import { faceBox } from "./ottoFace/art.js";
import { lastSpeakerOf, type SessionLast } from "./sessionLast.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import { agentNameOf, labelOf } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

/** 没聊过的那一只底下那一行（spec §5.2）。它不是内容，搜索不命中它（搜索读的是 lastText） */
export const FIRST_WORD_HINT = "点进去跟它说第一句";

export interface AgentRosterItem {
  kind: "agent";
  key: string;
  agentId: string;
  name: string;
  description: string;
  /** 这只的头像坑位（挑过的优先，没挑过按 agentId 派生） */
  slot: number;
  isAdmin: boolean;
  /** 和它的那条私聊；null = 还没聊过（点进去是草稿，第一句发出去才建） */
  sessionId: string | null;
  /** 第一行名字后面那段小字（职责）。职责挪到第二行时这里是空串——同一句话不画两遍 */
  sub: string;
  /** 第二行：最后一句 / 没聊过的提示 / 读不到最后一句时的职责（spec §10 第 9 条）；null = 不画 */
  line2: string | null;
  /** 真正的最后一句（只给搜索用）；null = 没有 / 读不到 */
  lastText: string | null;
  /** 排序用的「最近一次动静」 */
  activityTs: number;
  /** 右边那格时间；null = 不画（没聊过） */
  timeTs: number | null;
}

export interface GroupRosterItem {
  kind: "group";
  key: string;
  sessionId: string;
  name: string;
  /** 成员名按名册顺序拼（`、` 分隔） */
  memberNames: string;
  agentIds: string[];
  slots: number[];
  /** 第一行名字后面那段小字（成员名） */
  sub: string;
  /** 第二行：「名字：摘录」；null = 读不到 / 还没人说过话 */
  line2: string | null;
  lastText: string | null;
  activityTs: number;
  timeTs: number | null;
}

export type RosterItem = AgentRosterItem | GroupRosterItem;

/** 群那一行的最后一句：「名字：摘录」。人说的写「我」（主场只有我一个人；万一不是，
    退回他在这个团队里的名字）。说话人认不出（空串 / 脏数据）就只写摘录，不编一个名字 */
function groupLastLine(home: WorkspaceSnapshot, last: SessionLast, selfUid: string): string {
  const who = lastSpeakerOf(last.from);
  if (who === null) return last.excerpt;
  const name = who.kind === "agent" ? agentNameOf(home, who.agentId) : who.uid === selfUid ? "我" : labelOf(home, who.uid);
  return `${name}：${last.excerpt}`;
}

/**
 * 名册那一列。顺序 = 最近一次动静降序；动静 = 那条聊天的 `last_ts` → 缺席退回那一行的
 * `updated_at`（这张表没有 created_at，而 updated_at 从没被补丁碰过，今天就等于创建时间）
 * → 没聊过的智能体退回它自己的 `created_at`（缺席按 0）；同分按名册顺序（单只按名册、
 * 群在后按 `groupRows` 的顺序）。
 */
export function rosterItems(o: {
  home: WorkspaceSnapshot;
  chats: readonly CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
  selfUid: string;
}): RosterItem[] {
  const createdOf = new Map(o.home.agents.map((a) => [a.agentId, a.createdTs ?? 0]));
  const agents = rosterRows(o.home, o.chats);
  const ranked: { item: RosterItem; order: number }[] = [];
  agents.forEach((r, i) => {
    const last = r.sessionId === null ? undefined : o.lasts.get(r.sessionId);
    const lastText = last !== undefined && last.excerpt !== "" ? last.excerpt : null;
    const activityTs = r.sessionId === null ? (createdOf.get(r.agentId) ?? 0) : (last?.ts ?? r.updatedTs);
    // 第二行三种：没聊过写提示；聊过写最后一句；聊过却读不到最后一句（0040 没跑 / runtime
    // 没部署）时把职责挪下来、第一行就不再重复写它（spec §10 第 9 条）
    const movedDown = r.sessionId !== null && lastText === null;
    ranked.push({
      order: i,
      item: {
        kind: "agent",
        key: `agent:${r.agentId}`,
        agentId: r.agentId,
        name: r.name,
        description: r.description,
        slot: agentFaceSlot(o.home, r.agentId),
        isAdmin: r.isAdmin,
        sessionId: r.sessionId,
        sub: movedDown ? "" : r.description,
        line2: r.sessionId === null ? FIRST_WORD_HINT : lastText ?? (r.description !== "" ? r.description : null),
        lastText,
        activityTs,
        timeTs: r.sessionId === null ? null : (last?.ts ?? null),
      },
    });
  });
  groupRows(o.home, o.chats).forEach((g, i) => {
    const last = o.lasts.get(g.sessionId);
    const activityTs = last?.ts ?? g.updatedTs;
    const memberNames = g.agentIds.map((id) => agentNameOf(o.home, id)).join("、");
    const lastText = last !== undefined && last.excerpt !== "" ? groupLastLine(o.home, last, o.selfUid) : null;
    ranked.push({
      order: agents.length + i,
      item: {
        kind: "group",
        key: `group:${g.sessionId}`,
        sessionId: g.sessionId,
        name: g.name,
        memberNames,
        agentIds: g.agentIds,
        slots: g.agentIds.map((id) => agentFaceSlot(o.home, id)),
        sub: memberNames,
        line2: lastText,
        lastText,
        activityTs,
        timeTs: last?.ts ?? null,
      },
    });
  });
  return ranked
    .sort((a, b) => b.item.activityTs - a.item.activityTs || a.order - b.order)
    .map((x) => x.item);
}

/** 名册的本机搜索（spec §5.2，记忆那一半归 A5）：按名字 / 职责 / 最后一句过滤；群按群名 /
    成员名 / 最后一句。拉丁字母不分大小写。没聊过那句提示不是内容，不参与匹配 */
export function filterRosterItems(items: readonly RosterItem[], query: string): RosterItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((it) => {
    const hay = it.kind === "agent"
      ? [it.name, it.description, it.lastText ?? ""]
      : [it.name, it.memberNames, it.lastText ?? ""];
    return hay.some((s) => s.toLowerCase().includes(q));
  });
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 右边那格时间：一分钟之内「刚刚」→ 同一个自然日写时刻 → 往前「昨天 / 周几 / 几月几日」
    （判自然日不判 24 小时，同 dayLabel.ts）。未来的时间戳（本机时钟被调过）按「刚刚」 */
export function rosterTimeLabel(ts: number, now: number): string {
  if (now - ts < 60_000) return "刚刚";
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return dayLabelOf(ts, now);
}

/** 群那几张 s 档脸叠在一起的总宽 = m 档单只的宽：这一列的左边缘是一条直线（spec §5.2） */
export const GROUP_FACES_WIDTH = faceBox("m").w;

/** 每张 s 档脸的 left（pt）。步长 `(59 − 29.5) / (n − 1)`，后一张压前一张（后画的在上面）；
    只有一张时居中 */
export function groupFaceOffsets(n: number): number[] {
  const w = faceBox("s").w;
  if (n <= 0) return [];
  if (n === 1) return [(GROUP_FACES_WIDTH - w) / 2];
  const step = (GROUP_FACES_WIDTH - w) / (n - 1);
  return Array.from({ length: n }, (_, i) => i * step);
}

/** 读屏念的那一句（#1356 A1）：名字 + 小字 + 第二行 + 时间。看得见的人每一行都读得到这几样；
    读屏只念名字的话，听不出谁刚说过话，两个没起名、成员又相同的群也分不开 */
export function rosterRowLabel(item: RosterItem, now: number): string {
  const time = item.timeTs === null ? "" : rosterTimeLabel(item.timeTs, now);
  return [item.name, item.sub, item.line2 ?? "", time].filter((p) => p !== "").join("，");
}
