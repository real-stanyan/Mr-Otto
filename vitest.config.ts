import { defineConfig } from "vitest/config";

// 测试发现钉死在本项目自己的 tests/ 下。
// 默认 include 会连 .claude/worktrees/ 下各 agent worktree 里的 tests/ 一起扫:
// 同一套测试跑 4 份、每份停在各自分支的版本——本 lane 会被别人分支的红拦住,
// 更糟的是停在旧提交的那份可能盖住当前分支的真实失败。
// 那些目录在 .git/info/exclude 里,CI 的 clone 根本没有,
// 所以这条 include 是让本地对齐 CI(CI == Gate 契约),不是削覆盖(issue #30 / ADR-0016)。
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
