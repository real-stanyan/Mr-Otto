// bash — 第三个工具，MVP 三件套齐。能力最强也最危险，必须过审批门。
//
// 设计要点：exitCode ≠ 0 不算工具 error——命令跑完就是"世界的正常反馈"
// （测试挂、grep 无匹配都是模型需要的信息），原样拼给模型自己判断。
// 只有参数非法才 throw（那才是管线故障）。超时由 world 层负责（LocalWorld 30s）。

import type { Tool } from "./tool.js";
import { estimateTokens } from "../shared/contextEstimate.js";
import type { SandboxEnforcementFacts } from "../world/sandbox.js";
import type { ExecResult } from "../world/executionWorld.js";

/** 后台任务登记口（issue #389）的最小接口。实现在 main/backgroundTasks.ts——
    工具层只见接口不 import main（ExecutionWorld 同款分层方向）。
    armed = 组装根接了完成回调：没接线的装配（subagent）起后台任务 = 结果必丢，
    这里拒绝而不是对模型撒谎说"会注回" */
export interface BackgroundStarter {
  readonly armed: boolean;
  start(cmd: string, run: () => Promise<ExecResult>): string;
}

/** 模型可见预算（字符/流）——三层截断的第三层（issue #343）。与内存层
    （world/localWorld.ts 的 EXEC_BUFFER_CAP）、IPC 层（shared/execStream.ts）
    **分开配置**：调小这个数只影响模型看到多少，不影响日志/直播 */
const MAX_CHARS = 8_000;
/** 中间截断的头尾配比：头 = 启动报错，尾 = 最终结果，中段进度最没用 */
const HEAD_CHARS = 4_800;
const TAIL_CHARS = MAX_CHARS - HEAD_CHARS;

function clip(label: string, text: string): string {
  if (!text) return "";
  if (text.length <= MAX_CHARS) return `${label}:\n${text}\n`;
  // 中间截断 + 警告头（codex 同款）：模型知道被截、知道原本多大，
  // 可自行决定重跑加 head/tail/grep 取所需段
  const warn =
    `Warning: 输出被中间截断（原始 ${text.length} 字符 ≈ ${estimateTokens(text)} tokens，` +
    `保留头 ${HEAD_CHARS} + 尾 ${TAIL_CHARS} 字符）。需要完整内容请用 head/tail/grep 重跑。`;
  return `${label}:\n${warn}\n${text.slice(0, HEAD_CHARS)}\n…[中间省略]…\n${text.slice(-TAIL_CHARS)}\n`;
}

/** 沙箱 enforcement 事实 → 模型可见行（issue #389）。放在 clip 之外：
    截断永远吃不掉它（BrowserReadResult.truncated「摆到模型眼前」同款约定）。
    v1 LocalWorld 不产 sandbox 字段 = 这里永远返回空串，输出逐字节不变 */
function sandboxLines(s: SandboxEnforcementFacts | undefined): string {
  if (!s) return "";
  const lines: string[] = [];
  if (s.enforcement === "partial")
    lines.push("[沙箱] enforcement: partial——有约束未能实施，隔离不完整");
  for (const d of s.denials ?? []) lines.push(`[沙箱拦截] ${d}`);
  for (const f of s.failures ?? []) lines.push(`[沙箱异常] ${f}（约束可能已失效）`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** bash 工厂（issue #389）：给了 background 才在参数表上宣称 run_in_background——
    工具表同时是模型的能力清单，报一个用不了的参数和报一把用不了的工具同罪
    （browser_read 的既有原则）。默认导出 bashTool = 无后台能力的旧形态，
    既有装配/测试零改动 */
export function createBashTool(background?: BackgroundStarter): Tool {
  return {
    def: {
      name: "bash",
      description:
        "在工程文件夹内执行一条 shell 命令（cwd = 工程文件夹，30 秒超时）。" +
        "返回 stdout / stderr / exit code；退出码非零不代表失败，自行判断。" +
        (background
          ? "run_in_background=true 时立即返回任务 id（30 分钟超时），完成后结果自动以新消息注回会话——给跑得比一轮对话长的命令用（构建/全量测试）。"
          : ""),
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "要执行的完整 shell 命令" },
          ...(background
            ? {
                run_in_background: {
                  type: "boolean",
                  description: "true = 后台执行：立即返回任务 id，完成后结果以新消息注回",
                },
              }
            : {}),
        },
        required: ["cmd"],
      },
    },
    requiresApproval: true,

    async run(args, world) {
      const { cmd, run_in_background } = args as { cmd: string; run_in_background?: boolean };
      if (typeof cmd !== "string" || cmd.trim().length === 0) {
        throw new Error("bash: 参数 cmd 必须是非空字符串");
      }
      if (run_in_background === true) {
        // armed 现查不缓存：装配后才接线（index.ts），冻在工厂时刻会误判
        if (!background || !background.armed || !world.execDetached) {
          throw new Error("bash: 此装配不支持后台执行（run_in_background），请去掉该参数直接执行");
        }
        const id = background.start(cmd, () => world.execDetached!(cmd));
        return `后台任务 ${id} 已启动（30 分钟超时）。完成后结果会以新消息注回会话，无需轮询等待。`;
      }
      const { stdout, stderr, exitCode, sandbox } = await world.exec(cmd);
      return `exit code: ${exitCode}\n${sandboxLines(sandbox)}${clip("stdout", stdout)}${clip("stderr", stderr)}`.trimEnd();
    },
  };
}

export const bashTool: Tool = createBashTool();
