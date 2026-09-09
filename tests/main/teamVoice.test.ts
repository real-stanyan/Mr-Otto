// teamVoice（#1163）：主进程替渲染层合成一段语音——拿 JWT 打网关的 /llm/v1/speech，
// 回字节 + 这一笔的 credit，额度头照记进 hostedQuota（同 chat 那条路的 noteHeaders）。
// 判据挂在 routeTts 上：没订阅 / 额度用完 / 网关不供语音一个字节都不发。
import { describe, expect, it, vi } from "vitest";
import { createTeamVoice } from "../../src/main/teamVoice.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";
import { TTS_HEADERS } from "../../src/shared/tts.js";

function make(res: () => Response, over: Partial<{ subscribed: boolean; ttsModels: string[]; token: string | null }> = {}) {
  const noted: Headers[] = [];
  const exhausted: unknown[] = [];
  const fetchImpl = vi.fn(async () => res()) as unknown as typeof fetch;
  const voice = createTeamVoice({
    quota: {
      ttsInput: () => ({ subscribed: over.subscribed ?? true, exhausted: false, ttsModels: over.ttsModels ?? ["speech-2.8-turbo"] }),
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
        headers: { "content-type": "audio/mpeg", [BILLING_HEADERS.cost]: "1139", [TTS_HEADERS.audioMs]: "5508", [BILLING_HEADERS.h5]: "99" },
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
      () => Response.json({ error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时额度已用完", window: "5h", resetAt: 5 } }, { status: 429 })
    );
    expect(await voice.speak("x", "v")).toEqual({ ok: false, message: "5 小时额度已用完" });
    expect(exhausted).toEqual([{ window: "5h", resetAt: 5 }]);
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
});
