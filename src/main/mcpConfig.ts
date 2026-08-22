// MCP server 清单 —— ~/.mr-otto/mcp.json 的解析与写回。
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
    错误结构化回流，由设置页显示，不抛（同 protocolListIssues 的降级口径）。

    `unrecognizedIds`：单条节点识别失败（command/url 缺失或冲突）的那些 id。
    这份清单不是给人看的，是给 serializeMcpConfig 用的回执——那台 server
    没能解析进 `servers`，不代表它该从磁盘上消失，写回时得靠这份 id 清单
    把它的原始节点从 prevText 里原样捞回来（见 serializeMcpConfig 的用法,
    F1 half 1）。整份 JSON 都解析不动时（errors 只有一条"不是合法 JSON"）
    这里永远是空数组——那种情形下我们连一个 id 都取不出来，得靠
    serializeMcpConfig 那边的另一道闸（F1 half 2：prevText 本身解析不动
    时拒绝写）来兜底。

    `fatal`：整份 JSON 都解析不动。**"读不出 server" 和 "这份文件说没有 server"
    是两件事**，调用方必须能分开（issue #159）。分不开的时候 mcpHub.syncFromDisk
    会把 `servers: {}` 当成"用户把所有 server 都删了"，于是把活着的连接一条条
    关掉、从内存里忘掉——用户什么提示都看不到，直到下次打开设置页。
    空文件不是 fatal：那是货真价实的"还没配过"。 */
export function parseMcpConfig(text: string): {
  servers: Record<string, McpServerConfig>;
  errors: string[];
  unrecognizedIds: string[];
  fatal: boolean;
} {
  if (text.trim() === "") return { servers: {}, errors: [], unrecognizedIds: [], fatal: false };

  let root: Raw;
  try {
    root = asRecord(JSON.parse(text));
  } catch {
    return {
      servers: {},
      errors: ["mcp.json 不是合法 JSON，整份配置本次被忽略"],
      unrecognizedIds: [],
      fatal: true,
    };
  }

  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];
  const unrecognizedIds: string[] = [];

  for (const [id, node] of Object.entries(asRecord(root["mcpServers"]))) {
    const s = asRecord(node);
    const hasCommand = typeof s["command"] === "string" && s["command"] !== "";
    const hasUrl = typeof s["url"] === "string" && s["url"] !== "";
    const enabled = s["enabled"] !== false;

    if (hasCommand && hasUrl) {
      errors.push(`${id}：command 和 url 同时给了，无法判断走 stdio 还是 http（不猜，本台跳过）`);
      unrecognizedIds.push(id);
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
      unrecognizedIds.push(id);
    }
  }

  return { servers, errors, unrecognizedIds, fatal: false };
}

/** 写回。**在 prev 的基础上改**，不是重新生成 ——
    用户可能手写了本版不认识的键（timeout、$schema、注释性字段），替他删掉是数据损失。

    `unrecognizedIds`（parseMcpConfig 同名字段的直接传递，见那边注释）：
    这些 id 没能解析进 `servers`，但它们不是"被删掉的"——调用方（mcpHub）
    压根不知道它们的存在，`servers` 参数里自然也不会有它们的位置。不把
    它们原样放回 next，下面这段全新 next 的写法就会把它们静默冲掉：
    保存/删除任何一台*认识*的 server 都会带上"整份 mcpServers 被重新生成，
    这些 id 不在其中"的副作用（F1 half 1 —— 原本的写法就是这么把 broken
    sibling 写没的）。 */
export function serializeMcpConfig(
  prevText: string,
  servers: Record<string, McpServerConfig>,
  unrecognizedIds: readonly string[] = []
): string {
  const hadPrev = prevText.trim() !== "";
  let root: Raw;
  try {
    root = hadPrev ? asRecord(JSON.parse(prevText)) : {};
  } catch {
    // prev 非空但解析不动：**拒绝这次写**，不能像从前那样从空对象重建——
    // 从空对象重建等于承认"我们不知道这份文件里原来有什么，所以干脆假装
    // 它是空的"，而磁盘上大概率还留着别的 server（含凭据）。整份都解析
    // 不动时我们连一个 id 都取不出来，没法像 unrecognizedIds 那样逐条
    // 保留——唯一诚实的选择是不写，把"文件坏了"这件事甩回给调用方
    // （F1 half 2；调用方 mcpHub.save/remove 让这个错误原样穿透到 IPC，
    // 落地到设置页的 saveError，同一条注释见 mcpHub.ts）。
    if (hadPrev) {
      throw new Error(
        "mcp.json 当前不是合法 JSON，为避免连带删掉其余内容，这次保存已取消——请先手动修好这份文件（或删掉它重新配置）"
      );
    }
    root = {};
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

  // 解析不动的那几台原样放回去——见上方注释，它们不在 `servers` 里
  // 不代表被删，只是这一轮没认出来
  for (const id of unrecognizedIds) {
    if (id in next) continue; // 不该发生（unrecognizedIds 和 servers 天然不相交），双重保险
    if (id in prevServers) next[id] = prevServers[id];
  }

  root["mcpServers"] = next;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function loadMcpConfig(
  path: string,
  reader: McpConfigReader = nodeReader
): { servers: Record<string, McpServerConfig>; errors: string[]; unrecognizedIds: string[]; fatal: boolean } {
  return parseMcpConfig(reader.readFile(path));
}

export function saveMcpConfig(
  path: string,
  servers: Record<string, McpServerConfig>,
  unrecognizedIds: readonly string[] = [],
  reader: McpConfigReader = nodeReader
): void {
  // serializeMcpConfig 可能抛（prevText 解析不动，F1 half 2）——不接住，
  // 原样穿透给调用方（mcpHub.save/remove），最终经 IPC 落到设置页的报错
  reader.writeFile(path, serializeMcpConfig(reader.readFile(path), servers, unrecognizedIds));
}
