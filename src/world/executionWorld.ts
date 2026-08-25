// ExecutionWorld — capability seam：工具能触碰的"世界"的全部
// 工具只依赖这个接口（AGENTS.md 硬规则），不知道背后是本机还是 Docker。
// v1: LocalWorld（本机）。v2: SandboxWorld（每 bot 一个容器，fork 时 docker commit）。

import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpStatus, McpToolInfo,
} from "../shared/mcp.js";
import type { SessionEvent } from "../session/events.js";
import type { SimButton, SimDevice, SimFrame, SimUiElement } from "../shared/simulator.js";
import type { SandboxEnforcementFacts } from "./sandbox.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 沙箱 enforcement 事实（issue #389）：命令跑完了但沙箱拦了什么/自身
      出了什么状况。可选 = 向后兼容：v1 LocalWorld 无沙箱永不产出，旧实现/
      假 world 零改动。生产者是 v2 SandboxWorld；工具层（bash）负责把它
      摆到模型眼前（BrowserReadResult.truncated 同款约定） */
  sandbox?: SandboxEnforcementFacts;
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
  /** 进程硬超时上限（ms）。缺省 = 实现自定（LocalWorld 30s）。
      给它的理由（issue #395 自动转后台）：bash 前台命令超 30s 不再一刀杀死，
      而是放宽到后台档位继续跑、由工具层把"还在跑"这个事实转成后台任务——
      放宽必须是调用方的显式请求，不是 world 偷偷改默认。实现可忽略
      （假 world 零改动），忽略 = 维持它自己的默认超时 */
  timeoutMs?: number;
  /** 写给子进程 stdin 的内容（写完即关）。用户钩子（issue #395）靠它递
      JSON 上下文——环境变量/argv 都过 shell 转义，stdin 不过。缺席 = 不写
      不关（旧行为：读 stdin 的命令等到超时，诚实反映"没人喂它"）。
      实现可忽略（假 world 零改动） */
  stdin?: string;
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
  /** 连不上时的人话原因；连上了 = undefined（同 McpServerStatus 的口径） */
  error?: string;
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

/** 工作区检查点能力（issue #395 / ADR-0090，Claude Code checkpoint 对照）。
    save = 把工作区文件此刻的状态存成一个可寻址的快照；restore = 把文件恢复
    到某个快照（**摧毁**快照之后对被跟踪文件的改动——调用方负责确认门）。
    模型看不到这把能力（不是工具）：消费者是装配根（每个用户 turn 前自动
    save）和「回到这一步」UI（fork 会话 + restore 文件成对使用）。
    v1 由 world/checkpoints.ts 的影子 git 实现（LocalWorld 系）；
    v2 SandboxWorld 可换 docker commit——接口在 seam 上，实现随 world 走 */
export interface CheckpointCapability {
  /** 返回快照 id（内容寻址，影子 git 下是 commit sha）。失败抛错——
      调用方决定要不要吞（自动存档吞掉只警告，不挡 turn） */
  save(label: string): Promise<string>;
  restore(id: string): Promise<void>;
}

/** 配置目录能力。rel 相对配置目录根，越界抛错。read 不存在 = null（不是抛错：
    "还没配过"是常态不是故障）；write 自动建父目录 */
export interface ConfigCapability {
  read(rel: string): Promise<string | null>;
  write(rel: string, content: string): Promise<void>;
}

/** 会话检索结果里的一条历史会话摘要——recent() 的返回形状（session_search 工具用） */
export interface HistorySession {
  sessionId: string;
  title: string | null;
  workspace: string | null;
  startedTs: number;
  lastTs: number;
  userTurns: number;
}

/** 全文检索命中的一行——search() 的返回形状 */
export interface HistoryHit {
  sessionId: string;
  seq: number;
  type: string;
  text: string;
  score: number;
}

/** 历史会话查询能力——session_search 工具的世界（硬规则：工具只认 ExecutionWorld，
    不直接碰 EventStore）。v1 由 src/main/historyCapability.ts 焊在 EventStore 上；
    v2 SandboxWorld 可以换成 RPC 到宿主 */
export interface HistoryCapability {
  /** 全文检索（已排除归档/子会话/当前会话） */
  search(query: string, opts?: { limit?: number }): HistoryHit[];
  /** 某会话 [fromSeq, toSeq] 区间的事件（含端点）；未知会话 = [] */
  window(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[];
  /** 整段事件；未知会话 = [] */
  load(sessionId: string): SessionEvent[];
  /** 标题投影（改名胜出，否则第一条用户消息首行）；未知会话/没标题 = null。
      discovery 给非榜首会话标卡片名用——只要标题就别付整段 load（issue #279） */
  title(sessionId: string): string | null;
  /** 最近会话（排除归档/子会话/当前会话） */
  recent(limit: number): HistorySession[];
}

/** iOS 模拟器能力（issue #401）。这块屏是人和 agent 共用的（同 browser 的立场）：
    人在右栏面板上点，agent 用 simulator 工具点，点的是同一台机器上同一个
    Simulator.app 窗口。坐标一律是**截图像素**（见 shared/simulator.ts 文件头）。

    注入方向同 browser/mcp（ADR-0035）：simctl 子进程生命周期、画面轮询、
    向渲染层推状态都是组装根的活，LocalWorld 造不出来，由 index.ts 用
    withSimulator 焊进来。v2 SandboxWorld 若把模拟器放在别的宿主上，
    这一层接口一字不改，换实现即可。 */
export interface SimulatorCapability {
  /** 可用设备清单（simctl list 的投影） */
  list(): Promise<SimDevice[]>;
  /** 开机并把 Simulator.app 的窗口切到这台。udid 省略 = 当前选中那台。
      幂等：已经开着的不重开。返回开完之后那台的状态 */
  boot(udid?: string): Promise<SimDevice>;
  /** 关机。udid 省略 = 当前选中那台 */
  shutdown(udid?: string): Promise<void>;
  /** 截一帧当前画面 */
  screenshot(): Promise<SimFrame>;
  /** 读屏幕上的无障碍元素（agent 的主力「看」手段：带 label 和框，
      不用从像素里猜）。frame 已换算到截图像素空间 */
  describe(): Promise<SimUiElement[]>;
  /** 点一下。坐标 = 截图像素 */
  tap(x: number, y: number): Promise<void>;
  /** 划一下。起止都是截图像素；durationMs 缺省由实现定 */
  swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs?: number
  ): Promise<void>;
  /** 往当前焦点里打字（先得有个输入框在焦点上——调用方负责先 tap 它） */
  typeText(text: string): Promise<void>;
  /** 按硬件键 */
  pressButton(button: SimButton): Promise<void>;
  /** 开深链 / 网址（simctl openurl） */
  openUrl(url: string): Promise<void>;
  /** 装一个 .app 目录 */
  install(appPath: string): Promise<void>;
  /** 起一个已装的 app */
  launch(bundleId: string): Promise<void>;
  /** 杀一个正在跑的 app */
  terminate(bundleId: string): Promise<void>;
  /** 输入通道（Swift helper）此刻能不能用。false = 点击/打字这几把会明确报错，
      而不是静默无反应——最常见的原因是没给「辅助功能」授权 */
  inputReady(): boolean;
}

export interface ExecutionWorld {
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** 可选：后台执行（issue #389）——不绑 turn 信号、超时放宽（LocalWorld 30 分钟）。
      给"跑得比一个 turn 长"的命令用（构建/测试全量跑）：turn 收口了它还活着，
      结果由组装根（backgroundTasks）以新 turn 注回会话。
      **刻意是独立方法而不是 ExecOptions 里的 flag**：withAbortSignal 把 turn
      信号焊进每个 exec 调用，后台任务必须躲开那次注入——分开的方法让装饰器
      "透传不加签"成为显式决定而不是遗漏。可选 = 向后兼容（假 world 零改动）；
      缺席 = 该装配不支持后台执行（bash 的 run_in_background 报错说明） */
  execDetached?(cmd: string): Promise<ExecResult>;
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
  /** 可选：用户级配置目录（~/.mr-otto）的读写。与 fs 分开：fs 圈在工程文件夹内，
      这里圈在配置目录内——记忆文件跨 workspace 共享，不属于任何工程。
      可选的理由同 openTerminal（旧实现和假 world 零改动）；缺席 = 该装配没有
      长期记忆（memory 工具不挂）。v2 SandboxWorld 可以把它映射成容器外的卷 */
  config?: ConfigCapability;
  /** 可选：查历史会话的能力（session_search 工具用）。可选的理由同 config/openTerminal
      （旧实现和假 world 零改动）；缺席 = 该装配没有历史检索（工具不挂）。
      v1 由 index.ts 用 withHistory 焊 historyCapability.ts 的实现进来；
      v2 SandboxWorld 这一层接口不变，换成 RPC 到宿主 */
  history?: HistoryCapability;
  /** 可选：工作区检查点（issue #395）。注入方向同 browser/mcp——影子 git
      要知道配置目录（快照库住在 ~/.mr-otto/checkpoints），LocalWorld 单靠
      workspace 造不出来，由组装根用 withCheckpoint 焊进来。缺席 = 该装配
      没有检查点（自动存档跳过、回退入口不出现）。工具层永远不消费它 */
  checkpoint?: CheckpointCapability;
  /** 可选：iOS 模拟器（issue #401）。注入方向同 browser/mcp——由组装根用
      withSimulator 焊进来。缺席 = 该装配没有模拟器（simulator 工具不挂，
      右栏面板入口不出现）。只在 macOS + 装了 Xcode 的机器上会被焊上 */
  simulator?: SimulatorCapability;
}

/** 把中断信号焊进 world 的装饰器（ADR-0006）。
    工具依旧只认 ExecutionWorld（硬规则）——它拿到的 world 天生带信号，
    自己无感。fs 不绑：读写是瞬时操作，中断收益为零。 */
export function withAbortSignal(world: ExecutionWorld, signal: AbortSignal): ExecutionWorld {
  return {
    fs: world.fs,
    exec: (cmd, opts) => world.exec(cmd, { ...opts, signal }),
    // 后台执行透传**不加签**（issue #389）：turn 中止不该杀后台任务——
    // 它的生命周期本来就设计成跨 turn 的
    ...(world.execDetached ? { execDetached: (cmd: string) => world.execDetached!(cmd) } : {}),
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
    ...(world.config ? { config: world.config } : {}),
    ...(world.history ? { history: world.history } : {}),
    ...(world.checkpoint ? { checkpoint: world.checkpoint } : {}),
    // 模拟器不绑中断信号：点击/截图都是毫秒级的一次性动作，
    // 中断收益为零（同 fs 的取舍）
    ...(world.simulator ? { simulator: world.simulator } : {}),
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
    // 后台执行不接直播（v1）：完整结果在完成回注时整段给
    ...(world.execDetached ? { execDetached: (cmd: string) => world.execDetached!(cmd) } : {}),
    http: world.http,
    ...(world.openTerminal ? { openTerminal: (o: OpenTerminalOptions) => world.openTerminal!(o) } : {}),
    ...(world.browser ? { browser: world.browser } : {}),
    ...(world.mcp ? { mcp: world.mcp } : {}),
    ...(world.config ? { config: world.config } : {}),
    ...(world.history ? { history: world.history } : {}),
    ...(world.checkpoint ? { checkpoint: world.checkpoint } : {}),
    // 模拟器不绑中断信号：点击/截图都是毫秒级的一次性动作，
    // 中断收益为零（同 fs 的取舍）
    ...(world.simulator ? { simulator: world.simulator } : {}),
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

/** 把历史检索能力焊进 world —— withBrowser/withMcp 同款手法。
    index.ts 用 createHistoryCapability(store, currentSessionId) 焊进来，
    工具照旧只调 world.history.search/window/load/recent，对 EventStore 的存在无感
    (硬规则原样成立)。 */
export function withHistory(world: ExecutionWorld, history: HistoryCapability): ExecutionWorld {
  return { ...world, history };
}

/** 把检查点能力焊进 world —— withBrowser/withMcp 同款手法（issue #395）。
    组装根用 world/checkpoints.ts 的影子 git 实现焊进来；工具层不消费它 */
export function withCheckpoint(world: ExecutionWorld, checkpoint: CheckpointCapability): ExecutionWorld {
  return { ...world, checkpoint };
}

/** 把 iOS 模拟器能力焊进 world —— withBrowser 同款手法（issue #401）。
    组装根从 simulatorHub 注入；工具照旧只调 world.simulator.tap(...)，
    对 hub、对 Swift helper 的存在一概无感（硬规则原样成立） */
export function withSimulator(world: ExecutionWorld, simulator: SimulatorCapability): ExecutionWorld {
  return { ...world, simulator };
}
