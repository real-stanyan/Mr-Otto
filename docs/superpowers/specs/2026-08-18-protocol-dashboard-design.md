# Protocol 只读仪表盘（gearbox 协议可视化）设计

日期:2026-08-18
状态:已批准(维护者会话确认)
背景:把 gearbox 协议功能融入 Mr Otto,让使用者脱离 gearbox 工具链也能获得协议价值。本任务是第一刀:只读可视化。

## 目标

1. Otto 内新增「Protocol」视图:可视化目标仓库的 ADR、GitHub issues、handoff 交接记录
2. 载体决策(维护者已定):ADR 走仓库 markdown 文件;任务/交接直接走 GitHub issues——Otto 做协议的 GUI 客户端,与 Claude Code 等 agent 共享同一条 issue 流,兼容性最大
3. 严格只读:本刀不写任何文件、不发任何 GitHub 请求以外的副作用

## 非目标

- 不做写操作(开 issue、关 issue、发 handoff 评论)——那是第二刀「收班自动化」,另立 spec
- 不做开班/收班生命周期管理(= 编排,明确 v2+)
- 不做本地文件任务载体(维护者选了 GitHub issues 路线)
- 不做缓存/落库:打开拉取 + 手动刷新,不进 SQLite 事件日志(非会话事实)

## 决策记录(需落 ADR)

本设计伴随项目 ADR-0012(protocol-dashboard),记录四个决策:

1. 协议产物存仓库(ADR 文件)+ GitHub issues,不建 Otto 私有储存——保住「repo 是唯一共享记忆」
2. issues 通过 `gh` CLI 读取(复用用户已有认证,私有仓库可用),不引 octokit/token 管理
3. 第一刀只读
4. 「harness 完工前无新 UI 面」约束豁免记录:只读面板不触 harness 核心,且 Otto 仓库自身即 gearbox 仓库,完工即自用(狗粮闭环)

## 1. 形态与入口

- 新增「Protocol」视图,与会话视图平级;sidebar 底部入口切换(现有 shadcn Sidebar 内加一项)
- 视图内三块内容:
  - **ADR 面板**:扫 `docs/adr/` 与 `docs/gearbox-adr/` 下 `NNNN-slug.md`,列表(编号 + 标题)+ 点开渲染 markdown
  - **Issues 面板**:open/closed 两组列表;按三角色染色标签——Task / Memory(handoff)/ Protocol gap;角色靠标题关键词启发式判定("handoff"/"交接" = Memory,"Protocol gap" = gap,其余 = Task),猜不中归 Task
  - **Handoff 视图**:点开 issue 看详情(正文 + 评论);评论中识别五段式(①-⑤ 标记,齐全且按序),解析成结构化卡片(五段各一节);解析失败整条回退原文渲染
- 目标仓库:默认当前会话工作目录;可手选文件夹(系统目录对话框),选择持久化(localStorage,UI 偏好非会话事实)

## 2. 数据管道

- 硬规矩不破:渲染进程只经 `ShellBridge`。接口扩四个方法:
  - `protocol.listAdrs(repoDir)` → `{ source: 'adr' | 'gearbox-adr', id, title, path }[]`
  - `protocol.readAdr(repoDir, path)` → `{ markdown }`(路径必须落在两个 ADR 目录内,主进程校验,防任意读)
  - `protocol.listIssues(repoDir)` → `{ number, title, state, role, updatedAt }[]`
  - `protocol.getIssue(repoDir, number)` → `{ number, title, state, body, comments: { author, createdAt, body }[] }`
- 主进程新建 `ProtocolService`:
  - ADR:fs 扫描 + 读文件。这是 app 功能不是 agent 工具,主进程直用 fs 合规(同 SQLite 日志先例),不经 ExecutionWorld
  - issues:子进程调 `gh issue list --json` / `gh issue view N --json --comments`,cwd = 目标仓库(gh 自动识别 remote)
- markdown 渲染:渲染进程引 react-markdown(或同类轻量库),ADR 与 issue 正文/评论共用
- 五段式解析器、角色判定器 = 纯函数,放 `src/shared/`(或 main 侧纯模块),便于测试

## 3. 降级与错误

各面板独立降级,任何一块坏不拖垮整页:

| 情形 | 表现 |
|---|---|
| 目录无 `docs/adr/` 且无 `docs/gearbox-adr/` | ADR 面板空态提示;issues 照常 |
| 非 git 仓库 / 无 GitHub remote | issues 面板提示"此目录未连 GitHub";ADR 照常 |
| gh 未安装 / 未登录 | issues 面板显示安装与 `gh auth login` 指引;ADR 照常 |
| 断网 / gh 超时 | issues 面板错误态 + 重试钮;ADR 照常 |

## 4. 测试与合规

- vitest(`tests/` 镜像结构):
  - ADR 扫描/文件名解析(编号、slug、双目录合并排序)
  - 五段式解析器(标准五段、缺段、乱序、非 handoff 评论回退)
  - 角色判定启发式
  - gh JSON 映射(mock 子进程输出,含错误分支:非零退出、非法 JSON)
  - 路径校验(readAdr 越界拒绝)
- UI 无组件级测试(仓库无 jsdom/testing-library,为一个 smoke 背两棵依赖不值——YAGNI):
  逻辑全下沉纯函数层已测,视图以 dev 实跑核对清单验收(见 plan Task 5)
- UI 全部用现有 shadcn 组件 + Tailwind 令牌,不新增自制样式体系
- 流程:开 Task issue 承载本活;分支 + PR;门禁 `npm test` 绿才收
