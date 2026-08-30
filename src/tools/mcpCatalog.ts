// mcp_catalog —— agent 查"这台 server 该怎么配"。
// 精选层只读一份仓内常量；精选没命中时经 world.http.getJson 只读查一次公开
// 注册表（GET，无副作用）。两条路都没有副作用，免审批不变（ADR-0171 4.6）。

import type { Tool } from "./tool.js";
import { searchCatalog, type CatalogEntry } from "../shared/mcpCatalog.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import { mapRegistryResponse, registrySearchUrl } from "../shared/mcpRegistry.js";

/** 一条目录 → 说给水獭听的那段话。
    导出只为了测：目录里此刻一条 blocked 都没有（#766），而"接不上的要跟水獭
    说一声"这条行为仍然要钉住——拿合成条目测它，比等下一台坏 server 出现再说好 */
export function render(e: CatalogEntry): string {
  const lines = [
    `## ${e.name}（建议 id: ${e.id}）`,
    e.description,
    `传输方式：${e.transport}`,
  ];
  if (e.url !== undefined) lines.push(`URL 模板：${e.url}`);
  if (e.command !== undefined) lines.push(`命令：${e.command} ${(e.args ?? []).join(" ")}`);
  lines.push(
    e.params.length === 0
      ? "需要用户提供的参数：无"
      : `需要用户提供的参数：\n${e.params
          .map((p) => `  - ${p.name}${p.required ? "（必填）" : "（可选）"}：${p.description}`)
          .join("\n")}`
  );
  lines.push(`认证：${e.auth} —— ${e.authNote}`);
  // 已知接不上的那几条要在这里也说一次。这句话原来混在 authNote 里，#760 把
  // 它拆成独立字段之后，不补这一行就等于**只有界面知道、agent 不知道**——
  // 水獭会照样 mcp_configure 落盘再 mcp_authorize，撞同一堵墙，还白留一台
  // 永远连不上的 server 在用户的 mcp.json 里
  if (e.blocked !== undefined) {
    lines.push(`现在接不上：${e.blocked}。别装这台，把这句原因直接告诉用户。`);
  }
  return lines.join("\n");
}

/** 查公开注册表。任何失败都吞成空数组——这是一条回退路径，它自己失败不该
    让整个工具调用失败；调用方拿到空数组会退到 web_search 那句话，链条不断。
    world.http.getJson 是可选字段（见 executionWorld.ts 的注释），缺席 =
    这个世界不提供 GET，同样退回 web_search */
async function searchRegistry(world: ExecutionWorld, query: string): Promise<CatalogEntry[]> {
  if (world.http.getJson === undefined) return [];
  try {
    return mapRegistryResponse(await world.http.getJson(registrySearchUrl(query)));
  } catch {
    return [];
  }
}

export const mcpCatalogTool: Tool = {
  def: {
    name: "mcp_catalog",
    description:
      "查常见 MCP server 的配置方法（URL / 命令 / 需要用户提供的参数 / 认证方式），" +
      "并由此进入「给自己接一台新 server」的入口：查到之后调 mcp_configure 落盘，" +
      "http 传输的再调 mcp_authorize 授权。" +
      "用户说要接某个外部服务（supabase / github / notion / linear / sentry / stripe / " +
      "postgres / slack / canva / playwright / 文件系统 filesystem 之类）、" +
      "或者你发现手上没有能干这件事的工具时，先查这里；查不到再用 web_search。" +
      "留空 query 可以列出全部已知的 server。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "服务名，例如 supabase / github；留空列出全部" },
      },
      required: [],
    },
  },
  // 三把刀里唯一一把 direct（终审 A Critical）：deferred 的代价是「模型初始
  // 工具表里看不见」，而唯一的补救通道 tool_search 是纯子串打分
  // （toolSearch.ts 里 hay = name + description），搜「supabase」命中不了一把
  // 名字叫 mcp_catalog 的工具——模型会就此判定「我做不了」，前面所有的落盘 /
  // 审批 / 授权 / 热更新都白做。所以这把入口必须在初始工具表里；另外两把留
  // deferred，由这把的返回文案与 mcp_configure 的 description 顺次引出
  // （链条本来就自洽，缺的只是一个 direct 的门）。
  exposure: "direct",
  requiresApproval: false,
  // 纯读常量，无共享状态
  parallelSafe: true,
  async run(args, world) {
    const q = (args as { query?: unknown } | null)?.query;
    const query = typeof q === "string" ? q : "";
    const hits = searchCatalog(query);
    if (hits.length > 0) {
      // 末尾这一句是 deferred 那两把刀的引子：它们不在初始工具表里，模型得先
      // 知道有这么两把才会去调（终审 A Critical——入口 direct 了，链条后半段
      // 也要在文案里点名，不能指望模型凭空想起来）
      return (
        hits.map(render).join("\n\n") +
        "\n\n下一步：调 mcp_configure 把它写进配置（会弹审批卡请用户确认）；" +
        "http 传输的通常还要再调一次 mcp_authorize 授权。"
      );
    }

    // 精选没命中 → 查公开注册表。原来这里直接叫模型去 web_search，而本文件
    // 顶部记着那个取舍的代价：web_search「每次多花几秒、还可能拿到错 URL」，
    // 而「让用户在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户」。
    // 注册表返回的是结构化配置，比从网页里读出来的 URL 准。
    const found = query === "" ? [] : await searchRegistry(world, query);
    if (found.length > 0) {
      return (
        found.slice(0, 8).map(render).join("\n\n") +
        "\n\n以上来自公开注册表（registry.modelcontextprotocol.io），**未经核验**——" +
        "任何人都可以往里投稿，同一个服务名下常有第三方包装的条目。" +
        "装之前把发布者说给用户听，让用户确认这是不是他要的那一台。" +
        "\n下一步：调 mcp_configure 把它写进配置（会弹审批卡请用户确认）；" +
        "http 传输的通常还要再调一次 mcp_authorize 授权。"
      );
    }

    return (
      `目录和公开注册表里都没有「${query}」。用 web_search 查一下它的 MCP server 地址` +
      `（关键词：<服务名> MCP server url），拿到之后再调 mcp_configure。`
    );
  },
};
