# 0046 — 子 agent 是一次独立会话，task 工具走注入接缝

日期：2026-08-21　状态：已采纳

## 背景

用户要求：碰到大任务时，主 agent 把它拆成小任务分发给 subagent 去做；用户能在设置页
配置自己的 subagent。

这件事同时压在三条硬规则上：

1. **append-only 事件日志是唯一事实来源；model-visible means logged。** 子 agent
   自己也在跟模型对话——那些上下文必须落盘，否则日志推不出"子 agent 看过什么"。
2. **工具实现只依赖 `ExecutionWorld`，禁止直接 import fs / child_process。**
   而"派活"这个动作要造一个新 agent，`createAgent` 住在 `src/main/`。工具不能碰它。
3. **SessionEvent schema 变更必须向后兼容。** 旧日志必须永远可重放。

另有一条 MVP 边界要照顾：AGENTS.md 写着"明确不做：多 agent 编排"。

## 决定

### 1. 子 agent = 一次完整的 `createAgent()` 装配，跑在自己的会话分区里

每次派活开一个新 sessionId，子 agent 的 `assistant_message` / `tool_result` /
`approval_decision` 全落它自己那份日志。父日志只落两条事实：派活
（`subagent_spawned`）和收到汇报（`tool_result`）。

复用整个 `createAgent` 而不是裸拼一个 `LoopEngine`：审批门、输出直播、中断信号、
模型路由（lane / 网关幂等键）、崩溃修复、resume、回放——这些全是免费的。子 agent
和主 agent 的差别只有四样（**指令**、工具子集、模型、审批模式），而那四样正好就是
设置页配的东西。

**"指令"不是 system 消息**：`subagent_briefed` 被 `deriveMessages` 投影成子会话的
第一条 **user** 消息（手法与 `skill_invoked` 一模一样），不是 system。原因是中途插
system 消息各家方言兼容性参差。子会话的 system 消息还是主会话那一份（workspace
围栏等会话事实），指令叠在它之上。写清楚这一点，免得下一个读到这里的人去代码里
找一个并不存在的"子 agent 专用 system prompt"。

**子会话的 world 是父的 world 实例，不新造。** 同一道 workspace 围栏；v2 换
SandboxWorld 时子 agent 天然在同一个容器里（方向同 ADR-0031：终端必须开在 agent
自己的 world 里，不能在 index.ts 另起一个 LocalWorld）。

### 2. `task` 工具通过注入的 `SubagentRunner` 接口派活

```ts
export interface SubagentRunner {
  run(opts: { agent: string; task: string; parentToolCallId: string; signal?: AbortSignal }):
    Promise<{ report: string; childSessionId: string }>;
}
export function createTaskTool(runner: SubagentRunner, list: () => SubagentDef[]): Tool;
```

形状与 `createAskUserTool(questioner)` / `createWebSearchTool(keyGetter)` 一模一样。
`runner` 在 `index.ts`（组装根）接线，内部调 `createAgent`。硬规则 2 原样成立。

`Tool.def` 由静态字段改为 getter——可用 subagent 清单要进工具描述（模型靠
`description` 挑人），而清单每次现扫磁盘（同 `scanSkills` 的不缓存规则）。
TypeScript 里 `{ get def() {...} }` 满足 `def: ToolDefinition`，**`Tool` 接口一个字
不改**，engine 每轮 `tools.map(t => t.def)` 天然现算，设置页加人当场生效。

### 3. 三处 schema 改动，全部向后兼容

- 新事件 `subagent_spawned`（落父侧）：`toolCallId` / `childSessionId` / `agent` / `task`。
  必须落盘的理由：`tool_result.output` 只有汇报正文，推不出 `childSessionId`，而
  "时间线上这张卡点进去是哪个子会话"是 UI 投影——投影必须可从日志推导。
- `SessionCreatedEvent` 加可选 `spawnedBy?: { sessionId; toolCallId; agent }`，与已有
  `forkedFrom` 并列。缺席 = 主会话，旧日志照常重放。会话列表靠它把子会话滤出侧栏。
- 新事件 `subagent_briefed`（落子侧，紧跟 `session_created`）：`agent` /
  `instructions`（派活时刻全文快照）/ `tools`（这次实际给了哪几把）/ `model`。

### 4. 审批卡冒泡到父会话

子 agent 里的危险工具照旧过审批门，但卡按 `AgentPush` 现有接线会挂到**子**
sessionId——而用户正看着父会话，会看不见卡、子 agent 干等，死锁。

runner 给子 agent 传一个包装过的 `AgentPush`：`approvalRequest` / `askUserRequest`
把 sessionId 换成父的，卡上标明来自哪个 subagent。审批是"问人"，人就在父会话界面上。
engine 和工具全程无感。

`assistantDelta` / `toolOutput` 不冒泡——那是子会话的直播，照旧挂子会话；父时间线
上那张卡自己订阅子会话的直播显示进度。

### 5. 子 agent 不能再派子 agent

`task` 永不进 subagent 的工具白名单，代码里硬挡。一层派活是工具调用，递归派活
就是编排——MVP 边界"明确不做多 agent 编排"由此原样成立。

**两个把守点，不是一个。** 会话有"创建"和"重建"两条路，两条都得挡：

- 创建：`subagentRunner.ts` 建子 agent 时不传 `subagentRunner`，task 工具压根不被造出来。
- 重建：`resumeChild.ts` 的 `createChildAgent` —— 它的参数表里**没有** `subagentRunner`
  这一项，所以"重建出来的子 agent 没有 task"是类型层面的事实，不靠纪律。

补这一条是因为它真的漏过：`resumeSession` 起初只认得主会话，把子会话按全权 agent
重建（带 bash / write_file / task）。而 resume 恰恰是查看子会话的唯一途径——时间线
那张卡和"回到父会话"都走它。根因是同一份装配代码在 `index.ts` 里抄了两份、drift 了；
修法是合并成 `createSessionAgent` 一处，"是不是子会话"只判断一次。

### 6. subagent 定义 = markdown 文件 + frontmatter

`~/.otter/agents/<名字>.md`（原生，优先）、`~/.claude/agents/`（兼容，用户已有的
Claude Code subagent 零迁移可用）。同名先到先得。规则与 skill 库（ADR-0007）一字
不差，理由也一样：定义是用户随时增删的外部文件，文件即事实来源。

认不出的工具名（Claude Code 写的是 `Read`/`Grep`，otter 是 `read_file`/`bash`）
静默丢弃 + 设置页标注，而不是让整个 subagent 报废。落进 `subagent_briefed.tools`
的是**实际给出去的那几把**——快照记事实，不记用户的意图。

### 7. 删除父会话级联删掉它的子会话

`EventStore.purge` 连带抹除 seq-0 的 `spawnedBy.sessionId` 指向被删会话的那些子会话，
并把真正抹掉的 id 列表返回给组装根（终端 / 浏览器 / agent 注册表按同一份名单注销）。
不递归——决定 5 保证了子 agent 不会有子 agent，一层到底。

理由有两条，各自都够：子会话不进侧栏、不进 ⌘K，只能从父时间线那张卡点进去，父日志
一没它就是够不着也删不掉的孤儿，而 `billedUsage` 还在替它算钱 —— 这与 ADR-0002 的
"整会话物理抹除，不可逆"直接冲突；而且子会话的日志里存着同一个 workspace 的文件内容
和 bash 输出，用户删掉一段对话时理所当然认为这些也跟着没了。

## 备选与否决

- **子 agent 事件写进父日志同一分区（带 `parentToolCallId` 字段）**：一条日志自包含，
  好听。但所有现存投影（`deriveMessages` / `deriveTodos` / `deriveSections` /
  `deriveUsage` / `barrenTurns`）都得补一道过滤，漏一处就把子 agent 的上下文灌进
  主模型。改动面大且失败模式安静。
- **子 agent 只落最终汇报，中间不落事件**：最轻，但子 agent 的模型看过的东西日志推
  不出来——直接违反"model-visible means logged"。要选它得先走 L1 改硬规则。
- **复用父 engine，只换 system prompt 和工具表**（"换个人格再跑一圈"）：最省，但
  日志分区就没了，与决定 1 冲突。
- **子 agent 裸拼一个 `LoopEngine`，不走 `createAgent`**：省一半装配，但审批门、
  直播、模型路由、崩溃修复得重接一遍，子会话还不能 resume / 回放。省下的比赔进去的少。
- **`subagent_briefed` 复用 `skill_invoked`**（`name: "agent:searcher"`）：零新事件
  类型，`deriveMessages` 一字不改。但工具白名单落不了盘——模型看到的工具声明来自
  用户随时可改的磁盘文件，重放时还原不出当时子 agent 到底有几把刀。否决理由同
  ADR-0007 拒绝"只存路径 + hash"：文件会被改会被删，hash 只能证明变了，救不回原文。
- **subagent 定义存 `userData/agents.json`**（像 permissions.json）：设置页 CRUD 写起来
  最直。但格式封闭，不能手写、不能分享、不能进 git。
- **同一批 `task` 调用并行跑**：快很多，但并发审批卡、并发输出直播、中断传播都得
  重新想一遍。第一版串行，engine 的 for 循环一字不动。

## 代价（接受）

- **子会话没有自己的停止键。** 失控兜底只有两层：父 turn 的停止键往下传（signal 穿
  `ToolRunContext.signal` 进 task 工具，runner 调子 `engine.abortTurn()`），以及工具
  白名单（不给 bash 的搜索员炸不了）。没做预算 / 轮数上限——需要时再加，届时它是
  subagent 定义里的又一个 frontmatter 字段。
- **串行派活慢。** 模型一次发 3 个 `task` 调用会排队跑完。事件 schema 没有为并行
  预留字段——将来改并行时，`subagent_spawned` 已经带 `toolCallId`，多个同时在跑
  是天然可表达的，日志格式不用改。
- **instructions 全文在每次派活的子会话日志里各存一份**，数据库随使用变肥。同
  ADR-0007 接受过的同一笔账。
- **会话列表要区分主 / 子。** 子会话不进侧栏（靠 `spawnedBy` 滤），只能从父时间线
  上那张卡进去。代价是子会话在全局搜索里怎么出现需要单独想。
- **子 agent 一建好就进组装根的 agent 注册表，且不再退出。** 必须进（否则
  `resumeSession` 会在同一个还活着的 sessionId 上再建一个 agent，第二个的崩溃修复
  给在飞的工具调用补一条假 `tool_result`，同一个 `toolCallId` 两条结果 = 这个子会话
  永久 400）；不退出是权衡后的选择——跑完就注销的话，用户此刻正看着的那个子会话会
  突然变成"会话不存在"，发不出消息。代价是注册表随一次运行里的派活次数增长，
  重启清零。删父会话时按 purge 返回的名单一并注销。
- **每会话成本口径不含它派出去的子会话。** `deriveUsage` 是按分区求和的，子会话的
  token 落在子分区里，所以"这个会话花了多少"系统性偏低——一个派了三个 subagent 的
  会话，屏幕上那个数只算它自己那几轮。时间线卡片上的"N 步 · Xk tokens"只补上了
  单次派活这一格，补不齐总账。全库口径（设置页那张"哪家烧了多少"）不受影响：
  `billedUsage` 扫的是整库，子会话的行本来就在里面。
- **`~/.claude/agents/` 扫来的定义只读**——不去改用户 Claude Code 的配置。要改先
  "复制到 ~/.otter/agents"。
