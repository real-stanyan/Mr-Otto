// MCP 客户端 —— **本仓唯一** import @modelcontextprotocol/sdk 的文件。
// 把 SDK 锁在一个文件里的理由：依赖树上多一棵树是有成本的,将来换实现只动这一处;
// 而且 mcpHub 因此可以完全不碰 SDK,状态机能用假 connect 测干净。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
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
  /** 重拉三份清单。可选是因为它是内部实现细节的把手，不是每个 McpClientConn
      的消费者都需要——但既然 hub 要跨模块边界调它，就必须写进这个接口，
      不能靠 hub 那边一个不受类型检查的 cast 去够一个"其实不存在"的字段。 */
  refresh?(): Promise<void>;
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

/** 判断一次连接失败是不是"要授权"。优先认 SDK 给的类型信号——
    StreamableHTTPClientTransport 在 POST 分支的 401/403 上抛 StreamableHTTPError，
    状态码在 .code 而不在 .message 里（构造函数把 message 包了一层前缀，
    正则永远配不上纯数字状态码）；GET/SSE 分支和一部分 auth() 内部路径抛
    UnauthorizedError。正则留着兜底——万一某个 transport/server 组合两个
    类型都不抛，只在文本里说了"unauthorized"这种情况 */
const isAuthError = (e: unknown): boolean => {
  if (e instanceof UnauthorizedError) return true;
  if (e instanceof StreamableHTTPError) return e.code === 401 || e.code === 403;
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
          // 只传用户为这台 server 配的 env——PATH/HOME/... 这类安全白名单由
          // SDK 自己在 spawn 时补在下面（stdio.js 的 start()：
          // `env: { ...getDefaultEnvironment(), ...this._serverParams.env }`，
          // 名单抄的是 sudo 的默认继承表，只有 6~12 个变量）。
          // 这里如果传一整份 process.env，等于把那份安全白名单整个盖掉——
          // 而 index.ts 的 applyToEnv(loadKeys(...), process.env) 早就把
          // DeepSeek/Claude/GLM 等模型 key 的明文写进了 process.env，相当于
          // 把用户的模型账号双手奉上给任意一个用户自己配置的第三方 npx 包。
          env: cfg.env,
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
    if (isAuthError(e)) throw new McpAuthRequiredError(`${id} 需要授权：${String(e)}`);
    throw e;
  }

  // initialize 握手成功后才有值——按 server 实际声明的 capability 决定拉不拉，
  // 不是"拉了失败就当没有"。这两码事对用户是不同的：真没有这项能力，跟声明了
  // 却因为传输死掉/超时/握手后 401 拉不到，前者该显示"这台没有 prompts"，
  // 后者该显示这台连接失败——不该被悄悄吞成一个状态健康、清单空空如也的 server。
  const caps = client.getServerCapabilities();

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

  // tools/resources/prompts 声明成 readonly 是给外部看的——hub 只读不改。
  // refresh() 内部要写，借一个宽类型的引用绕开 readonly，写的仍是同一个对象。
  const mutable = conn as { tools: McpToolInfo[]; resources: McpResourceInfo[]; prompts: McpPromptInfo[] };
  const refresh = async () => {
    // 没声明这项 capability = 真没有，给空数组，不发请求。
    // 声明了却调用失败 = 故障，原样抛出去，不在这里吞。
    const t = caps?.tools ? await client.listTools() : { tools: [] };
    const r = caps?.resources ? await client.listResources() : { resources: [] };
    const p = caps?.prompts ? await client.listPrompts() : { prompts: [] };
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
  // 首次拉取失败要原样抛出去：调用方（connectOne）的 try/catch 会把这台标成
  // failed/needs-auth，而不是把"握手成功但清单没拉到"误报成"一切正常"。
  await refresh();
  // refresh 现在是 McpClientConn 的一等公民（见上方接口声明），直接赋值即可，
  // 不需要再拿一个不受类型检查的 cast 去够一个接口里本不存在的字段。
  conn.refresh = refresh;

  return conn;
}
