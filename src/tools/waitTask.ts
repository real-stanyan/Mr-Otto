// wait_task — 模型在同一 turn 里等一个后台任务出结果（issue #871，
// Claude Code TaskOutput / Monitor 对照）。
//
// 没有它的话「后台任务」只有一种收场：模型说完话交卷，任务完成后 harness
// 再把它叫回来另开一轮。轨迹里看到的「一件事拆成好几段会话」就是这个。
// 有了它，模型知道后面的步骤依赖这个结果时可以选择等——等到的结果从这把
// 工具的 tool_result 回去，harness 那条追加路径看到有人在等就只记账不追加
// （BackgroundCompletion.claimed），一份结果不进两次上下文。
//
// 接口声明在工具层（与 bash.ts 的 BackgroundStarter 同款分层）：工具不 import
// main 模块，main 的 BackgroundTasks 实现它。

import type { Tool } from "./tool.js";
import type { ExecResult } from "../world/executionWorld.js";
import { clipHeadTail } from "../shared/redact.js";

/** wait() 的三种结局。kind 是事实不是线索（ADR-0193 同款立场）：
    done = 拿到结果；timeout = 还在跑，带此刻的输出尾巴；unknown = 没这个任务
    （id 打错，或上一次 app 运行留下的——进程早没了） */
export type BackgroundWaitOutcome =
  | { kind: "done"; id: string; cmd: string; result: ExecResult }
  | { kind: "timeout"; id: string; cmd: string; tail: string }
  | { kind: "unknown"; id: string };

export interface BackgroundWaiter {
  /** 后台回注接没接线（同 BackgroundStarter.armed）：没接线的装配起不了后台任务，
      这把工具也就没东西可等——从声明表里消失，别让模型白试 */
  readonly armed: boolean;
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundWaitOutcome>;
}

/** 默认等多久。取「一次全量构建/测试」的量级；模型可以按预期改 */
export const DEFAULT_WAIT_SECONDS = 300;
/** 单次等待上限，与后台任务自身的 30 分钟超时对齐——等得比任务活得还久没有意义 */
export const MAX_WAIT_SECONDS = 1_800;

/** 回给模型的输出预算。同 backgroundTasks.formatCompletion 的 8000 字：
    模型预算有界，日志侧本来就只有 HeadTail 1MB 内的事实 */
const MAX_REPORT_CHARS = 8_000;

export function formatWaitOutcome(o: BackgroundWaitOutcome): string {
  switch (o.kind) {
    case "done": {
      const body = [
        o.result.stdout ? `stdout:\n${o.result.stdout}` : "",
        o.result.stderr ? `stderr:\n${o.result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const clipped = clipHeadTail(
        body,
        MAX_REPORT_CHARS / 2,
        MAX_REPORT_CHARS / 2,
        `\n…[中间省略，原始 ${body.length} 字符]…\n`
      );
      return `[后台任务 ${o.id} 完成] ${o.cmd}\nexit code: ${o.result.exitCode}\n${clipped}`.trimEnd();
    }
    case "timeout":
      return (
        `后台任务 ${o.id} 还在跑（${o.cmd}）。此刻的输出尾巴：\n${o.tail || "(还没有输出)"}\n` +
        `可以再 wait_task 一次，或先做别的、完成后结果会自动进入对话。`
      );
    case "unknown":
      return `没有正在跑或刚完成的后台任务 ${o.id}——id 打错了，或者它是上一次启动留下的（进程早没了）。`;
  }
}

export function createWaitTaskTool(waiter: BackgroundWaiter): Tool {
  return {
    def: {
      name: "wait_task",
      description:
        "等一个后台任务（bash 的 run_in_background，或跑满 30 秒自动转后台的命令）出结果，在本轮里直接拿到它。" +
        "后面的步骤依赖那个结果时用它，不要结束回合去等——完成后结果本来也会自动进入对话，但那可能要等下一轮。" +
        "超时返回此刻的输出尾巴，任务继续跑，可以再等一次。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "后台任务 id，形如 bg-3" },
          timeout_seconds: {
            type: "number",
            description: `最多等多少秒（默认 ${DEFAULT_WAIT_SECONDS}，上限 ${MAX_WAIT_SECONDS}）`,
          },
        },
        required: ["task_id"],
      },
    },
    requiresApproval: false,
    // 等待不改变世界，但它占着这一步——并发跑多个 wait 没意义，串行照旧
    available: () => waiter.armed,

    async run(args, _world, ctx) {
      const { task_id, timeout_seconds } = args as { task_id?: unknown; timeout_seconds?: unknown };
      if (typeof task_id !== "string" || !/^bg-\d+$/.test(task_id)) {
        throw new Error("wait_task: 参数 task_id 必须是 bg-N 形式的后台任务 id");
      }
      let seconds = DEFAULT_WAIT_SECONDS;
      if (timeout_seconds !== undefined) {
        if (typeof timeout_seconds !== "number" || !Number.isFinite(timeout_seconds) || timeout_seconds <= 0) {
          throw new Error("wait_task: 参数 timeout_seconds 必须是正数");
        }
        seconds = Math.min(timeout_seconds, MAX_WAIT_SECONDS);
      }
      const outcome = await waiter.wait(task_id, seconds * 1000, ctx?.signal);
      return formatWaitOutcome(outcome);
    },
  };
}
