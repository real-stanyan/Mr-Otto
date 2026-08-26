// MCP OAuth 凭据的唯一落点：userData/mcp-auth.json（0600）。
// 与 mcp.json 分家的理由（spec §3.3）：mcp.json 要与 Claude Code 的 .mcp.json
// 格式兼容（用户能把已有配置直接粘过来、也会手编它），而 OAuth token 是
// 程序拥有、会被定期自动刷新重写的状态。把"用户手写的配置"和"程序频繁改写
// 的状态"混在一个文件里，两边都会出问题。
//
// 三条不变量抄 keyVault.ts：token 不进事件日志（日志不可删，进去 = 永久泄漏）、
// 不从主进程回流渲染层（渲染层只能问"这台授权了没"）、文件只属当前用户可读写。
// 主进程组装根特权：允许直接摸 fs（工具层的 fs 禁令不覆盖这里）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** 一台 server 的 OAuth 家当。三个字段分别对应 SDK 的三个 save* 回调。
    值类型故意宽（Record<string, unknown>）：这一层不认识 SDK 的
    OAuthTokens / OAuthClientInformation，那两个类型只在 mcpClient.ts 里
    出现（ADR-0050 的 SDK 单点 import 约束）。两边都是普通 JSON 对象，
    适配就是 mcpClient 那一处结构性赋值。 */
export interface McpAuthRecord {
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
  /** 上一次授权用的 redirect_uri（#471）。动态客户端注册把它写死进服务端的
      注册记录，而 loopback 端口每次都随机——二次授权前拿它对一下，就知道
      盘上的注册还能不能用（不能就丢掉重注册）。这是本仓自己的字段，
      不对应 SDK 的哪个 save* 回调 */
  redirectUri?: string;
}

export type McpAuthFile = Record<string, McpAuthRecord>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function loadMcpAuth(path: string): McpAuthFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    // 顶层必须是普通对象。数组/字符串/null 都当"还没授权过"——
    // 一份被写坏的文件不该让授权流程整个抛死，用户重新授权一次就能修好。
    // 每台 server 的记录同样只认普通对象（#474）：一条被手编坏的记录
    // （字符串/数组）只废它自己那台，不连累同伴，也不让 readMcpAuth 的
    // 调用方拿到一个形状不对的东西
    if (!isPlainObject(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(([, rec]) => isPlainObject(rec))
    ) as McpAuthFile;
  } catch {
    return {}; // 没有文件 / 坏 JSON = 还没授权过（同 keyVault.loadKeys 的口径）
  }
}

export function readMcpAuth(path: string, id: string): McpAuthRecord {
  return loadMcpAuth(path)[id] ?? {};
}

/** 部分更新一台 server 的记录。patch 里没提的字段原样保留 —— SDK 分三次
    回调落盘（先 saveClientInformation、再 saveCodeVerifier、最后 saveTokens），
    每次都整条覆盖会把上一步刚存的擦掉，授权流程会在换 token 那步找不到
    code_verifier 而失败。 */
export function writeMcpAuth(path: string, id: string, patch: Partial<McpAuthRecord>): void {
  const all = loadMcpAuth(path);
  all[id] = { ...all[id], ...patch };
  persist(path, all);
}

/** 丢掉一台 server 的动态客户端注册（#471）：二次授权的 loopback 端口和
    注册时不一样，精确匹配 redirect_uri 的授权服务器会拒——丢掉
    clientInformation 让 SDK 重跑一次注册。codeVerifier 是那次注册配套的
    流程残留，一起丢；tokens 保留（可能还能 refresh，丢了就得整个重来）。 */
export function dropMcpAuthClientRegistration(path: string, id: string): void {
  const all = loadMcpAuth(path);
  const rec = all[id];
  if (rec !== undefined) {
    delete rec.clientInformation;
    delete rec.codeVerifier;
    persist(path, all);
  }
}

/** 清一台（删除 server、或用户点"重新授权"时）。同伴的记录不动 */
export function clearMcpAuth(path: string, id: string): void {
  const all = loadMcpAuth(path);
  delete all[id];
  persist(path, all);
}

function persist(path: string, all: McpAuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // mode 只在新建时生效，已有文件补一刀（同 keyVault）
}
