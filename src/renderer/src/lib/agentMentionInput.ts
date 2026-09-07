// agentMentionInput —— composer 里「正在打 @」的光标判定与补全写回（#932 切片 1b）。
// **不是**@ 解析：发送时点了谁一律由 src/shared/remote/agentMention.ts 的
// parseMentions 决定（三端共用那一份）。这里只回答"光标此刻是不是停在一个
// 没打完的 @ 后面、打了几个字"，好决定要不要弹选人列表——那是编辑器的事，
// 与"这句话最后点了谁"是两个问题。边界判据抄 parseMentions 的口径（@ 前是
// 行首或非构词字符），不然邮箱地址会弹出选人。

import { mentionTokens, parseMentions, type MentionCandidate } from "../../../shared/remote/agentMention.js";

const WORD = /[\p{L}\p{N}_]/u;

// #935 / #957 C-I4：全角 ＠（U+FF20 FULLWIDTH COMMERCIAL AT）与半角 @ 同等对待——
// 中文输入法全角标点习惯打出来的就是这个字符，用户以为自己点了名，选人层却从来
// 不开、消息悄悄地谁都没提到。边界判据（@ 前必须是行首或非构词字符）原样照抄
// parseMentions 的口径不区分半角/全角（`tests/shared/agentMention.test.ts`
// 的「全角 ＠ 前面是构词字符时仍算越界」那条），这里不额外放宽——两处判据分家
// 会出现「弹出了选人层，但发送时 parseMentions 判定越界不认」的撕裂。
export function mentionQueryAt(text: string, caret: number): { at: number; query: string } | null {
  const head = text.slice(0, caret);
  // 找靠后的那一个：同一句话里全角半角混用时，离光标最近的那个才是"正在打"的那个
  const at = Math.max(head.lastIndexOf("@"), head.lastIndexOf("＠"));
  if (at < 0) return null;
  if (at > 0 && WORD.test(head[at - 1]!)) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null; // 已经打过空格 = 这个 @ 结束了
  return { at, query };
}

// #935 / #957 C-I4：下一个字符已经是空白（用户在句子中间插入 @，后面本来就
// 跟着一个空格或换行）时不再补一个——原来无条件加空格，插在两个词中间就是
// 一句话里冒出双空格。只在真的没有空白（含光标已在行尾）时才补一个，好让
// 用户能紧接着往后打字而不必自己再按一次空格。
export function applyAgentMention(text: string, at: number, caret: number, name: string): { text: string; caret: number } {
  const nextChar = text[caret];
  const needsSpace = nextChar === undefined || !/\s/.test(nextChar);
  const inserted = needsSpace ? `@${name} ` : `@${name}`;
  return { text: text.slice(0, at) + inserted + text.slice(caret), caret: at + inserted.length };
}

// #935 / #957 C-I4：选人弹层的空态判据——纯函数,不碰任何 store/IPC。
// 非 null 只有一种情形:用户确实停在一个 @ 后面(picking 非空)、已经打了至少
// 一个字(query 非空——刚打完 @ 还没打字时不该报"没有叫「」的成员或智能体"，那是
// 在羞辱用户还没做的事)、且这份名单里一个都不匹配。名单变陈旧(改名/新增)
// 是最常见的诱因,所以这里只回答"有没有这个空态"，具体怎么办(弹一行提示+
// 一颗刷新钮)交给调用方。
export function pickerEmptyState(
  picking: { at: number; query: string } | null,
  options: readonly unknown[]
): { query: string } | null {
  if (picking === null) return null;
  if (picking.query.trim() === "") return null;
  if (options.length > 0) return null;
  return { query: picking.query };
}

// ── 发送时那句 @ 到底算点了谁（第四批 C2-I5）────────────────────────────
// 起因：正文里明明写了 @名字，本地名单却一个都解析不出来时，第二批那版按
// 「刷新后名单长度是不是 0」决定发不发数组——而 refreshWorkspaceGroups()
// **失败时保留旧名单不动**（store.ts 只 set workspaceGroupsError），于是最
// 常见的两种形状全落空：① 刷新失败 → 旧名单非空 → 照旧发一个权威的 `[]`，
// 服务端读作「我确认谁都没点」（ADR-0220 决策 2），消息静默变成没人接的闲聊；
// ② 刷新成功但新名单里确实没有这个名字（打错字/那只 agent 删了）→ 同样发
// `[]`，且一个字都不说。
//
// 换成两个**互相独立**的判据：「名单读没读出来」（refreshFailed / freshCandidates
// 缺席）决定要不要把解析权交给云端，「新名单里有没有这个人」决定这句话该不该
// 发出去。两种情形说两句不同的话——前者发得出去只是不确定点到谁（中性提示），
// 后者是用户打错了名字（拦下来，让他改），措辞混成一句就等于没说。
export type SendMentionPlan =
  | { kind: "send"; mentions: string[] | undefined; notice: string | null }
  | { kind: "block"; error: string };

/** 纯函数：不碰 store，也不自己发起刷新——`refreshFailed` 与 `freshCandidates`
    由组件在 `await refreshWorkspaceGroups()` 之后算好递进来。
    `freshCandidates === null` = 这一刻的名单压根没拿到（刷新失败，或刷新成功
    但这个工作区已经不在返回的清单里），与「拿到了、里面没有这个名字」是两回事。
    `mentions: undefined` = 缺席，让服务端拿它自己那份名单解析正文（老语义）；
    `[]` 是权威的「没点任何 agent」。**#1059 之前这个函数在正文写了 @token 时
    永远不返回 `[]`**，现在有且只有一种情形返回它：那几个 @ 全都点在人类成员上
    （见下面 memberCandidates 那段）—— 那时「没点任何 agent」是事实而不是失败，
    服务端照 targets.length === 0 只落一条 chat_message */
export function resolveSendMentions(args: {
  text: string;
  parsed: string[];
  refreshFailed: boolean;
  freshCandidates: MentionCandidate[] | null;
  /** 人类成员按 `{agentId: uid, name: 显示名}` 递进来（#1059）。**只用来判"这个
      @ 认不认得"，不进 `mentions`** —— 服务端 resolveTargets 按 agent id 过滤，
      uid 放进去也会被静默丢掉。缺席（旧调用方/单 agent 会话）= 名单里没有人类，
      行为与改动前逐字相同。
      为什么复用 parseMentions 而不是拿 `mentionTokens` 的结果去比字符串：token 是
      **贪婪吃到空白为止**的（"@张三，帮我看下" 切出来是 "张三，帮我看下"），而
      parseMentions 走的是 startsWith 最长匹配 —— 两套切词判据分家，就会出现
      "弹层里点了这个人、发送时说不认识他" 这种撕裂 */
  memberCandidates?: readonly MentionCandidate[];
}): SendMentionPlan {
  const tokens = mentionTokens(args.text);
  // 压根没写 @ ：`parsed`（必然是 []）原样发，那是真的「谁都没点」
  if (tokens.length === 0) return { kind: "send", mentions: args.parsed, notice: null };
  // 本地名单就解析得出来 —— 与 chip 行显示的是同一份，不用刷新
  if (args.parsed.length > 0) return { kind: "send", mentions: args.parsed, notice: null };
  if (args.refreshFailed || args.freshCandidates === null) {
    // 名单读不出来：本地无从判断这个名字存不存在，拦下来等于把一句可能完全
    // 正常的话卡住。交给云端按名字解析，但要说出口——用户得知道界面上那行
    // chip 为什么没出来，以及这句话点到谁不由这台机器说了算
    return { kind: "send", mentions: undefined, notice: "名单读不出来，这句话的 @ 由云端按名字解析" };
  }
  const fresh = parseMentions(args.text, args.freshCandidates);
  if (fresh.length > 0) return { kind: "send", mentions: fresh, notice: null };
  // 一只 agent 都没点到、但点到了一个**人类成员**（#1059）：这不是打错字，是这个
  // 群里最普通的一句话。`[]` 是权威的「我确认没点任何 agent」，服务端照
  // targets.length === 0 那条分支只落一条 chat_message、不起 turn —— 正是 @ 一个
  // 人今天该发生的事（通知另说，见 ADR-0252）。
  // **排在 fresh 之后**：agent 与成员撞名时（成员的显示名来自 profiles.name，
  // 从来没过 agentNameConflict 那套前缀检查）这一句归 agent 接，与本地名单健康时
  // `parsed` 先命中给出的答案逐字相同 —— 反过来排会让"名单读得出来"与"读不出来"
  // 两条路对同一句话给出不同的接话人
  if (parseMentions(args.text, args.memberCandidates ?? []).length > 0) {
    return { kind: "send", mentions: [], notice: null };
  }
  // 名单是新的、里面确实没有这个人 —— 这是唯一能确定「用户打错了」的情形，
  // 也是唯一该拦的情形。截 20 字：token 贪婪吃到空白为止，"@运营@广告" 会整段
  // 吞成一个 token，不截的话一整段正文会糊在这句提示里
  return { kind: "block", error: `没有叫「${tokens[0]!.slice(0, 20)}」的成员或智能体，检查一下名字` };
}
