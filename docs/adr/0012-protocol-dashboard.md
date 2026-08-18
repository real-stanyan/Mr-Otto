# ADR-0012: Protocol 只读仪表盘——gearbox 协议可视化进 Otto

日期:2026-08-18
状态:已接受

## 背景

把 gearbox 协议功能融入 Mr Otto,让使用者脱离 gearbox 工具链也能获得协议价值
(换班记忆/决策记录/任务追踪)。完整讨论见 spec:
docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md。

## 决策

1. **协议产物不建 Otto 私有储存**:ADR 读仓库 markdown(docs/adr + docs/gearbox-adr),
   任务/交接直接读 GitHub issues——Otto 是协议的 GUI 客户端,不是协议的替代储存。
   保住 gearbox 的灵魂:repo 是唯一共享记忆,Claude Code 等其他 agent 共享同一条 issue 流。
2. **issues 走 gh CLI**(execFile 子进程,复用用户已有认证,私有仓库可用),
   不引 octokit/token 管理——少背一棵依赖树 + 不碰凭证存储。
3. **第一刀严格只读**:零写文件、零 GitHub 写请求。第二刀(收班自动化:从事件日志
   生成 handoff 草稿)另立 spec。
4. **「harness 完工前无新 UI 面」约束豁免**:只读面板不触 harness 核心,
   且 Otter 仓库自身即 gearbox 仓库——完工即自用,狗粮闭环。豁免仅此一项,约束仍在。

## 后果

- 主进程新增 protocolService(fs + gh 子进程;app 功能不经 ExecutionWorld,同 SQLite 先例)
- ShellBridge 扩四个只读方法;错误结构化回流(不 throw),面板独立降级
- 依赖 gh CLI 存在与登录;纯离线只有 ADR 面板可用——接受,降级路径已铺
- handoff 五段式解析是启发式(①—⑤ 齐全按序),解析不出回退原文——宁可不解析,不猜
