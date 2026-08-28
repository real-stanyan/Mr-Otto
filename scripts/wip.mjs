#!/usr/bin/env node
// wip —— 把手上的活先落成一个提交，别用 stash（issue #632，ADR-0154）
//
//   npm run wip                 提交所有改动（含未跟踪），信息 "WIP"
//   npm run wip -- 换个说法      自定义信息
//
// 为什么要有这个：worktree 隔离文件、隔离 HEAD，但 `.git` 是共享的——**stash 栈也是
// 共享的**。这是 worktree 模型唯一的漏点，本仓因此丢过东西（#543 现象 2：另一条 lane
// 的 `pop` 弹走了不属于它的改动）。
//
// git 没有 stash 钩子，拦不住。但可以把**用 stash 的理由**拿掉：在自己的一次性
// worktree 里，未提交的改动没人碰得着，"先存起来"这件事一个普通提交就够了，而且
// 提交是自己分支上的，别人的 `pop` 够不到。
//
// 撤销：git reset --soft HEAD~1（改动原样回到工作区）。这句也印在输出里。

import { execFileSync } from "node:child_process";
import { argv, exit, stdout, stderr } from "node:process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function tryGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

if (tryGit(["rev-parse", "--git-dir"]) === null) {
  stderr.write("\n✗ 当前目录不是 git 仓库\n\n");
  exit(1);
}

const message = argv.slice(2).join(" ").trim() || "WIP";

if (tryGit(["status", "--porcelain"]) === "") {
  stdout.write("· 没有改动，什么都不用存\n");
  exit(0);
}

git(["add", "-A"]);
// 钩子照跑：在自己的 worktree 里它本来就放行；在主 checkout 上被拒是**对的**
// ——那正是 ADR-0149 要挡的事，不该被一条"图省事"的命令绕过去
git(["commit", "-m", message]);

stdout.write(`
✓ 存好了：${git(["rev-parse", "--short", "HEAD"])}  ${message}

  想拿回来接着改：git reset --soft HEAD~1
  （别用 git stash——多 worktree 共享同一个 stash 栈，别人的 pop 会弹走你的东西，
    本仓踩过：issue #543）
`);
