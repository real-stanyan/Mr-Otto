# ADR-0090: 对照 Claude Code 的四笔借鉴——检查点回退 / 用户钩子 / 前台自动转后台 / 派活上限

原为 ADR-0089，因与「已归档会话是侧栏的独立视图」撞号，按 ADR-0074 改号。

日期：2026-08-25
状态：已接受
关联：issue #395；调研对象 anthropics/claude-code（CHANGELOG + hooks/checkpoints 文档 + plugins 目录）；ADR-0084（fork）、ADR-0086/0088（前两批 harness 加固的同款批量形态）、issue #350（钩子基础设施）、issue #389（后台回注）

## 背景

调研 Claude Code 公开仓（CLI 本体不开源，可借鉴的是 CHANGELOG 里的功能设计史与扩展机制形态），对照本仓现状筛出四个真空档。筛选原则：已有等价物的不重做（显式 run_in_background、execpolicy 前缀规则、workspaceTrust、压缩、记忆都已覆盖）；与既有 ADR 立场冲突的不引入（plugin marketplace 撞 ADR-0007，记忆注入式索引撞 ADR-0065——那是深思过的反向选择，不摇摆）。

## 决定 1：工作区检查点 = 影子 git + 「回到这一步」（fork + restore 成对）

事件日志能重放对话，磁盘改动却不可逆；fork（ADR-0084）只分叉引用，UI 二期一直欠着入口。补上文件侧：

- **能力挂在 seam 上**：`ExecutionWorld.checkpoint?: {save, restore}`——工具层永不消费（它不是工具，模型看不见）；消费者是装配根（每个用户 turn 前自动 save）和回退 UI。v1 影子 git，v2 SandboxWorld 可换 docker commit，接口不动。
- **影子 git**：`--git-dir` 住 `~/.mr-otto/checkpoints/<workspace-hash>`，`--work-tree` 指回工作区。工作区自己的 .git 天然不被跟踪（git 不收名叫 .git 的目录）——restore 永不碰用户的分支/暂存区；.gitignore 照常生效（忽略区不进快照也不被还原）；每个 commit 挂 `refs/checkpoints/<id>` 保可达（reset 甩出 HEAD 链的"未来"点仍能回去）。
- **回退顺序即安全**：先 fork（零拷贝，失败时磁盘零改动）再 `reset --hard`。fork 锚点 = 检查点前最近的 `turn_ended`（ADR-0084 的边界语义免费复用）；检查点落在第一个 turn 之前时退化为「回到对话开始」（同工作区全新会话）。
- **事件**：`checkpoint_created{checkpointId}` / `workspace_restored{checkpointId, fromSessionId}`，都 ignorable（模型不消费，旧版本跳过照常重放）。日志只存 id，快照本体在库外——重放依赖快照库（附件库同款取舍，ADR-0009）。

## 决定 2：用户钩子 = hooks.json 翻译成 engine ToolHook

钩子基础设施（#350 的 Pre/PostToolUse + `tool_hook` 落盘）一直只留着口。用户侧接法：

- **配置**：`userData/hooks.json`，execPolicyStore 同款纪律——加载期校验、坏文件整份拒载（fail-safe 空钩子）、每次工具调用现读（热更新；engine 的 `hooks` 参数为此加宽成可给 getter）。
- **协议**：stdin 收 JSON 上下文（phase/tool/args/workspace，post 加 status/output）；stdout 回 JSON 裁决（pre 认 block/reviseArgs，post 认 reject/feedback）；exit 2 = 快捷否决（CC 同款，stderr 作理由）；其余失败（非零 exit / 非 JSON 输出 / 超时 / 执行异常）一律**弃权**——钩子是观察/干预者，fail-open；安全边界仍是守卫（fail-closed）和审批门（middleware.ts 的既有立场，不因用户钩子而变）。
- **执行环境**：专用 LocalWorld（cwd = 工作区、凭据环境变量已剥、10s 超时对齐 HOOK_TIMEOUT_MS），不借 agent 的 world——那个被 engine 按调用包了直播层，钩子输出会被误标成命令输出。`ExecOptions` 为此加 `stdin`（写完即关；JSON 不过 shell 转义）。
- **只挂主会话**：子会话没人盯着，用户钩子的干预面不该静默扩大（ADR-0047 收权同款）。

## 决定 3：前台命令超 30s 自动转后台（不杀不重跑）

#389 已有显式 `run_in_background`，但预判失误的长命令仍被 30s SIGTERM 一刀杀，重跑 = 副作用重放。CC 的 auto-background 对照：

- 回注已接线（armed）的装配里，前台 exec 以 `ExecOptions.timeoutMs`（新字段，实现可忽略）显式放宽到后台档（30 分钟），工具层等 30s，没等到就把**还在跑的同一个 in-flight** 登记成后台任务，完成走既有回注链路（新 turn 注回，不 mid-splice）。
- 未 armed 的装配（subagent）维持 30s 硬杀——没人注回的结果不该活过 turn。
- **取舍**：迁移进程仍绑 turn 中断信号（withAbortSignal 焊死的）——立场：停止键停的是"这个 turn 发起的一切"，显式 run_in_background 才是用户经模型明确要求的不绑信号例外。直播碎片继续流向原工具卡（对账诚实，略显冗余）。

## 决定 4：派活总量硬上限（SUBAGENT_SESSION_CAP = 100）

递归已由构造挡死（子 agent 没有 task 工具），但"每 turn 派一个"的失控循环没有闸。长 turn 软告警（LONG_TURN_ROUNDS）喊的是模型步数；每次派活烧的是一整个子会话，量级不同，值得一道自己的**硬**闸（这与"无步数上限是 DSH 式决定"不冲突：那条护的是单 turn 内的模型循环，兜底是人在屏幕前的停止键；派活失控烧钱快一个量级，等人回来再停代价不对称）。计数从父日志 `subagent_spawned` 推导（投影硬规则：不另立计数器），fork 链上祖先派的也算；闸在建子会话之前，抛错给模型让它收手。

## 明确不抄（同批裁定，防后人重提）

- **Plugin marketplace / 插件系统**：ADR-0007 已裁定 skill = 纯提示词注入；hooks.json 是配置不是插件。
- **记忆注入式索引**（MEMORY.md 每会话加载）：ADR-0065 已裁定跨会话回忆靠搜索不靠注入。
- **Headless / CI 模式**：GUI 产品定位不符。

## 权衡与已知边界

- 检查点每 turn 一次 `add -A + commit`：暖库毫秒级；首次在大工作区可能秒级——失败/超时只警告不挡 turn。嵌套 git 仓记成 gitlink（restore 还原不了内容），CC 影子仓同款边界。
- 同工作区多会话共用一个影子库：并发 save 撞 index.lock 时后到者失败（吞成警告，下个 turn 再存）——检查点是便利品，不是一致性承诺。
- 用户钩子给了用户一把能拦/改模型工具调用的刀：本机配置文件与 execPolicy 同信任级（能改 hooks.json 的人本来就能改一切）。

推翻前提：若 v2 SandboxWorld 落地时 docker commit 的快照粒度（整容器）与文件级 restore 语义合不拢，checkpoint 接口要重谈；若用户钩子出现真实的"需要对子会话生效"场景，「只挂主会话」要重开 issue。
