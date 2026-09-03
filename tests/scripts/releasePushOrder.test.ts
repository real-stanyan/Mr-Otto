// release.mjs 的步骤顺序（issue #679，ADR-0215）。
//
// 钉的是一条**顺序**不变量：升版之后先把 main 推上去占位，抢不到就在构建之前退出。
// 原来的顺序（构建完再 `push --follow-tags`）有条 race——十分钟构建期间别条 lane 合了
// PR，最后那次 push 被拒，而 tag 因为不是原子推送已经出门了，落地成远端一个悬空 tag
// 加没有 release。发 v1.1.0 时真踩过。
//
// 为什么要真跑而不是读源码断言：这条不变量是「哪一步先发生」，而源码里 `run(...)` 的
// 出现顺序只是它的一个**表象**——把占位挪进一个 if 里、或者哪天加了提前 return，源码
// 顺序照旧、行为已经变了。所以照 laneTooling.test.ts 的路子：起真临时仓 + 真裸仓当
// remote + 真跑脚本，用「构建脚本有没有留下脚印」判断它到底跑没跑到那一步。
//
// `gh` 和真构建都换成临时目录里的假货（PATH 前置 + package.json 里的 stub），
// 脚本本身一行没改地跑。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RELEASE = resolve(__dirname, "../../scripts/release.mjs");

let root: string;
let work: string;
let bare: string;
let bin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 跑 release.mjs，PATH 前置假 gh。回退出码与合并输出——失败路径也要能读到话。 */
function release(bump: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [RELEASE, bump], {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

/** dist:mac 的 stub 干两件事：留脚印（证明构建这一步真跑到了）、把**当时**远端 main
    的 SHA 记下来（证明占位 push 发生在它之前）。dist:win 造出三个假产物凑够资产检查。 */
const DIST_MAC = [
  "node -e \"require('fs').writeFileSync('built.txt','mac')\"",
  "&& node -e \"require('fs').writeFileSync('remote-at-build.txt', require('child_process').execFileSync('git',['ls-remote','origin','refs/heads/main'],{encoding:'utf8'}))\"",
].join(" ");

const DIST_WIN = [
  "node -e \"require('fs').mkdirSync('dist',{recursive:true})\"",
  "&& node -e \"const v=require('./package.json').version;for(const s of ['-'+v+'-x64.dmg','-'+v+'-arm64-mac.zip','-'+v+'-win-x64-setup.exe'])require('fs').writeFileSync('dist/app'+s,'x')\"",
].join(" ");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "release-order-"));
  bare = join(root, "origin.git");
  work = join(root, "work");
  bin = join(root, "bin");

  // 假 gh：记下自己被调用过，永远成功。真 gh 会打网络。
  await mkdir(bin, { recursive: true });
  const gh = join(bin, "gh");
  await writeFile(gh, `#!/bin/sh\necho "$@" >> "${root}/gh-calls.txt"\nexit 0\n`);
  await chmod(gh, 0o755);

  // 「别条 lane 合了 PR」写成一个能被构建脚本调用的小程序——advanceRemote() 是同一件事
  // 的同步版,两者共用一份行为
  await writeFile(
    join(root, "advance.mjs"),
    [
      `import { execFileSync } from "node:child_process";`,
      `import { rmSync } from "node:fs";`,
      `const other = ${JSON.stringify(join(root, "other-build"))};`,
      `rmSync(other, { recursive: true, force: true });`,
      `const q = { stdio: "ignore" };`,
      `execFileSync("git", ["clone", ${JSON.stringify(bare)}, other], q);`,
      `execFileSync("git", ["config", "user.email", "o@example.com"], { cwd: other, ...q });`,
      `execFileSync("git", ["config", "user.name", "o"], { cwd: other, ...q });`,
      `execFileSync("git", ["commit", "--allow-empty", "-m", "别条 lane 合了 PR"], { cwd: other, ...q });`,
      `execFileSync("git", ["push", "origin", "main"], { cwd: other, ...q });`,
    ].join("\n"),
  );

  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  // npm version 会打 tag，需要签名以外的东西都不要
  git(work, "config", "tag.gpgSign", "false");
  git(work, "config", "commit.gpgSign", "false");

  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ name: "t", version: "1.0.0", private: true, scripts: { "dist:mac": DIST_MAC, "dist:win": DIST_WIN } }, null, 2),
  );
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "push", "-u", "origin", "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 让远端抢先走一格：另一条 lane 在我们升版的空档合了 PR。 */
function advanceRemote(): void {
  const other = join(root, "other");
  execFileSync("git", ["clone", bare, other], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "o@example.com"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "o"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "别条 lane 合了 PR"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: other, stdio: "ignore" });
}

describe("release.mjs 的步骤顺序（#679）", () => {
  it("顺利时：占位 push 在构建之前——构建那一刻远端 main 已经是版本提交", () => {
    const r = release("patch");
    expect(r.ok, r.out).toBe(true);

    // 构建真跑了
    expect(existsSync(join(work, "built.txt"))).toBe(true);
    // 而它跑的时候，远端 main 已经等于本地的版本提交（= 占位在前）
    const head = git(work, "rev-parse", "HEAD");
    const remoteAtBuild = readFileSync(join(work, "remote-at-build.txt"), "utf8");
    expect(remoteAtBuild).toContain(head);
  });

  it("顺利时：tag 最后才出门，release 建了", () => {
    expect(release("patch").ok).toBe(true);
    expect(git(work, "ls-remote", "--tags", "origin")).toContain("v1.0.1");
    expect(existsSync(join(root, "gh-calls.txt"))).toBe(true);
  });

  it("抢不到位子：**构建之前**就退出，十分钟不白花", () => {
    advanceRemote();
    const r = release("patch");

    expect(r.ok).toBe(false);
    // 唯一真正要钉的一条：构建一步都没跑
    expect(existsSync(join(work, "built.txt"))).toBe(false);
  });

  it("抢不到位子：远端不留悬空 tag，本地那个还在（人工收拾）", () => {
    advanceRemote();
    expect(release("patch").ok).toBe(false);

    // 远端干净——这正是 v1.1.0 那次的伤口
    expect(git(work, "ls-remote", "--tags", "origin")).not.toContain("v1.0.1");
    // 本地留着，脚本不自作聪明回滚（文件头的原则）
    expect(git(work, "tag", "--list")).toContain("v1.0.1");
    // 也没去建 release
    expect(existsSync(join(root, "gh-calls.txt"))).toBe(false);
  });

  it("抢不到位子：报错里带着照抄就能用的收拾步骤", () => {
    advanceRemote();
    const r = release("patch");
    expect(r.out).toContain("git tag -d v1.0.1");
    expect(r.out).toContain("git pull --ff-only");
    expect(r.out).toContain("npm run release -- patch");
  });

  it("占位之后被超车：照样发得出去，tag 仍然指向构建自的那棵树", async () => {
    // 真实场景是这样的：占位成功 → 构建十分钟 → 这期间别条 lane 合了 PR。
    // 所以把「别人合 PR」塞进构建脚本里,让它真的发生在占位之后、推 tag 之前。
    // 这条是分成两条 push（而不是一条 `--follow-tags`）的理由：此时本地 main 是
    // **落后**的,推分支是 no-op,`--follow-tags` 就不会把 tag 带上去。
    await writeFile(
      join(work, "package.json"),
      JSON.stringify(
        {
          name: "t", version: "1.0.0", private: true,
          scripts: { "dist:mac": `node ${join(root, "advance.mjs")} && ${DIST_MAC}`, "dist:win": DIST_WIN },
        },
        null, 2,
      ),
    );
    git(work, "add", "-A");
    git(work, "commit", "-m", "构建期间制造一次超车");
    git(work, "push", "origin", "main");

    const r = release("patch");
    expect(r.ok, r.out).toBe(true);

    // 远端确实被别人推进过（超车真的发生了,这条断言防的是测试自己失效）。
    // 现问远端不看本地的 origin/main——那条 remote-tracking ref 没人 fetch 过它就是陈旧的
    git(work, "fetch", "origin");
    expect(git(work, "log", "--oneline", "origin/main", "-1")).toContain("别条 lane");
    // 而 tag 照样上去了,且指向我们构建自的那个提交
    const head = git(work, "rev-parse", "HEAD");
    expect(git(work, "ls-remote", "--tags", "origin")).toContain("v1.0.1");
    expect(git(work, "rev-parse", "v1.0.1^{commit}")).toBe(head);
    expect(existsSync(join(root, "gh-calls.txt"))).toBe(true);
  });
});
