// exec 输出三层截断的第二层：事件流/IPC 限流（issue #343，借鉴 codex
// async_watcher.rs）。保护 Electron IPC 与渲染进程，与内存层（headTail.ts）、
// 模型层（bash.ts 的可见预算）分开配置——三层各管各的，调谁都不牵连别人。
//
// 两个细节（codex 同款）：
// - 超配额后**丢弃直播**但不停读——消费方继续拿 chunk（读到 EOF 由 world 层
//   保证），只是不再过桥；停读会让管道 back-pressure 卡死子进程
// - 大 chunk 在字符边界切片，且不从 surrogate pair 中间切——渲染层拼接时
//   不会出现半个字符

export interface ExecStreamLimits {
  /** 单个过桥 chunk 的字符上限 */
  maxChunkChars?: number;
  /** 单次调用允许过桥的 chunk 总数；超过即静默丢弃（直播是预览，事实在 tool_result） */
  maxChunks?: number;
}

export const DEFAULT_EXEC_STREAM_LIMITS: Required<ExecStreamLimits> = {
  maxChunkChars: 8_192,
  maxChunks: 10_000,
};

/** 把一条输出直播回调包成"限流版"。按调用各建一个（配额是 per-call 的） */
export function createExecStreamLimiter(
  emit: (chunk: string, stream: "stdout" | "stderr") => void,
  limits: ExecStreamLimits = {}
): (chunk: string, stream: "stdout" | "stderr") => void {
  const { maxChunkChars, maxChunks } = { ...DEFAULT_EXEC_STREAM_LIMITS, ...limits };
  let sent = 0;
  return (chunk, stream) => {
    let i = 0;
    while (i < chunk.length) {
      if (sent >= maxChunks) return; // 配额烧完:直播静默结束,完整输出仍在 tool_result
      let end = Math.min(i + maxChunkChars, chunk.length);
      // 不从 surrogate pair 中间切
      if (end < chunk.length) {
        const c = chunk.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      emit(chunk.slice(i, end), stream);
      sent += 1;
      i = end;
    }
  };
}
