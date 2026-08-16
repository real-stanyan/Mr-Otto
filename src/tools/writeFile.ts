// write_file — 第一个危险工具：改变世界（覆盖写盘），必须过审批门

import type { Tool } from "./tool.js";

export const writeFileTool: Tool = {
  def: {
    name: "write_file",
    description: "把内容写入指定路径的文件（覆盖写，父目录必须已存在）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件的绝对路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["path", "content"],
    },
  },
  requiresApproval: true,

  async run(args, world) {
    const { path, content } = args as { path: string; content: string };
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("write_file: 参数 path 必须是非空字符串");
    }
    if (typeof content !== "string") {
      throw new Error("write_file: 参数 content 必须是字符串");
    }
    await world.fs.write(path, content);
    return `已写入 ${path}（${content.length} 字符）`;
  },
};
