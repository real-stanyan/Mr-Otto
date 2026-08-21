// MCP 客户端 —— **本仓唯一** import @modelcontextprotocol/sdk 的文件。
// 把 SDK 锁在一个文件里的理由：依赖树上多一棵树是有成本的,将来换实现只动这一处;
// 而且 mcpHub 因此可以完全不碰 SDK,状态机能用假 connect 测干净。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpServerConfig, McpToolInfo,
} from "../shared/mcp.js";

/** 需要授权 —— hub 据此把状态标成 needs-auth 而不是 failed。
    两者对用户的意思完全不同：一个是"你去点一下授权",一个是"这台坏了"。 */
export class McpAuthRequiredError extends Error {}

/** 一条连上的 MCP 连接。hub 只认这个形状,不认 SDK。 */
export interface McpClientConn {
  readonly tools: McpToolInfo[];
  readonly resources: McpResourceInfo[];
  readonly prompts: McpPromptInfo[];
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<string>;
  /** server 说"我的清单变了" —— hub 收到就重拉 */
  onListChanged(cb: () => void): void;
  close(): Promise<void>;
}

type RawContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string } };

/** SDK 的 content 形状 → 本仓的 McpContent。认不得的类型折成一行说明,不静默丢 */
function toContent(raw: unknown): McpContent[] {
  const arr = Array.isArray(raw) ? (raw as RawContent[]) : [];
  return arr.map((c): McpContent => {
    if (c.type === "text") return { kind: "text", text: c.text ?? "" };
    if (c.type === "image") return { kind: "image", data: c.data ?? "", mimeType: c.mimeType ?? "image/png" };
    if (c.type === "resource") {
      return {
        kind: "resource",
        uri: c.resource?.uri ?? "",
        ...(c.resource?.text !== undefined ? { text: c.resource.text } : {}),
        ...(c.resource?.mimeType !== undefined ? { mimeType: c.resource.mimeType } : {}),
      };
    }
    return { kind: "text", text: `(server 返回了本版认不得的内容类型：${c.type})` };
  });
}

const looksLikeAuth = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b401\b|unauthor|forbidden|\b403\b/i.test(msg);
};

/** 连一台 server,握手 + 拉三份清单。失败原样抛(hub 负责分类) */
export async function connectMcpClient(id: string, cfg: McpServerConfig): Promise<McpClientConn> {
  const client = new Client({ name: "mr-otto", version: "1.0.0" }, { capabilities: {} });

  const transport =
    cfg.kind === "stdio"
      ? new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          // 继承当前环境再叠用户配的 —— npx 要 PATH 才跑得起来
          env: { ...(process.env as Record<string, string>), ...cfg.env },
        })
      : new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers },
        });

  try {
    // as unknown as Transport：SDK 的 StreamableHTTPClientTransport.sessionId
    // 是个 `get sessionId(): string | undefined` 的 getter，而 Transport 接口
    // 把它声明成 `sessionId?: string`——本仓开了 exactOptionalPropertyTypes，
    // 两者在这条属性上结构性对不上。SDK 没为这个选项写过,不是我们代码的错,
    // 这里断言掉，不因此放松 tsconfig。
    await client.connect(transport as unknown as Transport);
  } catch (e) {
    if (looksLikeAuth(e)) throw new McpAuthRequiredError(`${id} 需要授权：${String(e)}`);
    throw e;
  }

  // 三份清单：server 没声明对应 capability 时 SDK 会抛,那不是错,是"这台没有这项"
  const safe = async <T>(f: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return empty;
    }
  };

  const conn: McpClientConn = {
    tools: [],
    resources: [],
    prompts: [],
    async callTool(name, args, signal) {
      const r = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        signal ? { signal } : undefined
      );
      return toContent((r as { content?: unknown }).content);
    },
    async readResource(uri, signal) {
      const r = await client.readResource({ uri }, signal ? { signal } : undefined);
      const contents = (r as { contents?: { uri?: string; text?: string; mimeType?: string }[] }).contents ?? [];
      return contents.map((c) => ({
        kind: "resource" as const,
        uri: c.uri ?? uri,
        ...(c.text !== undefined ? { text: c.text } : {}),
        ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
      }));
    },
    async getPrompt(name, args) {
      const r = await client.getPrompt({ name, arguments: args });
      const msgs = (r as { messages?: { content?: unknown }[] }).messages ?? [];
      return msgs.flatMap((m) => toContent([m.content])).map((c) => (c.kind === "text" ? c.text : "")).join("\n\n").trim();
    },
    onListChanged(cb) {
      // 用 SDK 导出的真 schema 注册处理器 —— setNotificationHandler 内部靠
      // schema 的 zod shape 取 method 字面量，喂一个手写的 `{ method: "..." }`
      // 字面量对象会在运行时抛"Schema is missing a method literal"。
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { cb(); });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { cb(); });
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => { cb(); });
    },
    close: () => client.close(),
  };

  // refresh 是可变的：list_changed 之后 hub 会再叫一次
  const mutable = conn as { tools: McpToolInfo[]; resources: McpResourceInfo[]; prompts: McpPromptInfo[] };
  const refresh = async () => {
    const t = await safe(() => client.listTools(), { tools: [] });
    const r = await safe(() => client.listResources(), { resources: [] });
    const p = await safe(() => client.listPrompts(), { prompts: [] });
    mutable.tools = (t.tools ?? []).map((x) => ({
      name: x.name, description: x.description ?? "", inputSchema: x.inputSchema ?? { type: "object" },
    }));
    mutable.resources = (r.resources ?? []).map((x) => ({
      uri: x.uri, name: x.name ?? x.uri,
      ...(x.description !== undefined ? { description: x.description } : {}),
      ...(x.mimeType !== undefined ? { mimeType: x.mimeType } : {}),
    }));
    mutable.prompts = (p.prompts ?? []).map((x) => ({
      name: x.name,
      ...(x.description !== undefined ? { description: x.description } : {}),
      arguments: (x.arguments ?? []).map((a) => ({
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.required !== undefined ? { required: a.required } : {}),
      })),
    }));
  };
  await refresh();
  (conn as { refresh?: () => Promise<void> }).refresh = refresh;

  return conn;
}
