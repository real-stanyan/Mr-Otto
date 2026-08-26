import { resolve } from "path";
import { defineConfig } from "vitest/config";

// 测试发现钉死在本项目自己的 tests/ 下。
// 默认 include 会连 .claude/worktrees/ 下各 agent worktree 里的 tests/ 一起扫:
// 同一套测试跑 4 份、每份停在各自分支的版本——本 lane 会被别人分支的失败拦住,
// 更糟的是停在旧提交的那份可能盖住当前分支的真实失败。
// 那些目录在 .git/info/exclude 里,CI 的 clone 根本没有,
// 所以这条 include 是让本地对齐 CI(CI == Gate 契约),不是削覆盖(issue #30 / ADR-0016)。
//
// .test.tsx 是 task-5 新加的一类(渲染层组件测试,McpSettings 的授权按钮)——
// 收紧发现范围(多认一种文件后缀)是 L2(gearbox ADR-0020：测试类门禁，config
// 层「收紧 = L2」),之前压根没有任何 .tsx 测试文件被 include 命中过
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 每个测试文件跑完删掉它建过的一次性目录（tests/helpers/tempDir.ts）。
    // 挂在这里而不是让每个文件各自 afterEach：那要求每个新测试都记得补，
    // 记不住的规矩迟早失效——而失效的表现是 /tmp 里慢慢堆满 otter-* 目录
    setupFiles: ["tests/helpers/setup.ts"],
  },
  resolve: {
    // 与 electron.vite.config.ts 的渲染进程别名对齐——McpSettings.tsx 这类
    // 组件源码用 `@/...` 指代 src/renderer/src,不跟着配就是"这条别名只在
    // 打包时存在,测试时不存在"的分叉
    alias: { "@": resolve(__dirname, "src/renderer/src") },
  },
});
