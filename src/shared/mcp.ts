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
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeServer = safe(server);
  const safeTool = safe(tool);
  const full = `mcp__${safeServer}__${safeTool}`;
  // 读得回原来那两截、也不超长 = 这个名字完整地表达了它自己，不必加料
  const faithful =
    safeServer === server &&
    safeTool === tool &&
    !safeServer.includes("__") &&
    !safeServer.endsWith("_");
  if (faithful && full.length <= NAME_MAX) return full;
  const fp = fingerprint(`${server}\u0000${tool}`);
  // "_" + 4 位 = 5 个字符
  return full.length + 5 <= NAME_MAX
    ? `${full}_${fp}`
    : `${full.slice(0, NAME_MAX - 5)}_${fp}`;
}

/** content 数组压成喂给模型的字符串。
    image 本版不进视觉桥（ADR-0009 的附件库是另一条路），折成一行说明 ——
    但必须说出来：模型该知道"有一张图我没给你看"，而不是以为工具返回了空。 */
export function renderMcpContent(content: readonly McpContent[]): string {
  if (content.length === 0) return "(工具没有返回任何内容)";
  return content
    .map((c) => {
      if (c.kind === "text") return c.text;
      if (c.kind === "image") return `(server 返回了一张 ${c.mimeType} 图片，本版不展开)`;
      const head = `[${c.uri}${c.mimeType ? ` · ${c.mimeType}` : ""}]`;
      return c.text ? `${head}\n${c.text}` : `${head}(无正文)`;
    })
    .join("\n\n");
}

/** 遮罩凭据。键名保留 —— 用户要认出"这一格配的是哪一把"（同 ADR-0044 的判断） */
export function maskMcpConfig(cfg: McpServerConfig): McpServerConfig {
  const maskAll = (r: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskKey(v)]));
  return cfg.kind === "stdio"
    ? { ...cfg, env: maskAll(cfg.env) }
    : { ...cfg, headers: maskAll(cfg.headers) };
}
