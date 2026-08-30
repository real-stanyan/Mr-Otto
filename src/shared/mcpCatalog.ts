// 常见 MCP server 的目录 —— 用户说"帮我接上 supabase"时，agent 从这儿
// 知道该填什么（spec §3.5）。
//
// 这份清单会过时，这是明知的取舍：它覆盖绝大多数请求且结果确定，而纯靠
// web_search 每次多花几秒、还可能拿到错 URL——虽然有审批门兜底，但让用户
// 在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户。
// 不在单上的走 web_search，见 tools/mcpCatalog.ts 的兜底话术。
//
// 每一条 remote 都是**实测**进来的，不是抄别人的清单（issue #725，ADR-0184）：
// 拿仓里那份 SDK 跑一遍授权前半段（发现元数据 → 动态注册 → 生成授权 URL），
// 走到"浏览器该开了"这一步才算数。抄表会抄错——社区那份把 GitHub 标成
// 支持动态注册，实际它不支持，而我们没有手填 client_id 的路（#697）。

export interface CatalogParam {
  name: string;
  description: string;
  required: boolean;
}

/** 目录页的分组。82 条平铺是一堵墙——分组是让"我要找个建站的"这件事
    在不敲字的情况下也成立。国内平台单独成组而不是按功能拆开：用的人
    是按这条线找的（issue #725 的原话是"国内，国外都要"） */
export type CatalogCategory =
  | "开发与部署"
  | "数据与分析"
  | "设计与内容"
  | "协作与项目"
  | "客户与销售"
  | "支付与财务"
  | "搜索与抓取"
  | "文档与知识"
  | "本机工具"
  | "国内平台";

/** 目录页里分组出现的顺序（不是字母序，也不是条数序：从"改代码"到
    "查资料"，越靠前越常用） */
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [
  "开发与部署",
  "数据与分析",
  "设计与内容",
  "协作与项目",
  "客户与销售",
  "支付与财务",
  "搜索与抓取",
  "文档与知识",
  "国内平台",
  "本机工具",
];

export interface CatalogEntry {
  /** 建议的 server id（用户可改） */
  id: string;
  name: string;
  description: string;
  /** 目录页的分组。**只有精选层有**——长尾来自公开注册表，那边没有这个字段，
      也没人给它归类；长尾本来就平铺，分类对它没有意义。
      精选层漏填会在类型上红（见下面的 CuratedEntry），不会静默掉出分组 */
  category?: CatalogCategory;
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
  /** 可选：**实测**过、此刻接不上，值是给用户看的那句原因。
      为什么要有这个字段：当初那三条（GitHub / Asana / Figma）的结论早就写进
      目录了，但只写进了 authNote，而 authNote 只在未核验条目的确认框里
      露面——于是"我们知道它连不上"这件事一个用户都没看见，界面照发
      「添加」和「授权」，点下去必失败（issue #760）。
      写下来而没说出口等于没写：`installSlot` 读这个字段，把那两颗按钮
      换成一句安静的说明。
      **真连上了以现实为准**——这是我们上次实测的结论，对方随时可能补上
      动态注册，所以 connected 不受它影响。判据与复现法见 #733。

      **此刻没有任何条目用它**（issue #766）：GitHub 改走 token 之后就能连了，
      Asana / Figma 确认没有不经 OAuth 的路，删掉了。机制留着——下一台被发现
      接不上的 server 还要用它，而"发现之后怎么说"这件事已经想清楚了（ADR-0190）。
      加一条 blocked 之前先问一句：是真的没路，还是只试了 OAuth 那一条？ */
  blocked?: string;
  /** 可选：打进包的本地图标资源键（不是 URL）。渲染进程用它查
      src/renderer/src/assets/mcp/ 下的 SVG 或 PNG；缺席就画首字母色块。
      **刻意不接受远程 URL**：注册表条目的 icons 由投稿者自由填写，让渲染进程
      去加载等于每翻一次目录就把用户 IP 交给一批陌生服务器。长尾层一律色块 */
  icon?: string;
  /** 可选：http 传输的请求头模板。键是**真实**请求头名，值是带 {占位符} 的模板
      （`Authorization` → `Bearer {smithery_api_key}`）。
      为什么不能只靠 params 拼：params 里的名字是**占位符**名（它才是问用户时
      该显示的标签），而请求头名和 `Bearer ` 这个前缀合起来才是认证方案本身。
      只留占位符名去落盘，存出来的是 `smithery_api_key: <key>` —— 服务端永远
      401，而用户看到的却是一条指向 OAuth 的授权失败，凭据还躺在 mcp.json 里
      一个毫无意义的键下面。
      精选层大多用不上（它们的凭据要么走 OAuth，要么就在 url 模板里），所以是可选的 */
  headerTemplates?: Readonly<Record<string, string>>;
}

/** 精选层的条目 —— 就是 CatalogEntry 但 category 必填。
    这个类型存在的唯一理由：新加一条目录忘了写分类，要在 tsc 里红，
    而不是在界面上安静地不出现在任何一段里 */
export interface CuratedEntry extends CatalogEntry {
  category: CatalogCategory;
}

export const MCP_CATALOG: readonly CuratedEntry[] = [
  /* ── 开发与部署 ──────────────────────────────────────────────────── */
  {
    id: "github",
    name: "GitHub",
    description: "读写 issue / PR / 仓库内容",
    category: "开发与部署",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    // 走 token 不走 OAuth。#733 记的"接不上"是对的，但那个判据只跑了 OAuth
    // 那条路（动态注册），跑不通就收工，**没试过还有别的门**——实测这台收
    // 任意来源的 bearer token，200 + 44 个工具（issue #766）
    params: [
      {
        name: "github_token",
        description:
          "GitHub 的访问令牌。装了 gh 的话，终端里 `gh auth token` 的输出直接粘过来；" +
          "或者去 Settings → Developer settings 签一个有 repo 权限的 PAT",
        required: true,
      },
    ],
    auth: "token",
    authNote: "填一个 GitHub 令牌，不用走浏览器授权",
    headerTemplates: { Authorization: "Bearer {github_token}" },
    icon: "github",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "查线上报错、issue 详情与堆栈",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "sentry",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "管理 Cloudflare 账号下的 DNS / Workers / R2 等资源（覆盖整个 API）",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.cloudflare.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择要开放的账号",
    icon: "cloudflare",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "部署项目、看构建与运行日志、管环境变量和域名",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.vercel.com/",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里选团队",
    icon: "vercel",
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "部署站点、管环境变量、看构建与部署日志",
    category: "开发与部署",
    transport: "http",
    url: "https://netlify-mcp.netlify.app/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "netlify",
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "读写 issue / 合并请求 / 仓库内容，看流水线",
    category: "开发与部署",
    transport: "http",
    url: "https://gitlab.com/api/v4/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权（gitlab.com 官方托管版）",
    icon: "gitlab",
  },
  {
    id: "buildkite",
    name: "Buildkite",
    description: "看流水线、构建状态与作业日志",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.buildkite.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "buildkite",
  },
  {
    id: "datadog",
    name: "Datadog",
    description: "查指标、日志与告警，看服务依赖和事件",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择站点与组织",
    icon: "datadog",
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "查仪表盘、指标与告警规则",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.grafana.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "grafana",
  },
  {
    id: "semgrep",
    name: "Semgrep",
    description: "扫代码里的安全问题，看规则命中与修法",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.semgrep.ai/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "semgrep",
  },
  {
    id: "workos",
    name: "WorkOS",
    description: "管企业单点登录、目录同步与组织",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.workos.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "workos",
  },
  {
    id: "clerk",
    name: "Clerk",
    description: "管用户、组织与登录配置",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.clerk.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权；要动自己的账号数据时它会在会话里引导你登录",
    icon: "clerk",
  },
  {
    id: "vanta",
    name: "Vanta",
    description: "看合规状态、控制项与证据收集进度",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.vanta.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "vanta",
  },
  {
    id: "retool",
    name: "Retool",
    description: "管内部工具的应用、查询与数据源",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.retool.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "retool",
  },
  {
    id: "replicate",
    name: "Replicate",
    description: "跑开源模型（图像/音频/视频），看运行记录",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.replicate.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "replicate",
  },
  {
    id: "alchemy",
    name: "Alchemy",
    description: "查链上数据：账户、交易、NFT 与代币（多链）",
    category: "开发与部署",
    transport: "http",
    url: "https://mcp.alchemy.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "alchemy",
  },

  /* ── 数据与分析 ──────────────────────────────────────────────────── */
  {
    id: "supabase",
    name: "Supabase",
    description: "查数据库结构、跑只读 SQL、看项目配置与文档",
    category: "数据与分析",
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
    id: "neon",
    name: "Neon",
    description: "管理 Postgres 项目与分支，建表、跑 SQL（Neon 托管）",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.neon.tech/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "neon",
  },
  {
    id: "prisma",
    name: "Prisma",
    description: "管 Prisma Postgres 数据库与分支，跑 SQL",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.prisma.io/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "prisma",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "读写 Airtable 的表格记录、字段与视图",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.airtable.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择要开放的 base",
    icon: "airtable",
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "查产品分析、会话回放与功能开关",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.posthog.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "posthog",
  },
  {
    id: "amplitude",
    name: "Amplitude",
    description: "查产品分析的事件、留存与漏斗",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.amplitude.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "amplitude",
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    description: "查事件分析、留存与用户分群",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.mixpanel.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "mixpanel",
  },

  /* ── 设计与内容 ──────────────────────────────────────────────────── */
  {
    id: "canva",
    name: "Canva",
    description: "创建/修改设计、传素材、导出文件",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.canva.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "canva",
  },
  {
    id: "miro",
    name: "Miro",
    description: "搜索并总结白板内容，画图形、回评论",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.miro.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择白板所在的团队",
    icon: "miro",
  },
  {
    id: "webflow",
    name: "Webflow",
    description: "管站点内容、CMS 集合与发布",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.webflow.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择站点",
    icon: "webflow",
  },
  {
    id: "wix",
    name: "Wix",
    description: "管站点内容、商品与订单",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.wix.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择站点",
    icon: "wix",
  },
  {
    id: "sanity",
    name: "Sanity",
    description: "读写 Sanity 内容库的文档与结构",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.sanity.io/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "sanity",
  },
  {
    id: "contentful",
    name: "Contentful",
    description: "读写 Contentful 的条目、资源与内容模型",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.contentful.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，选择 space",
    icon: "contentful",
  },
  {
    id: "storyblok",
    name: "Storyblok",
    description: "读写 Storyblok 的故事与组件",
    category: "设计与内容",
    transport: "http",
    url: "https://mcp.storyblok.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要在这里授权；要动内容时它会在会话里引导你登录",
    icon: "storyblok",
  },
  {
    id: "cloudinary",
    name: "Cloudinary",
    description: "管媒体资源、转换与投放",
    category: "设计与内容",
    transport: "http",
    url: "https://asset-management.mcp.cloudinary.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "cloudinary",
  },

  /* ── 协作与项目 ──────────────────────────────────────────────────── */
  {
    id: "notion",
    name: "Notion",
    description: "读写 Notion 页面与数据库",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里选择要开放给 Mr Otto 的页面",
    icon: "notion",
  },
  {
    id: "linear",
    name: "Linear",
    description: "查看和创建 Linear 的 issue / 项目",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "linear",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "读写 Jira issue，搜 Confluence 页面内容",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，登录 Atlassian 账号并选择站点",
    icon: "atlassian",
  },
  {
    id: "monday",
    name: "monday.com",
    description: "查看板与任务、建条目、跑自动化",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.monday.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "monday",
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "查任务、文档与空间，建任务、改状态",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.clickup.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "clickup",
  },
  {
    id: "shortcut",
    name: "Shortcut",
    description: "查 story、epic 与迭代，建 story",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.shortcut.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "shortcut",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    description: "搜文件、读内容、建分享链接",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.dropbox.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "dropbox",
  },
  {
    id: "fireflies",
    name: "Fireflies",
    description: "查会议记录、转写与要点",
    category: "协作与项目",
    transport: "http",
    url: "https://api.fireflies.ai/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "fireflies",
  },
  {
    id: "cal",
    name: "Cal.com",
    description: "看日程与预约，建会议链接",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.cal.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "calcom",
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "调你在 Zapier 里配好的动作，间接连上几千个应用",
    category: "协作与项目",
    transport: "http",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里选要开放哪些动作",
    icon: "zapier",
  },

  /* ── 客户与销售 ──────────────────────────────────────────────────── */
  {
    id: "intercom",
    name: "Intercom",
    description: "搜对话、联系人和帮助中心文章（仅限美区托管的 Intercom）",
    category: "客户与销售",
    transport: "http",
    url: "https://mcp.intercom.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "intercom",
  },
  {
    id: "close",
    name: "Close",
    description: "查线索、联系人与商机，记跟进",
    category: "客户与销售",
    transport: "http",
    url: "https://mcp.close.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "close",
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    description: "查用户分群、营销活动与投放指标",
    category: "客户与销售",
    transport: "http",
    url: "https://mcp.klaviyo.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "klaviyo",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "查联系人、公司与交易，写 CRM 记录",
    category: "客户与销售",
    transport: "http",
    url: "https://app.hubspot.com/mcp/v1/http",
    params: [
      { name: "hubspot_token", description: "HubSpot 私有应用的访问令牌（设置 → 集成 → 私有应用里生成）", required: true },
    ],
    auth: "token",
    // HubSpot 的授权服务器不支持动态注册，走不了 OAuth 那条路（#697）；
    // 它同时支持私有应用令牌，所以这条用请求头模板落地
    authNote: "不走浏览器授权：在 HubSpot 里建一个私有应用，把访问令牌填进来",
    icon: "hubspot",
    headerTemplates: { Authorization: "Bearer {hubspot_token}" },
  },
  {
    id: "resend",
    name: "Resend",
    description: "发事务邮件、查投递状态与域名配置",
    category: "客户与销售",
    transport: "http",
    url: "https://mcp.resend.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "resend",
  },

  /* ── 支付与财务 ──────────────────────────────────────────────────── */
  {
    id: "stripe",
    name: "Stripe",
    description: "查客户、订阅、支付与产品目录",
    category: "支付与财务",
    transport: "http",
    url: "https://mcp.stripe.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "stripe",
  },
  {
    id: "square",
    name: "Square",
    description: "查支付与订单、管商品目录与库存、看客户",
    category: "支付与财务",
    transport: "http",
    // /sse 是文档写的那条；这里用 /mcp —— 它回的是带 www-authenticate 与
    // resource_metadata 的 401，即标准的 MCP 受保护资源（streamable-http 那一侧）
    url: "https://mcp.squareup.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，浏览器里登录 Square 并选要授权的权限",
    icon: "square",
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "查订单与交易，开发票、退款",
    category: "支付与财务",
    transport: "http",
    url: "https://mcp.paypal.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "paypal",
  },

  /* ── 搜索与抓取 ──────────────────────────────────────────────────── */
  {
    id: "exa",
    name: "Exa",
    description: "面向 agent 的网页搜索与内容抓取",
    category: "搜索与抓取",
    transport: "http",
    url: "https://mcp.exa.ai/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权即可试用；量大要在 exa.ai 拿 key",
    icon: "exa",
  },
  {
    id: "tavily",
    name: "Tavily",
    description: "网页搜索、抓取与站点地图（面向 agent）",
    category: "搜索与抓取",
    transport: "http",
    url: "https://mcp.tavily.com/mcp/?tavilyApiKey={tavily_api_key}",
    params: [
      { name: "tavily_api_key", description: "Tavily 的 API key（app.tavily.com 里拿）", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：把 Tavily 的 API key 填进来即可",
    icon: "tavily",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "把整站抓成干净的 markdown，供模型阅读",
    category: "搜索与抓取",
    transport: "http",
    url: "https://mcp.firecrawl.dev/{firecrawl_api_key}/v2/mcp",
    params: [
      { name: "firecrawl_api_key", description: "Firecrawl 的 API key（firecrawl.dev 里拿）", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：key 直接拼在地址里",
    icon: "firecrawl",
  },
  {
    id: "brightdata",
    name: "Bright Data",
    description: "抓公开网页与搜索结果，带反爬绕过",
    category: "搜索与抓取",
    transport: "http",
    url: "https://mcp.brightdata.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "brightdata",
  },
  {
    id: "apify",
    name: "Apify",
    description: "跑 Apify 上的爬虫（Actor），拿结构化结果",
    category: "搜索与抓取",
    transport: "http",
    url: "https://mcp.apify.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
    icon: "apify",
  },

  /* ── 文档与知识 ──────────────────────────────────────────────────── */
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    description: "查微软官方文档、示例与 API 参考",
    category: "文档与知识",
    transport: "http",
    url: "https://learn.microsoft.com/api/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "microsoft",
  },
  {
    id: "aws-knowledge",
    name: "AWS 文档",
    description: "查 AWS 官方文档、API 参考与最佳实践",
    category: "文档与知识",
    transport: "http",
    url: "https://knowledge-mcp.global.api.aws",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "aws",
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare 文档",
    description: "查 Cloudflare 官方文档（不碰你的账号）",
    category: "文档与知识",
    transport: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "cloudflare",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "搜模型、数据集与 Space，读文档",
    category: "文档与知识",
    transport: "http",
    url: "https://hf.co/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权即可搜；要动自己的仓库再登录",
    icon: "huggingface",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "读任意 GitHub 仓库的自动生成文档、问它架构问题",
    category: "文档与知识",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "deepwiki",
  },
  {
    id: "context7",
    name: "Context7",
    description: "取任意开源库的最新文档片段（按版本）",
    category: "文档与知识",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "context7",
  },
  {
    id: "astro-docs",
    name: "Astro 文档",
    description: "查 Astro 官方文档",
    category: "文档与知识",
    transport: "http",
    url: "https://mcp.docs.astro.build/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "astro",
  },
  {
    id: "svelte-docs",
    name: "Svelte 文档",
    description: "查 Svelte / SvelteKit 官方文档",
    category: "文档与知识",
    transport: "http",
    url: "https://mcp.svelte.dev/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "svelte",
  },
  {
    id: "wolfram",
    name: "Wolfram",
    description: "算数学、查事实数据与单位换算",
    category: "文档与知识",
    transport: "http",
    url: "https://agenttools.wolfram.com/mcp",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "wolfram",
  },
  {
    id: "shopify-dev",
    name: "Shopify 文档",
    description: "查 Shopify 开发文档与 GraphQL schema（不碰店铺数据）",
    category: "文档与知识",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@shopify/dev-mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要授权；首次运行会从 npm 下载",
    icon: "shopify",
  },

  /* ── 国内平台 ────────────────────────────────────────────────────── */
  {
    id: "amap",
    name: "高德地图",
    description: "地理编码、路径规划、周边搜索与天气",
    category: "国内平台",
    transport: "http",
    url: "https://mcp.amap.com/mcp?key={amap_key}",
    params: [
      { name: "amap_key", description: "高德开放平台的 Web 服务 key（console.amap.com 里建）", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：key 直接拼在地址里",
    icon: "amap",
  },
  {
    id: "baidu-map",
    name: "百度地图",
    description: "地理编码、路径规划、地点检索与天气",
    category: "国内平台",
    transport: "http",
    url: "https://mcp.map.baidu.com/mcp?ak={baidu_map_ak}",
    params: [
      { name: "baidu_map_ak", description: "百度地图开放平台的服务端 ak（lbsyun.baidu.com 里建）", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：ak 直接拼在地址里",
    icon: "baidumap",
  },
  {
    id: "tencent-map",
    name: "腾讯位置服务",
    description: "地理编码、路径规划、地点检索",
    category: "国内平台",
    transport: "http",
    url: "https://mcp.map.qq.com/mcp?key={tencent_map_key}",
    params: [
      { name: "tencent_map_key", description: "腾讯位置服务的 key（lbs.qq.com 控制台里建）", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：key 直接拼在地址里",
    icon: "tencentmap",
  },
  {
    id: "edgeone-pages",
    name: "EdgeOne Pages",
    description: "腾讯云：把生成好的 HTML / 静态站一键部署上线",
    category: "国内平台",
    transport: "http",
    url: "https://mcp-on-edge.edgeone.site/mcp-server",
    params: [],
    auth: "none",
    authNote: "不需要授权",
    icon: "edgeone",
  },
  {
    id: "alipay",
    name: "支付宝",
    description: "创建支付、查交易、退款（支付宝开放平台）",
    category: "国内平台",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@alipay/mcp-server-alipay"],
    // stdio 的参数名**就是环境变量名**（见 lib/mcpDirectory.ts 的 configFromEntry）
    params: [
      { name: "AP_APP_ID", description: "支付宝开放平台的应用 ID", required: true },
      { name: "AP_APP_KEY", description: "应用私钥（PKCS#8，一整串）", required: true },
      { name: "AP_PUB_KEY", description: "支付宝公钥（用来验签回调）", required: true },
      { name: "AP_CURRENT_ENV", description: "环境：prod 正式 / sandbox 沙箱", required: false },
    ],
    auth: "token",
    authNote: "不走浏览器授权：填开放平台的应用 ID 与密钥；先在沙箱环境试",
    icon: "alipay",
  },
  {
    id: "lark",
    name: "飞书 / Lark",
    description: "读写云文档、日历、任务与群消息",
    category: "国内平台",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@larksuiteoapi/lark-mcp", "mcp", "-a", "{app_id}", "-s", "{app_secret}"],
    params: [
      { name: "app_id", description: "飞书自建应用的 App ID（open.feishu.cn 后台里拿）", required: true },
      { name: "app_secret", description: "对应的 App Secret", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：填自建应用的 App ID 与 Secret；应用要先开好对应权限",
    icon: "lark",
  },
  {
    id: "cloudbase",
    name: "CloudBase",
    description: "腾讯云开发：管云函数、云数据库与静态托管",
    category: "国内平台",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@cloudbase/cloudbase-mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要在这里填密钥；首次调用会开浏览器让你登录腾讯云",
    icon: "cloudbase",
  },
  {
    id: "aliyun-ops",
    name: "阿里云运维",
    description: "管 ECS / VPC / RDS 等云资源，查监控与账单",
    category: "国内平台",
    transport: "stdio",
    command: "uvx",
    args: ["alibaba-cloud-ops-mcp-server@latest"],
    params: [
      { name: "ALIBABA_CLOUD_ACCESS_KEY_ID", description: "阿里云 AccessKey ID", required: true },
      { name: "ALIBABA_CLOUD_ACCESS_KEY_SECRET", description: "阿里云 AccessKey Secret", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：填 AccessKey；跑在 uvx 上，本机没装 uv 的话先装好",
    icon: "aliyun",
  },
  {
    id: "yunxiao",
    name: "阿里云云效",
    description: "查代码库、流水线与工作项（云效 DevOps）",
    category: "国内平台",
    transport: "stdio",
    command: "npx",
    args: ["-y", "alibabacloud-devops-mcp-server"],
    params: [
      { name: "YUNXIAO_ACCESS_TOKEN", description: "云效个人访问令牌", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：在云效里建个人访问令牌填进来",
    icon: "aliyun",
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "文本转语音、声音克隆、图像与视频生成",
    category: "国内平台",
    transport: "stdio",
    command: "uvx",
    args: ["minimax-mcp"],
    params: [
      { name: "MINIMAX_API_KEY", description: "MiniMax 开放平台的 API key", required: true },
      { name: "MINIMAX_API_HOST", description: "接口域名：国内 https://api.minimaxi.com，海外 https://api.minimax.io", required: true },
    ],
    auth: "token",
    authNote: "不走浏览器授权：填 API key；跑在 uvx 上，本机没装 uv 的话先装好",
    icon: "minimax",
  },

  /* ── 本机工具 ────────────────────────────────────────────────────── */
  {
    id: "filesystem",
    name: "本地文件系统",
    description: "把指定目录开放出来（Mr Otto 自带读写文件工具，一般用不上）",
    category: "本机工具",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{root}"],
    params: [{ name: "root", description: "要暴露的目录绝对路径", required: true }],
    auth: "none",
    authNote: "不需要授权",
    icon: "filesystem",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "用真浏览器点页面、填表单、截图",
    category: "本机工具",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要授权；首次运行会下载浏览器内核",
    icon: "playwright",
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description: "用本机 Chrome 调页面：看网络、控制台与性能分析",
    category: "本机工具",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要授权；会启动/接管本机的 Chrome",
    icon: "chromedevtools",
  },
  {
    id: "mongodb",
    name: "MongoDB",
    description: "连 MongoDB：查集合、跑聚合、看索引",
    category: "本机工具",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mongodb-mcp-server", "--connectionString", "{connection_string}"],
    params: [
      { name: "connection_string", description: "MongoDB 连接串（mongodb:// 或 mongodb+srv://）", required: true },
    ],
    auth: "token",
    authNote: "不需要浏览器授权：连接串里已经带着凭据",
    icon: "mongodb",
  },
  {
    id: "git",
    name: "Git",
    description: "本地仓库操作：看 diff、查提交历史、管理分支（Mr Otto 自带 bash，一般用不上）",
    category: "本机工具",
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
    category: "本机工具",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    params: [],
    auth: "none",
    authNote: "不需要授权；跑在 uvx 上，本机没装 uv 的话先装好",
    icon: "fetch",
  },
];

/** 查目录。空查询 = 返回全部（agent 想看看有哪些）。
    匹配 id / 名字 / 描述 / 分类，大小写无关 */
export function searchCatalog(query: string): CuratedEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...MCP_CATALOG];
  return MCP_CATALOG.filter((e) =>
    [e.id, e.name, e.description, e.category].some((f) => f.toLowerCase().includes(q))
  );
}
