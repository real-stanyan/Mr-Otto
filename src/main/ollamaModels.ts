// 本机 Ollama 装了哪些型号 —— 现问现答，无缓存。
//
// 为什么不写进目录：用户 `ollama pull` 了什么就有什么，写死几个常见 tag 只会得到
// 一份跟本机对不上的清单。为什么走 OpenAI 兼容的 /models 而不是 /api/tags：
// adapter 也走这一套，两处对同一个服务的看法不该分叉。
//
// 拎出 index.ts 是为了能测：这里面有两处历史上咬过人的判断（回环地址怎么探、
// 失败了说什么），它们值得有断言看着。

/** 型号 id 前缀。日志里存带前缀的 id，发给 API 前剥掉（见 shared/modelCatalog.ts） */
export interface OllamaProbeInput {
  /** 目录里的默认端点（含 /v1） */
  defaultBaseUrl: string;
  /** 用户配的端点覆盖，没配则 undefined */
  overrideBaseUrl?: string | undefined;
  /** 远端 Ollama 要鉴权时才有 */
  apiKey?: string | undefined;
  /** id → 带前缀的 id */
  prefix: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export interface OllamaProbeResult {
  models: string[];
  /** 空串 = 问到了（哪怕清单是空的：那是"一个都没 pull"，不是故障） */
  error: string;
}

/** 要探的端点清单。配了覆盖就只认它——用户指名的地址不该被我们偷偷换掉；
    没配就把两种回环写法都试一遍：Ollama 默认只监听 IPv4，但用户可能把
    OLLAMA_HOST 设成了 :: / 0.0.0.0。Node 的 fetch 不做 happy-eyeballs 回退
    （curl 会，所以命令行试得通、应用里却连不上），这一层轮询只能我们自己来 */
export function probeCandidates(defaultBaseUrl: string, overrideBaseUrl?: string): string[] {
  if (overrideBaseUrl) return [overrideBaseUrl];
  const alt = defaultBaseUrl.replace("127.0.0.1", "localhost");
  return alt === defaultBaseUrl ? [defaultBaseUrl] : [defaultBaseUrl, alt];
}

export async function probeOllamaModels(input: OllamaProbeInput): Promise<OllamaProbeResult> {
  const { defaultBaseUrl, overrideBaseUrl, apiKey, prefix, fetchImpl, timeoutMs = 2000 } = input;
  const errors: string[] = [];

  for (const base of probeCandidates(defaultBaseUrl, overrideBaseUrl)) {
    try {
      const res = await fetchImpl(`${base}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      });
      if (!res.ok) {
        errors.push(`${base} 返回 ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter((id) => id !== "")
        .sort((a, b) => a.localeCompare(b))
        .map((id) => prefix + id);
      return { models, error: "" };
    } catch (e) {
      // 没装/没跑不是故障，是默认状态。带上试过的地址——只说"连不上"而不说连的哪儿，
      // 用户没法判断是服务没开还是端点填错了
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { models: [], error: errors.join("；") };
}
