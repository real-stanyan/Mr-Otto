// read_file — 最无害的第一个工具：纯读，不需要审批

import type { Tool } from "./tool.js";

export const readFileTool: Tool = {
  def: {
    name: "read_file",
    description: "读取一个文本文件的完整内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" },
      },
      required: ["path"],
    },
  },
  requiresApproval: false,
  parallelSafe: true, // 纯读文件,无共享状态(issue #283 ③)

  async run(args, world) {
    const { path } = args as { path: string };
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("read_file: 参数 path 必须是非空字符串");
    }
    return world.fs.read(path);
  },
};
