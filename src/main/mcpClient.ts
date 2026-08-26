// MCP 客户端 —— **src/ 下唯一** import @modelcontextprotocol/sdk 的文件
// （测试为了拿到真错误实例做 instanceof 断言，另外 import 了一份，见 mcpClient.test.ts）。
// 把 SDK 锁在一个文件里的理由：依赖树上多一棵树是有成本的,将来换实现只动这一处;
// 而且 mcpHub 因此可以完全不碰 SDK,状态机能用假 connect 测干净。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpServerConfig, McpToolInfo,
} from "../shared/mcp.js";
import type { McpAuthRecord } from "./mcpAuthStore.js";
import { startLoopback, AUTH_TIMEOUT_MS } from "./mcpOAuth.js";

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
  /** 同步杀掉底层子进程(SIGKILL)。close() 走协议层优雅关闭——SDK 的
      StdioClientTransport.close() 先 stdin.end()，等 2s 空转定时器才补
      SIGTERM，再等 2s 才 SIGKILL；那两个定时器在 app 退出时永远没机会触发
      （before-quit 一返回 Electron 就继续退出流程），子进程就被留成孤儿。
      kill() 是给"不能等"的场景准备的逃生舱：stdio 场景直接按 pid 发
      SIGKILL，调用它的这一拍就已经生效，不需要 await。http 场景没有子
      进程可杀，是空操作——连接会随进程退出自然断开，没有东西需要收尾。 */
  kill(): void;
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
export const isAuthError = (e: unknown): boolean => {
  if (e instanceof UnauthorizedError) return true;
  if (e instanceof StreamableHTTPError) return e.code === 401 || e.code === 403;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b401\b|unauthor|forbidden|\b403\b/i.test(msg);
};

/** 把一次鉴权失败折成**不含自由文本**的短描述（#470）。
    这句话最终沿 McpAuthRequiredError → hub 的 e.error → tool_result 落进
    append-only 事件日志，而 SDK 在 token 端点失败时会把响应体原文塞进
    e.message（client/auth.js 的 parseErrorResponse："Raw body: ..."）——
    响应体里完全可能有凭据，日志删不掉，所以 message 一个字都不能带。
    白名单只放三样结构化信息：HTTP 状态码、OAuth spec 的 error code
    （invalid_grant / access_denied 这类，本身就是最有用的诊断）、错误类名。 */
export const describeAuthError = (e: unknown): string => {
  if (e instanceof StreamableHTTPError) return e.code === undefined ? "HTTP 状态码未知" : `HTTP ${e.code}`;
  // 鸭子类型认 SDK 的 OAuthError 子类（errorCode 是 spec 枚举串）——
  // 不 import server/auth 路径，client 侧只吃这个形状
  const code = (e as { errorCode?: unknown } | null | undefined)?.errorCode;
  if (typeof code === "string") return code;
  if (e instanceof Error) return e.name;
  return typeof e;
};

/** 两处 throw 共用的构造点——保证"需要授权"这句话永远只经 describeAuthError 措辞 */
export const authRequiredError = (id: string, e: unknown): McpAuthRequiredError =>
  new McpAuthRequiredError(`${id} 需要授权（${describeAuthError(e)}）`);

/** 只重写带服务端文本的 OAuthError（message 里可能有响应体原文），
    其余错误原样放行——SDK 自己的静态 message（不支持 DCR / 发现失败）和
    本仓的人话错误（loopback 超时）是安全且必要的诊断，不能一刀切丢掉。 */
export const scrubOAuthError = (e: unknown): unknown => {
  if (!(e instanceof Error)) return e;
  const code = (e as unknown as { errorCode?: unknown }).errorCode;
  if (typeof code !== "string") return e;
  return new Error(`授权服务端返回错误：${code}（${e.name}；响应原文已略去，防止凭据进事件日志）`);
};

/** 连一台 server,握手 + 拉三份清单。失败原样抛(hub 负责分类) */
export async function connectMcpClient(
  id: string,
  cfg: McpServerConfig,
  authProvider?: OAuthClientProvider
): Promise<McpClientConn> {
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
          // 给了就走 OAuth：SDK 先用盘上的 access_token，过期自动 refresh，
          // refresh 也不行才抛 UnauthorizedError（→ hub 标 needs-auth）。
          // 不给 = 这台没配过 OAuth，照旧只用静态 header（老路径零改动）
          ...(authProvider ? { authProvider } : {}),
        });

  try {
    // as unknown as Transport：SDK 的 StreamableHTTPClientTransport.sessionId
    // 是个 `get sessionId(): string | undefined` 的 getter，而 Transport 接口
    // 把它声明成 `sessionId?: string`——本仓开了 exactOptionalPropertyTypes，
    // 两者在这条属性上结构性对不上。SDK 没为这个选项写过,不是我们代码的错,
    // 这里断言掉，不因此放松 tsconfig。
    await client.connect(transport as unknown as Transport);
  } catch (e) {
    // 不带原始错误文本（#470，见 describeAuthError）；非鉴权失败也过一遍
    // scrub——OAuthError 的 message 同样会沿 hub 的 e.error 进 tool_result
    if (isAuthError(e)) throw authRequiredError(id, e);
    throw scrubOAuthError(e);
  }

  // 留传输对象本身,不留 pid 数字——kill() 可能在连接建立后很久才被调用
  // (before-quit,可能是几小时后),这中间子进程完全可能已经自然退出。
  // 如果这里把 pid 存成一个数字快照，kill() 时那个号早被操作系统回收去
  // 给了别的进程——process.kill 对一个"存在但不是它"的 pid 不会抛，
  // 会成功杀死一个跟这台 MCP server 毫无关系的进程。
  // stdio.js 的 pid 是 getter（`get pid() { return this._process?.pid ?? null }`），
  // 子进程 close 时 SDK 自己把 _process 置 null（stdio.js:83）——所以在 kill()
  // 里现读 transport.pid 而不是在这里存一份快照，就白得了 SDK 自带的
  // 存活判断：子进程已经退出时，这里读到的就是 null，不会瞎杀。
  // instanceof 而不是 cfg.kind：cfg 在这里已经用不上了，transport 自己的
  // 运行时类型就是唯一可信来源，两者本该一致，用 instanceof 更直接。
  const stdioTransport = transport instanceof StdioClientTransport ? transport : null;

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
    kill: () => {
      // 现读，不用捕获的快照——见上方 stdioTransport 的注释：子进程已经
      // 自然退出时 SDK 把 pid 收回成 null，这里跟着读到 null 就什么也不做，
      // 而不是拿一个失效的数字去杀一个毫不相干的进程。
      const pid = stdioTransport?.pid;
      if (pid == null) return; // http 场景 / 子进程已经不在了:空操作(见接口注释)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 极小的竞态窗口：上面刚读到非 null 的 pid，这一行执行前进程恰好
        // 退出——kill 一个已经不存在的目标不是我们的错，也不该让 before-quit
        // 的收尾流程因为这一条而中断收别的 server
      }
    },
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
  //
  // 但这里的失败发生在 client.connect() 已经成功之后——SDK 只在 initialize
  // 阶段失败时自己收尾（client/index.js:311-316，catch 里 void this.close()）,
  // 握手之后的失败它不管。不在这里补一刀 client.close()，stdio 场景下就是
  // 让已经 spawn 出来的子进程永远挂着：conn 从没构造完、从没赋给 e.conn，
  // hub 手上根本没有能拿去 close() 的引用，closeAll()/remove() 都够不着它；
  // ready() 还会在下一轮重试同一台失败的 server，每次都再多孤儿一个进程。
  //
  // 同时,这一步失败也要过一遍鉴权分类：这里能抛出的典型场景正是"握手不需要
  // 授权,但方法调用需要"（服务端在 tools/list 上返回 401），也就是 I3 那次
  // 明确要求别再吞掉的那类真故障——它不是在 client.connect() 那次 try/catch
  // 里出现的,原来的分类只包住了握手那一步,这里得单独再分类一次,否则用户
  // 看到的是"这台坏了"而不是"去点一下授权"。
  try {
    await refresh();
  } catch (e) {
    // 关闭失败就吞掉,不能让一次收尾失败盖过更有信息量的原始错误
    await client.close().catch(() => {});
    if (isAuthError(e)) throw authRequiredError(id, e);
    throw scrubOAuthError(e);
  }
  // refresh 现在是 McpClientConn 的一等公民（见上方接口声明），直接赋值即可，
  // 不需要再拿一个不受类型检查的 cast 去够一个接口里本不存在的字段。
  conn.refresh = refresh;

  return conn;
}

/** 存取凭据的把手 + 开浏览器的把手。hub 注入真实现，测试注入假的 */
export interface McpOAuthDeps {
  read(): McpAuthRecord;
  write(patch: Partial<McpAuthRecord>): void;
  /** 丢掉盘上的动态客户端注册（保 tokens），见 needsFreshRegistration（#471）。
      真实现是 mcpAuthStore.dropMcpAuthClientRegistration */
  resetClientRegistration(): void;
  openBrowser(url: string): void;
}

/** 盘上的动态客户端注册还能不能用这次的 redirect_uri（#471）。
    注册只在盘上没有 clientInformation 时跑一次，注册进服务端的
    redirect_uris 绑着那一次的随机端口；loopback 每次授权都换端口，
    RFC 8252 §7.3 只是 SHOULD 允许 loopback 变端口——精确匹配的授权服务器
    （相当一部分企业 IdP）会直接 invalid_redirect_uri。老记录没存过
    redirectUri 的一律当过期：重注册的代价是多一次请求，误判"还能用"的
    代价是用户永远授不动、还没有界面能清。 */
export const needsFreshRegistration = (rec: McpAuthRecord, redirectUri: string): boolean =>
  rec.clientInformation !== undefined && rec.redirectUri !== redirectUri;

/** SDK 的 OAuthClientProvider 适配器 —— 本仓这一侧只负责"存哪、怎么开浏览器"。
    协议本身（元数据发现、动态客户端注册、PKCE、code 换 token、refresh 续期）
    全在 SDK 里，我们一行都不重写（spec §4）。

    SDK 类型（OAuthTokens / OAuthClientInformation）只在这个文件里出现：
    mcpAuthStore 用等价的 Record<string, unknown> 形状存盘，两边都是普通
    JSON 对象，适配就是下面这几处结构性断言（ADR-0050 的 SDK 单点 import）。 */
export function createOAuthProvider(
  opts: {
    redirectUri: string;
    state: string;
    /** false = 连接路径的 provider（#471）：token 过期且 refresh 失败时 SDK
        会在连接路径上跑完整 auth()，把盘上进行中授权的 codeVerifier 覆盖掉
        ——用户点完同意，finishAuth 拿新 verifier 去换旧 verifier 的 code，
        invalid_grant。连接路径只许写 tokens（refresh 续期要落盘），
        saveCodeVerifier / saveClientInformation 一律 no-op。缺省 true（授权路径）。 */
    persistFlowState?: boolean;
  } & Pick<McpOAuthDeps, "read" | "write" | "openBrowser">
): OAuthClientProvider {
  const persistFlow = opts.persistFlowState !== false;
  const metadata: OAuthClientMetadata = {
    client_name: "Mr Otto",
    redirect_uris: [opts.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // 公开客户端：桌面 app 藏不住 client_secret，安全性靠 PKCE 而不是密钥
    token_endpoint_auth_method: "none",
  };
  return {
    get redirectUrl() { return opts.redirectUri; },
    get clientMetadata() { return metadata; },
    state: () => opts.state,
    clientInformation: () => opts.read().clientInformation as OAuthClientInformation | undefined,
    saveClientInformation: (info) => {
      if (persistFlow) opts.write({ clientInformation: info as Record<string, unknown> });
    },
    tokens: () => opts.read().tokens as OAuthTokens | undefined,
    // 两处 as 的层数不同不是笔误（#474）：OAuthClientInformation 是纯
    // interface，与 Record<string, unknown> 结构兼容，单层 as 就够；
    // OAuthTokens 经过 zod 推导带了索引签名的交叉类型，TS 判定两边
    // "不够重叠"，得先过一趟 unknown
    saveTokens: (t) => { opts.write({ tokens: t as unknown as Record<string, unknown> }); },
    saveCodeVerifier: (v) => {
      if (persistFlow) opts.write({ codeVerifier: v });
    },
    codeVerifier: () => {
      const v = opts.read().codeVerifier;
      // 抛人话而不是返回 undefined：SDK 会把它直接塞进 token 请求，
      // 服务端回一句语焉不详的 invalid_grant，那比这句话难查十倍
      if (v === undefined) throw new Error("这台 server 还没发起过授权（缺 code_verifier），请重新点一次授权");
      return v;
    },
    redirectToAuthorization: (url) => { opts.openBrowser(url.toString()); },
  };
}

/** 跑完一次完整授权：开浏览器 → 等回调 → 换 token 落盘。
    成功返回即代表凭据已经在盘上，调用方（hub）接着 reconnect 即可。 */
export async function authorizeMcpServer(
  id: string,
  cfg: McpServerConfig,
  deps: McpOAuthDeps
): Promise<void> {
  if (cfg.kind !== "http") {
    // stdio 的凭据走 env，没有 OAuth 这回事——让调用方看到明确的话，
    // 而不是在 new URL(undefined) 那里炸一个看不懂的 TypeError
    throw new Error(`「${id}」是 stdio 传输的 server，凭据配在 env 里，没有 OAuth 授权这一步`);
  }
  const loopback = await startLoopback();
  try {
    // 二次授权（#471）：盘上的动态客户端注册绑着上一次的随机端口，精确匹配
    // redirect_uri 的授权服务器会拒——先丢注册（保 tokens）让 SDK 重跑一次
    // DCR，再记下这次用的 redirect_uri 供下一次对照
    if (needsFreshRegistration(deps.read(), loopback.redirectUri)) deps.resetClientRegistration();
    deps.write({ redirectUri: loopback.redirectUri });
    const provider = createOAuthProvider({
      redirectUri: loopback.redirectUri,
      state: loopback.state,
      read: deps.read,
      write: deps.write,
      openBrowser: deps.openBrowser,
    });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
      authProvider: provider,
    });
    const client = new Client({ name: "mr-otto", version: "1.0.0" }, { capabilities: {} });
    try {
      // 预期内的两种结局：
      // ① 抛 UnauthorizedError —— SDK 已经走完发现/注册/PKCE 并调过
      //    redirectToAuthorization（浏览器已经开了），"人已经送去授权页"
      //    就是这个异常的全部含义，不是故障
      // ② 不抛 —— 盘上的 token 还能用（或刚被 refresh 续上），这台其实
      //    不需要重新授权，关掉连接直接收工
      await client.connect(transport as unknown as Transport);
      await client.close();
      return;
    } catch (e) {
      // 这条路和下面 finishAuth 的失败最终都会变成 mcp_authorize 的
      // tool_result 落日志——OAuthError 的响应体原文在这里拦掉（#470）
      if (!(e instanceof UnauthorizedError)) throw scrubOAuthError(e);
    }
    const code = await loopback.waitForCode(AUTH_TIMEOUT_MS);
    // finishAuth 内部用盘上的 code_verifier 把 code 换成 token，
    // 换到之后走 provider.saveTokens 落盘。失败的典型场景正是 token 端点
    // 拒绝（invalid_grant），SDK 会把响应解析成 OAuthError——同样要 scrub
    try {
      await transport.finishAuth(code);
    } catch (e) {
      throw scrubOAuthError(e);
    }
    // 这条路关 transport 而上面成功路径关 client，不是笔误（#474）：
    // connect() 抛了 UnauthorizedError 之后，"client 是否已把这条传输接管
    // 到能被 close() 收到"取决于 SDK 在哪一步失败（protocol.js 是先赋
    // _transport 再 start()，但这属于内部实现，版本间可变）。transport
    // 是我们自己 new 的、必然在手上的把手，直接关它不赌 SDK 内部时序；
    // 成功路径 connect 已收尾完整，关 client 是官方出口
    await transport.close();
  } finally {
    // 成功路径里 waitForCode 已经关过一次；close() 是幂等的，
    // 这里兜的是"中途抛错"那条路——端口不能留着
    loopback.close();
  }
}
