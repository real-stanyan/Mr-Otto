// 后台任务完成回注（issue #389，dsh completion re-injection 对照）。
//
// 形态：bash 的 run_in_background 起任务（world.execDetached，不绑 turn 信号），
// 这里跟踪存活任务；完成时回调组装根（index.ts），由它落
// background_task_completed 事件并决定回注时机——**以新 turn 回注，永不
// mid-splice**：steer 那条"往跑着的 turn 里 append"的路技术上现成，但 turn
// 中途改投影中段 = prefix cache 全废（ADR-0073 的教训，微压缩为此宁可丢结果）。
// turn 在跑就攒着，收口（completed）后合并成一条注回。
//
// 模型可见的载体是回注 turn 的 user_message（"先落盘再喂模型"由 runTurn 的
// 既有路径满足）；background_task_completed 事件是审计注记，模型不消费。

import type { ExecResult } from "../world/executionWorld.js";
// BackgroundStarter 接口声明在工具层（tools/bash.ts）：工具不 import main 模块
// （分层与 ExecutionWorld 同款方向——main 实现、工具只见接口），这里是实现方
import type { BackgroundStarter } from "../tools/bash.js";

export interface BackgroundCompletion {
  id: string;
  cmd: string;
  result: ExecResult;
}

export class BackgroundTasks implements BackgroundStarter {
  private n = 0;
  private liveMap = new Map<string, string>();
  private cb: ((c: BackgroundCompletion) => void) | null = null;

  get armed(): boolean {
    return this.cb !== null;
  }

  /** 组装根（index.ts）接线；只允许一个订阅者——回注入口只有一个 */
  onCompletion(cb: (c: BackgroundCompletion) => void): void {
    this.cb = cb;
  }

  /** 存活任务（id + 命令）——UI/调试用 */
  live(): Array<{ id: string; cmd: string }> {
    return [...this.liveMap].map(([id, cmd]) => ({ id, cmd }));
  }

  start(cmd: string, run: () => Promise<ExecResult>): string {
    const id = `bg-${++this.n}`;
    this.liveMap.set(id, cmd);
    // execDetached 不该 reject（起不来也按 ExecResult 返回，LocalWorld 契约），
    // 这里仍兜一层：万一实现抛了，完成事实不能丢
    run()
      .catch(
        (e): ExecResult => ({
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          exitCode: 1,
        })
      )
      .then((result) => {
        this.liveMap.delete(id);
        this.cb?.({ id, cmd, result });
      });
    return id;
  }
}

/** 回注 turn 的 user_message 文案。中间截断同 bash 的三层截断精神：
    模型预算有界，日志侧本来就只有 HeadTail 1MB 内的事实 */
const MAX_REPORT_CHARS = 8_000;

export function formatCompletion(c: BackgroundCompletion): string {
  const body = [
    c.result.stdout ? `stdout:\n${c.result.stdout}` : "",
    c.result.stderr ? `stderr:\n${c.result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const clipped =
    body.length <= MAX_REPORT_CHARS
      ? body
      : `${body.slice(0, MAX_REPORT_CHARS / 2)}\n…[中间省略，原始 ${body.length} 字符]…\n${body.slice(-MAX_REPORT_CHARS / 2)}`;
  return `[后台任务 ${c.id} 完成] ${c.cmd}\nexit code: ${c.result.exitCode}\n${clipped}`.trimEnd();
}
