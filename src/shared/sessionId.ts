// 会话 id：秒级时间戳 + 随机段。原来住在 src/main/agent.ts（随机段用 node 的 randomBytes）。
// 搬进 shared 是因为手机端（③）也要铸同一形状：Default 子目录名就是它（ADR-0206），
// 另一台电脑靠它算路径。随机段是承重的那一半——id 是 append-only 日志的分区键，
// 撞一次就是两个会话的事件写进同一条日志，事后拆不开（#111）。
// 不 import node:crypto：src/shared 三端共用（tests/architecture.test.ts 钉着），
// Node 20+ / Electron / RN（polyfill 后）都有 globalThis.crypto.getRandomValues。
export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `s-${stamp}-${hex}`;
}
