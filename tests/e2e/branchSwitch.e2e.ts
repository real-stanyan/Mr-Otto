// 分支切换在会话时间线上留痕（issue #411 / ADR-0093）—— 读代码验不了的那一段：
// 顶栏那颗下拉真的切了 git 吗、主进程真的往**这条会话**的日志里追加了事件吗、
// 追加的事件真的被推给渲染层并画成了时间线上那一行吗。
// 单测里这三段全是被假 deps 顶住的：真 git、真 IPC、真 SQLite 只有在这里才在场。

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

/** 造一个有两个分支的临时仓库。用户名/邮箱写死在仓库级配置里：
    跑 CI 的机器上可能压根没有全局 git identity，commit 会直接失败 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-branch-"));
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir });
  git("init", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(dir, "readme.md"), "# hi\n");
  git("add", ".");
  git("commit", "-m", "first");
  git("branch", "feature/x");
  return dir;
}

test("#411 顶栏切分支：会话时间线上长出「切到分支 …」那一行，且写明从哪来", async () => {
  const otto = await launchOtto();
  const ws = makeRepo();
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好切分支");

    // ADR-0157 起每只水獭都开在自己的 git worktree 副本里（取消了「第一只不隔离」
    // 的例外），起始分支不是 ws 的 main，是 sessionWorktreeService 建的
    // `otto/session-<随机>`（isolatedBranchName，创建时 slug 固定传 "session"，
    // 见 src/main/index.ts 的 sessionWorktrees.create(opts.workspace, "session")）。
    // 现查这份副本的真实分支名再比对，而不是只断言一个宽松正则——这样命名规则
    // 哪天真的变了，这条测试会红，不会被一个模糊形状糊弄过去
    const worktreesDir = join(otto.accountData, "worktrees");
    const worktreeEntries = readdirSync(worktreesDir);
    expect(worktreeEntries, `会话应该恰好开出一份 worktree 副本：${worktreesDir}`).toHaveLength(1);
    const isolatedBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: join(worktreesDir, worktreeEntries[0]!),
      encoding: "utf8",
    }).trim();
    expect(isolatedBranch).toMatch(/^otto\/session-[0-9a-f]{6}$/);

    // 顶栏那颗下拉要等 git 问完分支才出现（非 git 目录时它整块不存在）
    const picker = win.getByTestId("branch-select");
    await expect(picker).toBeVisible({ timeout: 20_000 });
    await expect(picker).toContainText(isolatedBranch);

    await picker.click();
    await win.getByRole("option", { name: "feature/x" }).click();

    // 时间线上那一行 = 日志投影。它出现就说明事件真的落了盘并推了回来
    const marker = win.getByTestId("branch-marker");
    await expect(marker).toBeVisible({ timeout: 20_000 });
    await expect(marker).toContainText("切到分支");
    await expect(marker).toContainText("feature/x");
    // 「从哪来」是这一行唯一的增量信息：只写落点的话，读的人得自己往上翻——
    // 从哪来是这个会话自己的隔离分支，不是 ws 原来的 main
    await expect(marker).toContainText(isolatedBranch);

    // git 那边真的切了（下拉的当前值跟着变），不是只画了一行字
    await expect(picker).toContainText("feature/x");

    expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
  }
});
