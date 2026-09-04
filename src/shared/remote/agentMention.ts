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

/** @ 前面必须是行首或空白 —— 否则 "rick@运营" 这种邮箱地址会被当成点名 */
function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  return /\s/.test(text[at - 1]!);
}

/**
 * 按出现顺序返回被点名的 agentId,去重。
 * 名字长的先试(最长匹配):名单里同时有「运营」和「运营助理」时,
 * "@运营助理" 该认成后者,而不是前者加两个多余的字。
 */
export function parseMentions(text: string, names: readonly MentionCandidate[]): string[] {
  const byLength = [...names].sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isBoundary(text, i)) continue;
    for (const c of byLength) {
      if (!text.startsWith(c.name, i + 1)) continue;
      if (!seen.has(c.agentId)) {
        seen.add(c.agentId);
        out.push(c.agentId);
      }
      i += c.name.length; // 跳过已匹配的部分,别在名字内部再找 @
      break;
    }
  }
  return out;
}
