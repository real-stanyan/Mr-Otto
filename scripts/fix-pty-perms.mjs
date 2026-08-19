#!/usr/bin/env node
// npm 解包 node-pty 时会丢掉 spawn-helper 的执行位(tarball 里有,落地就没了),
// 于是开终端时 posix_spawnp 直接失败——报错还不提这个文件,只说 "posix_spawnp failed"。
// 每次 npm i 都会重犯,所以挂 postinstall 自动补,而不是写进 README 让人手动 chmod。
//
// 只碰 node-pty 自己的 spawn-helper,不递归整个 node_modules:改别人家文件的权限
// 是越权,出了事也难查。Windows 没有执行位,直接跳过。

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "win32") process.exit(0);

const root = join(process.cwd(), "node_modules", "node-pty");
if (!existsSync(root)) process.exit(0); // 没装 node-pty(比如只装了 CI 子集)不算错

/** spawn-helper 可能落在 build/Release、build/Debug、prebuilds/<plat>-<arch> 三处
    (node-pty 的 utils.js 就按这个顺序找),各处都补一遍 */
const candidates = [join(root, "build", "Release"), join(root, "build", "Debug")];
const prebuilds = join(root, "prebuilds");
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir));
}

for (const dir of candidates) {
  const helper = join(dir, "spawn-helper");
  if (!existsSync(helper)) continue;
  const mode = statSync(helper).mode;
  if (mode & 0o111) continue; // 已经能执行了,别白改
  chmodSync(helper, 0o755);
  console.log(`[fix-pty-perms] chmod +x ${helper}`);
}
