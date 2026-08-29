// 目录页的判断题——组件只管渲染（同 mcpForm.ts 的分工）。
//
// 两层的分野在这里落地：精选层来自仓内常量（人工核过、进过 PR review），
// 长尾层来自公开注册表（开放投稿，搜 notion 头两条是中间商包装）。
// verified 是**来路**的性质而不是条目自身的属性——同一份配置从精选层拿是
// 核过的，从注册表拿就不是——所以它在这个包装类型上，不在 CatalogEntry 上。

import {
  CATALOG_CATEGORIES,
  type CatalogCategory,
  type CatalogEntry,
} from "../../../shared/mcpCatalog.js";
import type { McpServerConfig } from "../../../shared/mcp.js";
import { mcpServerIdError, type McpDisplayStatus } from "./mcpForm.js";

/** 已装的一台 —— 目录卡要的是**状态**，不只是"这个 id 在不在配置里"。
    只拿 id 的那一版让三件事长得一模一样：连上了 / 需要授权 / 连不上，
    三张卡都是一个绿勾（issue #722：装 Canva 时把浏览器关了，勾照样出现） */
export interface InstalledServer {
  id: string;
  status: McpDisplayStatus;
}

export interface DirectoryItem {
  entry: CatalogEntry;
  /** 来自仓内精选层 = 人工核过 */
  verified: boolean;
  /** 已装的话是它此刻的状态；没装是 null */
  installed: McpDisplayStatus | null;
}

export interface BuildDirectoryOptions {
  query: string;
  /** 精选层命中的条目（调用方用 searchCatalog 算好） */
  curated: readonly CatalogEntry[];
  /** 注册表返回的条目 */
  registry: readonly CatalogEntry[];
  /** 已装的 server 及其状态 */
  installed: readonly InstalledServer[];
}

export function buildDirectory(opts: BuildDirectoryOptions): {
  curated: DirectoryItem[];
  longTail: DirectoryItem[];
} {
  const installed = new Map(opts.installed.map((s) => [s.id, s.status]));
  const curatedIds = new Set(opts.curated.map((e) => e.id));
  const wrap = (entry: CatalogEntry, verified: boolean): DirectoryItem => ({
    entry,
    verified,
    installed: installed.get(entry.id) ?? null,
  });
  return {
    curated: opts.curated.map((e) => wrap(e, true)),
    // 空查询不出长尾（调用方本来就不会去打网，这里是第二道保险）；
    // 跟精选撞 id 的剔掉——同一台 server 不该在一屏里出现两次
    longTail:
      opts.query.trim() === ""
        ? []
        : opts.registry.filter((e) => !curatedIds.has(e.id)).map((e) => wrap(e, false)),
  };
}

/** 精选层按分类切成小段。
    八十多张卡平铺是一堵墙——不敲字的时候，"我要找个建站的"这件事只能靠
    从头扫到尾。分组把它变成扫一眼组名。

    顺序取自 CATALOG_CATEGORIES 而不是条目出现的顺序：目录数组是按分类
    写的，但那是**书写**顺序，改一条的位置就会顺带改掉界面上的段落次序，
    而那不该是"挪一条目录"的后果。空组不出（分类是联合类型，加一个却
    还没有条目的中间态照样得渲染得下去）。

    搜索时不分组：结果本来就少，再切成七段反而更难扫；这个判断在组件里
    做（searched 分支），这儿只提供分组本身 */
export function groupByCategory(
  items: readonly DirectoryItem[]
): { category: CatalogCategory; items: DirectoryItem[] }[] {
  const bucket = new Map<CatalogCategory, DirectoryItem[]>();
  for (const item of items) {
    // 没分类的一律不进任何一段：那只可能是长尾条目（注册表不给分类），
    // 而长尾从来不走这条路。精选层漏填在 tsc 里就红了（CuratedEntry）
    const category = item.entry.category;
    if (category === undefined) continue;
    const list = bucket.get(category);
    if (list === undefined) bucket.set(category, [item]);
    else list.push(item);
  }
  return CATALOG_CATEGORIES.flatMap((category) => {
    const list = bucket.get(category);
    return list === undefined || list.length === 0 ? [] : [{ category, items: list }];
  });
}

/** 装之前要不要弹确认卡。
    判据只有一条：这条是不是「未经核验的 stdio」。stdio 装上意味着 Otto 会
    npx/uvx 从公共包仓库下载并在用户本机执行代码，而注册表是开放投稿的——
    从搜索结果里点一下，跟用户自己在新建对话框里敲命令不是一回事，点击的人
    未必知道自己触发了什么。
    远程条目不弹：代码跑在对方机器上，不在用户机器上。
    精选条目不弹：已人工核过（这正是精选层存在的意义）。 */
export function needsInstallConfirm(item: DirectoryItem): boolean {
  return !item.verified && item.entry.transport === "stdio";
}

/* ── 以下是组件落盘那一步要用的判断题，同样不该住在 JSX 里 ────────────── */

/** 落盘用的 server id。撞了就补后缀，规则跟注册表映射层的 id 去重一致
    （`${base}-2`、`-3`…，见 shared/mcpRegistry.ts）。
    撞名判据复用 mcpServerIdError 本体，不在这里另写一份"id 合不合法"——
    两份判据一旦分叉，目录页装出来的 id 就可能是新建对话框拒绝的那种 */
export function uniqueServerId(base: string, existingIds: readonly string[]): string {
  // 目录条目的 id 不该是空的（精选层是字面量，注册表那边 slugId 兜了底），
  // 但真空了就得给个名字：mcpServerIdError 只报错不改名，落盘的对象键
  // 不能是空串
  const stem = base.trim() === "" ? "server" : base.trim();
  let id = stem;
  for (let n = 2; mcpServerIdError(id, existingIds) !== null; n += 1) id = `${stem}-${n}`;
  return id;
}

/** 目录条目 + 用户填的参数值 → 可落盘的配置。
    值代进 url / args / 请求头模板里的 `{占位符}`。两种传输的收尾不一样：

    - **http**：请求头只从 `entry.headerTemplates` 生成，键名是**真实**请求头名
      （`Authorization`），值是整条模板代完的结果（`Bearer <key>`）。不拿参数名
      当键名——那样存出来的 `smithery_api_key: <key>` 服务端永远 401，用户看到的
      却是一条指向 OAuth 的授权失败，而凭据已经躺在 mcp.json 里一个毫无意义的键
      下面了。params 和 headerTemplates 在映射层是同一个循环产出的（fromHeaders），
      所以"有参数没地方放"在构造上不成立。
    - **stdio**：注册表把 environmentVariables 折成 params，**参数名就是环境变量
      名**，args 里本来就没有占位符可代——代不进去的落 env 才是对的。

    空值、以及代完仍留着占位符的（用户没填），一律不落盘：宁可少一个头/一个环境
    变量让服务端明说缺什么，也不写一个装着 `{hole}` 字面量的键 */
export function configFromEntry(
  entry: CatalogEntry,
  values: Readonly<Record<string, string>>
): McpServerConfig {
  const used = new Set<string>();
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const v = values[name];
      if (v === undefined || v === "") return whole;
      used.add(name);
      return v;
    });
  const hasHole = (text: string): boolean => /\{\w+\}/.test(text);
  if (entry.transport === "http") {
    const url = fill(entry.url ?? "");
    const headers: Record<string, string> = {};
    for (const [headerName, template] of Object.entries(entry.headerTemplates ?? {})) {
      const value = fill(template);
      if (value === "" || hasHole(value)) continue;
      headers[headerName] = value;
    }
    return { kind: "http", url, headers, enabled: true };
  }
  const args = (entry.args ?? []).map(fill);
  const env = Object.fromEntries(
    Object.entries(values).filter(([k, v]) => !used.has(k) && v !== "")
  );
  return { kind: "stdio", command: entry.command ?? "", args, env, enabled: true };
}

/** 确认卡上那句"从 <哪儿> 下载"。认不出的运行时不冒充 npm——说错了比说
    "包仓库"更糟，用户是照着这句话判断要不要点同意的 */
export function installSourceLabel(entry: CatalogEntry): string {
  if (entry.command === "npx") return "npm";
  if (entry.command === "uvx") return "PyPI";
  return "包仓库";
}

/** 确认卡上那个包名。`npx -y <pkg>` 的包名在 -y 后面，`uvx <pkg>` 就是第一个
    参数——统一取"第一个不以 - 开头的参数"，认不出就退回命令本身 */
export function installPackageName(entry: CatalogEntry): string {
  const pkg = (entry.args ?? []).find((a) => !a.startsWith("-"));
  return pkg ?? entry.command ?? entry.id;
}

/** 没有本地图标的条目画首字母色块，颜色由 id 定死——同一条目每次打开目录都是
    同一个颜色，色块才有"认出来"的价值（每次随机就只是装饰）。
    色板是 Tailwind 默认调色板里的六个色相，写成完整类名字面量：v4 的扫描器
    只认源码里出现过的完整类名，拼出来的 `bg-${hue}-500/15` 不会被生成 */
const TINTS = [
  "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  "bg-rose-500/15 text-rose-600 dark:text-rose-300",
  "bg-teal-500/15 text-teal-600 dark:text-teal-300",
] as const;

export function directoryTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/* 这个标该怎么上色。`<img>` 里的 SVG 收不到 currentColor，也看不见 app 自己
   那个主题开关（它只认系统的 prefers-color-scheme），所以"一张图两个主题都
   认得出"这件事没法在 SVG 内部解决。

   分野按**品牌色本身有没有信息量**来划：
   - "mono" —— 品牌标就是纯黑/近黑（GitHub、Notion、Linear、Square、Miro、
     Sentry），以及本来就不是品牌的功能图标（文件夹、地球）。这类标的颜色不
     携带任何品牌信息，各家自己在深色背景上也一律翻成白的。渲染成
     `mask-image` + `background-color: currentColor`：只取形状，颜色跟着主题
     的前景色走，浅色主题近黑、深色主题近白。
   - "color" —— 品牌色是标的一部分（Stripe 紫、Figma 五色、Supabase 渐变）。
     照原样画，前提是这个颜色在两种卡片底色上都过得去（≥3:1，图形元素的
     WCAG 下限）。Atlassian 的 #0052CC 在深色底上只有 1.9:1，所以换成它自己
     那支深色底专用的 Blue 400 #2684FF，而不是给它开个特例。

   为什么不干脆全走 mask：那等于把 Stripe 画成灰的。品牌色是识别信号的一半。 */
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

/* ── 目录卡右边那一格该长什么样 ─────────────────────────────────────────
   原来只有两档：装了画 ✓、没装画 +。那个 ✓ 的判据是「配置里有没有一个叫
   这名字的」，从来不看状态，于是它在两种情况下撒谎（issue #722）：

   ① **授权还在飞的时候。** `install()` 里 saveMcpServer 一成功，卡片立刻
      切到 ✓，而 authorizeMcpServer 还挂在 waitForCode 上——AUTH_TIMEOUT_MS
      是五分钟。浏览器关掉之后，用户看着一个绿勾，背后是五分钟静默等待。
   ② **授权没成的时候。** needs-auth 和 connected 同一个勾。真相在页面下半
      那份清单里（那边有「需要授权」和「授权」按钮），但上半说的是"完事了"。

   所以这一格按真实状态分档，busy 优先——它盖住的正是 ① 那个窗口。
   needs-auth 直接给一个能点的「授权」：用户不该为了走完流程，先弄明白
   "上面那个勾和下面那一行是同一台"。 */
export type InstallSlot =
  | { kind: "add" }
  | { kind: "busy" }
  | { kind: "authorize" }
  | { kind: "done" }
  /** 装上了但此刻用不了/不该催 —— 画一句安静的说明，动作留给下面那份清单 */
  | { kind: "note"; label: string; title: string };

export function installSlot(item: DirectoryItem, busy: boolean): InstallSlot {
  if (busy) return { kind: "busy" };
  if (item.installed === null) return { kind: "add" };
  switch (item.installed) {
    case "connected":
      return { kind: "done" };
    case "needs-auth":
      return { kind: "authorize" };
    case "failed":
      return { kind: "note", label: "连不上", title: "已装上，但连不上——原因看下面那份清单" };
    case "connecting":
      return { kind: "note", label: "连接中", title: "已装上，正在连" };
    case "disabled":
      return { kind: "note", label: "已关闭", title: "已装上，但被关掉了——在下面那份清单里打开" };
  }
}
