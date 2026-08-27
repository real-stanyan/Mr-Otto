// MCP 的共享世界 —— 类型 + 纯函数，零运行时依赖，主进程/渲染层/工具层共 import。
// 与 shellBridge.ts 同一个定位：桥两头都要认的形状放这儿。

import { maskKey } from "./keyMask.js";

export type McpTransportKind = "stdio" | "http";

/** 一台 server 的四种活法。UI 的状态灯直接读它 */
export type McpStatus = "connecting" | "connected" | "needs-auth" | "failed";

export interface McpStdioConfig {
  kind: "stdio";
  command: string;
  args: string[];
  /** 值是凭据 —— 过桥前必过 maskMcpConfig */
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpHttpConfig {
  kind: "http";
  url: string;
  /** 值是凭据 —— 同上 */
  headers: Record<string, string>;
  enabled: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** MCP 返回的内容块。工具层把它压成喂模型的字符串（renderMcpContent） */
export type McpContent =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "resource"; uri: string; text?: string; mimeType?: string };

export interface McpToolInfo {
  /** server 自报的原始名（未加前缀） */
  name: string;
  description: string;
  /** JSON Schema，原样透给模型 */
  inputSchema: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments: readonly { name: string; description?: string; required?: boolean }[];
}

/** 过桥给渲染层的一台 server —— 配置已遮罩，能力清单是快照 */
export interface McpServerStatus {
  id: string;
  status: McpStatus;
  /** 连不上时的人话原因；连上了 = undefined */
  error?: string;
  config: McpServerConfig;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

/** listMcpServers 等四个读写方法过桥的整体形状：server 清单 + 配置文件
    解析阶段的错误。errors 挂在这里而不是塞进某一台 server 的字段——它是
    整份 ~/.mr-otto/mcp.json 级别的问题（一行 JSON 坏了、缺 command/url），
    不属于任何一台已经解析成功的 server（mcpConfig.ts 的 parseMcpConfig
    早就结构化产出了这份清单；review finding 4 之前它只是从没被接到桥上，
    设置页（Task 8/9，未在本次开工）能不能显示它，取决于这个字段先落地）。 */
export interface McpServersSnapshot {
  servers: McpServerStatus[];
  errors: string[];
}

const NAME_MAX = 64;

/** 4 位十六进制指纹。收口之后还要唯一 —— 两个不同的 (server, tool) 不能塌成
    同一个名字，那会让模型调 A 实际执行 B（LoopEngine 的 toolsByName 是个 Map，
    撞名时静默保留最后一个）。"收口"有两条路会丢信息：净化（非法字符换下划线）
    和截断（超长砍掉尾巴），两条都要挂指纹 */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 4);
}

/** 工具名：mcp__<server>__<tool>，与 Claude Code 一致。
    加前缀是为了避开与内置工具撞名 —— 某台 server 完全可能提供一个叫 bash 的工具。
    模型侧的工具名只认 [A-Za-z0-9_-] 且有长度上限，越界的部分在这里收口。

    收口一旦丢信息就挂指纹（issue #156）。曾经指纹只挂在**长度**分支上，
    于是净化那条路是敞开的：server id `foo.bar` 和 `foo_bar` 都产出
    `mcp__foo_bar__x`，离 64 字符远得很，指纹永远不触发——正是上面那条注释
    禁止的"调 A 执行 B"。prompt 那边（mcpPromptMenu.ts）当初就把 server 编进了
    id，所以这是两处不一致，不是没想到。

    分隔符 `__` 自己也会塌：("a_", "b") 和 ("a", "_b") 都拼成 `mcp__a___b`，
    ("a__b", "c") 和 ("a", "b__c") 都拼成 `mcp__a__b__c`——一个字符都没被
    净化换掉，长度也远没到上限。判据因此不是"有没有被改"，而是"这个名字还
    读得回原来那两截吗"：server 那一截里不含 `__`、也不以 `_` 结尾时，
    前缀之后的第一个 `__` 就一定是真分隔符，读得回去；否则读不回去。

    指纹算在**原始**的 `server\u0000tool` 上，不是算在净化后的字符串上：
    净化后再算等于把已经塌掉的两个名字喂给同一个哈希，指纹也跟着塌。
    `\u0000` 当分隔符是同一个道理——它不可能出现在任何一侧。 */
export function mcpToolName(server: string, tool: string, salt = 0): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeServer = safe(server);
  const safeTool = safe(tool);
  const full = `mcp__${safeServer}__${safeTool}`;
  // 读得回原来那两截、也不超长 = 这个名字完整地表达了它自己，不必加料。
  // salt > 0 = 上一轮产出的名字与别的工具撞了（assignMcpToolNames），
  // 换哈希输入重试——faithful 捷径此时必须关掉，不然重试永远产出同一个名字
  const faithful =
    salt === 0 &&
    safeServer === server &&
    safeTool === tool &&
    !safeServer.includes("__") &&
    !safeServer.endsWith("_");
  if (faithful && full.length <= NAME_MAX) return full;
  const fp = fingerprint(`${server}\u0000${tool}${salt > 0 ? `\u0000${salt}` : ""}`);
  // "_" + 4 位 = 5 个字符
  return full.length + 5 <= NAME_MAX
    ? `${full}_${fp}`
    : `${full.slice(0, NAME_MAX - 5)}_${fp}`;
}

/** 整桌 MCP 工具的模型可见名统一分配（issue #349）——名字必须在**全体**里唯一，
    逐个独立算保证不了：净化/截断把不同原名折到同一串时指纹只有 16 位，撞上
    就是"调 A 执行 B"。三条规则（codex normalize_tools_for_model 同款）：
    ① 完全相同的原始身份（同 server 名 + 同 tool 名）去重跳过——返回 null，
      调用方不重复注册
    ② 名字冲突：换哈希输入（salt 递增）重试直到唯一
    ③ raw 名（协议回调用）不在这管——它跟着 server.id + tool 原名走闭包，
      本函数只管模型可见的那一套 ID
    返回数组与入参一一对应；顺序敏感（salt 依赖先来后到），同一份清单
    永远同一份分配——approvalPreview 反查时用同一函数重算即可对上 */
export function assignMcpToolNames(
  pairs: readonly { server: string; tool: string }[]
): (string | null)[] {
  const seenRaw = new Set<string>();
  const used = new Set<string>();
  return pairs.map(({ server, tool }) => {
    const rawId = `${server}\u0000${tool}`;
    if (seenRaw.has(rawId)) return null;
    seenRaw.add(rawId);
    let name = mcpToolName(server, tool);
    for (let salt = 1; used.has(name); salt++) {
      name = mcpToolName(server, tool, salt);
    }
    used.add(name);
    return name;
  });
}

/** 自助配置三件套的模型可见名（spec §5.2 / issue #473）。挂载条件是「装配有
    mcp 能力」，与有没有连上 server 无关——known 名单必须同样无条件认得它们，
    否则子 agent frontmatter 里点名会落进 unknownTools 被静默剔除：一条写得出、
    看起来生效、实际被吞掉的配置。字符串必须与 tools/mcpCatalog.ts /
    mcpConfigure.ts / mcpAuthorize.ts 的 def.name 逐字一致——
    tests/shared/mcp.test.ts 有一致性钉子，改名会先红在那 */
export const MCP_SELF_CONFIG_TOOL_NAMES = ["mcp_catalog", "mcp_configure", "mcp_authorize"] as const;

/** 「此刻认得哪些 MCP 系工具名」的纯逻辑（issue #473，从 index.ts 的
    mcpToolNamesNow 拎出来才测得到）。自助配置三件套 + mcp_read_resource
    无条件在列（挂载条件都是"有 mcp 能力"，零 server 也挂）；server 提供的
    工具只算 live 的，但名字分配跑在**全体**上再滤（issue #349）：撞名的哈希
    后缀取决于整桌顺序，与 createMcpTools（装配时也是全体）同一份分配才对得上号 */
export function knownMcpToolNames(
  servers: readonly { name: string; live: boolean; tools: readonly { name: string }[] }[]
): string[] {
  const all = servers.flatMap((s) => s.tools.map((t) => ({ server: s.name, tool: t.name, live: s.live })));
  const names = assignMcpToolNames(all.map(({ server, tool }) => ({ server, tool })));
  return [
    ...MCP_SELF_CONFIG_TOOL_NAMES,
    "mcp_read_resource",
    ...all.flatMap((e, i) => (e.live && names[i] !== null ? [names[i]!] : [])),
  ];
}

/** content 数组压成喂给模型的字符串。
    image 不进视觉桥（ADR-0009 的附件库是另一条路），折成一行说明 ——
    但必须说出来：模型该知道"有一张图我没给你看"，而不是以为工具返回了空。
    图本身会入附件库、在时间线上出卡（#594 的 imagesOf → imageIntake），
    所以这句话要点明"用户看得见"：模型据此才知道自己可以就这张图和人对话，
    而不是以为这次调用什么都没产出。 */
export function renderMcpContent(content: readonly McpContent[]): string {
  if (content.length === 0) return "(工具没有返回任何内容)";
  return content
    .map((c) => {
      if (c.kind === "text") return c.text;
      if (c.kind === "image")
        return `(server 返回了一张 ${c.mimeType} 图片：已显示给用户，你自己看不到内容)`;
      const head = `[${c.uri}${c.mimeType ? ` · ${c.mimeType}` : ""}]`;
      return c.text ? `${head}\n${c.text}` : `${head}(无正文)`;
    })
    .join("\n\n");
}

/** 一台 server 刚连上时，回给模型的那句"新工具什么时候能用"。
    mcp_configure / mcp_authorize 共用一份（终审 B Important）。

    工具表是按 turn 重算的（engine.rebuildTools() 在下一个 turn 才跑），所以
    刚连上的那几把**这一轮不在模型的工具表里**：模型照着"可用工具 3 个：
    list_tables、execute_sql、apply_migration"在同一轮直接调，命中的是"未知
    工具"。逃生舱也不通——tool_search 的 listDeferred 闭包捕获的是这一轮的
    list（agent.ts）。

    设计上就是"下一个 turn 生效"（spec §5.2），实现也对；出问题的是没人告诉
    模型。所以这句话必须点明"从用户的下一条消息开始"和"本轮不要直接调"。 */
export function mcpNewToolsNotice(toolNames: readonly string[]): string {
  const list = toolNames.length === 0 ? "（这台没有暴露工具）" : toolNames.join(" / ");
  return (
    `新增 ${toolNames.length} 把工具（${list}）。` +
    "它们从**用户的下一条消息**开始才会出现在你的工具列表里——" +
    "本轮请先把结果告诉用户，不要在这一轮直接调用它们。"
  );
}

/** mcp_configure / mcp_authorize 共用的收尾通报（#474：从前两把刀各写一遍
    「查这台现状并报工具数」，平行实现迟早漂移）。connected / notConnected
    是两把刀各自的措辞前缀；needsAuth 只有 configure 用（authorize 收尾时
    还 needs-auth 就是失败，走 notConnected 那句）。 */
export function mcpOutcomeReport(
  hit: { live: boolean; status: string; tools: readonly { name: string }[]; error?: string } | undefined,
  wording: { connected: string; notConnected: string; needsAuth?: string }
): string {
  if (hit?.live) return `${wording.connected}，${mcpNewToolsNotice(hit.tools.map((t) => t.name))}`;
  if (wording.needsAuth !== undefined && hit?.status === "needs-auth") return wording.needsAuth;
  return `${wording.notConnected}：${hit?.error ?? "原因未知"}`;
}

/** 遮罩凭据。键名保留 —— 用户要认出"这一格配的是哪一把"（同 ADR-0044 的判断） */
export function maskMcpConfig(cfg: McpServerConfig): McpServerConfig {
  const maskAll = (r: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskKey(v)]));
  return cfg.kind === "stdio"
    ? { ...cfg, env: maskAll(cfg.env) }
    : { ...cfg, headers: maskAll(cfg.headers) };
}

/** 归一化 + 校验一个 http 传输的 url（Task 9 审查 Critical 1）。
    WHATWG 的 URL 解析器会在解析**之前**把输入里所有的 ASCII tab / LF / CR
    悄悄剥掉：`"https://good.com" + "\n".repeat(30) + "@evil.com/mcp"` 解析出
    的 host 是 evil.com。如果写盘的、审批卡上显示的都是那个带隐藏换行的原始
    字符串，用户读到的是掉在滚动框可视范围内的 "https://good.com"，而
    "@evil.com/mcp" 被换行推到看不见的地方——审批等于在给一个他没读到的主机
    签字。所以：含这类字符直接拒绝（合法的 MCP 端点不会有它们），而不是
    静默吃掉后再归一化——静默归一化会把"模型/用户的错误输入"伪装成
    "系统悄悄接受了一次改写"。

    返回值统一是 `URL.href`：写盘的配置、mcp_configure 的审批预览，都必须
    是同一个归一化后的字符串——不存在"原始串"和"解析后"两种读法的空间。 */
export function normalizeMcpHttpUrl(url: string): string {
  if (/[\t\r\n]/.test(url)) {
    throw new Error(
      "url 里不能有制表符或换行——它们会被 URL 解析器悄悄吃掉，卡片上看到的和实际连的会是两个地址"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`url 不是合法的地址：${url}`);
  }
  // 只认 http/https：file:// / data: 之类在这里没有任何正当用途，
  // 而它们能让一次"配置 MCP"变成读本地文件的惊喜面
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`url 只支持 http/https，收到的是 ${parsed.protocol}`);
  }
  // 拒绝非空的 userinfo（Task 9 复审 Critical A）：控制字符那条路堵上之后，
  // 同一个漏洞换个填充字符仍然完全可利用——
  // "https://mcp.supabase.com" + ".".repeat(1400) + "@evil.com/mcp" 解析出的
  // host 是 evil.com，而这个 href 逐字节等于输入本身（没有隐藏字符可剥），
  // 卡片上折叠线以上看到的却是 "https://mcp.supabase.com...."。合法的 MCP
  // 端点不会带 userinfo——OAuth 正是这个功能存在的理由，这里没有正当用途。
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "url 里不能带用户名/密码段（@ 之前的部分）——它会让地址栏看起来是一个主机、实际连的是另一个"
    );
  }
  return parsed.href;
}
