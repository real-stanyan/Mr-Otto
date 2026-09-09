// tts —— 语音合成的三端共用纯逻辑（#1163）。
//
// `ttsUnits` 与 MiniMax 官方计费口径逐字对齐（按量计费页：1 个汉字算 2 个字符；
// 英文字母、希腊字母、标点、特殊符号、空格、回车各算 1）。网关拿它算预扣（hold），
// 桌面拿它估一段要花多少——两边一份判据，各写一遍迟早分家。真机对账数据钉在
// tests/shared/tts.test.ts（那两个数是回包里的 `extra_info.usage_characters`）。
//
// 只认 Han 这一族：日文假名 / 韩文官方口径没写，按 1 算——算少了是网关预扣少一点，
// 结算按上游报的真实数走（parseTtsReply 的 usage_characters），钱不会错，
// 只是这一刻的预扣偏小。
const HAN = /\p{Script=Han}/u;

export function ttsUnits(text: string): number {
  let n = 0;
  for (const ch of text) n += HAN.test(ch) ? 2 : 1;
  return n;
}

/** 单次合成的字符上限（≈ 1000 汉字）。一段气泡远小于它；超了是客户端没拆段，
    网关直接 400——非流式接口官方建议 3000 字符以上走流式，这里连一半都不到 */
export const TTS_MAX_UNITS = 2000;

/** `/llm/v1/speech` 成功响应上除额度头之外的两个头：这段音频多长（毫秒，上游的
    `audio_length`）、按多少字符计的费。桌面拿前者排播放队列的预取时机 */
export const TTS_HEADERS = { audioMs: "x-otto-audio-ms", chars: "x-otto-tts-chars" } as const;
