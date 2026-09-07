// 云会话 @ 选人弹层的一行 = 一个可以被点名的对象（#1059）。
//
// 在这个文件之前，那份名单只有 ws.agents —— 而云会话是**群聊**：房里既有智能体
// 也有人类成员，人类成员发的话、头像、署名时间线上一直都画着（#971），唯独 @ 的
// 时候他们不存在。维护者给的参考版式（assistant-ui 的 composer-mentions）左边一枚
// 头像、右边标这一条是人还是 agent，两族并排在同一张列表里。
//
// 单独一个文件的理由与 friendMentionItems 那条一样：这里有两条判定，都不该埋在
// 组件的 useMemo 里 ——
//   ① 一行显示哪几个字段（头像 / 名字 / 中间那格灰字 / 右边的「成员 · 智能体」）
//   ② 输入的那几个字拿去比对哪几个字段
// 两条必须一致：**列表上写着的字，必须搜得出来**。摆出一个字段又不认它，和界面
// 骗人是同一类毛病。
//
// ── @ 一个人类成员今天会发生什么 ────────────────────────────────────────
// 只有一件事：那个名字进正文，房里所有人（含各只 agent 的上下文）都看得见。
// **不起 turn、也没有任何通知**：服务端 resolveTargets 按 agent id 的集合过滤
// mentions（sessionService.ts），人类 uid 放进去会被静默丢掉；客户端因此只把
// agent 那几个 id 填进 mentions（只 @ 人时就是 `[]` —— 那是一句权威的「我确认
// 没点任何 agent」，服务端照 targets.length === 0 那条分支只落一条 chat_message）。
// 所以这一版**服务端零改动**。真正给被 @ 的成员发通知（未读角标 / 推送）是另一件
// 事，今天工作区一条往成员那边推的通道都没有，另开 issue（见 ADR-0252）。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export type MentionKind = "agent" | "member";

/** 右边那格标注。文案跟本仓其余地方对齐：设置页里人类那张表就叫「成员」，
    agent 一律叫「智能体」——同一个东西在两块屏幕上不能有两个名字 */
export const MENTION_KIND_LABEL: Readonly<Record<MentionKind, string>> = {
  agent: "智能体",
  member: "成员",
};

export interface MentionRow {
  /** React key + 高亮下标之外的稳定标识。agent_id 与 uid 是两张表的键，
      两族之间不保证不撞，所以带族名前缀 */
  readonly key: string;
  readonly kind: MentionKind;
  /** 写回正文的那个名字，**也是**列表上显示的那个 —— 必须是同一个字符串：
      显示一个、写回另一个，用户按名字核对时对不上（#831 那条同款纪律） */
  readonly name: string;
  /** agent 才有；成员是 null。发送时 `mentions` 只收非 null 的这一格 */
  readonly agentId: string | null;
  /** 成员才有：profiles.avatar_url，空串 = 没设过（渲染层退回首字母）。
      agent 的脸由 agentAvatarSrc 从 agentId 算，不经这一格 */
  readonly avatarUrl: string;
  /** 中间那格灰字。三种来源，优先级见 buildDetail 的注释 */
  readonly detail: string;
}

/** 一个成员的名字会不会被 parseMentions 抢走（返回抢它的那只 agent 的名字）。
 *
 * parseMentions 的名单里**只有 agent**（服务端那份也是），而成员的显示名来自
 * profiles.name —— 那是一格自由文本，从来没过 validateAgentName/agentNameConflict
 * 那套前缀检查。于是「member 名字 === agent 名字」和「member 名字以某个 agent
 * 名字开头」这两种形状下，正文里的 `@名字` 一律解析成那只 agent：
 *
 *   agent「运营」 + 成员「运营助理」 → "@运营助理" 里 parseMentions 最长匹配吃掉
 *   "运营" 就收工（"运营助理" 不在它的名单里），于是 agent 运营 接了这一棒。
 *
 * 反方向不成立：成员「运」 + agent「运营」时 "@运" 不满足 startsWith("运营")，
 * 没有人被点到，那是正常的「谁都没点」。
 *
 * 这一格存在的意义是**别让列表撒谎**：不标出来的话，用户点了写着「成员」的那一行，
 * 回来接话的却是一只 agent，而界面上没有任何一个字解释过。
 */
export function memberShadowedBy(
  memberName: string,
  agentNames: readonly string[]
): string | null {
  for (const agentName of agentNames) {
    if (agentName.length === 0) continue;
    if (memberName.startsWith(agentName)) return agentName;
  }
  return null;
}

/** 中间那格灰字。优先级：会被抢走 > 重名 > 职责 > 空。
    前两条都是「这一行和你以为的不是一回事」，比「它是干什么的」更该占这格 —— 这格
    会截断，两样都塞进去等于两样都读不到 */
function buildDetail(args: {
  kind: MentionKind;
  name: string;
  id: string;
  description: string;
  shadowedBy: string | null;
  duplicated: boolean;
}): string {
  if (args.shadowedBy !== null) return `@ 会点到智能体「${args.shadowedBy}」`;
  // 同名成员（两个人的 profiles.name 一样）：正文里写出来的是同一串字，谁也分不出
  // 点的是哪一个 —— 反正都不起 turn，功能上确实没差别，但列表上两行一模一样会让人
  // 以为自己看花了眼。补一段 uid 前缀，同 resolveLabel 没名字时的兜底口径
  if (args.duplicated) return args.id.slice(0, 8);
  return args.kind === "agent" ? args.description : "";
}

/**
 * 工作区快照 → 选人列表。
 *
 * **agent 在前、成员在后**，各自保持快照里的顺序（服务端按 created_at 升序给，
 * 名单第一只是这个工作区的管理员）。不是按字母混排：这枚 @ 在这个输入框里的主要
 * 用途是把活派给一只 agent —— 只有那一族真的会接话。排前面意味着默认高亮（下标 0）
 * 落在一只 agent 上，「打完 @ 直接回车」做的是有用的那件事。
 *
 * **自己也在名单里**：@ 自己在群聊里确实没什么用，但把自己摘掉就要维护两份名单
 * ——列表一份、"这个 @ 认不认得"（resolveSendMentions）另一份——而后者必须含自己，
 * 否则用户 @ 了自己的名字会被拦下来说「没有叫 X 的成员或智能体」，而那个 X 就是他
 * 本人。一份名单，一条判据。
 */
export function mentionRows(ws: WorkspaceSnapshot): MentionRow[] {
  const agentNames = ws.agents.map((a) => a.name);
  const nameCount = new Map<string, number>();
  for (const n of [...agentNames, ...ws.members.map((m) => m.label)]) {
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const agents: MentionRow[] = ws.agents.map((a) => ({
    key: `agent:${a.agentId}`,
    kind: "agent" as const,
    name: a.name,
    agentId: a.agentId,
    avatarUrl: "",
    // agent 那一族撞不上名（workspace_agents 有唯一索引，且 agentNameConflict
    // 连前缀都拒），所以它永远走 description 那条；shadowedBy/duplicated 传的是
    // 常量而不是省略参数，好让"为什么 agent 不用判"这件事看得见
    detail: buildDetail({
      kind: "agent",
      name: a.name,
      id: a.agentId,
      description: a.description,
      shadowedBy: null,
      duplicated: false,
    }),
  }));
  const members: MentionRow[] = ws.members.map((m) => ({
    key: `member:${m.uid}`,
    kind: "member" as const,
    name: m.label,
    agentId: null,
    avatarUrl: m.avatarUrl,
    detail: buildDetail({
      kind: "member",
      name: m.label,
      id: m.uid,
      description: "",
      shadowedBy: memberShadowedBy(m.label, agentNames),
      duplicated: (nameCount.get(m.label) ?? 0) > 1,
    }),
  }));
  return [...agents, ...members];
}

/**
 * 按输入的字过滤。名字 **或** 中间那格灰字 **或** 右边那格标注命中即可，大小写不敏感。
 *
 * 标注也算一格：它是行上写着的字，按上面那条纪律就得搜得出来 —— 顺带 `@成员` 能把
 * 人类那一族筛出来，`@智能体` 反之，在一个几十行的工作区里这是最省事的一次筛选。
 *
 * 空串 = 不过滤（刚打完 `@` 那一刻要看到全部候选，而不是一片空白）。
 */
export function filterMentionRows(rows: readonly MentionRow[], query: string): MentionRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      MENTION_KIND_LABEL[r.kind].includes(q)
  );
}
