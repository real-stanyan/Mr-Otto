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

const NAME_MAX = 64;

/** 4 位十六进制指纹。截断后还要唯一 —— 两个前 60 个字符相同的长工具名
    不能塌成同一个名字，那会让模型调 A 实际执行 B */
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
    模型侧的工具名只认 [A-Za-z0-9_-] 且有长度上限，越界的部分在这里收口。 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${safe(server)}__${safe(tool)}`;
  if (full.length <= NAME_MAX) return full;
  return `${full.slice(0, NAME_MAX - 5)}_${fingerprint(full)}`;
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
