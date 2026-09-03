#!/usr/bin/env node
// 门禁开跑前先确认 node 版本对不对。挂在 pretest 上,不是重复 vitest 的失败,
// 是把失败的**归因**从代码挪回环境。
//
// 起因(#897):node 20 上 better-sqlite3 13 的 darwin-arm64 prebuild 在
// `new Database(...)` 那一刻段错误——`require` 是好的,构造才崩。于是每个
// `new EventStore(...)` 的测试文件,worker 在跑第一条断言之前就没了。
// vitest 把它记成 `Errors 50`,退出码确实是 1(门禁并不是绿的),但摘要行写的是
//
//     Test Files  370 passed (403)
//          Tests  4503 passed (4856)
//
// ——读起来像"有几个用例挂了",而真相是"50 个文件一条都没跑"。同一份 checkout
// 在 node 22 上是 420 passed (420) / 5000。一个只在摘要括号里出现的差值,
// 不该由读的人负责发现。
//
// 门槛取**实测跑通过的最低版本**,不是 .nvmrc 那个:20 实测坏、22 实测好
// (420 files / 5000 tests 全绿),21 没验过,所以写 >=22。CI 用 24,.nvmrc 也是 24——
// 那是推荐值,这里是下限,两者不必相等。
//
// 版本可由 argv 传入(默认取当前进程),这样它自己的测试不必伪造一个 node 进程。

const MIN_MAJOR = 22;

/** 解析出主版本号;认不出来返回 null(认不出就别拦人,见下) */
function majorOf(version) {
  const m = /^v?(\d+)\./.exec(String(version).trim());
  return m === null ? null : Number(m[1]);
}

const version = process.argv[2] ?? process.versions.node;
const major = majorOf(version);

// 认不出版本号不拦:这道闸的价值是"把已知的坏版本挡在门外",
// 不是"把没见过的形状一律当坏的"——后者会在某天 node 改了版本号格式时
// 把整条门禁锁死,而那时它挡住的是一个完全健康的运行时。
if (major !== null && major < MIN_MAJOR) {
  process.stderr.write(
    `\n门禁跑在不支持的 node 上:当前 v${version.replace(/^v/, "")},本仓要求 >= ${MIN_MAJOR}。\n\n` +
      `  node 20 上 better-sqlite3 的 prebuild 会在 new Database() 时段错误,\n` +
      `  于是每个建 EventStore 的测试文件的 worker 在跑第一条断言之前就没了。\n` +
      `  vitest 把它记成 "Errors N",退出码是 1,但摘要行写的是\n` +
      `  "Test Files 370 passed (403)" —— 读起来像几个用例挂了,\n` +
      `  实际是 50 个文件一条都没跑(issue #897)。\n\n` +
      `  修:nvm use 24(CI 与 .nvmrc 用的版本),再跑 npm test。\n\n`
  );
  process.exit(1);
}
