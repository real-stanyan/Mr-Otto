// 厂商标记 —— 模型下拉框和「模型配置」页共用的那枚小方块。
//
// 图形说明：这些是**按各家 logo 的形状特征重画的简化字形**，不是官方商标素材
// （官方素材要么带授权条款，要么是外链资源——外链在 Electron 里等于开一个网络洞）。
// 用途只是"一眼把十几家分开"，所以只保留每家最可辨认的一个形状特征：
// Gemini 的四角星、xAI 的 X、Kimi 的月牙、Mistral 的方块旗……剩下的一律不画。
//
// 样式沿用 Apple 设置页的做法：品牌色实底圆角方块 + 白色字形。实底而非淡色底是
// 因为这枚方块要在 13 行长列表里当扫读锚点，淡色底在深色主题下几乎糊成一片。

import type { ReactNode } from "react";

import type { ProviderId } from "../../../shared/providerCatalog.js";
import { findProvider } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";

/** 24×24 viewBox 的字形。stroke 系用 currentColor，跟着方块的白字走 */
const GLYPHS: Record<ProviderId, ReactNode> = {
  // 六边环 —— OpenAI 那枚绳结的外轮廓
  openai: (
    <>
      <path
        d="M12 2.8 20.2 7.4v9.2L12 21.2 3.8 16.6V7.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M12 8.4 15.6 10.4v3.2L12 15.6 8.4 13.6v-3.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  // 无横杠的 A —— Anthropic 的字标特征
  anthropic: (
    <path d="M13.15 3.6h-2.3L4.3 20.4h3.45l1.4-3.75h5.7l1.4 3.75h3.45L13.15 3.6zm-2.9 9.9L12 8.75l1.75 4.75h-3.5z" />
  ),
  // 四角星 —— Gemini 的 sparkle
  google: (
    <path d="M12 1.9c.95 5.2 4 8.25 9.2 9.2-5.2.95-8.25 4-9.2 9.2-.95-5.2-4-8.25-9.2-9.2C8 10.15 11.05 7.1 12 1.9z" />
  ),
  // 鲸 —— DeepSeek 的鲸鱼剪影，只留背脊、头和一只眼
  deepseek: (
    <>
      <path d="M2.2 12.1c2.7.15 4.85-.85 6.45-3 1.3-1.75 3.2-2.6 5.7-2.6 3.9 0 6.75 2.4 7.6 6.05.12.5-.34.94-.83.8l-2.5-.72c-1.1 2.9-3.65 4.5-7.05 4.5-4.2 0-7.6-2-9.6-4.5-.25-.3-.1-.55.23-.53z" />
      <circle cx="15.1" cy="11.1" r="1.05" fill="var(--mark-bg)" />
    </>
  ),
  // Z —— 智谱
  glm: <path d="M6.4 3.8h11.2v2.5L10 17.7h7.6v2.5H6.4v-2.5L14 6.3H6.4z" />,
  // 月牙 —— 月之暗面
  moonshot: <path d="M20.6 15.1A8.6 8.6 0 0 1 8.9 3.4 8.6 8.6 0 1 0 20.6 15.1z" />,
  // Q —— 通义千问
  qwen: (
    <>
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M14.9 15.2 20.3 20.6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  // X
  xai: <path d="M3.4 3.4h4.3L20.6 20.6h-4.3zM20.6 3.4h-4.3L3.4 20.6h4.3z" />,
  // 双峰 M —— MiniMax
  minimax: (
    <path
      d="M2.6 18.4V6.4l4.6 5.9 4.6-5.9v12M12.2 18.4V6.4l4.6 5.9 4.6-5.9v12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  ),
  // 方块阶梯旗 —— Mistral
  mistral: (
    <>
      <rect x="3" y="3.6" width="4.2" height="4.2" />
      <rect x="16.8" y="3.6" width="4.2" height="4.2" />
      <rect x="3" y="9.9" width="18" height="4.2" />
      <rect x="3" y="16.2" width="4.2" height="4.2" />
      <rect x="9.9" y="16.2" width="4.2" height="4.2" />
      <rect x="16.8" y="16.2" width="4.2" height="4.2" />
    </>
  ),
  // G —— Groq
  groq: (
    <path
      d="M12 4a8 8 0 1 0 8 8h-7.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  ),
  // 分流 —— OpenRouter 的"一进多出"
  openrouter: (
    <>
      <path
        d="M2.6 12h4.6l4-4.6h8.2M7.2 12l4 4.6h8.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="19.8" cy="7.4" r="2.1" />
      <circle cx="19.8" cy="16.6" r="2.1" />
    </>
  ),
  // 双层水流 —— 硅基流动
  siliconflow: (
    <path
      d="M3.4 8.6 12 12.8l8.6-4.2M3.4 14.6 12 18.8l8.6-4.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

/** sizeCls 决定方块边长（默认 20px）；字形恒占方块的 68%，缩放时比例不跑 */
export function ProviderMark({
  provider,
  className,
  title,
}: {
  provider: ProviderId;
  className?: string;
  title?: string;
}) {
  const info = findProvider(provider);
  const accent = info?.accent ?? "var(--muted-foreground)";
  return (
    <span
      aria-hidden
      title={title ?? info?.name}
      // --mark-bg 给字形里需要"挖空"的地方用（鲸鱼的眼睛）：挖空色 = 底色本身
      style={{ background: accent, ["--mark-bg" as string]: accent }}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] text-white",
        className
      )}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[68%]">
        {GLYPHS[provider]}
      </svg>
    </span>
  );
}
