// 厂商标记 —— 模型下拉框和「模型配置」页共用的那枚小方块。
//
// 图形是**各厂官方 logo**，来自 @lobehub/icons（内联 SVG 组件，不走网络：
// Electron 里从 CDN 拉品牌素材等于给渲染进程开一个外链洞）。品牌底色/字色/
// 图占比也一并取自该包的 style 模块，不在这里手抄——抄一次就多一处会过期的真相。
//
// 只深引 `components/Mono|Color` 和 `style`，不引包的 index：index 会带出 Avatar，
// 而 Avatar 的 peer 依赖是 @lobehub/ui + antd，整条 antd 链不该为了 13 枚图标进来。
// 用哪个字形（Mono 还是 Color）跟上游 Avatar.js 的选择保持一致。
//
// 版式沿用 Apple 设置页：圆角方块 + 官方底色。加一圈极淡内描边，
// 因为官方底色里有纯黑(OpenAI/OpenRouter)也有纯白(Gemini/xAI)——
// 没有这圈线，它们会各自在深色/浅色主题里融进背景。

import type { IconType } from "@lobehub/icons/es/types/index.js";

import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono.js";
import * as anthropicStyle from "@lobehub/icons/es/Anthropic/style.js";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono.js";
import * as deepseekStyle from "@lobehub/icons/es/DeepSeek/style.js";
import GeminiMono from "@lobehub/icons/es/Gemini/components/Mono.js";
import * as geminiStyle from "@lobehub/icons/es/Gemini/style.js";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono.js";
import * as groqStyle from "@lobehub/icons/es/Groq/style.js";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono.js";
import * as minimaxStyle from "@lobehub/icons/es/Minimax/style.js";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono.js";
import * as mistralStyle from "@lobehub/icons/es/Mistral/style.js";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono.js";
import * as moonshotStyle from "@lobehub/icons/es/Moonshot/style.js";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono.js";
import * as ollamaStyle from "@lobehub/icons/es/Ollama/style.js";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono.js";
import * as openaiStyle from "@lobehub/icons/es/OpenAI/style.js";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono.js";
import * as openrouterStyle from "@lobehub/icons/es/OpenRouter/style.js";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono.js";
import * as qwenStyle from "@lobehub/icons/es/Qwen/style.js";
import SiliconCloudMono from "@lobehub/icons/es/SiliconCloud/components/Mono.js";
import * as siliconcloudStyle from "@lobehub/icons/es/SiliconCloud/style.js";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono.js";
import * as xaiStyle from "@lobehub/icons/es/XAI/style.js";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono.js";
import * as zhipuStyle from "@lobehub/icons/es/Zhipu/style.js";

import type { ProviderId } from "../../../shared/providerCatalog.js";
import { findProvider } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";

interface BrandStyle {
  AVATAR_BACKGROUND: string;
  AVATAR_COLOR: string;
  AVATAR_ICON_MULTIPLE: number;
}

interface Brand {
  Icon: IconType;
  /** 官方底色。可能是渐变串（MiniMax），所以进 background 而不是 backgroundColor */
  background: string;
  /** 官方字色。Color 版字形自带颜色，这个值对它无效 */
  color: string;
  /** 图形占方块边长的比例（上游 IconAvatar 的 iconMultiple） */
  multiple: number;
}

// 该包没有 "type": "module"，nodenext 下 TS 把 es/*.js 当 CJS，默认导入的类型
// 就退化成整个模块对象；而真正跑代码的是 Vite，它读的是源文件里的 ESM 默认导出。
// 打包器和类型系统对同一个文件的看法不一致，这一层双重断言就是那道缝的补丁，
// 只补在这一处，不为它去改全仓的 esModuleInterop
const asIcon = (mod: unknown): IconType => mod as IconType;

const brand = (Icon: Brand["Icon"], s: BrandStyle): Brand => ({
  Icon,
  background: s.AVATAR_BACKGROUND,
  color: s.AVATAR_COLOR,
  multiple: s.AVATAR_ICON_MULTIPLE,
});

const BRANDS: Record<ProviderId, Brand> = {
  openai: brand(asIcon(OpenAIMono), openaiStyle),
  anthropic: brand(asIcon(AnthropicMono), anthropicStyle),
  // Gemini 用单色字形 + 显式配色，不用上游 Avatar 选的 Color 版：Color 内部靠
  // useId 生成渐变 id，那是这十几枚图标里唯一一处 React hook —— 换掉它，
  // ProviderMark 整条依赖链就一个 hook 都不剩（渲染层崩在 useId 上的那次报错，
  // 唯一可能的来源就是这里）。官方白底配白字形等于看不见，字色改成 Google 蓝
  google: { ...brand(asIcon(GeminiMono), geminiStyle), color: "#4285f4" },
  deepseek: brand(asIcon(DeepSeekMono), deepseekStyle),
  glm: brand(asIcon(ZhipuMono), zhipuStyle),
  moonshot: brand(asIcon(MoonshotMono), moonshotStyle),
  qwen: brand(asIcon(QwenMono), qwenStyle),
  xai: brand(asIcon(XAIMono), xaiStyle),
  minimax: brand(asIcon(MinimaxMono), minimaxStyle),
  mistral: brand(asIcon(MistralMono), mistralStyle),
  groq: brand(asIcon(GroqMono), groqStyle),
  openrouter: brand(asIcon(OpenRouterMono), openrouterStyle),
  siliconflow: brand(asIcon(SiliconCloudMono), siliconcloudStyle),
  ollama: brand(asIcon(OllamaMono), ollamaStyle),
};

/** size = 方块边长（px，默认 20）；图形按各家官方比例居中 */
export function ProviderMark({
  provider,
  size = 20,
  className,
  title,
}: {
  provider: ProviderId;
  size?: number;
  className?: string;
  title?: string;
}) {
  const b = BRANDS[provider];
  const { Icon } = b;
  const glyph = Math.round(size * b.multiple);
  return (
    <span
      aria-hidden
      title={title ?? findProvider(provider)?.name}
      style={{ background: b.background, color: b.color, width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[6px] ring-1 ring-black/10 ring-inset dark:ring-white/[0.14]",
        className
      )}
    >
      {/* 行内 style 而不是只给 size prop：shadcn 的菜单项带着
          `[&_svg:not([class*='size-'])]:size-4` 和 `…:text-muted-foreground`，
          落在这枚 svg 上会把 logo 撑成 16px 的灰块。行内样式压得过类，
          className 里的 text- 字样则让那条颜色规则不匹配 */}
      <Icon
        size={glyph}
        className="text-current"
        style={{ width: glyph, height: glyph }}
      />
    </span>
  );
}
