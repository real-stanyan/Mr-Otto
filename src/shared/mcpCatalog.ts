// 常见 MCP server 的目录 —— 用户说"帮我接上 supabase"时，agent 从这儿
// 知道该填什么（spec §3.5）。
//
// 这份清单会过时，这是明知的取舍：它覆盖绝大多数请求且结果确定，而纯靠
// web_search 每次多花几秒、还可能拿到错 URL——虽然有审批门兜底，但让用户
// 在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户。
// 不在单上的走 web_search，见 tools/mcpCatalog.ts 的兜底话术。

export interface CatalogParam {
  name: string;
  description: string;
  required: boolean;
}

export interface CatalogEntry {
  /** 建议的 server id（用户可改） */
  id: string;
  name: string;
  description: string;
  transport: "http" | "stdio";
  /** http：URL 模板，占位符写成 {param_name} */
  url?: string;
  /** stdio */
  command?: string;
  args?: readonly string[];
  params: readonly CatalogParam[];
  auth: "oauth" | "token" | "none";
  /** 认证方式的一句话说明，直接说给用户听 */
  authNote: string;
}

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: "supabase",
    name: "Supabase",
    description: "查数据库结构、跑只读 SQL、看项目配置与文档",
    transport: "http",
    url: "https://mcp.supabase.com/mcp?project_ref={project_ref}&features=database%2Cdocs",
    params: [
      { name: "project_ref", description: "Supabase 项目的 ref（在项目 URL 里，形如 kpeemypbhkynapkjzewr）", required: true },
    ],
    auth: "oauth",
    authNote: "配好后点一次授权，浏览器里登录 Supabase 并同意即可，不用手动建 token",
  },
  {
    id: "github",
    name: "GitHub",
    description: "读写 issue / PR / 仓库内容",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里同意 GitHub 的授权请求",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "查线上报错、issue 详情与堆栈",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "notion",
    name: "Notion",
    description: "读写 Notion 页面与数据库",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里选择要开放给 Mr Otto 的页面",
  },
  {
    id: "linear",
    name: "Linear",
    description: "查看和创建 Linear 的 issue / 项目",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "查客户、订阅、支付与产品目录",
    transport: "http",
    url: "https://mcp.stripe.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "filesystem",
    name: "本地文件系统",
    description: "把指定目录暴露成 MCP 资源（Mr Otto 自带读写文件工具，一般用不上）",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{root}"],
    params: [{ name: "root", description: "要暴露的目录绝对路径", required: true }],
    auth: "none",
    authNote: "不需要授权",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "用真浏览器点页面、填表单、截图",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要授权；首次运行会下载浏览器内核",
  },
];

/** 查目录。空查询 = 返回全部（agent 想看看有哪些）。
    匹配 id / 名字 / 描述，大小写无关 */
export function searchCatalog(query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...MCP_CATALOG];
  return MCP_CATALOG.filter((e) =>
    [e.id, e.name, e.description].some((f) => f.toLowerCase().includes(q))
  );
}
