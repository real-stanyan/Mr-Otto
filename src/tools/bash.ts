// bash — 第三个工具，MVP 三件套齐。能力最强也最危险，必须过审批门。
//
// 设计要点：exitCode ≠ 0 不算工具 error——命令跑完就是"世界的正常反馈"
// （测试挂、grep 无匹配都是模型需要的信息），原样拼给模型自己判断。
// 只有参数非法才 throw（那才是管线故障）。超时由 world 层负责（LocalWorld 30s）。

import type { Tool } from "./tool.js";
import { estimateTokens } from "../shared/contextEstimate.js";

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

export const bashTool: Tool = {
  def: {
    name: "bash",
    description:
      "在工程文件夹内执行一条 shell 命令（cwd = 工程文件夹，30 秒超时）。" +
      "返回 stdout / stderr / exit code；退出码非零不代表失败，自行判断。",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "要执行的完整 shell 命令" },
      },
      required: ["cmd"],
    },
  },
  requiresApproval: true,

  async run(args, world) {
    const { cmd } = args as { cmd: string };
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      throw new Error("bash: 参数 cmd 必须是非空字符串");
    }
    const { stdout, stderr, exitCode } = await world.exec(cmd);
    return `exit code: ${exitCode}\n${clip("stdout", stdout)}${clip("stderr", stderr)}`.trimEnd();
  },
};
