// MCP server 清单 —— ~/.otter/mcp.json 的解析与写回。
// 格式与 Claude Code 的 .mcp.json 兼容（同名字段同语义），用户能把已有配置直接粘过来。
// 解析是纯函数，fs 以接口注入（抄 skills.ts 的 SkillDirReader 形状），测试喂假实现。
// 主进程模块（组装根特权可碰 fs）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServerConfig } from "../shared/mcp.js";

export interface McpConfigReader {
  /** 文件全文；不存在/读不了 = 空串（"没配过"不是错） */
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

const nodeReader: McpConfigReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
  writeFile(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    // 0600：文件里有 env/headers 里的凭据，与 keys.json 同一档待遇
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600); // mode 只在新建时生效，已有文件补一刀
  },
};

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const asStringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, x]) => [k, String(x)]));
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** 解析。一台坏的不带垮其它台 —— 用户手写的文件，一个 typo 不该让全部 server 消失。
    错误结构化回流，由设置页显示，不抛（同 protocolListIssues 的降级口径）。 */
export function parseMcpConfig(text: string): {
  servers: Record<string, McpServerConfig>;
  errors: string[];
} {
  if (text.trim() === "") return { servers: {}, errors: [] };

  let root: Raw;
  try {
    root = asRecord(JSON.parse(text));
  } catch {
    return { servers: {}, errors: ["mcp.json 不是合法 JSON，整份配置本次被忽略"] };
  }

  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  for (const [id, node] of Object.entries(asRecord(root["mcpServers"]))) {
    const s = asRecord(node);
    const hasCommand = typeof s["command"] === "string" && s["command"] !== "";
    const hasUrl = typeof s["url"] === "string" && s["url"] !== "";
    const enabled = s["enabled"] !== false;

    if (hasCommand && hasUrl) {
      errors.push(`${id}：command 和 url 同时给了，无法判断走 stdio 还是 http（不猜，本台跳过）`);
      continue;
    }
    if (hasCommand) {
      servers[id] = {
        kind: "stdio",
        command: String(s["command"]),
        args: asStringArray(s["args"]),
        env: asStringMap(s["env"]),
        enabled,
      };
    } else if (hasUrl) {
      servers[id] = {
        kind: "http",
        url: String(s["url"]),
        headers: asStringMap(s["headers"]),
        enabled,
      };
    } else {
      errors.push(`${id}：既没有 command 也没有 url，不知道怎么连（本台跳过）`);
    }
  }

  return { servers, errors };
}

/** 写回。**在 prev 的基础上改**，不是重新生成 ——
    用户可能手写了本版不认识的键（timeout、$schema、注释性字段），替他删掉是数据损失。 */
export function serializeMcpConfig(
  prevText: string,
  servers: Record<string, McpServerConfig>
): string {
  let root: Raw;
  try {
    root = prevText.trim() === "" ? {} : asRecord(JSON.parse(prevText));
  } catch {
    root = {}; // prev 坏了不能吞掉这次保存，从空对象重建
  }

  const prevServers = asRecord(root["mcpServers"]);
  const next: Raw = {};

  for (const [id, cfg] of Object.entries(servers)) {
    const keep = asRecord(prevServers[id]);
    // 本版认识的键全部重写，其余原样留着
    for (const k of ["command", "args", "env", "url", "headers", "enabled"]) delete keep[k];
    const written: Raw =
      cfg.kind === "stdio"
        ? { command: cfg.command, args: cfg.args, env: cfg.env }
        : { url: cfg.url, headers: cfg.headers };
    if (!cfg.enabled) written["enabled"] = false; // true 是缺省，写了是噪音
    next[id] = { ...keep, ...written };
  }

  root["mcpServers"] = next;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function loadMcpConfig(
  path: string,
  reader: McpConfigReader = nodeReader
): { servers: Record<string, McpServerConfig>; errors: string[] } {
  return parseMcpConfig(reader.readFile(path));
}

export function saveMcpConfig(
  path: string,
  servers: Record<string, McpServerConfig>,
  reader: McpConfigReader = nodeReader
): void {
  reader.writeFile(path, serializeMcpConfig(reader.readFile(path), servers));
}
