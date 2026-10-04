// ttsClient —— 合成一段语音（#1163 桌面主进程那一半；#1356 A4 挪进 shared，手机端用同一份）。
//
// 路是「客户端 → edge 网关 `/llm/v1/speech` → MiniMax」（同 generate_image 那条路，ADR-0257）：
// 官方 key 只在 Worker secret 里，客户端一个字节都拿不到；钱走**听的人**自己的订阅额度（自己的 JWT），
// 所以 hold/settle/usage_event 整套现成。
//
// 判据全挂在 routeTts 上（ttsRoute.ts）：没订阅 / 额度用完 / 网关不供语音 / 拿不到 JWT —— 这四种一个
// 字节都不发，各自一句人话。额度头与 chat 那条路同一份纪律：成功就 noteHeaders，429 quota_exhausted
// 就 noteExhausted——桌面接 hostedQuota（界面上那枚环跟着动），手机没有那份账，两个口接空。

import { BILLING_HEADERS, parseBillingError } from "./billing.js";
import type { VoiceSpeakResult } from "./shellBridge.js";
import { TTS_HEADERS } from "./tts.js";
import { SPEECH_TICKET_HEADER } from "./speechTicket.js";
import { routeTts, type TtsRouteInput } from "./ttsRoute.js";
import { prosodyFor, type SpeechEmotion } from "./voiceProsody.js";

/** 额度那三个口：桌面是 hostedQuota（结构上就是它），手机是一份订阅快照 + 两个空口 */
export interface TtsQuotaPort {
  ttsInput(): TtsRouteInput["hosted"];
  noteHeaders(h: Headers): void;
  noteExhausted(info: { resetAt?: number }): void;
}

export interface TtsClientDeps {
  quota: TtsQuotaPort;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** 一次合成的附加项 */
export interface TtsSpeakOpts {
  /** 外联通话的票（#1441）：好友听主人的智能体说话，钱记主人。runtime 在 welcome / call_result 里签发，
      网关验过才改记主人，验不过去退回记调用者自己。缺席或空串 = 一切照旧 */
  speechTicket?: string;
  /** 这一句的情绪（#1515）：带上时请求体多 emotion / speed / vol；null / 缺席 = 平读，三格请求体同以前 */
  emotion?: SpeechEmotion | null;
}

export interface TtsClient {
  speak(text: string, voiceId: string, opts?: TtsSpeakOpts): Promise<VoiceSpeakResult>;
}

const numberHeader = (h: Headers, name: string): number | null => {
  const raw = h.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function createTtsClient(deps: TtsClientDeps): TtsClient {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async speak(text, voiceId, opts) {
      const token = await deps.accessToken();
      const ticket = opts?.speechTicket !== undefined && opts.speechTicket !== "" ? opts.speechTicket : null;
      // 带票时这笔钱记主人：好友自己有没有订阅、额度还剩多少与这一笔无关，客户端不拿「我没订阅」把它挡掉。
      // 网关验不过票会退回记好友自己，那一侧的 402 / 429 由网关当场说出口。型号清单（ttsModels）是路由表读出来的、
      // 与订阅无关，所以仍从快照取；快照还没查到（undefined）时没有型号可发，照旧不发
      const own = deps.quota.ttsInput();
      const hosted = ticket !== null && own !== undefined ? { ...own, subscribed: true, exhausted: false } : own;
      const route = routeTts({
        ...(hosted === undefined ? {} : { hosted }),
        hostedBaseUrl: `${deps.edgeBaseUrl()}/llm/v1`,
        ...(token ? { hostedToken: token } : {}),
      });
      if (route.kind === "blocked") return { ok: false, message: route.reason };
      const emotion = opts?.emotion ?? null;
      const body = emotion === null
        ? { model: route.model, text, voice_id: voiceId }
        : { model: route.model, text, voice_id: voiceId, emotion, ...prosodyFor(emotion) };
      let res: Response;
      try {
        res = await doFetch(route.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(ticket !== null ? { [SPEECH_TICKET_HEADER]: ticket } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return { ok: false, message: `连不上订阅网关：${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const e = parseBillingError(res.status, payload);
        // 带票时 429 说的是主人的额度，不是「我的额度用完了」：记进去会让好友自己那枚环亮红
        if (e?.code === "quota_exhausted" && ticket === null) {
          deps.quota.noteExhausted(e.resetAt !== undefined ? { resetAt: e.resetAt } : {});
        }
        return { ok: false, message: e?.message ?? `语音合成失败（HTTP ${res.status}）` };
      }
      // 带票时回的额度头是主人那本账的：记进好友自己的快照，他那枚环就跟着别人的用量动
      if (ticket === null) deps.quota.noteHeaders(res.headers);
      const audio = new Uint8Array(await res.arrayBuffer());
      return {
        ok: true,
        audio,
        costMicro: numberHeader(res.headers, BILLING_HEADERS.cost) ?? 0,
        audioMs: numberHeader(res.headers, TTS_HEADERS.audioMs),
      };
    },
  };
}
