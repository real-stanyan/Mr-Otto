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

/** 请求头这一趟只走一遍，params 和 headerTemplates 一起产出——**这两样必须
    同源**：param 是问用户的那一格，template 是把答案装回请求头的那个模子，
    分两个函数各扫一遍，就有了"有 param 没 template"的可能，而那正是凭据落进
    `smithery_api_key: <key>` 这种无意义键的路。同一个循环产出，这类不同步
    在构造上就不存在。 */
function fromHeaders(headers: unknown[]): {
  params: CatalogParam[];
  templates: Record<string, string>;
} {
  const params: CatalogParam[] = [];
  const templates: Record<string, string> = {};
  for (const h of headers) {
    if (!isObj(h)) continue;
    const headerName = str(h.name);
    const template = str(h.value);
    const hasHole = template !== undefined && /\{\w+\}/.test(template);
    if (h.isRequired === true) {
      const name = paramNameFromHeader(h);
      if (name !== undefined) {
        params.push({ name, description: str(h.description) ?? `${name} 的值`, required: true });
        if (headerName !== undefined) {
          // 必填但模板里没有占位符（`"value": ""` 或直接写着 `Bearer YOUR_TOKEN`）：
          // paramNameFromHeader 这时已经退回拿 header 名当参数名，那就把整个值
          // 当成"要问用户的东西"。丢掉 `Bearer ` 这种前缀是这一支的已知代价——
          // 注册表的约定本来就是用 {占位符} 标出用户要填的部分，没标就没得推
          templates[headerName] = hasHole ? template : `{${name}}`;
        }
      }
      continue;
    }
    // 非必填的静态头（版本号之类）原样带上；带占位符却又不必填的没法问，跳过
    if (headerName !== undefined && template !== undefined && !hasHole) {
      templates[headerName] = template;
    }
  }
  return { params, templates };
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
    const { params, templates } = fromHeaders(arr(remote.headers));
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
      // 一个头都没有的条目不带这个字段（exactOptionalPropertyTypes：给了就得是
      // 真值，不能是 undefined）
      ...(Object.keys(templates).length > 0 ? { headerTemplates: templates } : {}),
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
    const entry = mapRegistryServer(record);
    if (entry === null) continue;
    // 注册表按版本历史把同一个 server 的每条记录都返回，旧版本在前。
    // name 去重必须落在 mapRegistryServer 判完 isLatest 之后——先记 name 再
    // 校验的话，旧版本会先把坑占了，后面才轮到的当前版本反而被当成"重复"丢掉
    const fullName = isObj(record) && isObj(record.server) ? str(record.server.name) : undefined;
    if (fullName !== undefined) {
      if (seenNames.has(fullName)) continue;
      seenNames.add(fullName);
    }
    let id = entry.id;
    for (let n = 2; usedIds.has(id); n += 1) id = `${entry.id}-${n}`;
    usedIds.add(id);
    out.push(id === entry.id ? entry : { ...entry, id });
  }
  return out;
}
