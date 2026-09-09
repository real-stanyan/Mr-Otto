# ADR-0281：主窗 session 按账号分 partition——localStorage 也进抽屉

- 状态：已采纳（2026-09-09）
- Issue：#758（#749 / ADR-0187 / ADR-0188 那条线的收尾）

## 背景

ADR-0187/0188 把**主进程管的**本机数据按登录账号分了抽屉（`accounts/<sha256(uid) 前16位>/`），
但渲染层的 `localStorage` 没在里面：它是 Chromium 的存储，主窗没写 `partition` 就是默认
session，落在 `<userData>/Local Storage/`——抽屉的**外面**，两个账号共用一份。漏的是**路径**
不是内容：侧栏折叠状态的 key 是工程目录绝对路径、`otter-protocol-repo` 存仪表盘目标仓库路径，
「上一个账号在这台机器上做过哪些项目」就这么漏给下一个登录的人——正是 #749 想挡住的那一类。

## 决策

主窗 `webPreferences.partition = windowSessionPartition(bootUid)`（`persist:otto-<抽屉名>`），
一行的事，前提全都现成：

- `bootUid` 在模块顶层就同步算好（同 ADR-0183 读 `auth.json`，不等网络往返），`createWindow()`
  跑在 `whenReady` 里，必然拿得到；
- 换号本来就要重启（`needsRelaunch`，ADR-0187），重启后新窗口自然拿到新 partition，
  **不需要任何热切换**；
- 全仓没有任何 `defaultSession` / `fromPartition` 的使用，这一改不会带偏别的东西；
- 内置浏览器用的是 `WebContentsView` 自己写死的 `persist:otto-browser`，与主窗 session
  本来就是两摊，这次也不合并——网页的 cookie 不该和 Otto 的搅在一起（webContentsViewFactory
  头注）。partition 名的 `otto-` 前缀就是为了让 `Partitions/` 下这两摊分得开。

判据函数收进 `accountScope.ts`（抽屉名怎么算只有这一处知道），主窗接线在 `index.ts` 的
`createWindow`——`index.ts` 没法 import 进 vitest（顶层 `whenReady` 副作用），所以
`tests/main/accountScope.test.ts` 里除了判据函数的行为断言，还有一条读源码的接线断言
（`partition: windowSessionPartition(bootUid)`）。摘掉这一行不会红任何行为测试——
共享默认 session 恰恰是「什么都没坏」的样子，这正是 #758 躺了这么久的原因。

## 代价（都知道会发生，都可接受）

- **存量 localStorage 不迁移**：partition 一换，所有人的侧栏折叠状态、主题、面板宽度清一次。
  重置密码那笔记号（`resetPending`，ADR-0194）也在 localStorage——跨这次升级、流程走到一半
  的人会重走一遍引导，无害。
- e2e 不受影响：harness 换 `HOME` 做隔离，不碰 localStorage；`launchOtto({ authRecord })`
  过闸走的是主进程那侧。
