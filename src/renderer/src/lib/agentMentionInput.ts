// agentMentionInput —— composer 里「正在打 @」的光标判定与补全写回（#932 切片 1b）。
// **不是**@ 解析：发送时点了谁一律由 src/shared/remote/agentMention.ts 的
// parseMentions 决定（三端共用那一份）。这里只回答"光标此刻是不是停在一个
// 没打完的 @ 后面、打了几个字"，好决定要不要弹选人列表——那是编辑器的事，
// 与"这句话最后点了谁"是两个问题。边界判据抄 parseMentions 的口径（@ 前是
// 行首或非构词字符），不然邮箱地址会弹出选人。

const WORD = /[\p{L}\p{N}_]/u;

export function mentionQueryAt(text: string, caret: number): { at: number; query: string } | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && WORD.test(head[at - 1]!)) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null; // 已经打过空格 = 这个 @ 结束了
  return { at, query };
}

export function applyAgentMention(text: string, at: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, at) + inserted + text.slice(caret), caret: at + inserted.length };
}

export function filterAgentCandidates<T extends { name: string; description: string }>(roster: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  return roster.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
}
