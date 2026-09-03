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
/** 后台任务的输出直播口（issue #772）。start 把它递给 run，run 负责把它接到
    真实的输出流上——显式后台接 world.execDetached 的 onOutput，前台自动转后台
    接的是命令起跑时就挂好的那一份 tee（见下）。不接 = 面板画一个空终端，
    不报错：直播是增强，不是承诺 */
export type BackgroundOutputSink = (chunk: string, stream: "stdout" | "stderr") => void;

export interface BackgroundStarter {
  readonly armed: boolean;
  start(cmd: string, run: (onOutput: BackgroundOutputSink) => Promise<ExecResult>): string;
}

/** 转后台之前先攒下的输出上限（字符，issue #772）。与主进程那份尾巴同数：
    两头攒的是同一条流的同一段尾巴，配不同的数只会让交接处出现一个台阶 */
const MIGRATED_TEE_CHARS = 4_000;

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

/** 前台命令自动转后台的等待阈值（issue #395，Claude Code auto-background 对照）：
    跑满这么久还没完 = 它是个长活，别杀——转成后台任务继续跑（同一进程，
    副作用不重跑），完成走既有回注链路。可注入是给测试的（真值 30s 等不起） */
export const AUTO_BACKGROUND_AFTER_MS = 30_000;
/** 转后台后进程还能跑多久（与 LocalWorld 的 DETACHED_TIMEOUT_MS 同数同理：
    无限 = 泄漏出走的进程，30 分钟够全量构建/测试）。经 ExecOptions.timeoutMs
    显式传给 world——放宽超时是调用方的请求，不是 world 偷偷改默认 */
const MIGRATED_TIMEOUT_MS = 1_800_000;

/** bash 工厂（issue #389）：给了 background 才在参数表上宣称 run_in_background——
    工具表同时是模型的能力清单，报一个用不了的参数和报一把用不了的工具同罪
    （browser_read 的既有原则）。默认导出 bashTool = 无后台能力的旧形态，
    既有装配/测试零改动 */
export function createBashTool(
  background?: BackgroundStarter,
  timings?: { autoBackgroundAfterMs?: number }
): Tool {
  const autoAfterMs = timings?.autoBackgroundAfterMs ?? AUTO_BACKGROUND_AFTER_MS;
  return {
    def: {
      name: "bash",
      description:
        "在工程文件夹内执行一条 shell 命令（cwd = 工程文件夹，30 秒超时）。" +
        "返回 stdout / stderr / exit code；退出码非零不代表失败，自行判断。" +
        (background
          ? "跑满 30 秒还没完的命令会自动转入后台继续跑（同一进程，不重跑），完成后结果自动进入对话。" +
            "预判会跑很久的命令（构建/全量测试）可直接 run_in_background=true：立即返回任务 id（30 分钟超时），不占等待。" +
            "后面的步骤依赖它的结果就用 wait_task 在本轮里等，别结束回合去等。"
          : ""),
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "要执行的完整 shell 命令" },
          ...(background
            ? {
                run_in_background: {
                  type: "boolean",
                  description: "true = 后台执行：立即返回任务 id，完成后结果自动进入对话（要等就 wait_task）",
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
        const id = background.start(cmd, (onOutput) => world.execDetached!(cmd, { onOutput }));
        return `后台任务 ${id} 已启动（30 分钟超时）。完成后结果会自动进入对话；后面的步骤依赖它就用 wait_task 等，不要轮询。`;
      }
      // 前台自动转后台（issue #395）：回注已接线（armed）的装配里，前台命令
      // 不再 30s 一刀杀——超时放宽到后台档位，工具层等 30s，没等到就把
      // **还在跑的同一个进程**登记成后台任务（不杀不重跑：重跑 = 副作用重放，
      // 批过的是这一次执行）。没接线的装配（subagent）维持旧行为：30s 硬杀，
      // 结果没人注回就不该让进程活过这个 turn。
      // 已知取舍：① 迁移后的进程仍绑着 turn 中断信号（withAbortSignal 焊死的）
      // ——用户按停止会连它一起杀，与显式 run_in_background 的"不绑信号"不同；
      // 立场：停止键停的是"这个 turn 发起的一切"，显式后台是用户经模型明确
      // 要求的例外。② 直播碎片继续流向原工具卡（对账诚实，略显冗余）
      if (background?.armed) {
        // 输出的第二个接收方（issue #772）：转后台那一刻，工具卡上的直播随
        // tool_result 落地一起消失（渲染层清 toolOutputByCall），可进程还在跑——
        // 后台任务面板要接着画同一个终端，中间不能断。所以命令起跑时就挂一份
        // 自己的 tee：交接前攒着（超上限丢头部，尾巴才是"最新进展"），
        // 交接那一刻整段补给面板，之后直接转发。
        // 没转后台的那条路（命令 30 秒内跑完）白攒一次，代价是有界的几 KB
        let sink: BackgroundOutputSink | null = null;
        let buffered: Array<[string, "stdout" | "stderr"]> = [];
        let bufferedChars = 0;
        const inflight = world.exec(cmd, {
          timeoutMs: MIGRATED_TIMEOUT_MS,
          onOutput: (chunk, stream) => {
            if (sink) {
              sink(chunk, stream);
              return;
            }
            buffered.push([chunk, stream]);
            bufferedChars += chunk.length;
            while (bufferedChars > MIGRATED_TEE_CHARS && buffered.length > 1) {
              bufferedChars -= buffered.shift()![0].length;
            }
          },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol("timeout");
        const winner = await Promise.race([
          inflight,
          new Promise<typeof timedOut>((r) => {
            timer = setTimeout(() => r(timedOut), autoAfterMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (winner === timedOut) {
          const id = background.start(cmd, (onOutput) => {
            for (const [chunk, stream] of buffered) onOutput(chunk, stream);
            buffered = [];
            bufferedChars = 0;
            sink = onOutput;
            return inflight;
          });
          return (
            `命令已运行超 ${Math.round(autoAfterMs / 1000)} 秒，自动转入后台任务 ${id} 继续执行` +
            `（同一进程，上限 30 分钟）。完成后结果会自动进入对话；后面的步骤依赖它就用 wait_task 等，不要轮询。`
          );
        }
        const { stdout, stderr, exitCode, sandbox } = winner;
        return `exit code: ${exitCode}\n${sandboxLines(sandbox)}${clip("stdout", stdout)}${clip("stderr", stderr)}`.trimEnd();
      }
      const { stdout, stderr, exitCode, sandbox } = await world.exec(cmd);
      return `exit code: ${exitCode}\n${sandboxLines(sandbox)}${clip("stdout", stdout)}${clip("stderr", stderr)}`.trimEnd();
    },
  };
}

export const bashTool: Tool = createBashTool();
