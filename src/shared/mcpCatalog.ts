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
  /** 可选：打进包的本地图标资源键（不是 URL）。渲染进程用它查
      src/renderer/src/assets/mcp/ 下的 SVG；缺席就画首字母色块。
      **刻意不接受远程 URL**：注册表条目的 icons 由投稿者自由填写，让渲染进程
      去加载等于每翻一次目录就把用户 IP 交给一批陌生服务器。长尾层一律色块 */
  icon?: string;
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
    icon: "supabase",
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
    icon: "github",
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
    icon: "linear",
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
    icon: "playwright",
  },
  {
    id: "figma",
    name: "Figma",
    description: "读设计文件和 Dev Mode 标注，创建/修改 Figma 与 FigJam 里的内容",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里同意 Figma 的授权请求",
    icon: "figma",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "读写 Jira issue，搜 Confluence 页面内容",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，登录 Atlassian 账号并选择站点",
    icon: "atlassian",
  },
  {
    id: "asana",
    name: "Asana",
    description: "查任务和项目状态，建任务、加评论",
    transport: "http",
    url: "https://mcp.asana.com/v2/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "canva",
    name: "Canva",
    description: "创建/修改设计、传素材、导出文件",
    transport: "http",
    url: "https://mcp.canva.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "管理 Cloudflare 账号下的 DNS / Workers / R2 等资源（覆盖整个 API）",
    transport: "http",
    url: "https://mcp.cloudflare.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择要开放的账号",
  },
  {
    id: "neon",
    name: "Neon",
    description: "管理 Postgres 项目与分支，建表、跑 SQL（Neon 托管）",
    transport: "http",
    url: "https://mcp.neon.tech/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "neon",
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "搜对话、联系人和帮助中心文章（仅限美区托管的 Intercom）",
    transport: "http",
    url: "https://mcp.intercom.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "miro",
    name: "Miro",
    description: "搜索并总结白板内容，画图形、回评论",
    transport: "http",
    url: "https://mcp.miro.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择白板所在的团队",
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "部署站点、管环境变量、看构建与部署日志",
    transport: "http",
    url: "https://netlify-mcp.netlify.app/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "netlify",
  },
  {
    id: "git",
    name: "Git",
    description: "本地仓库操作：看 diff、查提交历史、管理分支（Mr Otto 自带 bash，一般用不上）",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "{repo_path}"],
    params: [{ name: "repo_path", description: "本地 git 仓库的绝对路径", required: true }],
    auth: "none",
    authNote: "不需要授权；跑在 uvx 上，本机没装 uv 的话先装好",
    icon: "git",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "抓取网页转成干净文本，供模型阅读（Mr Otto 自带 web_extract，一般用不上）",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    params: [],
    auth: "none",
    authNote: "不需要授权；跑在 uvx 上，本机没装 uv 的话先装好",
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
