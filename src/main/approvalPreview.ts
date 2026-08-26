// 审批预览 — 审批卡弹出前，主进程替人把"将要发生什么"看清楚。
// 两种工具有专门的排版：
//   write_file → 旧内容 vs 新内容（渲染层现算 diff）
//   MCP 工具   → 哪台 server 的哪把刀 + 参数表（issue #157）
// 其余（bash/read_file…）没有可对照的"世界现状"，退回原样 JSON 参数展示。
// 读旧文件走 world.fs（围栏天然生效）——预览不开任何工具之外的口子。

import type { ToolCallRequest } from "../session/events.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { ApprovalPreview, McpPreviewArg } from "../shared/shellBridge.js";
import { assignMcpToolNames, normalizeMcpHttpUrl } from "../shared/mcp.js";

/** 单边文本超过此长度就放弃预览（IPC 别扛巨物，diff 也算不动），退回 JSON 展示 */
const MAX_PREVIEW_CHARS = 200_000;

/** 单个 MCP 参数值在主进程就截断的长度。审批卡是"扫一眼看清要发生什么"，
    不是全文阅读器；一个塞了整份文件的参数不该把 IPC 和卡片一起撑爆 */
const MAX_ARG_CHARS = 2_000;

export async function buildApprovalPreview(
  call: ToolCallRequest,
  world: ExecutionWorld
): Promise<ApprovalPreview | undefined> {
  if (call.name === "mcp_configure") return mcpConfigurePreview(call, world);
  if (call.name.startsWith("mcp__")) return mcpPreview(call, world);
  if (call.name !== "write_file") return undefined;
  // 参数出自模型，不赌形状：不像 {path, content} 就不预览（审批卡照常弹，走 JSON 兜底）
  const args = call.args as { path?: unknown; content?: unknown };
  if (typeof args.path !== "string" || typeof args.content !== "string") return undefined;
  if (args.content.length > MAX_PREVIEW_CHARS) return undefined;

  // 读不到 = 新文件（不存在/没权限统统按"无旧内容"处理——预览失败不该挡住审批）
  const oldText = await world.fs.read(args.path).then(
    (t) => t,
    () => null
  );
  if (oldText !== null && oldText.length > MAX_PREVIEW_CHARS) return undefined;

  return { kind: "write_file", path: args.path, oldText, newText: args.content };
}

/** 预览这一步的 url 展示值：直接调 normalizeMcpHttpUrl——同一份归一化 +
    校验逻辑，run() 存盘用的也是它（Task 9 复审「Critical 1 的 check (a)
    未通过」：此前这里自己另写了一份 `new URL(raw).href`，语义上和
    normalizeMcpHttpUrl 刻意不同，"一份归一化、两个读者"靠人手同步而不是
    结构上保证）。校验失败（语法错误/协议不对/带 userinfo/含 tab 换行）时，
    run() 那层会真正拒绝这次调用——这里退回展示原始值，让卡片至少说得出
    模型传了什么，而不是直接哑掉退回 JSON 兜底。 */
function previewUrl(raw: string): string {
  try {
    return normalizeMcpHttpUrl(raw);
  } catch {
    return raw;
  }
}

/** 卡片上独立的一行、永不截断的真实主机名（Task 9 复审 Critical A 修法②）。
    只取 `URL.host`——它天生不含 userinfo，也不受 url 字符串本身长度/变形的
    影响：无论 url 那一行被截成什么样、里面藏了什么，"到底连哪个主机"必须
    永远在这一行、永远完整。解析失败（run() 那层会拒绝）= null，不编一个
    假主机出来。 */
function previewHost(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/** 单个字符串值按 MAX_ARG_CHARS 截断，和 clip() 同一份纪律（Task 9 审查
    Important 2：这个预览此前没有 mcp_tool 参数预览、write_file 都有的
    长度上限，一个几 MB 的 command/url/arg 会整个原样过 IPC 落到卡片上）。 */
function clipValue(value: string, max = MAX_ARG_CHARS): { value: string; truncated: boolean; fullLength: number } {
  return value.length <= max
    ? { value, truncated: false, fullLength: value.length }
    : { value: value.slice(0, max), truncated: true, fullLength: value.length };
}

/** 凭据键名的两道上限。键名天生短（TOKEN / Authorization / project_ref），
    几百字符的"键名"和几百把"键"都只有一个用途：把卡片撑长。而卡上唯一那条
    永不截断的安全闸（host 行）离折叠线越近越好（终审 C 8+9）。
    超出的部分不静默丢弃——末尾补一句人话，卡片可以少说，不能撒谎。 */
const MAX_CRED_KEYS = 50;
const MAX_CRED_KEY_CHARS = 120;

/** server id 的上限。同上一条的理由，但更紧：这一行渲染在 host **之前**，
    而 id 只是一个名字 */
const MAX_SERVER_CHARS = 200;

function clipCredentialKeys(keys: string[]): string[] {
  const shown = keys.slice(0, MAX_CRED_KEYS).map((k) => clipValue(k, MAX_CRED_KEY_CHARS).value);
  return keys.length > MAX_CRED_KEYS
    ? [...shown, `…（还有 ${keys.length - MAX_CRED_KEYS} 个键名未显示）`]
    : shown;
}

/** mcp_configure 的预览。参数出自模型，形状一律不赌——认不出来就不预览，
    审批卡照常弹、走 JSON 兜底（同 write_file 分支的口径）。 */
function mcpConfigurePreview(call: ToolCallRequest, world: ExecutionWorld): ApprovalPreview | undefined {
  const mcp = world.mcp;
  if (!mcp) return undefined;
  const a = call.args as Record<string, unknown> | null;
  const rawId = a?.["id"];
  if (typeof rawId !== "string" || rawId.trim() === "") return undefined;
  // 与 parseConfigureArgs 同一把尺子（终审 B Minor）：那边存的是 trim 后的
  // id，这里不 trim 的话 configOf(" supabase ") 查不到磁盘上那台 supabase，
  // 卡片会把一次 update 显示成 add——卡和现实说的不是同一台 server
  const id = rawId.trim();
  // server（= 完全由模型控制的 id）此前没有长度上限。它渲染在 host 那一行
  // **之前**，所以一个几千字符的 id 会把"到底连哪个主机"那一行推下折叠线——
  // 正好挤掉 Task 9 两轮修复才换来的那条唯一安全闸（终审 C 8+9）。
  // 上限比 MAX_ARG_CHARS 紧得多：id 是一个名字，200 字符已经离谱得够用了
  const serverClip = clipValue(id, MAX_SERVER_CHARS);

  const existing = mcp.configOf(id);
  // before 的两个值同样上限（终审 C 8+9）：它们来自磁盘，但磁盘上那份也可能
  // 是上一次 mcp_configure 写进去的模型输入。渲染在 host 之后，挤不掉安全闸，
  // 但没理由让一个几 MB 的旧 command 原样过 IPC
  const before = existing
    ? {
        url: existing.kind === "http" ? clipValue(existing.url).value : null,
        command: existing.kind === "stdio" ? clipValue(existing.command).value : null,
        // 旧的启用状态（终审 B Important）：没有它，"这次会把用户手动关掉的
        // 那台重新启用"在卡上完全看不出来——新值和旧值都不在，卡片会把一次
        // 有执行后果的翻转显示成"什么都没变的更新"
        enabled: existing.enabled,
        toolCount: mcp.servers().find((s) => s.id === id)?.tools.length ?? 0,
        // 旧凭据的键名（#472）：不带 env/headers 的更新会把旧键整批丢掉
        // （mergeMaskedCreds 只遍历 incoming 的键），卡片要画得出
        // 「改之前 / 改之后」这两个集合，用户才看得见自己正在丢掉哪几把。
        // 键名同样过 clipCredentialKeys 的长度纪律；值照旧绝不过桥
        credentialKeys: clipCredentialKeys(
          Object.keys(existing.kind === "http" ? existing.headers : existing.env)
        ),
      }
    : null;

  if (a?.["action"] === "remove") {
    return {
      kind: "mcp_configure", server: serverClip.value, action: "remove", transport: null,
      host: null, url: null, command: null, args: [], credentialKeys: [],
      // 删除不谈"改成什么启用状态"
      enabled: null, before,
      truncated: { server: serverClip.truncated, url: false, command: false, args: [] },
      fullLength: { server: serverClip.fullLength, url: 0, command: 0, args: [] },
    };
  }

  const kind = a?.["kind"];
  if (kind !== "http" && kind !== "stdio") return undefined;
  const creds = kind === "http" ? a?.["headers"] : a?.["env"];

  // url 走 previewUrl 归一化再截断——卡片和最终写盘的 URL.href 因此永远是
  // 同一份（normalizeMcpHttpUrl 在 mcpConfigure.ts 里存的也是 href）
  const urlClip =
    kind === "http" && typeof a?.["url"] === "string" ? clipValue(previewUrl(a["url"] as string)) : null;
  // host 独立算、永不截断（Critical A 修法②）：不从 urlClip.value 里切，
  // 直接从原始输入解析——url 那一行截不截断、变不变形，都不影响这一行
  const host = kind === "http" && typeof a?.["url"] === "string" ? previewHost(a["url"] as string) : null;
  const commandClip =
    kind === "stdio" && typeof a?.["command"] === "string" ? clipValue(a["command"] as string) : null;
  const argsClip = Array.isArray(a?.["args"]) ? (a["args"] as unknown[]).map((x) => clipValue(String(x))) : [];

  return {
    kind: "mcp_configure",
    server: serverClip.value,
    action: before ? "update" : "add",
    transport: kind,
    host,
    url: urlClip?.value ?? null,
    command: commandClip?.value ?? null,
    // 一格一项，不 join——每一条 arg 是它自己的一行（Task 9 审查 Important 1）
    args: argsClip.map((c) => c.value),
    // 只出键名。真值绝不过桥（ADR-0044）——审批卡要回答的是"配了哪几把"，
    // 不是"每把长什么样"
    credentialKeys: clipCredentialKeys(
      Object.keys(creds !== null && typeof creds === "object" && !Array.isArray(creds) ? creds : {})
    ),
    // 与 mcpConfigure.parseConfigureArgs 逐字同一份默认（`!== false` = 缺省
    // 为 true）：卡上写的必须就是即将落盘的那个值，两边各写一份就会漂移
    enabled: a?.["enabled"] !== false,
    before,
    truncated: {
      server: serverClip.truncated,
      url: urlClip?.truncated ?? false,
      command: commandClip?.truncated ?? false,
      args: argsClip.map((c) => c.truncated),
    },
    fullLength: {
      server: serverClip.fullLength,
      url: urlClip?.fullLength ?? 0,
      command: commandClip?.fullLength ?? 0,
      args: argsClip.map((c) => c.fullLength),
    },
  };
}

/** 把 `mcp__<server>__<tool>` 还原成"哪台 server 的哪把刀"。
    不从工具名反推——mcpToolName 的收口有损（净化 + 截断 + 指纹，见 shared/mcp.ts），
    反推不回去。正着来：拿此刻的清单逐个算一遍名字，撞上的那个就是它。
    清单里没有（server 刚掉线、工具被撤了）= 不预览，审批卡照常弹、走 JSON 兜底 */
function mcpPreview(call: ToolCallRequest, world: ExecutionWorld): ApprovalPreview | undefined {
  const mcp = world.mcp;
  if (!mcp) return undefined;
  // 与 createMcpTools 同一份分配（issue #349）：名字唯一性依赖整桌统一算
  // （撞名的哈希后缀取决于先来后到），逐个独立算会对不上号
  const entries = mcp.servers().flatMap((server) => server.tools.map((tool) => ({ server, tool })));
  const names = assignMcpToolNames(entries.map((e) => ({ server: e.server.name, tool: e.tool.name })));
  for (const [i, { server, tool }] of entries.entries()) {
    if (names[i] !== call.name) continue;
    return {
      kind: "mcp_tool",
      server: server.name,
      tool: tool.name,
      description: tool.description ?? "",
      args: previewArgs(call.args),
    };
  }
  return undefined;
}

/** 参数摊平成一格一项。值出自模型，形状不赌：字符串原样，其余 JSON 序列化。
    参数根本不是对象（模型给了个数组或一个裸值）时也不硬拆，整体记成一项 */
function previewArgs(args: unknown): McpPreviewArg[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [clip("参数", stringify(args))];
  }
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => clip(k, stringify(v)));
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // 循环引用之类：说得出"这里有个值，但它印不出来"比整张卡不预览强
    return String(v);
  }
}

function clip(name: string, value: string): McpPreviewArg {
  return value.length <= MAX_ARG_CHARS
    ? { name, value, truncated: false, fullLength: value.length }
    : { name, value: value.slice(0, MAX_ARG_CHARS), truncated: true, fullLength: value.length };
}
