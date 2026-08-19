# Terminal 面板设计（会话内嵌终端）

- 日期：2026-08-19
- 状态：待实现
- 相关：ADR-0031（终端挂在 ExecutionWorld 上、且不进事件日志）
- 后续子系统：Browser 预览面板（另起一份 spec，复用本设计的面板宿主与标签机制）

## 目标

在 Otto 会话里内嵌一个真终端面板：用户自己敲命令、跑 `npm run dev`、看日志、按
Ctrl-C，和 Claude Code 桌面版的 Terminal 面板同构。

## 非目标（明确不做）

- **agent 看不见终端**。终端输出不进模型上下文、不进事件日志、不进任何工具的返回值。
  想让 Otto 看某段输出，用户自己复制粘贴到输入框。
- 人机共用同一个 shell 会话（agent 的 `bash` 工具和用户终端仍是两个独立进程）。
- 终端内容跨 app 重启保留（PTY 进程随 app 死，缓冲在内存里）。
- Browser 预览面板（下一份 spec）。

## 决策记录（本次拍板的五个岔路）

| 岔路 | 选择 | 被否方案 |
|---|---|---|
| 归属 | 纯人用，agent 看不见 | 可主动喂给 agent／人机共用同一 shell |
| 终端底层 | 真 PTY（node-pty + xterm.js） | 管道 spawn（无色、不可交互） |
| 生命周期 | 每会话多标签，关面板不杀进程 | 每会话单终端／全局终端不绑会话 |
| 面板位置 | 右侧面板，复用现有槽位 | 底部抽屉／浮动窗口 |
| 世界 | 挂进 `ExecutionWorld` seam | 主进程直接 node-pty，绕过 seam |

## 架构

### 1. 接缝：`ExecutionWorld` 新增可选能力

```ts
// src/world/executionWorld.ts
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (exitCode: number) => void): () => void;
}

export interface OpenTerminalOptions {
  cols: number;
  rows: number;
  /** 缺省 = $SHELL，再缺省 = /bin/zsh */
  shell?: string;
}

export interface ExecutionWorld {
  fs: { /* 不变 */ };
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  http: { /* 不变 */ };
  /** 可选：世界能不能开交互终端。缺 = 这个世界没有终端能力，UI 据此不显示入口 */
  openTerminal?(opts: OpenTerminalOptions): Promise<TerminalSession>;
}
```

**可选字段**是为了向后兼容：旧实现（含测试里的假 world）零改动，与 `ExecOptions`
可选参数是同一条先例。

`withAbortSignal` / `withExecOutput` 两个装饰器要把 `openTerminal` 原样透传下去
（现在它们是手写字段拷贝，加字段必须同步改，否则装饰过的 world 会静默丢掉终端能力）。

LocalWorld 的实现：node-pty 1.1.0，`cwd = root`（工程文件夹），`env` 继承主进程再补
`TERM=xterm-256color`。v2 SandboxWorld 把它实现成 `docker exec -it`，用户终端自动落进
那个 bot 的容器 —— 这正是走 seam 而不是直接 node-pty 的全部理由。

**工具层不碰这个面**：终端不是工具，`Tool.run` 拿到的 world 里有没有 `openTerminal`
对它无意义。AGENTS.md 的「工具只依赖 ExecutionWorld」硬规则不受影响 —— 这里是给该接口
加面，不是绕过它。

### 2. 主进程：`src/main/terminalHub.ts`

```ts
interface TerminalRecord {
  id: string;
  sessionId: string;
  title: string;          // 默认 shell 名（zsh / bash）
  session: TerminalSession;
  ring: RingBuffer;       // 末尾 ~200 KB
  exitCode: number | null;
}
```

职责：

- 注册表 `Map<terminalId, TerminalRecord>`，按 sessionId 可反查。
- **每会话上限 8 个标签**，超了 `terminalOpen` 抛人话错误（防手滑刷出一堆 shell）。
- **环形回滚缓冲**：每终端保留最后约 200 KB 输出。这是「关面板不杀进程」的兑现物 ——
  面板一关渲染层的 xterm 实例就没了，进程还在吐，得有人接住；重开面板时把缓冲
  一次性灌回去，用户看到的是连续的。
- **连带清理**：app `before-quit` 杀全部；`deleteSession(sessionId)` 杀该会话名下全部。
  不留孤儿 dev server 是硬要求 —— 端口被占住而用户找不到是谁占的，是最难查的一类问题。
- 依赖注入：hub 收一个 `openTerminal` 函数而不是自己 import LocalWorld，这样测试能塞假
  pty 工厂。

hub 是 app 级资源（和 `EventStore` / `AttachmentStore` 同层），在 `index.ts` 里创建。

### 3. ShellBridge 新面

请求/响应：

| 方法 | 语义 |
|---|---|
| `terminalList(sessionId)` | `TerminalInfo[]`（id / title / exited），切回会话时重建标签行 |
| `terminalOpen(sessionId)` | 新开一个 → `{ id, snapshot: "" }` |
| `terminalAttach(id)` | 拿已有终端的回滚缓冲 → `{ snapshot }` |
| `terminalInput(id, data)` | 键盘输入透传给 pty |
| `terminalResize(id, cols, rows)` | 面板拖拽/展开时同步窗口大小 |
| `terminalClose(id)` | 杀进程 + 从注册表摘掉 |

订阅：`onTerminalData(cb({ id, data }))` · `onTerminalExit(cb({ id, exitCode }))`

`CHANNELS` 同步加对应频道常量。所有推送走 `createSend`（窗口销毁后静默丢弃）。

### 4. 数据边界：终端不落日志

终端输出**既不进 `SessionEvent`，也不进模型上下文**。

AGENTS.md 硬规则是「model-visible means logged」—— 它的前提是 model-visible。终端输出
永不进入模型上下文，所以不触发该规则。它比 `assistantDelta` / `toolOutput` 更彻底：那两个
至少是某个已落盘事实的临时投影，终端输出连事实都不是，是人的旁路工具。

这条必须写进 ADR，否则下一班会以为是漏写而「补上」。详见 ADR-0031。

### 5. 渲染层

新文件 `src/renderer/src/components/TerminalView.tsx`。

- **面板宿主复用现成的**：store 加 `terminalOpen: boolean`，与 `protocolOpen` /
  `gitGraphOpen` / `friendChat` 互斥（同一个右侧槽位）。半屏可拖、可展开全屏、位置记
  localStorage —— 全部白拿，不写新布局。
- **头部**：标签行（每个标签显示 title，`×` 关，末尾 `＋` 新开）+ 展开钮 + 关闭钮，
  与截图同构。
- **xterm 实例缓存在模块级 `Map<terminalId, Terminal>`**，组件卸载**不** dispose ——
  否则切走再切回，滚动历史和光标位置全丢。真正 dispose 只发生在 `terminalClose` 和
  会话删除时。
- `@xterm/addon-fit` 跟着面板宽度 fit，fit 后把新的 cols/rows 报给 `terminalResize`。
- **入口**：侧栏 footer icon（和好友/Git Graph 同排）+ 快捷键 `⌃\``。
- **主题**：取 `theme.ts` 的深色四色底盘，不用 xterm 默认配色。

### 6. 依赖与构建（唯一真风险）

- `node-pty@1.1.0` 是原生模块 → 加进 `rebuild-native` 脚本（当前只 `-w better-sqlite3`）。
- `electron.vite.config.ts` 要把 `node-pty` 标 external（不能被打进 bundle）。
- `@xterm/xterm@6` + `@xterm/addon-fit@0.11` 是纯 JS，渲染层直接用。
- `npm run dist:mac`（--arm64）打包后**必须实测**能起终端 —— 原生 `.node` 有没有跟进包
  是最容易在发版当天才炸的一环。

**实现第一步就是最小验证**：起一个空 pty 跑 `echo hi` 拿到 onData/onExit + 打一次包。
跑不通就在这里早退（回退方案 = 无 PTY 的管道面板，能力打折但零原生依赖），不要写完 UI
才发现打包起不来。

### 7. 测试（`tests/` 镜像 `src/`）

- `tests/main/terminalHub.test.ts`（注入假 pty 工厂）：
  - 开/列/关的注册表增删
  - 每会话上限 8，第 9 个报错
  - 缓冲截断：写超 200 KB 后 snapshot 只剩尾部
  - 会话隔离：A 会话列不到 B 会话的终端
  - `killSession(sessionId)` 只杀该会话名下的
  - `killAll()` 全杀
- `tests/world/localWorld.terminal.test.ts`：真起一个 pty 跑 `echo hi`，验 onData 收到
  文本、onExit 收到 0。一条就够（慢，但这是 seam 的唯一真实性证明）。
- `tests/world/executionWorld.test.ts` 补：`withAbortSignal` / `withExecOutput` 透传
  `openTerminal`（这是最容易在加装饰器时静默丢掉的一条）。
- 不测 xterm 的 DOM 渲染（收益低）。

## 实现顺序

1. 最小验证：node-pty 起 pty + `dist:mac` 打包实测（跑不通就早退）
2. `ExecutionWorld.openTerminal` + LocalWorld 实现 + 装饰器透传 + 测试
3. `terminalHub` + 测试
4. ShellBridge 新面 + preload + index.ts 接线
5. `TerminalView` + store 槽位 + 侧栏入口 + 快捷键
6. 手动验收：跑 `npm run dev` → 关面板 → 切会话 → 切回来，输出连续、进程没死

## 待定（实现时定，不阻塞）

- `⌃\`` 是否与既有快捷键冲突（实现时全局搜一遍）
- 标签是否支持改名（先不做，标题固定为 shell 名 + 序号）
