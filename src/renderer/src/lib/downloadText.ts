// 把一份文本交给系统「保存」。渲染进程不碰 fs（ShellBridge 硬规则），
// 走 <a download> —— 和图片下载同一条路（components/assistant-ui/image.tsx）。
// 原本长在 replay/TrajectoryView.tsx 里，云会话导出（#1117）也要用，抽出来共用。
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}
