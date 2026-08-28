// 目录页的判断题——组件只管渲染（同 mcpForm.ts 的分工）。
//
// 两层的分野在这里落地：精选层来自仓内常量（人工核过、进过 PR review），
// 长尾层来自公开注册表（开放投稿，搜 notion 头两条是中间商包装）。
// verified 是**来路**的性质而不是条目自身的属性——同一份配置从精选层拿是
// 核过的，从注册表拿就不是——所以它在这个包装类型上，不在 CatalogEntry 上。

import type { CatalogEntry } from "../../../shared/mcpCatalog.js";
import type { McpServerConfig } from "../../../shared/mcp.js";
import { mcpServerIdError } from "./mcpForm.js";

export interface DirectoryItem {
  entry: CatalogEntry;
  /** 来自仓内精选层 = 人工核过 */
  verified: boolean;
  /** 已经装上了 —— UI 画 ✓ 而不是 + */
  installed: boolean;
}

export interface BuildDirectoryOptions {
  query: string;
  /** 精选层命中的条目（调用方用 searchCatalog 算好） */
  curated: readonly CatalogEntry[];
  /** 注册表返回的条目 */
  registry: readonly CatalogEntry[];
  /** 已装 server 的 id */
  installedIds: readonly string[];
}

export function buildDirectory(opts: BuildDirectoryOptions): {
  curated: DirectoryItem[];
  longTail: DirectoryItem[];
} {
  const installed = new Set(opts.installedIds);
  const curatedIds = new Set(opts.curated.map((e) => e.id));
  const wrap = (entry: CatalogEntry, verified: boolean): DirectoryItem => ({
    entry,
    verified,
    installed: installed.has(entry.id),
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
    值先代进 url / args 里的 `{占位符}`；代不进去的（注册表把 stdio 的
    environmentVariables 和 http 的请求头都折成了 params，参数名就是变量名，
    模板本身没留占位符）落进 env / headers ——不能因为"没找到占位符"就把
    用户刚填的凭据丢掉，那是一次静默的数据丢失。
    http 那一路存的键名是**参数名**而不是真实请求头名（映射层没保留它），
    所以这条路装出来的远程 server 可能连不上，用户在下面的行编辑器里改一下
    键名即可——值还在，比人间蒸发强。
    空值不落盘：没填的可选参数不该变成一个空环境变量 */
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
  const leftovers = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).filter(([k, v]) => !used.has(k) && v !== "")
    );
  if (entry.transport === "http") {
    const url = fill(entry.url ?? "");
    return { kind: "http", url, headers: leftovers(), enabled: true };
  }
  const args = (entry.args ?? []).map(fill);
  return { kind: "stdio", command: entry.command ?? "", args, env: leftovers(), enabled: true };
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
