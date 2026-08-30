// McpEntryIcon —— 服务/连接器的品牌图标，一个组件三档画法（issue #786）。
// 原来是 McpDirectory 里的私有 EntryIcon；分享确认框也要按服务画 logo
// （ShareGrantDialog，#786），抽出来共用。三档：
//   1. mono  —— 纯黑/近黑的标走 mask-image + currentColor，只取形状、颜色跟主题走
//   2. color —— 品牌色本身有信息量的照原样 <img>
//   3. 兜底  —— 没有本地图标就画首字母色块（tint 按 tintKey 定死，同一条目永远同色）
// 分野的理由与坑（mask 地址要引号、block 不能省、png 不许进 MONO）都写在
// lib/mcpDirectory.ts 的 iconPaint 注释与本文件行内。
//
// 图标只认打进包的本地资源键，**永远不接远程 URL**：注册表条目的 icons 由
// 投稿者自由填写，让渲染进程去加载等于每翻一次目录就把用户 IP 报给任意第三方。

import { cn } from "@/lib/utils.js";
import { directoryTint, iconPaint } from "../lib/mcpDirectory.js";

// eager:true 只把**地址**收进来（?url），不是把图标内容打进包里（同 FileTypeIcon）。
// 也收 png：有一批牌子根本不发 SVG 标（详见原注释）；png 不能走 mask 那一档，
// MONO_ICONS 里不许出现 png 键，这条由 tests/renderer/mcpIcons.test.ts 钉住
const ICON_URLS = import.meta.glob<string>("../assets/mcp/*.{svg,png}", {
  eager: true,
  query: "?url",
  import: "default",
});

export function mcpIconUrl(icon: string | undefined): string | undefined {
  if (icon === undefined) return undefined;
  // svg 优先：同名两种格式都在时，矢量那份永远更好
  return ICON_URLS[`../assets/mcp/${icon}.svg`] ?? ICON_URLS[`../assets/mcp/${icon}.png`];
}

export function McpEntryIcon({
  icon,
  label,
  tintKey,
  size = 32,
}: {
  /** 本地资源键（CatalogEntry.icon）。缺席/查不到 → 首字母色块 */
  icon?: string | undefined;
  /** 兜底色块上的那个字取自它；也是色块 tint 的默认依据 */
  label: string;
  /** 色块颜色的哈希键（目录页传 entry.id，保证同一条目永远同色）。缺省用 label */
  tintKey?: string;
  size?: number;
}) {
  const src = mcpIconUrl(icon);
  // 尺寸走 style 而不是 tailwind 的 size-* ——类名要能被静态扫出来，
  // `size-[${n}]` 拼出来的那种在生产构建里根本不会生成
  const box = { width: size, height: size };
  if (src !== undefined && icon !== undefined) {
    // 透明底，标直接坐在卡片上。纯黑/近黑的标走 mask，只取形状、颜色跟主题
    // 前景色走；有品牌色的照原样画（分野的理由写在 lib/mcpDirectory.ts）
    if (iconPaint(icon) === "mono") {
      // mask-image 取的是这张 SVG 的 alpha（填充与描边的覆盖区），颜色一概不看。
      // 两个 mask-* 前缀都写：Safari 到今天仍然只认带 -webkit- 的那一支。
      //
      // 地址**必须加引号**：小于 4 KB 的 SVG 被 vite 内联成 data: 原文，
      // 裸写进 url() 会被 CSS 解析器整条丢掉——症状是一格实心方块且不报错
      return (
        <span
          aria-hidden
          data-testid="mcp-icon-mono"
          // block 不能省：宽高对 inline 元素不生效（#747，症状是"只有纯黑的
          // 那批标不见"且不报错）。让组件自足，别指望父级恰好是 flex
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
    return (
      <img
        src={src}
        // 图标是名字的复述，名字就在旁边——给它 alt 只会让读屏器念两遍
        alt=""
        draggable={false}
        style={box}
        className="shrink-0 select-none object-contain"
      />
    );
  }
  // 没有本地图标就画首字母色块。颜色由 tintKey 定死，色块才有"认出来"的价值
  return (
    <span
      aria-hidden
      // 字号/圆角跟着盒子缩：16px 的行内小图标塞 13px 字 + 8px 圆角就成了顶满的药丸
      //（目录卡 32/40 那档维持原来的 13px / 8px 不变）
      style={{
        ...box,
        fontSize: size < 24 ? Math.max(8, Math.round(size * 0.55)) : 13,
        borderRadius: size < 24 ? 4 : 8,
      }}
      className={cn(
        "grid shrink-0 place-items-center font-semibold",
        directoryTint(tintKey ?? label)
      )}
    >
      {label.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
