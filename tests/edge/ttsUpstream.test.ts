// MiniMax t2a_v2 的请求 / 回包纯映射（#1163）。网关只在这一层认识 MiniMax 的形状：
// 客户端发的是 `{model, text, voice_id, speed?}`，上游要的是 voice_setting /
// audio_setting 那套；回包里音频是 **hex**，错误是 **HTTP 200 + base_resp.status_code≠0**
// （真机：.io 站对国内 key 回 200 + 2049 invalid api key）。
import { describe, expect, it } from "vitest";
import { hexToBytes, parseTtsReply, parseTtsRequest, ttsUpstreamBody } from "../../services/edge/src/ttsUpstream.js";

describe("parseTtsRequest", () => {
  it("text / voice_id 必填，speed 缺省 1、越界拒", () => {
    expect(parseTtsRequest({ text: "你好", voice_id: "v" })).toEqual({ ok: true, req: { text: "你好", voiceId: "v", speed: 1 } });
    expect(parseTtsRequest({ voice_id: "v" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "  ", voice_id: "v" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", speed: 3 })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", speed: "1" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", speed: 1.5 })).toMatchObject({ ok: true, req: { speed: 1.5 } });
  });

  it("超过 TTS_MAX_UNITS 拒，且说出字符数——那是客户端没拆段，不是用户的错", () => {
    const r = parseTtsRequest({ text: "汉".repeat(1001), voice_id: "v" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("2002");
  });

  it("voice_id 超过 100 字拒（它会原样进上游请求，不设上限就是把请求体长度交给客户端）", () => {
    expect(parseTtsRequest({ text: "x", voice_id: "v".repeat(101) })).toMatchObject({ ok: false });
  });
});

describe("ttsUpstreamBody：MiniMax t2a_v2 的形状，非流式 mp3 64kbps 单声道", () => {
  it("字段齐全，model 是路由行的 wire_model", () => {
    const b = JSON.parse(ttsUpstreamBody("speech-2.8-turbo", { text: "hi", voiceId: "v", speed: 1.2 }));
    expect(b).toEqual({
      model: "speech-2.8-turbo",
      text: "hi",
      stream: false,
      voice_setting: { voice_id: "v", speed: 1.2, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 64000, format: "mp3", channel: 1 },
    });
  });
});

describe("parseTtsReply", () => {
  it("HTTP 200 + status_code≠0 是失败，带上游的码与话", () => {
    const r = parseTtsReply(JSON.stringify({ base_resp: { status_code: 2049, status_msg: "invalid api key" } }));
    expect(r).toEqual({ ok: false, message: "MiniMax 2049：invalid api key" });
  });

  it("成功：hex → 字节，usage_characters / audio_length 带回", () => {
    const r = parseTtsReply(
      JSON.stringify({
        data: { audio: "fffb", status: 2 },
        extra_info: { usage_characters: 41, audio_length: 5508 },
        base_resp: { status_code: 0, status_msg: "success" },
      })
    );
    expect(r).toEqual({ ok: true, audio: new Uint8Array([0xff, 0xfb]), usageChars: 41, audioMs: 5508 });
  });

  it("extra_info 缺席 / 不是数：两格 null，音频照回（钱按本地估的字符数结算）", () => {
    const r = parseTtsReply(JSON.stringify({ data: { audio: "00" }, base_resp: { status_code: 0 } }));
    expect(r).toEqual({ ok: true, audio: new Uint8Array([0]), usageChars: null, audioMs: null });
  });

  it("不是 JSON / 没有 audio / hex 坏了 → 失败", () => {
    expect(parseTtsReply("not json").ok).toBe(false);
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "" } })).ok).toBe(false);
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "zz" } })).ok).toBe(false);
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 0 } })).ok).toBe(false);
  });

  it("hexToBytes：奇数长度 / 非 hex 回 null，大小写都认", () => {
    expect(hexToBytes("0aFF")).toEqual(new Uint8Array([10, 255]));
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });
});
