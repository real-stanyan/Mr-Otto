// ttsClient（#1163；#1356 A4 挪进 shared）：替调用方合成一段语音——拿 JWT 打网关的 /llm/v1/speech，
// 回字节 + 这一笔的 credit，额度头照记进 hostedQuota（同 chat 那条路的 noteHeaders）。
// 判据挂在 routeTts 上：没订阅 / 额度用完 / 网关不供语音一个字节都不发。
import { describe, expect, it, vi } from "vitest";
import { createTtsClient } from "../../src/shared/ttsClient.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";
import { SPEECH_TICKET_HEADER } from "../../src/shared/speechTicket.js";
import { TTS_HEADERS } from "../../src/shared/tts.js";

function make(res: () => Response, over: Partial<{ subscribed: boolean; ttsModels: string[]; token: string | null; noSnapshot: boolean }> = {}) {
  const noted: Headers[] = [];
  const exhausted: unknown[] = [];
  const fetchImpl = vi.fn(async () => res()) as unknown as typeof fetch;
  const voice = createTtsClient({
    quota: {
      ttsInput: () => (over.noSnapshot === true ? undefined : { subscribed: over.subscribed ?? true, exhausted: false, ttsModels: over.ttsModels ?? ["speech-2.8-turbo"] }),
      noteHeaders: (h) => { noted.push(h); },
      noteExhausted: (i) => { exhausted.push(i); },
    },
    edgeBaseUrl: () => "https://edge",
    accessToken: async () => (over.token === undefined ? "jwt" : over.token),
    fetchImpl,
  });
  return { voice, fetchImpl, noted, exhausted };
}

describe("teamVoice.speak", () => {
  it("成功：POST /llm/v1/speech 带 JWT，回字节 + cost + audioMs，记额度头", async () => {
    const { voice, fetchImpl, noted } = make(
      () => new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "content-type": "audio/mpeg", [BILLING_HEADERS.cost]: "1139", [TTS_HEADERS.audioMs]: "5508", [BILLING_HEADERS.week]: "99" },
      })
    );
    const r = await voice.speak("你好", "male-qn-jingying");
    expect(r).toEqual({ ok: true, audio: new Uint8Array([1, 2]), costMicro: 1139, audioMs: 5508 });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://edge/llm/v1/speech");
    expect(init.headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(JSON.parse(String(init.body))).toEqual({ model: "speech-2.8-turbo", text: "你好", voice_id: "male-qn-jingying" });
    expect(noted).toHaveLength(1);
  });

  it("没 cost / audioMs 头：cost 按 0、audioMs 按 null，不炸", async () => {
    const { voice } = make(() => new Response(new Uint8Array([7]), { status: 200 }));
    expect(await voice.speak("x", "v")).toEqual({ ok: true, audio: new Uint8Array([7]), costMicro: 0, audioMs: null });
  });

  it("没订阅：一个字节都不发，blocked 文案说订阅", async () => {
    const { voice, fetchImpl } = make(() => new Response(""), { subscribed: false });
    const r = await voice.speak("x", "v");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("订阅");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("拿不到 JWT：说连不上，不发", async () => {
    const { voice, fetchImpl } = make(() => new Response(""), { token: null });
    const r = await voice.speak("x", "v");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("连不上");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("429 quota_exhausted：记 exhausted，文案原样透出", async () => {
    const { voice, exhausted } = make(
      () => Response.json({ error: { type: "otto_edge", code: "quota_exhausted", message: "本周额度已用完", window: "week", resetAt: 5 } }, { status: 429 })
    );
    expect(await voice.speak("x", "v")).toEqual({ ok: false, message: "本周额度已用完" });
    expect(exhausted).toEqual([{ resetAt: 5 }]);
  });

  it("上游 502 / 非信封错误：带状态码的一句人话", async () => {
    const { voice } = make(() => new Response("boom", { status: 502 }));
    const r = await voice.speak("x", "v");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("502");
  });

  it("连不上：说连不上，不说没订阅", async () => {
    const { voice } = make(() => { throw new Error("ECONNRESET"); });
    const r = await voice.speak("x", "v");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("连不上");
      // 「连不上订阅网关」里的「订阅」是网关的名字，不是「你没订阅」——判据钉在后一句
      expect(r.message).not.toContain("没有订阅");
      expect(r.message).not.toContain("要订阅");
    }
  });

  it("带 emotion（#1515）：请求体多 emotion / speed / vol，数值按 prosodyFor；不带时三格逐字节同以前", async () => {
    const { voice, fetchImpl } = make(() => new Response(new Uint8Array([1]), { status: 200 }));
    await voice.speak("行。", "v", { emotion: "sad" });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ model: "speech-2.8-turbo", text: "行。", voice_id: "v", emotion: "sad", speed: 0.88, vol: 0.92 });
    await voice.speak("行。", "v", { emotion: null });
    const [, init2] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]!;
    expect(JSON.parse(String(init2.body))).toEqual({ model: "speech-2.8-turbo", text: "行。", voice_id: "v" });
  });
});

describe("speak 带票（#1441）", () => {
  const headersOf = (fetchImpl: unknown): Record<string, string> =>
    (fetchImpl as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].headers as Record<string, string>;
  it("带票时请求头有 x-otto-speech-ticket；不带或空串时没有这个头", async () => {
    const a = make(() => new Response(new Uint8Array([1]), { status: 200 }));
    await a.voice.speak("你好", "v", { speechTicket: "T.sig" });
    expect(headersOf(a.fetchImpl)[SPEECH_TICKET_HEADER]).toBe("T.sig");
    const b = make(() => new Response(new Uint8Array([1]), { status: 200 }));
    await b.voice.speak("你好", "v");
    expect(SPEECH_TICKET_HEADER in headersOf(b.fetchImpl)).toBe(false);
    const c = make(() => new Response(new Uint8Array([1]), { status: 200 }));
    await c.voice.speak("你好", "v", { speechTicket: "" });
    expect(SPEECH_TICKET_HEADER in headersOf(c.fetchImpl)).toBe(false);
  });
  it("带票时钱记主人：好友自己没订阅也不被客户端挡（网关验票，验不过去退回记他自己）", async () => {
    const { voice, fetchImpl } = make(() => new Response(new Uint8Array([1]), { status: 200 }), { subscribed: false });
    const r = await voice.speak("你好", "v", { speechTicket: "T.sig" });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("带票时网关的 429 不记进「我的额度用完了」：那是主人的额度", async () => {
    const { voice, exhausted } = make(
      () => Response.json({ error: { type: "otto_edge", code: "quota_exhausted", message: "本周额度已用完", window: "week", resetAt: 5 } }, { status: 429 })
    );
    const r = await voice.speak("你好", "v", { speechTicket: "T.sig" });
    expect(r).toEqual({ ok: false, message: "本周额度已用完" });
    expect(exhausted).toEqual([]);
  });
});

describe("speak 带票但订阅快照还没查到（#1441 的取舍，不是意外）", () => {
  it("没有型号清单可发：照旧 blocked（说订阅那句），一个字节都不发——票绕过的是订阅闸，不是型号来源", async () => {
    const { voice, fetchImpl } = make(() => new Response(new Uint8Array([1]), { status: 200 }), { noSnapshot: true });
    const r = await voice.speak("你好", "v", { speechTicket: "T.sig" });
    expect(r).toEqual({ ok: false, message: "语音通话要订阅 Mr Otto（设置 → 订阅）。" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
