// teamVoice —— 团队语音通话的主进程半边（#1163）：替渲染层合成一段语音。
//
// 路是「桌面主进程 → edge 网关 `/llm/v1/speech` → MiniMax」（同 generate_image 那条路，
// ADR-0257）：官方 key 只在 Worker secret 里，客户端一个字节都拿不到；钱走**听的人**
// 自己的订阅额度（自己的 JWT），所以 hold/settle/usage_event 整套现成。渲染层只经
// IPC 拿到字节（硬规则：渲染层只走 ShellBridge），放进 <audio> 播。
//
// 判据全挂在 routeTts 上（modelRoute.ts）：没订阅 / 额度用完 / 网关不供语音 / 拿不到
// JWT —— 这四种一个字节都不发，各自一句人话。额度头与 chat 那条路同一份纪律：成功
// 就 noteHeaders，429 quota_exhausted 就 noteExhausted，界面上那枚环跟着动。

import { BILLING_HEADERS, parseBillingError } from "../shared/billing.js";
import { TTS_HEADERS } from "../shared/tts.js";
import type { VoiceSpeakResult } from "../shared/shellBridge.js";
import type { HostedQuota } from "./hostedQuota.js";
import { routeTts } from "./modelRoute.js";

export interface TeamVoiceDeps {
  quota: Pick<HostedQuota, "ttsInput" | "noteHeaders" | "noteExhausted">;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface TeamVoice {
  speak(text: string, voiceId: string): Promise<VoiceSpeakResult>;
}

const numberHeader = (h: Headers, name: string): number | null => {
  const raw = h.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function createTeamVoice(deps: TeamVoiceDeps): TeamVoice {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async speak(text, voiceId) {
      const token = await deps.accessToken();
      const route = routeTts({
        hosted: deps.quota.ttsInput(),
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
