// 「这句话点了谁的名」——@ 解析的唯一正文(#928)。
//
// 两端共用一份,纪律同 wire.ts:客户端要它(用户打字时出 chip,看得见自己
// @ 到了谁),服务端也要它(agent 输出的是**文本**,只能服务端按名单匹配)。
// 两处各写一条正则迟早分家 —— SUBAGENT_NAME_RE 那次就是(渲染层挡住了中文,
// 主进程那侧把中文 replace 成 "-",「搜索员」塌成 "---" 照样建出来)。
//
// 不用正则切词:agent 名字允许中文,而中文没有词边界,\b 在这儿是假的。
// 改成「按名单逐个试最长匹配」——名单是现成的,一个工作区几只到几十只,
// O(文本长度 × 名单) 完全够用,且行为可解释。

export interface MentionCandidate {
  agentId: string;
  name: string;
}

/** @ 前面必须是行首、或一个**非构词字符** —— 否则 "rick@运营" 这种邮箱地址会被当成点名。
    判据不是「是空白」而是「不是构词字符」:中文标点后不加空格是中文里最普通的句子形状
    (「你好，@运营 帮我看下」),按空白判会让整句静默变成「没人被点名」——不是少匹配一个
    候选,是整句失效。邮箱那条不受影响:rick@ 的 'k' 属于 \p{L},仍然不算边界 */
function isBoundary(text: string, at: number, lastMatchEnd: number): boolean {
  if (at === 0) return true;
  // 刚匹配完的位置也算边界:"@运营@广告" 里第二个 @ 前面是「营」,按字符判会被拒,
  // 于是静默少派一个人(与上面同一类失败)
  if (at === lastMatchEnd) return true;
  return !/[\p{L}\p{N}_]/u.test(text[at - 1]!);
}

/**
 * 按出现顺序返回被点名的 agentId,去重。
 * 名字长的先试(最长匹配):名单里同时有「运营」和「运营助理」时,
 * "@运营助理" 该认成后者,而不是前者加两个多余的字。
 */
// #935 / #957 F1：全角 ＠（U+FF20 FULLWIDTH COMMERCIAL AT）与半角 @ 同等对待——
// 中文输入法全角标点习惯打出来的就是这个字符，用户以为自己点了名，解析却认不出。
// 两者都是 BMP 内的单个码元，替换不改变字符串长度/下标，切词/边界判据不用跟着改。
function normalizeAtSign(text: string): string {
  return text.replace(/＠/g, "@");
}

export interface MentionSpan {
  /** 命中的候选的 agentId（成员那一族借这一格放 uid，同 MentionCandidate） */
  readonly agentId: string;
  /** 那个 `@` 在**归一化后的正文**里的下标。全角＠替换成半角是等长替换，
      所以这个下标对原文同样成立（normalizeAtSign 的注释里说过） */
  readonly at: number;
}

/**
 * `parseMentions` 的孪生函数，多回一格 **@ 的位置**，且**不去重**（同一个人被
 * @ 两次就是两条 span）。
 *
 * 位置这一格是给「两份名单各解析一遍、撞上了算谁的」用的（#1064）：agent 与
 * 人类成员是两张表，撞名时按 ADR-0252 归 agent 接。光比名字判不出来——
 * `memberShadowedBy` 那条「成员名以 agent 名开头」只覆盖一个方向，反过来
 * （agent「小红助手」+ 成员「小红」，正文 `@小红助手`）成员那一遍照样在同一个
 * `@` 上匹配成功，于是小红被通知了一次她根本没被点到的名。判据换成**同一个 @
 * 的位置**之后两个方向一起对：那个 @ 归谁，就是谁。
 */
export function parseMentionSpans(
  text: string,
  names: readonly MentionCandidate[]
): MentionSpan[] {
  const normalized = normalizeAtSign(text);
  // 防御:DB 层的唯一性约束还没合并,候选里过滤掉空名字,否则 String.startsWith("", i) 恒真
  const filtered = names.filter(c => c.name.length > 0);
  const byLength = [...filtered].sort((a, b) => b.name.length - a.name.length);
  const out: MentionSpan[] = [];
  let lastMatchEnd = 0; // 上次成功匹配结束的位置

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== "@" || !isBoundary(normalized, i, lastMatchEnd)) continue;
    for (const c of byLength) {
      if (!normalized.startsWith(c.name, i + 1)) continue;
      out.push({ agentId: c.agentId, at: i });
      lastMatchEnd = i + 1 + c.name.length; // 记下这次匹配的结束位置
      i = lastMatchEnd - 1; // for 循环下一个 i++ 会把它推到 lastMatchEnd
      break;
    }
  }
  return out;
}

export function parseMentions(text: string, names: readonly MentionCandidate[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of parseMentionSpans(text, names)) {
    if (seen.has(span.agentId)) continue;
    seen.add(span.agentId);
    out.push(span.agentId);
  }
  return out;
}

/**
 * 这句话点了哪几个**人类成员**（回 uid，按出现顺序去重）。
 *
 * 与 `parseMentions` 的关系是「同一次切词的另一半」，不是另一套判据：两族各解析
 * 一遍，**同一个 `@` 上 agent 那遍也命中的，成员这遍作废** —— agent 与成员撞名时
 * 归 agent 接（ADR-0252：成员显示名来自 `profiles.name`，从没过 agent 那套
 * `agentNameConflict` 前缀检查，而选人弹层里那一行已经用「@ 会点到智能体「X」」
 * 把这件事说出口了）。
 *
 * 这一格只用来决定**要不要给他发一条提醒**（#1064），一个 uid 都不会进 `mentions`
 * ——服务端 `resolveTargets` 按 agent id 的集合过滤，人类 uid 放进去只会被静默丢掉。
 */
export function parseMemberMentions(
  text: string,
  agents: readonly MentionCandidate[],
  members: readonly MentionCandidate[]
): string[] {
  const claimed = new Set(parseMentionSpans(text, agents).map((s) => s.at));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of parseMentionSpans(text, members)) {
    if (claimed.has(span.at) || seen.has(span.agentId)) continue;
    seen.add(span.agentId);
    out.push(span.agentId);
  }
  return out;
}

/** @ 后紧跟到空白/行尾的原始 token，**不按名单解析**（#957 F4）：接力 depth 记账
    要看"正文里写了哪个 @token"，不该先等一次 roster resolve 才知道点没点名——
    调用方自己再拿 token 去过 parseMentions/名单二次核验。
    边界判据抄 isBoundary 的口径（"@ 前面必须是行首或非构词字符"，同一份注释里
    说过的邮箱地址那条坑：a@b.c 的 'a' 是 \p{L}，不算边界，因此不产生 token）。
    与 parseMentions 不同的是**切词**：这里贪婪吃到下一个空白为止，天然会把
    "@运营@广告" 整段吞成一个 token（parseMentions 靠"最长匹配恰好吃完名字"
    才能把第二个 @ 认成新的起点，这里没有名字可比对，无从判断在哪断开）——
    起点判据一致，不代表切词结果一致。 */
export function mentionTokens(text: string): string[] {
  const normalized = normalizeAtSign(text);
  const out: string[] = [];
  let lastTokenEnd = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== "@" || !isBoundary(normalized, i, lastTokenEnd)) continue;
    let j = i + 1;
    while (j < normalized.length && !/\s/.test(normalized[j]!)) j++;
    if (j > i + 1) out.push(normalized.slice(i + 1, j));
    lastTokenEnd = j;
    i = j - 1;
  }
  return out;
}
