// byteSize — 附件大小的显示口径,一份。
//
// 以前三处各写各的:StagedChips 是 (b/1024).toFixed(0)、UserAttachments 是
// Math.max(1, round(b/1024))、assistant-ui/file.tsx 才是对的。同一个 105 字节的
// 附件在三个地方分别显示 "0 KB"、"1KB"、"105 B" —— 三份实现就是三种真相。
//
// 1KB 以下必须显示 B:文档转出的 Markdown 普遍就是几百字节(ADR-0046),
// 而用户刚拖进去的是几十 KB 的 docx。看到 "0 KB" 的第一反应是没读到内容。

/** 附件大小的人话。B / KB / MB 三档,单位前带空格 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
