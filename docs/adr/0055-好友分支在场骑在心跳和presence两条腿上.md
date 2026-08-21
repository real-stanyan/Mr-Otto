# 0055. 好友分支在场骑在心跳和 presence 两条腿上

状态:已采纳 · 2026-08-21 · issue #167

## 背景

Git Graph 要能看到"和我开同一个仓库的 Otto 好友此刻在哪根分支"。git 自己没有"谁正在开发"这个概念——author 是"谁提交过",不是"谁此刻在"。所以必须选一个事实源,graph 只是投影。

候选:分支命名前缀(静态,交接后失真)、PR/issue claim(需要 GitHub、本地未推的分支看不见)、最后 commit author(误导)、实时 presence(唯一能表达"正在")。这次要的是"正在",选 presence。

## 决定

1. **事实源 = 两条腿,和在线点一样(ADR-0027)**:Realtime presence 的 track meta `{repoKey, branch}` ∪ REST 心跳写进 `profiles.repo_key / repo_branch`(migration 0008)。读的时候 Realtime meta 优先(更新),没有就取心跳窗口内的列。线上 /realtime/v1 仍 503(#77),只靠 presence 会上线即死;心跳腿让它在 REST 活着时就准。
2. **仓库身份 = 规范化 remote URL 的 sha256 前 16 位**。规范化去协议 / `user@` / 端口 / `.git` / 尾斜杠 / 大小写(`shared/repoKey.ts`),ssh 与 https 克隆对得上。存 hash 不存地址:好友只能判断"同不同一个仓库",拿不到私有仓库地址。没有 origin 的本地仓库没有跨机器身份,不广播。
3. **分支 = 本地短名**(`symbolic-ref --short HEAD`),detached 为 null 但仍报 repoKey(人在仓库里,只是不在分支上)。graph 侧 `x` 和 `*/x` 都算命中——好友的本地分支在我这里多半只有 remote 徽章。
4. **主进程盯 git 目录**(`workspacePresence.ts`):渲染层通过 ShellBridge 报当前会话 workspace,主进程按 `known()` 校验后 `fs.watch` git 目录(linked worktree 的 HEAD 不在 `<repo>/.git`,用 `rev-parse --absolute-git-dir`),过滤 `HEAD`、去抖 200ms,外加 60s 慢轮询和窗口 focus 对账兜 macOS fs.watch 漏报。盯目录不盯文件:git 用 rename 落 HEAD,盯文件会在第一次 rename 后失联。
5. **Realtime 通道是全站的,工作区按好友集过滤**:`FriendsManager` 只放行上一拍心跳读到的好友 id。心跳腿本来就只读好友的行。
6. **不代为 fetch**:好友在的分支我本地没有 → 图顶一行灰字。图里唯一的写操作仍是 checkout(ADR-0014)。

## 不做(这次)

- 隐私开关:先默认对好友公开;要关再开 issue。
- 多窗口 / 多仓库同一人:presence 同 key 再 track 会覆盖,先做单 workspace(当前会话)。`presenceStateToEntries` 已按"多 meta 取第一个带 repoKey 的"读,meta 改数组时读端不用动。
- 按分支名前缀猜人、commit author 兜底——都不是"正在",不混进来。

## 会推翻它的前提

- 如果 #77 修好且 Realtime 被证明长期稳定,心跳腿可以退化成纯在线点(去掉两列),但 ADR-0027 的理由(自托管链路不可靠)不变,大概率不会。
- 如果要"谁认领了"而不是"谁正在",事实源应换成 issue assignee / PR author(ADR-0047 那一套),那是另一个功能,不是这个的改法。
