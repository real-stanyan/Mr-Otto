// ExecutionWorld — capability seam：工具能触碰的"世界"的全部
// 工具只依赖这个接口（AGENTS.md 硬规则），不知道背后是本机还是 Docker。
// v1: LocalWorld（本机）。v2: SandboxWorld（每 bot 一个容器，fork 时 docker commit）。

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecutionWorld {
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  exec(cmd: string): Promise<ExecResult>;
}
