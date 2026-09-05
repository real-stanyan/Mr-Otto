// agentMentionInput —— composer 里「正在打 @」的光标判定与补全写回（#932 切片 1b）。
// **不是**@ 解析：发送时点了谁一律由 src/shared/remote/agentMention.ts 的
// parseMentions 决定（三端共用那一份）。这里只回答"光标此刻是不是停在一个
// 没打完的 @ 后面、打了几个字"，好决定要不要弹选人列表——那是编辑器的事，
// 与"这句话最后点了谁"是两个问题。边界判据抄 parseMentions 的口径（@ 前是
// 行首或非构词字符），不然邮箱地址会弹出选人。

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
// 一个字(query 非空——刚打完 @ 还没打字时不该报"没有叫「」的智能体"，那是
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

export function filterAgentCandidates<T extends { name: string; description: string }>(roster: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  return roster.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
}
