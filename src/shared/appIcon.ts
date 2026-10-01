// appIcon —— 应用 / 连接器图标的两条判据，桌面与手机共用（#1437）：这个标怎么上色、这一行该画哪个标。
// 图标只认打进包的本地资源键（CatalogEntry.icon），**永远不接远程 URL**（理由见 McpEntryIcon 头注）。
import { MCP_CATALOG } from "./mcpCatalog.js";

// 分野的理由写在 renderer/src/lib/mcpDirectory.ts 的 iconPaint 注释里：品牌色本身没有信息量的
// （纯黑 / 近黑 / 太亮，或本来就是功能图标）只取形状、颜色跟主题前景色走。png 不许进这张表
// （tests/renderer/mcpIcons.test.ts 钉着）。
const MONO_ICONS = new Set([
  "github",
  "notion",
  "linear",
  "square",
  "miro",
  "sentry",
  "filesystem",
  "fetch",
  // 下面这批是 #725 扩表时按同一条判据挑的：品牌色的相对亮度低于 0.06
  // （深色卡上没影）或高于 0.6（浅色卡上没影）就交给 mask，让它跟主题
  // 前景色走。Supabase 的绿是 0.55，落在带里，所以照旧保原色
  "vercel",
  "posthog",
  "resend",
  "sanity",
  "retool",
  "calcom",
  "replicate",
  "alchemy",
  "prisma",
  "paypal",
  "amplitude",
  "huggingface",
  "aws",
]);

export type IconPaint = "mono" | "color";

export function iconPaint(icon: string): IconPaint {
  return MONO_ICONS.has(icon) ? "mono" : "color";
}

/** 目录条目的图标键；目录里没有这一条、或它没配图标 → null（画首字母） */
export function catalogIcon(catalogId: string): string | null {
  return MCP_CATALOG.find((e) => e.id === catalogId)?.icon ?? null;
}

/** 电脑上接的那一行：手上只有 serverId 与显示名。桌面从目录装的 server 用目录 id 当 serverId，
    所以先按 id 认、再按名字认（不分大小写）；都对不上就是自己配的 server，画首字母，不猜 */
export function serverIcon(serverId: string, label: string): string | null {
  const name = label.trim().toLowerCase();
  const hit =
    MCP_CATALOG.find((e) => e.id === serverId) ??
    (name === "" ? undefined : MCP_CATALOG.find((e) => e.name.toLowerCase() === name));
  return hit?.icon ?? null;
}
