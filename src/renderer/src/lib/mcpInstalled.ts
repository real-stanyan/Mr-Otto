// 已装的那几台 → 目录卡的形状（issue #753）。
//
// 为什么要这一层：目录卡吃的是 CatalogEntry，而"已装"这件事的事实来源是
// ~/.mr-otto/mcp.json 里那份配置。两者大部分时候能对上（从目录装的），但有
// 两种情况对不上：用户手填的、从公开注册表装的。那些也得画成卡片——把它们
// 藏起来比画得糙糟糕得多（那台就再也点不到了）。

import type { McpServerConfig, McpServerStatus } from "../../../shared/mcp.js";
import { MCP_CATALOG, type CatalogEntry } from "../../../shared/mcpCatalog.js";
import type { DirectoryItem } from "./mcpDirectory.js";
import { mcpDisplayStatus, type McpDisplayStatus } from "./mcpForm.js";

/** 一台已装的 server 在卡片上的那句描述：它到底连去哪儿。
    地址/命令是这台**此刻**的事实，比目录里那句通用描述更该出现在
    "我装的东西"这一组里——用户在这一组找的是"我配的那台"，不是"这个产品是什么" */
export function installedSummary(cfg: McpServerConfig): string {
  return cfg.kind === "stdio"
    ? [cfg.command, ...cfg.args].join(" ").trim() || "（没填命令）"
    : cfg.url || "（没填地址）";
}

/** 已装的一台 → 目录条目。
    目录里有同名的就用目录那条（有 logo、有人话名字），但**描述换成它自己的
    地址/命令**：这一组回答的是"我装的是哪一台"。目录里没有的现造一条，
    图标缺席 = 首字母色块（长尾层的待遇，ADR-0171 第四节）。 */
export function entryFromInstalled(
  server: { id: string; config: McpServerConfig },
  catalog: readonly CatalogEntry[] = MCP_CATALOG
): CatalogEntry {
  const hit = catalog.find((e) => e.id === server.id);
  const description = installedSummary(server.config);
  if (hit !== undefined) return { ...hit, description };
  return {
    id: server.id,
    name: server.id,
    description,
    transport: server.config.kind === "stdio" ? "stdio" : "http",
    ...(server.config.kind === "stdio"
      ? { command: server.config.command, args: server.config.args }
      : { url: server.config.url }),
    params: [],
    auth: "none",
    authNote: "",
  };
}

/** 已装的那几台，按卡片要的形状排好。
    `verified` 仍然是**来路**的性质：目录里有这条 = 人工核过；手填/注册表来的没有。 */
export function installedItems(
  servers: readonly McpServerStatus[],
  catalog: readonly CatalogEntry[] = MCP_CATALOG
): DirectoryItem[] {
  return servers.map((s) => ({
    entry: entryFromInstalled(s, catalog),
    verified: catalog.some((e) => e.id === s.id),
    installed: mcpDisplayStatus(s.config, s.status),
  }));
}

/** 分成"已接通"和"待接通"两组。
    为什么不合成一组：一张写着「连不上」的卡挂在「已接通」这个标题下面是
    自相矛盾。而把没接通的藏起来更糟——那台就再也点不到了，用户连改配置的
    入口都找不到。两组都在最上面，两句话各自说得准。 */
export function splitInstalled(items: readonly DirectoryItem[]): {
  connected: DirectoryItem[];
  pending: DirectoryItem[];
} {
  const connected: DirectoryItem[] = [];
  const pending: DirectoryItem[] = [];
  for (const item of items) {
    (item.installed === "connected" ? connected : pending).push(item);
  }
  return { connected, pending };
}

/** 这一组也跟着搜索框走：搜 supabase 的时候，已装的那台该留在结果里，
    不能因为"它在上面那一组"就被搜掉。匹配口径跟 searchCatalog 一致 */
export function filterInstalled(items: readonly DirectoryItem[], query: string): DirectoryItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((i) =>
    [i.entry.id, i.entry.name, i.entry.description, i.entry.category ?? ""].some((f) =>
      f.toLowerCase().includes(q)
    )
  );
}

export type { McpDisplayStatus };

/** 连不上时那句错误说给人听。
    SDK 抛的是协议的原话：`MCP error -32000: Connection closed`、`fetch failed`。
    照原样贴在界面上有两个问题：一是它把 "MCP" 这三个字母漏回了产品层
    （ADR-0178），二是它没告诉用户**该去改什么**——"Connection closed" 对着
    一条 `uvx nonexistent-thing` 的配置，真正的意思是"这个包不存在/起不来"。

    只翻认得出的那几类，认不出的**原样保留**：一句看不懂的英文，比一句
    自信的错误翻译有用得多。原文始终留在 title 里（调试时还得靠它）。 */
export function humanizeMcpError(raw: string): string {
  const t = raw.trim();
  // 授权那条路上最常撞的一句。目录里已知的三条走 catalog 的 blocked 字段
  // （那句更具体，还带 issue 号），这里覆盖的是**目录外**的 server——手填的、
  // 注册表来的，撞上同一堵墙时也该拿到一句人话而不是 SDK 的原文（#760）
  if (/does not support dynamic client registration/i.test(t)) {
    return "这台要求事先注册好的 client_id，而 Mr Otto 还没有手填它的地方 —— 暂时接不上（#697）。";
  }
  if (/Incompatible auth server/i.test(t)) {
    return "这台的授权方式 Mr Otto 还不支持。";
  }
  if (/Connection closed/i.test(t)) {
    return "进程没起来，或者起来之后立刻退出了 —— 先确认命令和包名是对的。";
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(t)) {
    return "连不上这个地址 —— 域名解析不了或者网络不通。";
  }
  if (/ECONNREFUSED/i.test(t)) return "对方拒绝了连接 —— 地址或端口可能不对。";
  if (/ENOENT/i.test(t)) return "找不到这个命令 —— 它装在这台机器上了吗？";
  if (/timed? ?out/i.test(t)) return "等太久没回应，超时了。";
  if (/\b40[13]\b|[Uu]nauthorized|[Ff]orbidden/.test(t)) {
    return "对方拒绝了这次请求（没授权或者凭据不对）。";
  }
  return t;
}
