// 本机 Ollama：装了就该能直接用 —— 端点、型号、能力全部现问 Ollama 自己。
//
// 三条都跟着 Ollama 的默认走，我们不另立一套：
// ① 端点：Ollama 的自有开关是 OLLAMA_HOST（`ollama serve --help` 写明默认
//    127.0.0.1:11434）。用户改过它就该生效，不该逼他再学一个我们发明的变量。
// ② 型号：`ollama pull` 了什么就有什么，走 OpenAI 兼容的 /v1/models
//    （adapter 也走这一套，两处对同一个服务的看法不会分叉）。
// ③ 能力与上下文：/api/show 直接给 capabilities（tools / vision / thinking）
//    和模型的 context_length。这些以前是我们瞎猜的常量，现在有出处。

// 线上契约（OllamaModelInfo / OllamaProbeResult）住 shared/shellBridge.ts：
// 渲染层和主进程得对同一份形状达成一致，这里只 re-export，不另立一份
import type { OllamaModelInfo, OllamaProbeResult } from "../shared/shellBridge.js";

export type { OllamaModelInfo, OllamaProbeResult };

const DEFAULT_PORT = "11434";

/** OLLAMA_HOST 的值 → 我们能拨号的 baseUrl（含 /v1）。
    Ollama 接受的写法很杂：`127.0.0.1:11434` / `:11434` / `example.com` /
    `http://host:port`，这里全兜住。
    0.0.0.0 与 :: 是**监听**地址不是拨号地址——服务端说"谁都可以连我"，
    客户端照着拨只会连了个寂寞，换成回环 */
export function ollamaHostToBaseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith(":")) s = "127.0.0.1" + s; // 只写了端口
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  const dialable = bare === "0.0.0.0" ? "127.0.0.1" : bare === "::" ? "::1" : bare;
  const host = dialable.includes(":") ? `[${dialable}]` : dialable;
  return `${u.protocol}//${host}:${u.port || DEFAULT_PORT}/v1`;
}

export interface OllamaEnv {
  /** 我们自己的端点覆盖（完整 URL，含 /v1）。给远端 / 反代用 */
  baseUrlOverride?: string | undefined;
  /** Ollama 自己的开关 */
  ollamaHost?: string | undefined;
  /** 目录里的默认端点 */
  defaultBaseUrl: string;
}

/** 要探的端点，按优先级排。
    我们的覆盖 > Ollama 的 OLLAMA_HOST > 默认。
    只有走到"默认"这一档才探两种回环写法：Ollama 默认只监听 IPv4，而 localhost
    在部分机器上先解析到 ::1，Node 的 fetch 不做 happy-eyeballs 回退
    （curl 会自己换一条，所以命令行试得通、应用里却连不上）。
    前两档是用户指名的地址，指名了就别替他改主意。 */
export function resolveOllamaBaseUrls(env: OllamaEnv): string[] {
  if (env.baseUrlOverride) return [env.baseUrlOverride];
  const fromHost = env.ollamaHost ? ollamaHostToBaseUrl(env.ollamaHost) : null;
  if (fromHost) return [fromHost];
  const alt = env.defaultBaseUrl.replace("127.0.0.1", "localhost");
  return alt === env.defaultBaseUrl ? [env.defaultBaseUrl] : [env.defaultBaseUrl, alt];
}

/** /v1 前缀剥掉 = Ollama 的原生 API 根（/api/show 住那儿） */
function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

interface ShowResponse {
  capabilities?: unknown;
  model_info?: Record<string, unknown>;
}

/** /api/show 里上下文窗的键名带架构前缀（llama.context_length / qwen3.context_length…），
    架构名不固定，按后缀认 */
function contextFromShow(info: Record<string, unknown> | undefined): number | null {
  for (const [k, v] of Object.entries(info ?? {})) {
    if (k.endsWith(".context_length") && typeof v === "number" && v > 0) return v;
  }
  return null;
}

export interface ProbeInput extends OllamaEnv {
  /** 远端 Ollama 要鉴权时才有 */
  apiKey?: string | undefined;
  /** 会话日志里的 id 前缀 */
  prefix: string;
  /** 服务端 OLLAMA_CONTEXT_LENGTH（能看到就用来封顶）。
      看不到就用模型自己的窗——宁可用有出处的数，也不塞一个拍脑袋的常量 */
  contextCap?: number | undefined;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/** 兜底能力：/api/show 问不到时的保守假设。
    tools 给 true 是因为"问不到"不等于"不支持"，一刀切成 false 会把整台机器的
    型号全从选单里抹掉——那比偶尔选到一个不会调工具的更糟 */
const FALLBACK: Pick<OllamaModelInfo, "contextLength" | "tools" | "vision" | "thinking"> = {
  contextLength: 4096, // `ollama serve --help`：默认按显存 4k/32k/256k，取最低档
  tools: true,
  vision: false,
  // thinking 与 tools 相反，问不到就当没有：多给一档"思考"只会让请求带上一个
  // 型号不认的 reasoning_effort，而少给一档只是少个开关
  thinking: false,
};

export async function probeOllamaModels(input: ProbeInput): Promise<OllamaProbeResult> {
  const { apiKey, prefix, contextCap, fetchImpl, timeoutMs = 2000 } = input;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
  const errors: string[] = [];

  for (const baseUrl of resolveOllamaBaseUrls(input)) {
    let tags: string[];
    try {
      const res = await fetchImpl(`${baseUrl}/models`, {
        // 没装 Ollama 时连接会立刻被拒；超时兜的是"端口通着但没人应"
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      });
      if (!res.ok) {
        errors.push(`${baseUrl} 返回 ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      tags = (body.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter((id) => id !== "")
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      // 没装/没跑不是故障，是默认状态。带上试过的地址——只说"连不上"而不说连的哪儿，
      // 用户没法判断是服务没开还是端点填错了
      errors.push(`${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // 能力逐个问。并发：本机调用，串行 N 次会让设置页明显卡一下。
    // 单个失败只降级那一个，不牵连整份清单——清单本身已经问到了
    const models = await Promise.all(
      tags.map(async (tag): Promise<OllamaModelInfo> => {
        const base = { id: prefix + tag, tag };
        try {
          const res = await fetchImpl(`${apiRoot(baseUrl)}/api/show`, {
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ model: tag }),
          });
          if (!res.ok) return { ...base, ...FALLBACK };
          const show = (await res.json()) as ShowResponse;
          const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
          const ctx = contextFromShow(show.model_info) ?? FALLBACK.contextLength;
          return {
            ...base,
            contextLength: contextCap ? Math.min(ctx, contextCap) : ctx,
            tools: caps.includes("tools"),
            vision: caps.includes("vision"),
            thinking: caps.includes("thinking"),
          };
        } catch {
          return { ...base, ...FALLBACK };
        }
      })
    );

    return { baseUrl, models, error: "" };
  }

  return { baseUrl: "", models: [], error: errors.join("；") };
}

// ── 主进程侧的注册表 ──────────────────────────────────────────────────
// agent 要按型号决定"发不发图"（supportsVision），而 Ollama 的能力只有探测才知道。
// 探到就记下来，resolveModel 出来的兜底形态再拿它补齐。
// 探不到就用兜底值——注册表是缓存，不是事实来源，缺了只影响精度不影响能跑。

const registry = new Map<string, OllamaModelInfo>();

export function rememberOllamaModels(models: OllamaModelInfo[]): void {
  registry.clear();
  for (const m of models) registry.set(m.tag, m);
}

export function lookupOllamaModel(tag: string): OllamaModelInfo | undefined {
  return registry.get(tag);
}
