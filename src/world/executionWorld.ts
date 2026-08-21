// ExecutionWorld — capability seam：工具能触碰的"世界"的全部
// 工具只依赖这个接口（AGENTS.md 硬规则），不知道背后是本机还是 Docker。
// v1: LocalWorld（本机）。v2: SandboxWorld（每 bot 一个容器，fork 时 docker commit）。

import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpStatus, McpToolInfo,
} from "../shared/mcp.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** exec 的可选项。signal（ADR-0006）：中止 = 杀死运行中的进程——
    实现必须 reject（AbortError 语义），不得把中断伪装成命令自己的失败。
    可选参数 = 接口向后兼容，旧实现/旧调用零改动 */
export interface ExecOptions {
  signal?: AbortSignal;
  /** 输出直播回调：子进程每吐一段就叫一次（到达顺序，stdout/stderr 分流标注）。
      直播是 UI 增强，不是事实——完整输出仍由 ExecResult 一次性返回并落盘，
      和 assistantDelta 同款边界：碎片永不进日志，日志只收凝固后的整体 */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface HttpPostOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** 一个活着的交互终端（PTY）。与 exec 的一次性命令是两回事：
    它有生命周期、双向流、窗口尺寸。纯人用——agent 看不见它（ADR-0031） */
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** 返回退订函数（与 ShellBridge 的订阅同构） */
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (exitCode: number) => void): () => void;
}

export interface OpenTerminalOptions {
  cols: number;
  rows: number;
  /** 缺省 = $SHELL，再缺省 = /bin/zsh */
  shell?: string;
}

/** 读一次内置浏览器。url 给了 = 先导航再读;不给 = 读当前页 */
export interface BrowserReadOptions {
  url?: string;
  signal?: AbortSignal;
}

export interface BrowserReadResult {
  /** 读完那一刻的实际 URL(重定向之后的)。以浏览器宿主为准,不采信页面自报 */
  url: string;
  title: string;
  text: string;
  /** 正文超上限被截断了。截了就明说,不假装读全了 */
  truncated: boolean;
  /** 本次请求的 url,只在它和实际读到的 url 不一致时才有:重定向,
      或者人在读取途中把这块共用的屏导去了别处。有值 = 正文属于 url 而不是
      requestedUrl,工具层要把这句话摆到模型眼前 */
  requestedUrl?: string;
}

/** 浏览器能力。只读——导航 + 抽正文,不点不打字(本期边界,工具名已把它划在名字里) */
export interface BrowserCapability {
  read(opts?: BrowserReadOptions): Promise<BrowserReadResult>;
}

/** 一台**配置过**的 server 及其能力。三个 list 是快照，不是订阅——
    server 发 list_changed 通知时由 hub 重新拉，工具层永远只看到当下这份。
    没连上时三个 list 是空的，live 为 false —— 工具层靠它决定 Tool.available()。 */
export interface McpServerHandle {
  id: string;
  name: string;
  status: McpStatus;
  /** status === "connected" 的糖。工具层只关心这一个布尔 */
  live: boolean;
  tools: readonly McpToolInfo[];
  resources: readonly McpResourceInfo[];
  prompts: readonly McpPromptInfo[];
}

export interface McpCapability {
  /** 把所有 enabled 的 server 连一遍，全部落定后 resolve。幂等：已连上的不重连。
      agent.ts 拼工具表之前 await 它 —— 工具表是一次性拼好的（挂载一次定终身），
      拼的时候必须已经知道每台提供了什么。 */
  ready(): Promise<void>;
  /** 全部**配置过**的 server，连没连上都在。
      挂载需要全集，可用性由每台的 live 决定。 */
  servers(): readonly McpServerHandle[];
  callTool(serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  getPrompt(serverId: string, name: string, args: Record<string, string>): Promise<string>;
}

export interface ExecutionWorld {
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** JSON POST——工具的全部网络面。v1 LocalWorld 用 fetch;v2 Docker 按 bot 走代理/断网 */
  http: {
    postJson(url: string, body: unknown, opts?: HttpPostOptions): Promise<unknown>;
  };
  /** 可选：这个世界开不开得了交互终端。
      可选 = 向后兼容（旧实现和测试里的假 world 零改动，同 ExecOptions 的先例）；
      缺这个字段 = 该世界没有终端能力，UI 据此不显示入口。
      v2 SandboxWorld 把它实现成 docker exec，用户终端自动落进那个 bot 的容器 */
  openTerminal?(opts: OpenTerminalOptions): Promise<TerminalSession>;
  /** 可选:这个世界有没有内置浏览器。
      可选的理由同 openTerminal(旧实现和测试里的假 world 零改动)。
      v1 的实现不在 LocalWorld 里——WebContentsView 是 Electron 主进程的东西,
      LocalWorld 是纯 Node 模块,造不出来,所以由 index.ts 从 browserHub 注入(withBrowser)。
      这与终端的方向是反的(终端是 hub 去调 world),因为 pty 是 LocalWorld 自己能干的活。
      v2 SandboxWorld 若在容器里跑浏览器,可以自己实现这个字段,注入那条线就自然退场。 */
  browser?: BrowserCapability;
  /** 可选:这个世界能不能连 MCP server。
      注入方向同 browser —— hub 要管子进程生命周期、要向渲染层推状态,
      LocalWorld 造不出来,由 index.ts 用 withMcp 焊进来(ADR-0035 同款)。
      v2 SandboxWorld 把 stdio server spawn 进容器,这一层接口一字不改。 */
  mcp?: McpCapability;
}

/** 把中断信号焊进 world 的装饰器（ADR-0006）。
    工具依旧只认 ExecutionWorld（硬规则）——它拿到的 world 天生带信号，
    自己无感。fs 不绑：读写是瞬时操作，中断收益为零。 */
export function withAbortSignal(world: ExecutionWorld, signal: AbortSignal): ExecutionWorld {
  return {
    fs: world.fs,
    exec: (cmd, opts) => world.exec(cmd, { ...opts, signal }),
    http: {
      postJson: (url, body, opts) => world.http.postJson(url, body, { ...opts, signal }),
    },
    ...(world.openTerminal ? { openTerminal: (o: OpenTerminalOptions) => world.openTerminal!(o) } : {}),
    ...(world.browser
      ? { browser: { read: (o?: BrowserReadOptions) => world.browser!.read({ ...o, signal }) } }
      : {}),
    ...(world.mcp
      ? {
          mcp: {
            ready: () => world.mcp!.ready(),
            servers: () => world.mcp!.servers(),
            callTool: (id: string, tool: string, args: unknown) =>
              world.mcp!.callTool(id, tool, args, signal),
            readResource: (id: string, uri: string) => world.mcp!.readResource(id, uri, signal),
            getPrompt: (id: string, name: string, args: Record<string, string>) =>
              world.mcp!.getPrompt(id, name, args),
          },
        }
      : {}),
  };
}

/** 把输出直播回调焊进 world 的装饰器——withAbortSignal 同款手法。
    engine 按工具调用包一层（回调里绑好 toolCallId），bash 工具照旧
    只调 world.exec(cmd)，对直播的存在无感（硬规则原样成立）。 */
export function withExecOutput(
  world: ExecutionWorld,
  onOutput: NonNullable<ExecOptions["onOutput"]>
): ExecutionWorld {
  return {
    fs: world.fs,
    exec: (cmd, opts) => world.exec(cmd, { ...opts, onOutput }),
    http: world.http,
    ...(world.openTerminal ? { openTerminal: (o: OpenTerminalOptions) => world.openTerminal!(o) } : {}),
    ...(world.browser ? { browser: world.browser } : {}),
    ...(world.mcp ? { mcp: world.mcp } : {}),
  };
}

/** 把浏览器能力焊进 world——withAbortSignal 同款手法。
    index.ts 按会话包一层(read 里绑好 sessionId),工具照旧只调 world.browser.read,
    对 hub 的存在无感(硬规则原样成立)。 */
export function withBrowser(world: ExecutionWorld, browser: BrowserCapability): ExecutionWorld {
  return { ...world, browser };
}

/** 把 MCP 能力焊进 world —— withBrowser 同款手法。
    index.ts 从 mcpHub 注入,工具照旧只调 world.mcp.callTool,对 hub 的存在无感
    (硬规则原样成立)。 */
export function withMcp(world: ExecutionWorld, mcp: McpCapability): ExecutionWorld {
  return { ...world, mcp };
}
