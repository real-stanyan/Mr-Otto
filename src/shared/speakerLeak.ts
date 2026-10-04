// speakerLeak —— 模型续写了别人的发言，从那一行起截掉（#1483，ADR-0347）。
//
// 云会话里别人的话以「[名字]: 内容」投影给模型（deriveMessages 的 chat_message /
// user_message 两条路，agentView.memberSpeech 把同伴的回复也折成这个样子）。模型
// 读多了这种转录，偶尔会在自己答完之后接着「写下去」：先编一行「[Otto产品经理]: …」，
// 再接一段思考，最后把答案重写一遍——全在 content 里（群 64997e68 seq 1132）。
// 提示词管不住这件事（它发生在模型该停而没停的那一刻），所以在落盘前机械地截：
//   · 判据只有一条——**行首是群里真有的某个名字的说话人行**。方括号本身不是罪证
//     （模型自己列的「[参考]:」留着），代码围栏里的也不算（那是交付物里的字）。
//   · 开头是**自己**的名字只剥前缀：那是把投影格式学了回来，不是在替别人说话。
//   · 截掉的尾巴**不丢**：engine 把它放进 assistant_message.trimmed，日志仍然说得清
//     模型那一刻到底吐了什么；投影（模型上下文 / 气泡 / 最后一句 / 语音）只读 content。
//   · 名单为空 = 什么都不做：本机会话没有说话人行这回事，日志形状一个字节不变。
//
// 名字比对走 NFKC + 去空白 + 小写（同 safeSpeakerLabel 判保留名的那把尺子）：模型
// 复述名字时常把「Stan Yan」写成「Stan  Yan」、把半角写成全角。

import type { SessionEvent } from "../session/events.js";

/** 系统旁白的保留名（promptSafe.RESERVED_SPEAKER_LABEL 同一个字面量；不 import 那边
    是因为这里只要名字本身，不要它的 uid 判据）。runtime 自己那几句旁白就叫这个名字，
    模型也会学着写，所以它永远在名单里——speakerNamesOf 自带，runtime 的预览那条路自己加 */
export const SYSTEM_SPEAKER_NAME = "系统";

/** 与 chatBubbles.splitBubbles 同一条围栏判据：围栏里的空行不分段，围栏里的名字也不算说话人 */
const FENCE = /^\s*(```|~~~)/;

/** 一行是不是「[名字]: 内容」的形状。冒号后的空格宽容（投影拼的是 `]: `，模型复述时
    可能吞掉那个空格）；名字里不许再出现方括号或换行——与 parseUserMessageLabel 的
    非贪婪匹配同一个意思，写成字符类是为了一行里出现两组方括号时不会把中间全吃掉 */
const SPEAKER_LINE = /^[^\S\n]*\[([^\[\]\n]{1,80})\]:[ \t]*/u;

/** 投影前缀的解析（同 cloudTimeline.parseUserMessageLabel 的契约：非贪婪匹配第一个 `]: `
    之前的内容当 label）。不 import 那边——它为了画时间线拖着头像 / 计费一串依赖，
    而这里要跑在 engine 里 */
const PREFIX = /^\[(.*?)\]: /;

export function normalizeSpeakerName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export interface SpeakerLeakCut {
  /** 截完剩下的正文（没截就是原文，引用相等） */
  content: string;
  /** 被截掉的那一截（从伪造的说话人行起到结尾，原样）。没截就没有这把键 */
  trimmed?: string;
}

/** 把 `content` 里第一行「[群里某个名字]: 」起的部分截掉。`self` = 这只自己的名字（null = 不认识），
    只用于「开头是自己的前缀」那条剥前缀的例外 */
export function cutSpeakerLeak(content: string, names: ReadonlySet<string>, self: string | null): SpeakerLeakCut {
  if (names.size === 0 || !content.includes("[")) return { content };
  const known = new Set([...names].map(normalizeSpeakerName));
  const me = self === null ? null : normalizeSpeakerName(self);
  const lines = content.split("\n");
  let inFence = false;
  let seenText = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      seenText = true;
      continue;
    }
    if (inFence) continue;
    const m = SPEAKER_LINE.exec(line);
    if (m === null) {
      if (line.trim() !== "") seenText = true;
      continue;
    }
    const who = normalizeSpeakerName(m[1]!);
    if (!known.has(who) && who !== me) {
      seenText = true;
      continue;
    }
    // 第一行非空文字就是自己的前缀：剥掉它，剩下的照常往下查
    if (!seenText && me !== null && who === me) {
      lines[i] = line.slice(m[0].length);
      seenText = true;
      continue;
    }
    const kept = lines.slice(0, i).join("\n").trimEnd();
    return { content: kept, trimmed: lines.slice(i).join("\n") };
  }
  const rebuilt = lines.join("\n");
  return rebuilt === content ? { content } : { content: rebuilt };
}

/** 从日志里认出群里有谁。四个来源，各带半个名字表：
    agent_briefed（自己 + 名单）、chat_message 的 label（同伴的回复、真人闲聊、系统旁白）、
    user_message 正文的「[名字]: 」前缀（点火那个人）。系统旁白的保留名永远在——runtime
    自己那几句旁白就是这个名字，模型也会学着写。`selfAgentId` 在时，自己的名字取它最新
    一条 agent_briefed（改名之后以最新的为准） */
export function speakerNamesOf(
  events: readonly SessionEvent[],
  selfAgentId?: string
): { names: Set<string>; self: string | null } {
  const names = new Set<string>([SYSTEM_SPEAKER_NAME]);
  let self: string | null = null;
  for (const e of events) {
    switch (e.type) {
      case "agent_briefed":
        names.add(e.name);
        for (const r of e.roster) names.add(r.name);
        if (selfAgentId !== undefined && e.agentId === selfAgentId) self = e.name;
        break;
      case "chat_message":
        names.add(e.label);
        break;
      case "user_message": {
        const m = PREFIX.exec(e.content);
        if (m !== null) names.add(m[1]!);
        break;
      }
      default:
        break;
    }
  }
  return { names, self };
}
