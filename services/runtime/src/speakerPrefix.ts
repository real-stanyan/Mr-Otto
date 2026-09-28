// speakerPrefix —— 人说的那句话落盘时带的 `[名字]: ` 前缀（say() 拼的）。
//
// 正则**只此一份**（#959 复审 Medium 1 立的规矩）：名字表（sessionService 的
// `learnSpeakerLabel` / `speakerLabelOf`）与派活读的上下文（dispatch.ts，#1405）都要认它，
// 两处各写一遍，改前缀那天会有一处安静地不认。
//
// 「没带前缀」不是理论上的情形：接力开场白（`relayOpeningText`）与拉进通话的招呼
// （`voiceCallGreetingText`）的形状是 `[系统] …`，`]` 后面没有冒号。所以这里要能说出
// 「这条日志到底带没带名字」——取名字的调用方拿到 `null` 再决定退路（uid 前 8 位），
// 喂名字表的调用方拿到 `null` 就不记（把退路记成事实就是记了一个假名字）。

const PREFIX = /^\[([^\]]*)\]: /;

/** 拆成名字与正文；没有前缀、或名字是空串，回 `null` */
export function splitSpeakerPrefix(content: string | undefined): { label: string; body: string } | null {
  if (!content) return null;
  const m = PREFIX.exec(content);
  if (!m || m[1]!.length === 0) return null;
  return { label: m[1]!, body: content.slice(m[0].length) };
}

/** 只要名字（`splitSpeakerPrefix` 的一半） */
export function labelFromPrefix(content: string | undefined): string | null {
  return splitSpeakerPrefix(content)?.label ?? null;
}
