// ttsUnits（#1163）：语音合成的计费字符数，与 MiniMax 官方口径逐字对齐——
// 「1 个汉字算 2 个字符；英文字母、标点、空格、回车各算 1」。网关拿它算预扣，
// 桌面拿它估一段要花多少，两边一份判据。前两条断言是真机打出来的
// `extra_info.usage_characters`，不是推出来的。
import { describe, expect, it } from "vitest";
import { TTS_HEADERS, TTS_MAX_UNITS, ttsUnits } from "../../src/shared/tts.js";

describe("ttsUnits：汉字 2、其余 1", () => {
  it("真机对账：那句 41、那句 35（extra_info.usage_characters）", () => {
    expect(ttsUnits("你好，我是管理员。这条消息是语音通话的测试。")).toBe(41);
    expect(ttsUnits("流式测试。第一句。第二句稍微长一点点。")).toBe(35);
  });

  it("英文字母 / 空格 / 换行 / emoji 各算 1，空串 0", () => {
    expect(ttsUnits("")).toBe(0);
    expect(ttsUnits("hi there\n")).toBe(9);
    expect(ttsUnits("👍")).toBe(1);
  });

  it("上限是个正整数，且一段正常气泡远小于它；两个头名固定", () => {
    expect(TTS_MAX_UNITS).toBe(2000);
    expect(TTS_HEADERS).toEqual({ audioMs: "x-otto-audio-ms", chars: "x-otto-tts-chars" });
  });
});
