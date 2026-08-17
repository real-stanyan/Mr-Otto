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

export interface ExecutionWorld {
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** 把中断信号焊进 world 的装饰器（ADR-0006）。
    工具依旧只认 ExecutionWorld（硬规则）——它拿到的 world 天生带信号，
    自己无感。fs 不绑：读写是瞬时操作，中断收益为零。 */
export function withAbortSignal(world: ExecutionWorld, signal: AbortSignal): ExecutionWorld {
  return {
    fs: world.fs,
    exec: (cmd, opts) => world.exec(cmd, { ...opts, signal }),
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
  };
}
