// cloudRepoStatus —— 工作区仓库那一格的状态文字（#834 起；#991 从 CloudSessionPage
// 搬到 lib，因为它现在画在工作区设置页的「仓库」tab 上，不在会话头部）。
//
// **给所有人看，不只是 owner**："这个工作区的水獭到底在哪个仓库上干活、拉下来没有"
// 是每个成员都该看得见的事实。`repo === null` = 没配——不是错误：不是每个工作区
// 都需要仓库（文案、运营类的活在空目录里干就行），所以 short 那句不带警告色。

import type { CsRepoState } from "../../../shared/remote/cloudSession.js";

export function repoStatusText(repo: CsRepoState | null): { short: string; full: string } {
  if (!repo) return { short: "未配仓库", full: "这个工作区没有配仓库，水獭的工作目录是空的。不是每个工作区都需要仓库。" };
  let host = repo.url;
  try {
    const u = new URL(repo.url);
    host = `${u.host}${u.pathname}`.replace(/\.git$/, "");
  } catch {
    /* 服务端校验过才存得进来，这里只是显示层的尽力而为 */
  }
  if (!repo.clone) {
    return { short: `${host} · 待克隆`, full: `${repo.url}\n还没克隆——下一次工具调用时才会去拉。` };
  }
  const bad = repo.clone.kind === "failed" || repo.clone.kind === "refused";
  return {
    short: `${host} · ${bad ? "未拉下来" : "已克隆"}`,
    full: `${repo.url}\n${repo.clone.text}`,
  };
}
