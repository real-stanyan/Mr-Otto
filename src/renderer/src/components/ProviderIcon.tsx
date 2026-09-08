// 型号旁边那枚厂商标。画法照抄 McpEntryIcon 的 mono 那一档（mask-image +
// currentColor）：simple-icons 的标全是单色，只取形状、颜色跟主题走 —— 品牌色
// 摆进一行 11px 的弱色脚注里，会比它旁边的字还响。
//
// 三个已经踩过的坑（原文在 McpEntryIcon.tsx，这里只留结论）：
//   · mask 地址**必须加引号** —— 小于 4 KB 的 SVG 被 vite 内联成 data: 原文，
//     裸写进 url() 会被 CSS 解析器整条丢掉，症状是一格实心方块且不报错
//   · `block` 不能省 —— 宽高对 inline 元素不生效（#747）
//   · 两个 mask-* 前缀都写 —— Safari 至今只认带 -webkit- 的那一支

import { providerMarkOf } from "../lib/providerMark.js";

// eager:true 只把**地址**收进来（?url），不是把图标内容打进包里（同 McpEntryIcon）
const MARK_URLS = import.meta.glob<string>("../assets/providers/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

export function providerMarkUrl(mark: string | null): string | undefined {
  return mark === null ? undefined : MARK_URLS[`../assets/providers/${mark}.svg`];
}

export function ProviderIcon({ model, size = 13 }: { model: string; size?: number }) {
  const { mark, letter } = providerMarkOf(model);
  const src = providerMarkUrl(mark);
  // 尺寸走 style 不走 size-*：`size-[${n}]` 拼出来的类名静态扫不出来，
  // 生产构建里根本不会生成（同 McpEntryIcon）
  const box = { width: size, height: size };
  if (src !== undefined) {
    return (
      <span
        aria-hidden
        data-testid="provider-mark"
        data-mark={mark}
        className="block shrink-0 bg-current"
        style={{
          ...box,
          maskImage: `url("${src}")`,
          WebkitMaskImage: `url("${src}")`,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          maskSize: "contain",
          WebkitMaskSize: "contain",
        }}
      />
    );
  }
  // 这家没有标（或型号认不出）：画首字母方块。底色用 currentColor 兑出来，
  // 跟着所在那行的字色走 —— 它是「没有标」这个事实的样子，不是一个新颜色
  return (
    <span
      aria-hidden
      data-testid="provider-letter"
      className="grid shrink-0 place-items-center rounded-[3.5px] font-semibold"
      style={{
        ...box,
        fontSize: Math.max(8, Math.round(size * 0.62)),
        lineHeight: 1,
        background: "color-mix(in srgb, currentColor 20%, transparent)",
      }}
    >
      {letter}
    </span>
  );
}
