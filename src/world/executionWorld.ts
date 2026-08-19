// ExecutionWorld — capability seam：工具能触碰的"世界"的全部
// 工具只依赖这个接口（AGENTS.md 硬规则），不知道背后是本机还是 Docker。
// v1: LocalWorld（本机）。v2: SandboxWorld（每 bot 一个容器，fork 时 docker commit）。

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
  /** 读完那一刻的实际 URL(重定向之后的) */
  url: string;
  title: string;
  text: string;
  /** 正文超上限被截断了。截了就明说,不假装读全了 */
  truncated: boolean;
}

/** 浏览器能力。只读——导航 + 抽正文,不点不打字(本期边界,工具名已把它划在名字里) */
export interface BrowserCapability {
  read(opts?: BrowserReadOptions): Promise<BrowserReadResult>;
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
  };
}

/** 把浏览器能力焊进 world——withAbortSignal 同款手法。
    index.ts 按会话包一层(read 里绑好 sessionId),工具照旧只调 world.browser.read,
    对 hub 的存在无感(硬规则原样成立)。 */
export function withBrowser(world: ExecutionWorld, browser: BrowserCapability): ExecutionWorld {
  return { ...world, browser };
}
