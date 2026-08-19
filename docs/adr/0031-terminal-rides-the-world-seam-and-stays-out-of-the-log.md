# ADR-0031：终端挂在 ExecutionWorld 上，且不进事件日志

- 状态：已接受
- 日期：2026-08-19
- 相关：ADR-0001（渲染层只走 ShellBridge）、ADR-0006（中断语义）、ADR-0009（附件库与日志的取舍）
- 设计文档：`docs/superpowers/specs/2026-08-19-terminal-panel-design.md`
- 授权：维护者 stanyan 在 2026-08-19 会话中要求「在 otto 里面，会话里面加入像 Claude Code 这样打开 Terminal 的功能」，并在四个岔路上逐条选定

## 背景

会话里要内嵌一个真终端（PTY），用户自己敲命令、跑 dev server、看日志。
它带来两个必须先答的问题，两个都触到既有硬规则的边：

1. PTY 进程该由谁开？工具层被硬规则禁止 import `child_process`，但终端不是工具。
2. 终端输出算不算「事实」？append-only 日志是唯一事实来源，且 model-visible means logged。

## 决定

### 1. 终端能力挂在 `ExecutionWorld` 上，作为可选面

```ts
openTerminal?(opts: { cols: number; rows: number; shell?: string }): Promise<TerminalSession>;
```

不在主进程直接 `import node-pty` 开进程。理由是 v2：每 bot 一个 Docker 容器时，用户打开
终端应该落进**那个 bot 的容器**，看到的文件系统和 agent 看到的是同一个。如果终端绕过
seam 直连宿主机，v2 一到就会出现「Otto 说文件在那儿，你的终端里没有」这类无解现象。
把它挂在 seam 上，SandboxWorld 把 `openTerminal` 实现成 `docker exec` 即可，UI 一行不改。

**可选**（`?`）是为了向后兼容：旧实现和测试里的假 world 零改动，与 `ExecOptions` 的可选
参数同一条先例。没有这个字段 = 这个世界没有终端能力，UI 据此不显示入口。

代价：`withAbortSignal` / `withExecOutput` 这类手写字段拷贝的装饰器必须同步透传新字段，
漏了会静默丢能力。用一条测试钉住。

工具层不受影响：`Tool.run` 拿到的 world 有没有这个面对它无意义，硬规则原样成立。

### 2. 终端输出不进事件日志、不进模型上下文

终端是**人的旁路工具**，agent 看不见。想让 Otto 看某段输出，用户自己复制粘贴。

这不违反「model-visible means logged」：该规则的前提是 model-visible，而终端输出永远
不进入模型上下文，前提不成立。

它比 `assistantDelta` / `toolOutput` 走得更远：那两个至少是某个已落盘事实的临时投影
（完整内容随后以事件形式落盘），终端输出连事实都不是 —— 日志推不出它，也不需要推出它。
会话重放不重放终端，重放出来的上下文与当时喂给模型的仍然逐字一致。

**这一条必须白纸黑字**，否则下一班读到「终端输出没落盘」会当成漏洞去补 —— 补上之后
日志里就混进了模型从未见过的内容，重放的意义反而被破坏。

### 3. 回滚缓冲放在主进程，不放渲染层

每终端保留末尾约 200 KB 的环形缓冲。面板一关，渲染层的 xterm 实例就没了，而 pty 还在
吐输出（这是「关面板不杀进程」的产品前提）—— 必须有人接住。放渲染层等于没放。

缓冲是内存态，不落盘、不跨 app 重启，和 pty 进程同生共死。

## 后果

- 好：v2 容器化时终端语义自动正确，UI 零改动。
- 好：日志的纯度不被终端稀释 —— 日志里的每一条仍然都是模型见过的。
- 坏：多一个原生依赖（node-pty），`rebuild-native` 和 mac 打包都要跟着验；这是本次唯一
  的真实构建风险，所以实现第一步就是打包实测，跑不通就早退到无 PTY 的管道方案。
- 坏：装饰器的手写字段拷贝多一处要维护（已用测试钉住）。
