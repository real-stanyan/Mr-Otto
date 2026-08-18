# ADR-0016：测试发现范围钉死在 `tests/`，本地门禁对齐 CI

日期：2026-08-18
状态：已采纳
关联：issue #30（Protocol gap）、gearbox ADR-0020（测试类门禁的 L1/L2 分层）、AGENTS.md「CI == Gate 契约」

## 背景

本地 `npm test` 报 107 个测试文件 / 1240 条，CI 上是 28 个 / 348 条。

差额不是本项目的测试：vitest 的默认 include 把 `.claude/worktrees/` 下各 agent worktree 里的
`tests/` 一并扫了进来 —— 同一套测试跑 4 份（main + 3 个 worktree），每份停在各自分支的版本。

后果不是"多跑几遍"，是门禁失真：

- 本 lane 的门禁会被**别的 lane 分支上的失败**拦住（实测撞到过一次：`friend-system` worktree 的
  `friends.test.ts` 红了，与当前改动无关）。要么被无关的红拦住，要么学会无视红色，两个都坏。
- 反向更危险：某个 worktree 停在旧提交，它那份旧测试可能**掩盖**当前分支的真实失败，而总数
  对不上没人会察觉。
- `.claude/worktrees/` 在 `.git/info/exclude` 里，CI 的 clone 没有这些目录 —— 也就是说
  AGENTS.md 的「CI == Gate」契约，在本地这一侧本来就是破的。

## 决策

新增 `vitest.config.ts`，把测试发现钉死在项目自己的目录：

```ts
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } })
```

Gate 命令行不变，仍是 `npm test`。`.claude/worktrees/*/tests/**` 自然落在 include 之外。
改后本地 28 文件 / 348 条，与 CI 逐一对上。

## 分层裁定：按 L2 处理

gearbox ADR-0020 给测试类门禁的规则是「收紧 = L2 / 放松 = L1」。缩小发现范围两边都读得通，
维护者 `stanyan` 在会话中裁定按**修复**处理（L2）：少掉的文件本就不属于本项目，是别的分支的
副本，CI 从来没跑过它们；此举是让本地对齐 CI，不是削本项目的覆盖。

本项目自己的测试一条没少：改前改后都是 `tests/` 下 28 个文件、348 条，全绿。

## 代价

- `tests/` 之外若将来要放测试（例如源码同目录），得回来改这条 include。这与 AGENTS.md
  「测试统一放 `tests/`，镜像 `src/` 结构」的既有约定一致，不构成新约束。
