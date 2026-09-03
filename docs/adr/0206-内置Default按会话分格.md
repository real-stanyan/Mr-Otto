# 0206 内置 Default 按会话分格：`<Default>/<sessionId>/`

日期：2026-09-03 ｜ 状态：已定 ｜ 关联：#851、ADR-0135（推进：`workspaceKind` 判定变了）、ADR-0204（主题桶）、ADR-0172（岛的分组镜头）
spec：docs/superpowers/specs/2026-09-02-topic-memory-design.md §4

## 背景
所有任务会话共写一个平铺的 `文档/Mr Otto/Default`：撞名（`report.md` 被下一个任务静默盖掉）、
coworkLog 混账、Files 面板越来越长。ADR-0135 的前提表早写了一句「Default 语义不再钉死在固定路径时，
`workspaceKind` 的判定要重审」——这就是那一天。

## 决定
1. **会话工作区 = `<内置 Default>/<sessionId>/`**，惰性 mkdir（只在真被用作会话工作区那一刻），
   只对**内置** Default；用户自定义的默认工作文件夹不分格——那是用户自己的文件夹，往里塞子目录是越界。
   `session_created.workspace` 落的就是子目录，Files / coworkLog / `package_project` 沿现有 workspace 语义不改。
2. **判据抽成纯函数** `isDefaultWorkspace(workspace, builtin)`（`src/shared/defaultWorkspace.ts`）：
   等于 Default 根（旧日志形状）**或**父目录是它（新形状）都算任务会话。主进程（`workspaceKind` 落盘）
   与渲染层（任务/项目分栏、「归到…」菜单）共用同一份，判据分叉就是 #722 那种撒谎的勾。
3. **先铸 id 再建会话**：子目录名要用 sessionId，而 `createAgent` 原本在内部铸 id。加 `presetSessionId`，
   `startSession` 与两条导入路径（`importSharedSession` / `importWorkspaceSession`）都经
   `allocateSessionWorkspace` 先铸、先 mkdir、再把 id 递进去——**子目录名 == 会话 id** 是不变量。
4. **子目录名用完整 sessionId，不用 spec 写的「前 8 位」**：sessionId 形如 `s-20260903111128-a1b2c3d4`，
   前 8 位是 `s-202609`，同月全撞。完整 id 唯一、Finder 里按时间排序、能直接对上会话。
5. **`PACKAGE_NUDGE` 不改**：它只是 `workspaceKind` 的函数，改了旧会话（仍共写根目录）的提示也跟着变；
   「别叫 report.md、同名先读」这几句在独占目录里无害。
6. **岛上折回一组**（`withDefaultFold`）：组头回答「这是哪个项目」，所有任务会话都属于「Default」；
   不折的话每个任务各占一组。
7. **归档不删子目录**（用户在 Finder 找得到自己的产出是 #559 照顾新手的理由）。设置页「清理空的任务文件夹」
   只删**名字像 sessionId + 空 + 不是活着的会话**三条都满足的——活着的会话刚建目录时也是空的，删掉等于把
   正在跑的水獭的 cwd 抽走。

## 被否掉的路
- 按标题命名子目录：标题在第一轮回复后才有、会改名，日志里的路径变成历史。
- 归档即删子目录：见决定 7。
- 任务不要工作区、产物进附件库：推翻「会话永远有工作区」，bash 没有 cwd，留给 v2 容器化再看。
- 临时目录 + 归档删：比分格干净，但新手在 Finder 找不到没打包的产物。

## 已知边界
- 内置 Default 恰好在一个 git 仓里（用户把 Documents 纳入版本控制）：`shouldIsolate` 会给会话开 worktree
  副本，`workspaceKind` 不落——这在分格前就是如此（worktree 路径从来不等于 Default 根），不是本 ADR 引入的；
  分格后多出一个空子目录，由决定 7 的清理收走。
- mkdir 发生在 `mcpHub.ready()` / 下载 / 建会话之前，后面失败会留一个空目录——同样由清理收走。

## 什么前提垮了要重看
- sessionId 形状变了 → `SESSION_FOLDER_RE` 与清理一起改，否则清理认不出新目录。
- Default 不再是文档区固定路径 → `isDefaultWorkspace` 的判据与 ADR-0135 一起重审。
- 用户要「同一个任务多个会话共用文件夹」→ 分格键从 sessionId 换成别的，决定 3 的不变量随之改。
