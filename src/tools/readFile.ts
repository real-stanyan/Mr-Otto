// read_file — 最无害的第一个工具：纯读，不需要审批

import type { Tool } from "./tool.js";

/** 模型可见上限（字符）——read_file 是唯一无界的口子（终审 C2）：水獭在
    沙箱里读一个 ~190KB+ 的 package-lock/打包产物/日志很常见，原样落日志后
    一旦要扇给 cs 云会话的客户端，单条事件就足以冲破 wire.ts 的
    MAX_FRAME_BYTES（256 KiB，见 cloudSession.ts）。截断不是静默的（同
    bash.ts 的 clip() 先例）：模型能看到自己被截了多少，可以自行决定用
    bash 的 head/tail/grep 重新精读所需片段。上限选得足够大——不影响正常
    读代码/配置文件，只挡真正离谱的大文件。 */
const MAX_CHARS = 200_000;

function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const warn =
    `\n\n[Warning: 文件内容被截断——原始 ${text.length} 字符，只保留前 ${MAX_CHARS} 字符。` +
    `需要完整内容请用 bash 的 head/tail/grep 重新读取所需片段。]`;
  return text.slice(0, MAX_CHARS) + warn;
}

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
    const content = await world.fs.read(path);
    return clip(content);
  },
};
