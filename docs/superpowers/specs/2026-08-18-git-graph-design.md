# Git Graph 只读可视化设计

日期:2026-08-18
状态:已批准(维护者会话确认)
背景:在 Mr Otto 内可视化当前项目的 Git 分支拓扑(参考 gitgraphui.com / VS Code Git Graph 形态)。仓库有 git 才有图;严格只读,不做任何 git 写操作。

## 目标

1. 新增「Git Graph」视图:彩色泳道 + commit 点 + 分支/tag 徽章,看清分叉与合并
2. 点 commit 看详情:元数据 + 文件级改动清单(`--numstat`)
3. 全部分支(`--all`,本地 + remote + HEAD),最近 300 条,手动刷新

## 非目标

- 不做 git 写操作(checkout / merge / 建分支)——只读第一刀
- 不做完整 diff 查看(文件补丁),留第二刀
- 不做手选目录:目标仓库永远 = 当前会话 workspace
- 不做缓存/落库:打开拉取 + 手动刷新
- 不引图形库:@gitgraph/react 等停更且是"编程造图"API,不合"读仓库画图"场景

## 决策记录(需落 ADR-0013)

1. git CLI 直调(execFile,复用 protocolService 的 DI 模式),不引 nodegit/isomorphic-git
2. 自绘 SVG + 自写泳道算法,零新依赖;算法为纯函数,vitest 全覆盖
3. 只读第一刀(与 ADR-0012 protocol dashboard 同哲学)

## 1. 形态与入口

- 「更多」溢出菜单加「Git Graph」项(GitBranch 图标)
- `GitGraphView` 与 ProtocolView 平级;store 加 `gitGraphOpen`,与 protocolOpen / settingsSection 互斥(开一个关其他)
- 目标仓库 = 当前会话 workspace

## 2. 数据管道

硬规矩不破:渲染进程只经 `ShellBridge`。扩两个只读方法:

- `gitGraphLog(repoDir)` → `{ ok: true, head: string | null, commits: RawCommit[] } | { ok: false, kind, detail }`
  - `git log --all --topo-order -n 300`,format 用 NUL(`%x00`)分隔字段、记录间用 `%x01`:`%H %P %D %an %at %s`
  - `head` = `git rev-parse HEAD`(空仓库/无 HEAD 时 null)
  - kind = `git-missing`(没装 git)| `no-repo`(非 git 仓库/目录不存在)| `git-error`(其余)
- `gitGraphCommit(repoDir, hash)` → `{ ok: true, detail: CommitDetail } | { ok: false, kind, detail }`
  - `git show --no-patch --format=...` 拿完整消息/作者/邮箱/时间 + `git show --numstat --format=` 拿文件增删行数

主进程 `GitGraphService`:DI 依赖 `{ execGit(args, cwd), dirExists(dir) }`,镜像 protocolService(cwd 先查存在,防 ENOENT 与"没装 git"混淆)。

## 3. 泳道算法(纯函数,`src/shared/gitGraph.ts`)

- 输入:topo 序 commit 数组(hash + parents)
- 输出:每行 `{ lane, edges: { fromLane, toLane }[] }`——lane 为本 commit 落点,edges 为本行与下一行之间的连线段
- 活动泳道表:每道记"等谁"(期望 hash)。处理 commit 时:
  - 等它的道:最左的落座,其余收拢进落座道(合并线)
  - 没道等它:右侧新开道
  - 第一父接续本道;其余父:已有道在等就画线过去,否则新开道
- 颜色 = lane 序号 mod 色板(从主题令牌派生固定 8 色)
- 另附纯函数:log 输出解析(NUL/记录分隔)、`%D` refs 解码(HEAD ->、分支、tag、remote)、numstat 解析

## 4. UI(GitGraphView)

- 头部:workspace 路径(font-mono truncate)+ 刷新 + 关闭,镜像 ProtocolView
- 主体:纵向滚动,每 commit 一行固定行高(28px 级);左列 SVG(宽 = 最大泳道数 × 14px):commit 点 + 行间贝塞尔连线,颜色按泳道;右侧 HTML:refs 徽章(HEAD 所在分支高亮,remote/tag 弱化)+ subject truncate + 作者 + 相对时间
- 点行:右侧 320px 详情栏(border-l)——完整消息、短 hash(font-mono)、作者/邮箱、绝对时间、文件列表(每行文件名 + `+n` 绿 `−m` 红)。✕ 或再点同行关闭
- 全部用 shadcn 组件 + Tailwind 令牌,不新增样式体系

## 5. 降级与错误

各态独立,不拖垮整页:

| 情形 | 表现 |
|---|---|
| 没装 git | 安装引导文案 |
| 非 git 仓库 / 目录不存在 | "此目录不是 git 仓库"空态,不报错 |
| git 命令失败(损坏/权限) | 错误 detail + 重试钮 |
| 空仓库(0 commit) | "还没有 commit"空态 |
| 详情拉取失败 | 详情栏内错误 + 重试,不影响图 |

## 6. 测试与合规

- vitest(`tests/` 镜像结构):
  - log 解析:NUL 字段/记录分隔、多 parent、无 parent、refs 解码(HEAD ->、tag:、remote)
  - 泳道算法:线性链 / 单分叉 / 单合并 / 交叉合并 / 多根(orphan)/ 泳道回收复用
  - numstat 解析(含 binary 文件 `-` 行)
  - 错误分类(ENOENT=git-missing、not a git repository=no-repo、其余=git-error)
- UI 无组件级测试(同 ADR-0012 先例):逻辑全下沉纯函数层,视图以 dev 实跑核对清单验收
- 流程:开 Task issue;分支 `feat/git-graph` + PR;门禁 `npm test` 绿才收
