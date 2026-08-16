// bash — 第三个工具，MVP 三件套齐。能力最强也最危险，必须过审批门。
//
// 设计要点：exitCode ≠ 0 不算工具 error——命令跑完就是"世界的正常反馈"
// （测试挂、grep 无匹配都是模型需要的信息），原样拼给模型自己判断。
// 只有参数非法才 throw（那才是管线故障）。超时由 world 层负责（LocalWorld 30s）。

import type { Tool } from "./tool.js";

/** 单段输出上限：防某条命令 cat 出几 MB 把上下文撑爆 */
const MAX_CHARS = 8_000;

function clip(label: string, text: string): string {
  if (!text) return "";
  const clipped =
    text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n…（截断，共 ${text.length} 字符）`
      : text;
  return `${label}:\n${clipped}\n`;
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
