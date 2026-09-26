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
import { routeTts, type TtsRouteInput } from "./ttsRoute.js";

/** 额度那三个口：桌面是 hostedQuota（结构上就是它），手机是一份订阅快照 + 两个空口 */
export interface TtsQuotaPort {
  ttsInput(): TtsRouteInput["hosted"];
  noteHeaders(h: Headers): void;
  noteExhausted(info: { window?: "5h" | "week"; resetAt?: number }): void;
}

export interface TtsClientDeps {
  quota: TtsQuotaPort;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface TtsClient {
  speak(text: string, voiceId: string): Promise<VoiceSpeakResult>;
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
    async speak(text, voiceId) {
      const token = await deps.accessToken();
      const hosted = deps.quota.ttsInput();
      const route = routeTts({
        ...(hosted === undefined ? {} : { hosted }),
        hostedBaseUrl: `${deps.edgeBaseUrl()}/llm/v1`,
        ...(token ? { hostedToken: token } : {}),
      });
      if (route.kind === "blocked") return { ok: false, message: route.reason };
      let res: Response;
      try {
        res = await doFetch(route.url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: route.model, text, voice_id: voiceId }),
        });
      } catch (err) {
        return { ok: false, message: `连不上订阅网关：${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const e = parseBillingError(res.status, payload);
        if (e?.code === "quota_exhausted") {
          deps.quota.noteExhausted({ ...(e.window ? { window: e.window } : {}), ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}) });
        }
        return { ok: false, message: e?.message ?? `语音合成失败（HTTP ${res.status}）` };
      }
      deps.quota.noteHeaders(res.headers);
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
