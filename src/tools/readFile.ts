// read_file — 最无害的第一个工具：纯读，不需要审批

import type { Tool } from "./tool.js";

/** 模型可见上限（**UTF-8 字节**）——read_file 是唯一无界的口子（终审 C2）：
    水獭在沙箱里读一个 ~190KB+ 的 package-lock/打包产物/日志很常见，原样
    落日志后一旦要扇给 cs 云会话的客户端，单条事件就足以冲破 wire.ts 的
    MAX_FRAME_BYTES（256 KiB，见 cloudSession.ts）。截断不是静默的（同
    bash.ts 的 clip() 先例）：模型能看到自己被截了多少，可以自行决定用
    bash 的 head/tail/grep 重新精读所需片段。

    **按字节不按字符**（issue #823）：上一版是 200_000 **字符**，于是它
    根本不保证事件发得出去——满上限的纯 ASCII 结果 JSON 实测 200,112 字节
    （已超 frameHandler 的 128 KiB 分片阈值），中文更是 600,112 字节。
    "无界"变成了"有界但仍可能超限"，最终还是要靠 frameHandler 的 skip
    兜底（在 backlog 里变成一条「历史事件过大已跳过」的占位）。上限取
    128 KiB，与 frameHandler 的 BACKLOG_CHUNK_BYTES 同源（那边不 import
    过来：src/tools 是共享层，不该反向依赖 services/runtime——两个常量
    各自写死、注释里互相点名）。够读任何正常的代码/配置文件，模型上下文
    本来也吃不下比这更大的东西。 */
const MAX_BYTES = 128 * 1024;

const utf8 = new TextEncoder();

function clip(text: string): string {
  const bytes = utf8.encode(text);
  if (bytes.byteLength <= MAX_BYTES) return text;
  // 退到一个完整码点的边界再切：UTF-8 的续接字节形如 10xxxxxx，切在它中间
  // 会解出一个 U+FFFD（"文件里凭空多出个 ￼"比截断本身更难排查）。
  // bytes[end] 是**切点之后**的第一个字节——它是续接字节就说明切在了字符
  // 中间，往回退到该字符的首字节为止
  let end = MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
  const head = new TextDecoder().decode(bytes.subarray(0, end));
  const warn =
    `\n\n[Warning: 文件内容被截断——原始 ${bytes.byteLength} 字节，只保留前 ${end} 字节。` +
    `需要完整内容请用 bash 的 head/tail/grep 重新读取所需片段。]`;
  return head + warn;
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
