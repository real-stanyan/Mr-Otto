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
export function parseMentions(text: string, names: readonly MentionCandidate[]): string[] {
  // 防御:DB 层的唯一性约束还没合并,候选里过滤掉空名字,否则 String.startsWith("", i) 恒真
  const filtered = names.filter(c => c.name.length > 0);
  const byLength = [...filtered].sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  const seen = new Set<string>();
  let lastMatchEnd = 0; // 上次成功匹配结束的位置

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isBoundary(text, i, lastMatchEnd)) continue;
    for (const c of byLength) {
      if (!text.startsWith(c.name, i + 1)) continue;
      if (!seen.has(c.agentId)) {
        seen.add(c.agentId);
        out.push(c.agentId);
      }
      lastMatchEnd = i + 1 + c.name.length; // 记下这次匹配的结束位置
      i = lastMatchEnd - 1; // for 循环下一个 i++ 会把它推到 lastMatchEnd
      break;
    }
  }
  return out;
}
