// agentDomain —— 智能体的职责域（#1571，spec docs/superpowers/specs/2026-10-05-agent-tiers-design.md §2.2）。
//
// 一只一个主域：固定清单（键是英文、显示是中文）+ 自定义（`custom:<名字>`）。域决定两件事：
// 管理员按它派活（匹配靠键不靠模型猜），runtime 按它圈工具面（`domainTools`）。纯逻辑零 IO，三端共用。

import { normalizeAgentName } from "./workspaceAgents.js";

/** 固定清单。`admin` 只给管理员（L0），表单里不出现 */
export const DOMAIN_CATALOG = [
  { key: "travel", label: "出行" },
  { key: "writing", label: "写作" },
  { key: "support", label: "客服" },
  { key: "ops", label: "运维" },
  { key: "dev", label: "开发" },
  { key: "finance", label: "财务" },
  { key: "life", label: "生活" },
  { key: "research", label: "调研" },
  { key: "design", label: "设计" },
  { key: "schedule", label: "日程" },
  /** Otto 应用的专员（#1591，spec §8 第 2 条）：写小网页、调 build_app */
  { key: "apps", label: "应用" },
] as const;

export type CatalogDomain = (typeof DOMAIN_CATALOG)[number]["key"];
/** 管理员的域 */
export const ADMIN_DOMAIN = "admin";
export const CUSTOM_DOMAIN_PREFIX = "custom:";
export const CUSTOM_DOMAIN_NAME_MAX = 12;

export function isCatalogDomain(v: string): v is CatalogDomain {
  return DOMAIN_CATALOG.some((d) => d.key === v);
}

export function isCustomDomain(v: string): boolean {
  return v.startsWith(CUSTOM_DOMAIN_PREFIX) && v.length > CUSTOM_DOMAIN_PREFIX.length;
}

/** 库里那一格合不合法：清单里的、`admin`、或形状对的自定义 */
export function isAgentDomain(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v === ADMIN_DOMAIN || isCatalogDomain(v)) return true;
  return isCustomDomain(v) && customDomainError(v.slice(CUSTOM_DOMAIN_PREFIX.length)) === null;
}

/** 自定义域的名字（主人在表单里打的那几个字）合不合规。null = 合规 */
export function customDomainError(raw: string): string | null {
  const name = normalizeAgentName(raw);
  if (name === "") return "域的名字不能为空";
  if (name.length > CUSTOM_DOMAIN_NAME_MAX) return `域的名字最多 ${CUSTOM_DOMAIN_NAME_MAX} 个字`;
  if (/[\p{Cf}\p{Cc}:]/u.test(name)) return "域的名字里不能有不可见字符或冒号";
  if (DOMAIN_CATALOG.some((d) => d.label === name || d.key === name) || name === ADMIN_DOMAIN) return `「${name}」已经在清单里了，直接选它`;
  return null;
}

/** 自定义域的键：`custom:` + 归一化后的名字 */
export function customDomain(raw: string): string {
  return `${CUSTOM_DOMAIN_PREFIX}${normalizeAgentName(raw)}`;
}

/** 显示用的中文 */
export function domainLabel(domain: string): string {
  if (domain === ADMIN_DOMAIN) return "管理";
  const hit = DOMAIN_CATALOG.find((d) => d.key === domain);
  if (hit !== undefined) return hit.label;
  if (isCustomDomain(domain)) return domain.slice(CUSTOM_DOMAIN_PREFIX.length);
  return domain;
}

/** 同一主场里自定义域不重名（与清单也不撞）。`existing` 是别的智能体的 domain 列 */
export function customDomainConflict(domain: string, existing: readonly string[]): string | null {
  if (!isCustomDomain(domain)) return null;
  return existing.includes(domain) ? `已经有一只「${domainLabel(domain)}」的智能体了——一只一个域，想再建就换个域名` : null;
}

// ── 工具面 ───────────────────────────────────────────────────────────

/** 内置工具按「动不动手」分三档。连接器（MCP）另算：`connectors` 说这个域默认能不能用主场里接的应用 */
export const READ_TOOLS: readonly string[] = ["read_file", "web_search", "web_extract", "browser_read", "mcp_read_resource", "tool_search", "mcp_catalog"];
export const WRITE_TOOLS: readonly string[] = ["write_file", "generate_image"];
export const EXEC_TOOLS: readonly string[] = ["bash", "simulator", "package_project", "mcp_configure", "mcp_authorize"];
/** 派活 / 报进度那几把（runtime 第 2 步加）：L0 / L1 有 assign，谁都有 report */
export const TASK_TOOLS: readonly string[] = ["create_task", "assign_task", "report_task"];

export interface DomainFace {
  /** 内置工具名 */
  tools: readonly string[];
  /** 主场里接的应用（连接器）能不能用 */
  connectors: boolean;
}

const RW: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];
const ALL: readonly string[] = [...RW, ...EXEC_TOOLS];

const CATALOG_FACE: Readonly<Record<CatalogDomain, DomainFace>> = {
  travel: { tools: RW, connectors: true },
  writing: { tools: RW, connectors: true },
  support: { tools: RW, connectors: true },
  ops: { tools: ALL, connectors: true },
  dev: { tools: ALL, connectors: true },
  finance: { tools: RW, connectors: true },
  life: { tools: RW, connectors: true },
  research: { tools: READ_TOOLS, connectors: true },
  design: { tools: RW, connectors: true },
  schedule: { tools: READ_TOOLS, connectors: true },
  // 写文件、跑命令都要（在沙箱里写应用、打包）；不碰连接器——应用的数据走它自己的格子
  apps: { tools: ALL, connectors: false },
};

/** 这个域默认的工具面（spec §2.2）：管理员全部；清单里的按上表；自定义域**只读 + 不碰连接器**——主人自己加。
    认不出的域（脏值）当自定义处置：宁可少给 */
export function domainFace(domain: string): DomainFace {
  if (domain === ADMIN_DOMAIN) return { tools: ALL, connectors: true };
  if (isCatalogDomain(domain)) return CATALOG_FACE[domain];
  return { tools: READ_TOOLS, connectors: false };
}
