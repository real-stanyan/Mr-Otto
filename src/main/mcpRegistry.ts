// 唯一打 registry.modelcontextprotocol.io 的地方。
//
// 不落盘、不做全量同步、不做过期刷新：全量拉的成本已经验掉了（循环翻页
// limit=100 跑两分钟没到底），而它换来的「离线可浏览」对一个装上也要联网才能
// 用的东西没价值。搜索走 live query，debounce 在渲染进程侧做。
//
// 映射逻辑不在这儿——在 src/shared/mcpRegistry.ts，因为 mcp_catalog 工具走
// world.http 那条路，两边共用同一份折叠规则。

import { mapRegistryResponse, registrySearchUrl } from "../shared/mcpRegistry.js";
import type { CatalogEntry } from "../shared/mcpCatalog.js";

const TIMEOUT_MS = 15_000;

export async function searchMcpRegistry(
  query: string,
  signal?: AbortSignal
): Promise<CatalogEntry[]> {
  const q = query.trim();
  // 空查询不打网：注册表按字母序返回，首屏拿到的是一堆无关条目，
  // 而目录页的空查询状态本来就该显示仓内精选层
  if (q === "") return [];
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(registrySearchUrl(q), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: merged,
  });
  if (!res.ok) throw new Error(`注册表返回 HTTP ${res.status}`);
  return mapRegistryResponse(await res.json());
}
