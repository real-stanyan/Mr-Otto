# 0110 — skill 渐进披露：模型自己发现并取用 skill 正文

日期：2026-08-26　状态：已采纳（issue #465）

> 编号说明：本分支开工时被指定用 0112（当时 re-fetch 到的 origin/main 最大号是
> 0111）。写完这篇之后再跑一次门禁前的 re-fetch，发现 origin/main 期间又合了
> `docs(adr): 0106/0107/0108/0109 撞号，按 ADR-0074 顺延到 0112–0115`——
> 0112–0115 现在被手机端四篇 ADR 占着，且本分支自己的 `docs/adr/` 只到 0109
> （110/111 是别的并行 lane 加的，还没并进这条分支）。继续用 0112 会立刻撞上
> `tests/docs/adrNumbers.test.ts` 的跳号检查（本分支内 110/111 缺号）和唯一性
> 检查（合并后撞上手机端那篇）两条断言，两条都会红。按 ADR-0074「编号在合并时
> claim，合并前 re-fetch，撞了就改成当时最大号 +1」的字面规矩，先改成本分支
> 当下语境里的正确下一个号 0110；本分支真正合并进 main 前还需要再 re-fetch
> 一次、按那时的 origin/main 最大号重新认领——这一步留给合并那一刻的 agent，
> 不在本次任务范围内提前做（提前做也会被后续继续推进的 main 再次撞号）。

## 背景

对照物是 obra/superpowers。它与本仓 skill 机制的差别只有一处，但是根子上的：
**模型自己能发现并取用 skill**——上下文里常驻的是 `name + description` 索引，
正文按需取。本仓此前的 skill 只有用户打 `$` 一条路（`composerDirectives.ts`），
模型不知道机器上装了什么。

现成的部件都在：`src/main/skills.ts` 现扫磁盘拿到 `SkillInfo`（含全文）；
`skill_invoked` 事件 + `deriveMessages` 投影（ADR-0007）；compact 清场后按台账
重注入（ADR-0066）；参数进可选字段 `args`（ADR-0067）；派子 agent 时复制进子
日志（ADR-0068）；`exposure.ts` / `toolSearch.ts` 已经是给工具用的渐进披露
机制，形状与 skill 要的一样。缺的只有一件：模型侧的取用口。

约束不变：硬规则「model-visible means logged」——模型读到的正文必须先落盘；
硬规则「SessionEvent schema 变更必须向后兼容」——只加可选字段 + 新事件类型；
ADR-0007 的边界「skill 不是插件系统」不能被磨损；以及 `subagentPrompt.ts:15`
写明的那条压缩规则——**投影层只削 tool_result 的输出和工具调用参数，user 消息
从来不削**。这最后一条直接决定了 D2 该怎么选。

设计全文见 `docs/superpowers/specs/2026-08-26-skill-progressive-disclosure-design.md`
（D1–D9，本 ADR 只收录其中影响最深的四条决定；其余归 issue #465 下各任务的
commit）。

## 决定

### 一、索引拼进工具 `description`，不另立一段常驻前置词

`skill` 工具（`list` / `acquire` / `release` 三个动作）的 `def.description`
动态拼已装 skill 的 `name — description` 清单，索引本身就是它。工具表本来就
常驻、本来就不落事件、本来就受 `exposure.ts` 的单工具预算管着——挂在这里是
零新注入面；不用为「索引凭什么不落盘」另编一套解释，`toolSearch.ts` 已经是
先例。`available()` 判定没装 skill 就不出这把刀，同 `toolSearch` 的规矩：
报一把只会返回空的工具是白让模型试。

### 二、正文走 `skill_invoked` 事件，`tool_result` 只回一句回执

`acquire` 的 `tool_result` 只说「skill「x」已启用」，正文另落 `skill_invoked`
事件（`source: "model"`）、由 `deriveMessages` 投影成 user 消息。

这是全篇最要紧的一条，理由就是背景里那条压缩规则本身：**投影层只削
`tool_result` 的输出、不削 user 消息**。正文若留在 `tool_result` 里，长任务
跑一阵就会被削掉——技能无声失效，而这正是 ADR-0066 刚修好的那个病
（compact 清场吞掉 skill 指令）从 `acquire` 这个新口子里原样跑回来。落成
`skill_invoked` 之后，compact 重注入（ADR-0066）、子 agent 继承（ADR-0068）、
`args` 快照（ADR-0067）三样东西一行代码不改、全部免费继承。

事件位置就是「此刻」：模型调用发生在 `tool_call` 与 `tool_result` 之间，
`deriveMessages` 既有的插话延后队列把它排到 tool 消息之后，不用另开一条
排序规则。

### 三、取用与 `$` 手选同权；新增停用动作

模型 `acquire` 的 skill 进台账，语义与用户 `$` 启用的完全一致：永久生效、
compact 后重注入、派子 agent 时继承——不给模型开小灶，也不因为「是模型点的」
就打个折扣。

同时补上 ADR-0066 结尾预留的口子：`release` 落新事件 `skill_released`，台账
按它剔除。三个入口、一条来源规则——模型可 `release`，用户可在 Timeline 卡片
上点掉，但**模型只能停自己 `acquire` 的**：`activeSkills().get(name).source`
不是 `"model"` 就报错且不落事件；用户停用不校验来源，用户意图优先于模型
判断。没有停用动作的话，模型误取一把大 skill 会永久占着上下文，而「省
上下文」正是渐进披露要解决的问题之一。

### 四、台账从「只增」变「增删」，两处 compact 连锁点必须跟上

`activeSkills()` 顺扫遇 `skill_released` 就 `delete`，语义变成「启用过且
未被停用 = 仍然生效」。这条改动牵连两处既有的 compact 逻辑，两处都不是
自动跟上，必须显式改：

1. **`modelContextScan`**：原来只从 checkpoint 之后单捞 `skill_invoked`
   （`ofType` 白名单）。只捞 invoked 不捞 released，compact 之后**停用记录
   会丢**——被模型停掉的 skill 在下一次压缩后诈尸重注入。`ofType` 的类型
   白名单里补上 `skill_released`。
2. **`microCompact` 规则⑥**：原来保证 `skill_invoked` 永不进吸收区。
   `skill_released` 要进同一条豁免——微压缩把一条停用记录吸收掉的效果，
   是那把 skill 悄悄复活（吸收区里的内容不进模型看到的上下文，等于这条
   `delete` 从没发生过）。

两处都是「新增一种事件类型，旧逻辑对它视而不见」的经典漏网写法——类型
系统不会替你提醒「这里也该加一种」，只能靠读一遍消费者列表逐个点名。

## 备选与否决

- **正文既进 `tool_result` 又落 `skill_invoked` 事件**：同一份说明书在上下文
  里出现两次，token 白烧；单独把正文放进 `tool_result`（不落事件）更是直接
  违反「model-visible means logged」，而且立刻撞上决定二说的那条压缩规则——
  被削是必然，不是概率问题。两种都否掉，只保留「事件是唯一事实来源，
  `tool_result` 只回执」这一种。
- **每把已装 skill 现扫时各生成一把 deferred 工具**（例如 `skill_apple_design`
  这种一 skill 一工具）：形状上更像「注册了一批可发现的能力」，磨损了
  ADR-0007 划的「skill 不是插件系统」的边界——`skill` 工具本身是一把纯提示词
  搬运工具，没有可执行扩展面；一 skill 一工具则让工具表的形状随用户装了
  多少个 skill 膨胀，且工具数量、`toolSearch` 检索面都跟着水涨船高，
  与「不做插件系统」的边界越贴越近。否掉，维持「一把工具、三个动作、
  索引拼在 description 里」的形状。
- **一次性取用，不进台账**（读一次正文塞进这一轮上下文，不落 `skill_invoked`、
  不参与 compact 重注入）：省了台账维护，但正是 ADR-0066 当时要修的那个
  病——「用户没说停，技能却在 compact 后无声失效」——原样从新口子里跑回来，
  只是触发条件从「用户 `$` 启用后无声消失」换成了「模型 `acquire` 后无声
  消失」，病灶没变。否掉，`acquire` 的 skill 必须进台账、必须扛得住 compact。

## 代价（接受，或明确记在这里等下一次有人踩到）

- **`src/main/resumeChild.ts` 没接 `skills`**：这是恢复子会话的重建口，
  `createChildAgent` 传给 `createAgent` 的参数表里没有 `skills` 这一项——
  恢复出来的子会话拿不到 `skill` 工具，与活着那一侧（`subagentRunner.ts`
  复用父 world、正常挂上 `skill` 工具）不对称。该文件对「恢复侧少若干
  能力」已有成文先例（文件头刻意写明不传 `history`、不传 `subagentRunner`），
  这次的 `skills` 缺席是同一类取舍的延续，不是遗漏——只是这次没有专门写
  注释说明，留在这里记一笔：如果日后有人抱怨「resume 回来的子会话怎么用不了
  skill 工具了」，答案在这条 ADR，不用重新排查一遍。
- **`agent.ts` 里 `activeSkills` 闭包每次 acquire/release 都全量扫描**：
  接线在 `createSkillTool` 的 `activeSkills` 闭包里是
  `store.load(sessionId)` 读整份日志 + `barrenEventIndexes(log)` 对整份日志
  再扫一遍，然后才喂给 `activeSkills()` 做线性台账重算。`EventStore` 已经有
  `ofType(sessionId, type, { beforeSeq? })` 这个按类型的稀疏索引（见
  `src/session/store.ts:411`），理论上可以只捞 `skill_invoked` /
  `skill_released` 两类事件、不用搬整份日志。这一次没有借道 `ofType`：
  `barrenEventIndexes` 判定「是不是空跑 turn」时依赖的是事件在整份日志里
  的下标，`ofType` 拿到的事件序列丢失了这份原始下标，要用就得让 `ofType`
  或调用方多带一份下标映射，属于另一层改动。长会话上 `store.load` 全量
  搬运是一笔看得见的开销（每次 `acquire`/`release` 一次，不是每轮一次，
  代价随会话长度线性增长但触发频率低），值得在下一次碰这段代码时顺手改，
  这里先记账，不在本次范围内动。
