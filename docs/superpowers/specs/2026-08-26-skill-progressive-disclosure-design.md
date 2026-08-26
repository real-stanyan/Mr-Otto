# skill 渐进披露：索引常驻 + 模型自取正文

日期：2026-08-26
状态：已由 stanyan 会话内批准（四段设计逐段确认 + 四处拍板：取用同权并加停用、索引塞进工具 description、停用三个入口、正文走事件不走 tool_result）
Issue：#465

## 背景与约束

对照物是 obra/superpowers（本机装的是 `claude-plugins-official/superpowers@6.3.0`，14 个 skill）。它的 skill 机制与本仓的差别只有一处，但是根子上的：**模型自己能发现并取用 skill**——上下文里常驻的是 `name + description` 索引，正文按需取。本仓的 skill 只有用户打 `$` 一条路（`composerDirectives.ts`），模型不知道机器上装了什么。

现状盘点：

- **skill 库是现成的**：`src/main/skills.ts` 现扫磁盘（`~/.mr-otto/skills` + 导入自别家），解析 frontmatter 的 `name` / `description` / `argument-hint`，`SkillInfo` 里已经带 `content` 全文。索引要的两个字段一个不缺。
- **注入链路是现成的**：`skill_invoked` 事件（`src/session/events.ts:251`）存发送时刻全文快照，`deriveMessages` 投影成 user 消息（ADR-0007）；compact 清场后按台账重注入（ADR-0066）；派子 agent 时复制进子日志（ADR-0068）；参数进可选字段 `args`（ADR-0067）。
- **渐进披露机制也是现成的，只是给工具用的**：`src/tools/exposure.ts` 按单工具 8KB / 总量 64KB / 数量 12 三道闸把工具降级成 `hidden` / `deferred`；`src/tools/toolSearch.ts` 让模型搜到才可见，可见集是装配层建的共享 Set。skill 要的是同一个形状。
- **缺的只有一件**：模型侧的取用口。没有工具能列出/取用 skill。

约束：

- 硬规则「model-visible means logged」：模型读到的 skill 正文必须先落盘。索引不落事件——它与工具声明表同档（模型可见、由装配期推导、`toolSearch` 已立先例，见其文件头注释）。
- 硬规则「SessionEvent schema 变更必须向后兼容」：只加可选字段 + 加新事件类型，旧日志投影逐字节不变。
- ADR-0007 的边界「skill 不是插件系统」不能被磨损：skill 仍是纯提示词包，取用 = 把 markdown 塞进上下文，不引入可执行扩展面。
- **投影层只削 tool_result 的输出和工具调用参数，user 消息从不削**（见 `src/main/subagentPrompt.ts` 文件头）。这条直接决定正文该落在哪儿。

## 决策

### D1 一把 `skill` 工具，三个动作

`list(query?)` / `acquire(name, args?)` / `release(name)`。

工具的 `def.description` 动态拼已装 skill 的 `name — description` 清单，即索引本身。选它而不是单独一段常驻前置词：工具表本来就常驻、本来就不落事件、本来就受 `exposure.ts` 的单工具预算管着——零新注入面，也不用为「索引凭什么不落盘」另编一套解释。

`available: () => scanSkills(roots).length > 0`——没装 skill 就不出这把刀（同 `toolSearch` 的规矩：报一把只会返回空的工具是白让模型试）。

`requiresApproval: false`：读本机文件 + 塞上下文，无副作用。

### D2 正文走 `skill_invoked` 事件，tool_result 只回执

`acquire` 的 tool_result 只回一句「skill「x」已启用」，正文另落 `skill_invoked` 事件。

这是全篇最要紧的一条，理由是本仓的压缩规则本身：投影层削 tool_result、不削 user 消息。正文若留在 tool_result 里，长任务跑一阵就被削掉——**技能无声失效，正是 ADR-0066 刚修好的那个病从新口子跑回来**。

落成 `skill_invoked` 则三样东西免费继承，一行不改：compact 重注入（ADR-0066）、子 agent 继承（ADR-0068）、args 快照（ADR-0067）。

否掉的两条：正文直接进 tool_result（上述）；正文既进 tool_result 又落事件（同一份说明书在上下文里出现两次，token 白烧）。

### D3 取用 = 启用，与 `$` 手选同权；新增停用动作

模型 `acquire` 的 skill 进台账，语义与用户 `$` 启用的完全一致：永久生效、compact 后重注入、派子 agent 时继承。

同时补上 ADR-0066 结尾预留的口子：`release` 落新事件 `skill_released`，台账按它剔除。没有停用动作的话，模型误取一把大 skill 就永久占着上下文——而「省上下文」是这条要解决的目标之一。

**三个入口，一条来源规则**：模型可 `release`，用户可在 UI 上点掉，但**模型只能停自己 `acquire` 的**。模型 release 用户 `$` 启用的那把，工具返回错误（「skill「x」由用户启用，模型不能停用」）且不落事件。用户停用不校验来源——用户意图优先级高于模型判断。

### D4 台账从「只增」变「增删」：四处连锁点

`src/session/activeSkills.ts` 的文件头现在明写着「当前没有『停用』动作」，这条改动要顺着它的消费者点一遍：

1. **`activeSkills()` 自身**：顺扫遇 `skill_released` 执行 `out.delete(name)`。语义变为「启用过且未被停用 = 仍然生效」。`barren` 过滤照旧（空跑 turn 里的 release 同样不算数）。台账 value 加 `source`，供 D3 的来源校验用。
2. **`deriveMessages` 清场重注入**（`deriveMessages.ts:477`）：消费台账，自动跟上，不用改。
3. **`modelContextScan`**（`modelContextScan.ts:49`）：**必须改**。它从 checkpoint 之后单捞 `skill_invoked`；只捞 invoked 不捞 released，compact 之后停用记录就丢了，被停掉的 skill 会诈尸重注入。`ofType` 那行加上 `skill_released`。
4. **`microCompact` 规则⑥**（`microCompact.ts:182`）：现在保证 `skill_invoked` 永不进吸收区，`skill_released` 要进同一条豁免——吸收掉一条停用记录，效果是 skill 悄悄复活。

### D5 事件 schema：一个可选字段 + 一个新类型

- `SkillInvokedEvent` 加可选 `source?: "user" | "model"`，缺省 = user。旧日志没有此字段，投影逐字节不变（手法同 ADR-0067 给 `args` 加字段，测试钉住）。
- 新增 `SkillReleasedEvent { type: "skill_released"; name: string; }`。旧日志里不存在 = 无人被停用，重放不变。

### D6 索引超预算：按最近启用排序，截断要说出来

一条 `name — description` 约 100 字节，8KB 单工具预算够装七八十把。超了不静默截半句：按**最近启用时间**排序列前 N，尾注「另有 N 个未列出，用 `list(query)` 检索」。

`list` 的评分抄 `toolSearch.ts`：空格分词、名字与描述并集计分、上限 10 条。

### D7 安全边界：name 是查表键，不是路径

`acquire(name)` 收的是 skill 名。主进程现扫磁盘拿到 `SkillInfo.path` 再读，模型指定不了任意目录——与 `importExternalSkills` 按 name 走、不收路径是同一条收权理由。

### D8 与 `$` 共存，UI 分辨来源

`$` 路径一行不改（渲染层直接落事件，`source` 缺省 = user）。Timeline 现有的 skill 卡片按 `source` 加一句「模型启用」——不然用户看见上下文里多出一份说明书却不知道谁塞的。用户停用入口挂在这张卡片上。

### D9 子智能体：继承照旧，`skills: none` 连刀一起关

ADR-0068 的继承语义不变，模型自取的一并复制进子日志。子会话自己也拿得到 `skill` 工具（能取新的）；但 `skills: none` 的子 agent **既不继承也不出这把刀**——「不被行为 skill 污染」的本意里，自己去取也该关掉。

## 测试

纯函数为主，全部进 `tests/`（镜像 `src/` 结构）：

- `activeSkills`：release 剔除、后启用覆盖、来源记录、barren 防御
- **旧日志兼容钉子**：不带 `source` 的日志投影逐字节不变
- **回归钉子**：checkpoint 之后停用 → compact 重注入里没有它（D4 第 3 点的证明）
- `microCompact`：`skill_released` 不进吸收区（D4 第 4 点）
- 工具层：索引拼装、超预算截断与尾注、`list` 评分、`release` 来源校验（模型停用户的那把要报错且不落事件）
- e2e：`tests/e2e/fakeModel.ts` 驱一次 `acquire`，界面出现标着「模型启用」的 skill 卡片

## 不做（YAGNI）

- **不做自动注入**：模型必须显式调工具。没有相关度阈值悄悄塞说明书这回事——那等于用户不知情地被改了行为。
- **不做 `references/` 附属文件按需读**：superpowers 的 skill 目录里还有引用文件和 prompt 模板，`scanSkills` 今天只读 `SKILL.md`。那是独立的一条改动，不塞进这条。
- **不做用户白名单**（哪些 skill 允许模型自取）：先全量，有人抱怨再加。
- **不改 `$` 语法**，不动 skill 正文在投影层的压缩豁免。

## 落地物

项目 ADR 一篇（编号合并前 re-fetch 认领 `max + 1`，撞号按 AGENTS.md 留「原为」行）+ 一个 Task issue + 一条分支 PR。
