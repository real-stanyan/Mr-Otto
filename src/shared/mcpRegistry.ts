// registry.modelcontextprotocol.io 的响应 → 仓内既有的 CatalogEntry。
//
// 为什么要这一层：注册表的形状（remotes/packages/headers/environmentVariables）
// 和本仓的 CatalogEntry 不是一回事，而下游有三个消费者——目录页 UI、
// mcp_catalog 工具、mcp_configure 落盘。折成同一个形状，三者共用一套渲染与
// 校验，而不是各自解一遍注册表的 JSON。
//
// 纯逻辑、零 IO：src/shared 手机端会直接 import（tests/architecture.test.ts
// 第 5 条），碰 node builtin 就断了那条路。取数在 src/main/mcpRegistry.ts。

import type { CatalogEntry, CatalogParam } from "./mcpCatalog.js";

export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/** 官方注册表往 _meta 里塞状态的键名。字面量，一字不能改 */
const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

export function registrySearchUrl(query: string, limit = 50): string {
  const p = new URLSearchParams({ search: query, limit: String(limit) });
  return `${REGISTRY_BASE}/v0/servers?${p.toString()}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 反向域名的末段做 id：ai.smithery/smithery-notion → smithery-notion。
    注册表的 name 带点和斜杠，不是合法的 mcp.json 对象键（也没法当 UI 里的
    稳定短名）。撞名由 mapRegistryResponse 统一补后缀 */
function slugId(name: string): string {
  const tail = name.split("/").pop() ?? name;
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "server" : slug;
}

/** header 的 value 模板形如 "Bearer {smithery_api_key}"——占位符的名字才是
    要问用户的东西，header 自己的名字（Authorization）不是 */
function paramNameFromHeader(h: Record<string, unknown>): string | undefined {
  const template = str(h.value);
  const hole = template?.match(/\{(\w+)\}/)?.[1];
  return hole ?? str(h.name);
}

function paramsFromHeaders(headers: unknown[]): CatalogParam[] {
  const out: CatalogParam[] = [];
  for (const h of headers) {
    if (!isObj(h) || h.isRequired !== true) continue;
    const name = paramNameFromHeader(h);
    if (name === undefined) continue;
    out.push({ name, description: str(h.description) ?? `${name} 的值`, required: true });
  }
  return out;
}

function paramsFromEnv(vars: unknown[]): CatalogParam[] {
  const out: CatalogParam[] = [];
  for (const v of vars) {
    if (!isObj(v) || v.isRequired !== true) continue;
    const name = str(v.name);
    if (name === undefined) continue;
    out.push({ name, description: str(v.description) ?? `${name} 的值`, required: true });
  }
  return out;
}

/** 包管理器 → 启动命令。runtimeHint 是注册表给的建议，缺席时按 registryType
    兜底（npm → npx -y，pypi → uvx）。认不出来的返回 null = 这条装不了 */
function commandFor(pkg: Record<string, unknown>): { command: string; args: string[] } | null {
  const identifier = str(pkg.identifier);
  if (identifier === undefined) return null;
  const hint = str(pkg.runtimeHint);
  if (hint === "uvx") return { command: "uvx", args: [identifier] };
  if (hint === "npx") return { command: "npx", args: ["-y", identifier] };
  if (hint !== undefined) return { command: hint, args: [identifier] };
  const type = str(pkg.registryType);
  if (type === "npm") return { command: "npx", args: ["-y", identifier] };
  if (type === "pypi") return { command: "uvx", args: [identifier] };
  return null;
}

const UNVERIFIED_NOTE = "这台 server 来自公开注册表，配置未经核验";

/** 一条注册表记录 → CatalogEntry；映不出来（旧版本 / 装不了 / 形状不对）返回 null */
export function mapRegistryServer(record: unknown): CatalogEntry | null {
  if (!isObj(record)) return null;
  const meta = isObj(record._meta) ? record._meta[OFFICIAL_META] : undefined;
  // 同一个 server 的每个历史版本都是一条记录，只要最新那条
  if (!isObj(meta) || meta.isLatest !== true) return null;

  const s = record.server;
  if (!isObj(s)) return null;
  const fullName = str(s.name);
  if (fullName === undefined) return null;

  const id = slugId(fullName);
  const name = str(s.title) ?? id;
  const description = str(s.description) ?? "";

  const remote = arr(s.remotes).find(
    (r) => isObj(r) && r.type === "streamable-http" && str(r.url) !== undefined
  );
  if (isObj(remote)) {
    const params = paramsFromHeaders(arr(remote.headers));
    const secret = arr(remote.headers).some((h) => isObj(h) && h.isSecret === true);
    return {
      id,
      name,
      description,
      transport: "http",
      url: str(remote.url)!,
      params,
      auth: secret || params.length > 0 ? "token" : "none",
      authNote: params[0]?.description ?? UNVERIFIED_NOTE,
    };
  }

  for (const p of arr(s.packages)) {
    if (!isObj(p)) continue;
    const cmd = commandFor(p);
    if (cmd === null) continue;
    const params = paramsFromEnv(arr(p.environmentVariables));
    return {
      id,
      name,
      description,
      transport: "stdio",
      command: cmd.command,
      args: cmd.args,
      params,
      auth: params.length > 0 ? "token" : "none",
      authNote: params[0]?.description ?? UNVERIFIED_NOTE,
    };
  }

  // 既没有能连的远程端点，也没有能跑的包 —— 装不了，不摆出来
  return null;
}

/** 一整页响应 → CatalogEntry[]。去重两道：先按注册表的 name（同名多条只留
    第一条），再按 slug 出来的 id（不同 name 可能 slug 成同一个 id，撞了补后缀，
    否则两张卡片的 key 和落盘的对象键都会撞） */
export function mapRegistryResponse(json: unknown): CatalogEntry[] {
  if (!isObj(json)) return [];
  const records = arr(json.servers);
  const seenNames = new Set<string>();
  const usedIds = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const record of records) {
    const fullName = isObj(record) && isObj(record.server) ? str(record.server.name) : undefined;
    if (fullName !== undefined) {
      if (seenNames.has(fullName)) continue;
      seenNames.add(fullName);
    }
    const entry = mapRegistryServer(record);
    if (entry === null) continue;
    let id = entry.id;
    for (let n = 2; usedIds.has(id); n += 1) id = `${entry.id}-${n}`;
    usedIds.add(id);
    out.push(id === entry.id ? entry : { ...entry, id });
  }
  return out;
}
