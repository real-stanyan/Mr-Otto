# ADR-0037: assistant-ui 迁移没有引入第二套 headless 库——它本来就建在 radix 上

日期：2026-08-20　状态：已接受

## 背景

迁移设计阶段的假设是：assistant-ui 的 registry 组件依赖 `@base-ui/react`，
而本仓存量的 sidebar / dialog / select / dropdown-menu 建在 `radix-ui` 上，
两套 headless 库会在同一个 bundle 里并存（`docs/superpowers/specs/2026-08-19-assistant-ui-migration-design.md`
§4.2 原文；Task 5 的执行计划里还专门留了一步「`npm run build` 会真的暴露
base-ui 与 react 19 的解析问题」）。据此预留了一条 ADR 位（当时编号 0035，
并入 main 时撞上 main 自己的 ADR-0035《浏览器骑在 ExecutionWorld seam 上》，
挪到了现在这个号）准备记录「并存是刻意的」这个决定。

写这份 ADR 前照惯例核对代码，结果是：**这个假设不成立。**

- `node_modules/@assistant-ui/react` 自己的 `package.json.dependencies` 全是
  `radix-ui` / `@radix-ui/react-*`（`primitive`、`collection`、`compose-refs`、
  `context`、`use-callback-ref`……），没有一行 `@base-ui`。
- `src/renderer/src/components/assistant-ui/` 目录下 10 个 copy-in 文件，
  逐个 grep `@base-ui` 全部为空。唯一出现 headless 库引用的地方是
  `tooltip-icon-button.tsx` 的 `import { Slot } from "radix-ui"`——用的正是
  本仓已有的那一套。
- `npm ls @base-ui/react` 给出的路径是
  `@lobehub/icons@5.16.0 → @lobehub/ui@5.32.2 → @base-ui/react@1.6.0`，
  和 assistant-ui 毫无关系：`@lobehub/icons` 是本仓已有的直接依赖
  （只在 `ProviderMark.tsx` 里用来画模型厂商图标），它把 `@lobehub/ui`
  列成一个可选 peerDependency，npm 的 auto-install-peers 顺手把它和它的
  依赖 `@base-ui/react` 一起装进了 `node_modules`——`src/` 里没有任何文件
  `import` 过 `@lobehub/ui` 或 `@base-ui`，这是一块从未被引用过的死重量。

## 决定

不做任何「统一 headless 库」或「隔离两套 headless 库」的动作——因为没有
两套库需要协调。assistant-ui 迁移进来的组件全部走 `radix-ui`，和本仓存量
组件用的是同一套原语。`@base-ui/react` 留在 `node_modules` 里不动：删它
（比如给 `@lobehub/icons` 加 `overrides` 剔除可选 peer）是一次和这次迁移
无关的依赖清理，不在本次范围内。

## 理由

设计阶段的假设大概率来自「assistant-ui 官方文档/模板有的示例用
base-ui」这类外部印象，没有对着这个仓库实际 `npx shadcn add` 出来的文件
核实过。Task 5 把三个组件真正装进来之后，`npm run build` 干净通过、
`tsc --noEmit` 干净——如果真的引入了 `@base-ui/react` 又没人 import 它，
类型检查和构建都不会报错，所以这个假设能一直悄悄躺到写 ADR 的这一步
才被戳破。记录下来，是为了不让 §4.2 那段已经过时的文字继续误导后来者——
以为这里存在一个「刻意的并存」决定，进而去维护一份根本不存在的协调成本，
或者反过来花力气去「统一」两套本来就没有并存的库。

## 代价

`@base-ui/react` 及其依赖仍会出现在 `node_modules` 和 `package-lock.json`
里（`@lobehub/icons` 的可选 peer 决定的，不受这次迁移影响），是纯粹的
磁盘占用，不进 bundle，不影响运行时。

## 什么前提倒了会推翻它

未来某次 assistant-ui 版本升级，或者从它的 registry 里新装一个当前没有
的组件（比如某个用 `@base-ui` 弹层原语实现的组件），真的在 `src/` 里
落下一行 `import ... from "@base-ui"`。那时候本仓才第一次真正面对「两套
headless 库并存要不要统一」这个决定，需要一份新的 ADR 记录选择——这份
ADR 到那时候作废，不是被修改。
