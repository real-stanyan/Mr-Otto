// Playwright 只跑 tests/e2e(起真 Electron)。vitest 的 include 钉在 *.test.ts,
// 这里用 *.e2e.ts 后缀,两套跑器互不捞对方的文件。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
