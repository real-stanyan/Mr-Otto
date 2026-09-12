#!/usr/bin/env node
// 门禁里多的那一条（手机端类型检查，#422 / ADR-0293）需要 `mobile/` 自己那份依赖在位。
// 挂在 pretest 上，理由和 check-node.mjs 逐字相同：**把失败的归因从代码挪回环境**。
//
// 不装的失败长什么样：`npm test` 跑到 `npm --prefix mobile run typecheck` 那一步，
// npm 回一句 `sh: tsc: command not found` + 一串 npm 自己的 error 栈。读起来像门禁坏了、
// 像 tsconfig 配错了，而真相只是「这台机器还没 `npm --prefix mobile ci`」——
// 一个只改桌面的人**没有任何理由**先装一遍 RN 依赖，所以这句话必须由我们说出口。
//
// 判据取 `mobile/node_modules/typescript`（`.bin/tsc` 指向的那个包），不取 `node_modules` 目录本身：
// 装了一半、或者只软链了外壳的目录都能让后者为真，而它为真恰恰是这道闸最该说话的时候。
//
// 仓库根可由 argv 传入，这样它自己的测试不必挪动真的 node_modules（同 check-node.mjs 传版本号）。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2] ?? join(fileURLToPath(new URL("../", import.meta.url)));
const pkg = join(repo, "mobile", "node_modules", "typescript", "package.json");

if (!existsSync(pkg)) {
  process.stderr.write(
    `\n手机端的依赖还没装：找不到 ${pkg}。\n\n` +
      `  门禁里的 \`npm test\` 现在连手机端的类型检查一起跑（#422、ADR-0293），\n` +
      `  而 mobile/ 是 Expo/RN，有自己的 package.json 与 node_modules。\n\n` +
      `  修：npm --prefix mobile ci\n\n` +
      `  （CI 在 npm test 之前就跑这一句；本机装一次之后不用再管。）\n\n`
  );
  process.exit(1);
}
