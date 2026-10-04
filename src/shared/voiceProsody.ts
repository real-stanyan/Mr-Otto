// voiceProsody —— 智能体说话的活人感那几件纯逻辑（#1515，ADR-0352）。三端共用、零 IO。
//
// 情绪从哪来：模型在段首写一个括注（（笑）（惊）（叹）（气）（怕）（嫌）），通话提示词只给这六个。
// 记号**落日志不落界面**：显示路径各剥一次（stripEmotionTag），出声路径解出来进 voice_setting.emotion。
// 只认段首、只认白名单：词表外的括注（（笑死））是模型说的话，剥它等于改它的话。
//
// 数值来自 ~/Github/ai-podcast 的 data/refs/delivery_recipe.json（32 期真人小宇宙闲聊蒸馏）：
// 高唤起（笑 / 惊 / 气）快一点响一点，低唤起（叹 / 怕）慢一点轻一点；真人停顿中位 0.23s、p90 0.55s。
// pitch 永远 0——移调 = 换共振峰 = 换一个人，这个文件连 pitch 这一格都不回。

export type SpeechEmotion = "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised";

export const SPEECH_EMOTIONS: readonly SpeechEmotion[] = ["happy", "sad", "angry", "fearful", "disgusted", "surprised"];

/** 括注里的字 → MiniMax 的 emotion。维护者定的六个；少给选项比多给准 */
export const EMOTION_TAGS: Readonly<Record<string, SpeechEmotion>> = {
  笑: "happy", 惊: "surprised", 叹: "sad", 气: "angry", 怕: "fearful", 嫌: "disgusted",
};

const LITERAL: Readonly<Record<SpeechEmotion, string>> = {
  happy: "（笑）", surprised: "（惊）", sad: "（叹）", angry: "（气）", fearful: "（怕）", disgusted: "（嫌）",
};

/** 段首：可选空白 + 全角或半角括号里 1–2 个非括号非空白字 + 可选空白 */
const TAG_AT_START = /^\s*[（(]([^()（）\s]{1,2})[）)][ \t]*/;

export function parseEmotionTag(bubble: string): { emotion: SpeechEmotion | null; text: string } {
  const m = TAG_AT_START.exec(bubble);
  if (m === null) return { emotion: null, text: bubble };
  const emotion = EMOTION_TAGS[m[1]!];
  if (emotion === undefined) return { emotion: null, text: bubble };
  return { emotion, text: bubble.slice(m[0].length) };
}

export function stripEmotionTag(bubble: string): string {
  return parseEmotionTag(bubble).text;
}

/** 整条回复：每个段首（开头、或空行之后）各剥一次；段间的空行一个字节不动 */
const TAG_AT_PARAGRAPH = /(^|\n[ \t]*\n)([ \t]*)[（(]([^()（）\s]{1,2})[）)][ \t]*/g;

export function stripEmotionTags(content: string): string {
  return content.replace(TAG_AT_PARAGRAPH, (whole, sep: string, indent: string, word: string) =>
    EMOTION_TAGS[word] === undefined ? whole : `${sep}${indent}`
  );
}

export function emotionTagLiteral(e: SpeechEmotion): string {
  return LITERAL[e];
}

const HIGH_AROUSAL = new Set<SpeechEmotion>(["happy", "surprised", "angry"]);
const LOW_AROUSAL = new Set<SpeechEmotion>(["sad", "fearful"]);

export function prosodyFor(emotion: SpeechEmotion | null): { speed: number; vol: number } {
  if (emotion !== null && HIGH_AROUSAL.has(emotion)) return { speed: 1.12, vol: 1.12 };
  if (emotion !== null && LOW_AROUSAL.has(emotion)) return { speed: 0.88, vol: 0.92 };
  return { speed: 1, vol: 1 };
}

// 归一化（搬 ai-podcast src/tts/normalize.ts）：MiniMax 把小写变体「Ai」念成「A」；四位年份默认念
// 「两千零二十六」，播报口径是逐位。只作用于送去合成的文本，显示不动。
const AI_TOKEN = /(?<![A-Za-z0-9])(?:AI|Ai)(?![A-Za-z0-9])/g;
const YEAR_TOKEN = /(?<!\d)(\d{4})(?!\d)\s*年/g;
const DIGIT_CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

export function normalizeSpoken(text: string): string {
  return text
    .replace(AI_TOKEN, "AI")
    .replace(YEAR_TOKEN, (_m, y: string) => `${Array.from(y, (d) => DIGIT_CN[Number(d)]!).join("")}年`);
}

/** 句间 / 换说话人之间至少隔这么久（毫秒）。真人 p50 / p90；>1s 的停顿真人只占 1%，不设更长的档 */
export const GAP_MS = { sentence: 230, speaker: 460 } as const;
