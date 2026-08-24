// Playwright 只跑 tests/e2e(起真 Electron)。vitest 的 include 钉在 *.test.ts,
// 这里用 *.e2e.ts 后缀,两套跑器互不捞对方的文件。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  workers: 1,
  // 环境时序类偶发挂（issue #274）：同机有别的 agent/构建并发时 terminal.e2e
  // 随机挂过（splash 20s 不退、xterm click 超时两种形态），单跑/加压复现 0/9+。
  // 已证伪 rAF 遮挡暂停与纯 CPU 负载两个假设，根因未钉死——retry 兜偶发，
  // 首次重试自动录 trace：再犯直接有 trace 可查，而不是又一轮"看一眼没了"。
  // list reporter 会把重试后过的标成 flaky，不会静默吞掉
  retries: 2,
  use: { trace: "on-first-retry" },
  reporter: "list",
});
