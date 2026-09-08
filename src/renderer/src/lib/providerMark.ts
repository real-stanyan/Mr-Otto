// 型号 → 厂商标（logo）。标是**打进包的本地 SVG**（simple-icons，CC0），
// 永远不接远程地址 —— 同 McpEntryIcon 那条纪律：让渲染进程去加载第三方地址，
// 等于每画一次型号名就把用户 IP 报给那家厂商。

import { describeModel, type ProviderId } from "../../../shared/modelCatalog.js";
import { findProvider } from "../../../shared/providerCatalog.js";

/** 每家表态一次：有本地标就写资源键，没有写 `null`（画首字母方块）。
    **穷举 `Record`** —— 目录里加一家新厂商而不来这里写一笔，tsc 直接红
    （同 `PRIVACY_VERDICTS` 那一族的形状）。

    `null` 不是「以后再补」：simple-icons 里确实没有智谱 / xAI / Groq / 硅基流动
    的标。自己描一个「差不多像」的比画首字母更糟 —— logo 的全部用处是让人一眼
    认出来，认错了比认不出更坏。

    两家共用 `kimi`：`moonshot`（按量）与 `kimicode`（订阅）是两套账号体系
    （ADR-0117），但**同一个牌子同一个标**。 */
export const PROVIDER_MARK: Record<ProviderId, string | null> = {
  openai: "openai",
  anthropic: "claude",
  google: "gemini",
  deepseek: "deepseek",
  glm: null,
  moonshot: "kimi",
  kimicode: "kimi",
  qwen: "qwen",
  xai: null,
  minimax: "minimax",
  mistral: "mistral",
  groq: null,
  openrouter: "openrouter",
  siliconflow: null,
  ollama: "ollama",
};

export interface ProviderMark {
  /** 本地资源键；`null` = 这家没有标，画 `letter` */
  mark: string | null;
  /** 兜底方块上的那个字。取厂商显示名的首字（智谱 GLM → 智），认不出型号时
      退回型号 id 的首字 */
  letter: string;
}

const firstChar = (s: string): string => (Array.from(s.trim())[0] ?? "?").toUpperCase();

/** 这个型号该画哪个标。

    **认不出的型号一律不画标**（`mark: null`），不走 `resolveModel` 的 DeepSeek
    兜底 —— 那条兜底存在的理由是「发得出请求」（OTTER_MODEL 填了目录外的 id 时
    按 DeepSeek 方言走），画到界面上就成了给一个陌生型号安一家厂商。 */
export function providerMarkOf(model: string): ProviderMark {
  const provider = describeModel(model)?.provider;
  if (provider === undefined) return { mark: null, letter: firstChar(model) };
  return { mark: PROVIDER_MARK[provider], letter: firstChar(findProvider(provider)?.name ?? provider) };
}
