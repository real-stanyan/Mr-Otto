# Subagent：大任务拆解与分发

日期：2026-08-21　　架构决定见 `docs/adr/0047-子agent是一次独立会话.md`

## 目标

主 agent 碰到大任务时，自主把它拆成小任务、派给合适的 subagent 去做，收回汇报后
继续。用户在设置页里定义自己的 subagent（名字、描述、指令、能用哪些工具、用哪个
模型、危险操作怎么处理）。

## 不做（本版边界）

- 并行派活。同一批 `task` 调用串行跑，`LoopEngine` 的 for 循环一字不动。
- 子 agent 再派子 agent。`task` 永不进 subagent 的工具白名单，代码里挡死。
- 预算 / 轮数上限。失控兜底只有父 turn 的停止键 + 工具白名单。
- 子会话进侧栏列表 / 全局搜索。只能从父时间线上那张卡进去。
- 改用户 `~/.claude/agents/` 里的文件。那批只读。

---

## 一、subagent 定义

### 文件格式

`~/.otter/agents/<名字>.md`：

```markdown
---
name: searcher
description: 只读搜索员 —— 翻代码找位置、找调用点，不改任何文件
tools: read_file, web_search, web_extract, todo_write
model: deepseek-chat
thinking: off
approval: deny
---
你是一个只读搜索员。收到任务后……
```

| 字段 | 缺省 | 说明 |
|---|---|---|
| `name` | 文件名（去 `.md`） | 同 `scanSkills` 的规则 |
| `description` | `""` | **写给模型看的**——它进 `task` 工具的 def，模型靠它挑人。这是它与 skill 的 description 最大的不同 |
| `tools` | `read_file, web_search, web_extract, todo_write` | 只读那几把，不是"全给"。安全默认 |
| `model` | 跟主会话当前模型 | 走 `resolveWithCapabilities` |
| `thinking` | 该型号默认档 | 落地前过 `clampThinking` |
| `approval` | `deny` | `ask` / `auto` / `deny`，对应 `ApprovalMode` |

### 扫描

`src/main/subagents.ts`，纯函数 + fs 接口注入（抄 `skills.ts` 的 `SkillDirReader`
形状），测试喂假实现。

- 根目录按序：`~/.otter/agents`（原生，优先）、`~/.claude/agents`（兼容）。
- 同名先到先得——原生目录排前面 = 覆盖优先。与 `scanSkills` 一字不差。
- 每次调用现扫磁盘，无缓存：定义是用户随时增删的外部文件。
- 没有 frontmatter 的 `.md` 不是 subagent，跳过。

### 工具名兼容

Claude Code 的 `tools` 写的是它自己的工具名（`Read` / `Grep` / `Glob`），和 otter 的
（`read_file` / `bash`）对不上。

- 认不出的名字**静默丢弃**，`SubagentDef` 里带一个 `unknownTools: string[]` 让设置页
  能标注「3 个工具名无法识别」。整个 subagent 不因此报废。
- `task` 出现在 `tools` 里 = 丢弃（决定 5）。
- 丢完一把不剩 = 退回缺省的只读那几把，不是"零工具"。

### 类型

```ts
// src/shared/subagent.ts —— 渲染层和主进程共用（设置页要画它）
export interface SubagentDef {
  name: string;
  description: string;
  instructions: string;      // frontmatter 之后的正文
  tools: string[];           // 已过滤，只剩本仓认识的
  unknownTools: string[];    // 认不出的原样留着，设置页标注用
  model?: string;            // 缺席 = 跟主会话
  thinking?: ThinkingMode;
  approval: ApprovalMode;    // 缺省 deny
  path: string;
  source: string;            // 哪个根目录来的
  readOnly: boolean;         // ~/.claude/agents/ 扫来的 = true
}
```

---

## 二、事件 schema（三处改动，全部向后兼容）

### 新事件 `subagent_spawned`（父侧）

```ts
export interface SubagentSpawnedEvent extends SessionEventBase {
  type: "subagent_spawned";
  toolCallId: string;      // 对回父的那次 task 调用
  childSessionId: string;
  agent: string;
  task: string;            // 派下去的任务（模型给的 args，原样）
}
```

必须落盘：`tool_result.output` 只有汇报正文，推不出 `childSessionId`，而"时间线上
这张卡点进去是哪个子会话"是 UI 投影——投影必须可从日志推导。模型不消费它
（`deriveMessages` 丢弃，同 `turn_ended`）。

落盘时机：子会话建好、子 turn 开跑**之前**。先落盘再跑。

### `SessionCreatedEvent` 加 `spawnedBy`

```ts
  spawnedBy?: { sessionId: string; toolCallId: string; agent: string };
```

与已有 `forkedFrom` 并列。缺席 = 主会话，旧日志照常重放。

### 新事件 `subagent_briefed`（子侧，紧跟 `session_created`）

```ts
export interface SubagentBriefedEvent extends SessionEventBase {
  type: "subagent_briefed";
  agent: string;
  instructions: string;    // 派活时刻的全文快照（含内置前言）
  tools: string[];         // 这次实际给了哪几把
  model: string;
}
```

`deriveMessages` 投影成 user 消息，手法照抄 `skill_invoked`。

### 不新造的

- 模型选择走已有的 `model_changed`（子会话第 0 条之后落一条）。
- 审批模式照旧不落盘：它是运行时偏好，决定"怎么问人"不是"模型看到什么"，与主会话一致。

---

## 三、`task` 工具

### 接缝

```ts
// src/tools/task.ts —— 只认注入的接口，不 import agent / fs / electron
export interface SubagentRunner {
  run(opts: {
    agent: string;
    task: string;
    parentToolCallId: string;
    signal?: AbortSignal;
  }): Promise<{ report: string; childSessionId: string }>;
}

export function createTaskTool(runner: SubagentRunner, list: () => SubagentDef[]): Tool;
```

`runner` 在 `src/main/index.ts`（组装根）接线，内部调 `createAgent`。工具只依赖
`ExecutionWorld` + 注入接口，硬规则原样成立。

### `Tool.def` 改 getter

可用 subagent 清单要进工具描述（`agent` 参数是 enum，模型靠 `description` 挑人），
而清单每次现扫磁盘。`{ get def() {...} }` 在 TS 里满足 `def: ToolDefinition`，
**`Tool` 接口一个字不改**。engine 每轮 `tools.map(t => t.def)` 天然现算，设置页
加人当场生效，不用重开会话。

`toolDefs`（BootInfo，渲染层算上下文占用用）同理现算。

### 参数

```json
{ "agent": "searcher", "task": "找出所有调用 deriveMessages 的地方" }
```

`agent` 是 enum，取当前扫到的名字。`requiresApproval: false`——主模型自主派活；
危险动作在子 agent 里各自过审批门。

清单为空（用户一个 subagent 都没配）时，`task` **不挂上去**：对模型宣称一把用不了
的工具是白烧一轮，而且工具表同时是 UI 报的上下文占用，报一把用不了的连账也是错的
（同 `browserReadTool` 的既有做法）。

### runner 干什么（`src/main/subagentRunner.ts`）

1. 查定义（现扫磁盘）。查不到 → 抛错，engine 落 `tool_result: error`。
2. `createAgent({ workspace: 父的, world: 父的, spawnedBy: {...}, push: 包装过的 })`。
3. 非默认模型 → 落 `model_changed`（`switchModel` 与当前相同时内部 no-op，零多余事件）。
4. 落 `subagent_briefed`（instructions 全文快照，含内置前言）。

   > 订正（issue #141）：这两条原来写反了。实现里 `model_changed` 在前 ——
   > `briefed.model` 读的是切换**之后**的值，先落 briefed 的话那份快照记的是父的
   > 型号，与它自称的"我是谁"的快照语义对不上。以实现为准。
5. 父侧落 `subagent_spawned`。
6. `engine.runTurn(task)`。
7. 取子日志最后一条 `assistant_message.content` 当汇报。空 → 回退文案
   "子任务结束但没有产出汇报正文"。
8. 返回 `{ report, childSessionId }`。

### 内置前言

runner 在用户写的 instructions **前面**拼一段固定文字：

> 你是被派来做一件具体任务的子 agent。你的最终一段文本就是返回值——它会直接交回给
> 派你来的那个 agent，不是给人看的消息。做完就把结论写出来，不要寒暄，不要问"还需要
> 什么帮助吗"。

不指望用户在每个 subagent 里都写一遍。前言也进 `subagent_briefed.instructions`
快照——快照记的是模型看到的全部。

### 审批卡冒泡

runner 给子 agent 传包装过的 `AgentPush`：

```ts
{
  ...parentPush,
  approvalRequest: (_child, call, tool, preview) =>
    parentPush.approvalRequest(parentSessionId, call, tool, preview),
  askUserRequest: (_child, id, qs) => parentPush.askUserRequest(parentSessionId, id, qs),
  // assistantDelta / toolOutput / event 原样透传，挂子 sessionId
}
```

卡上要能显示"来自 subagent: searcher"——`ShellBridge` 的审批推送里加一个可选
`fromAgent?: string` 字段（可选 = 主会话的卡一字不改）。

### 中断传播

父 turn 停止 → signal 穿 `ToolRunContext.signal` 进 task 工具 → runner 调子
`engine.abortTurn()`。子会话落 `turn_ended: aborted`，父侧 `tool_result` 写
"子任务被用户中断"（`status: "error"`，模型据此知道这条线断了）。

---

## 四、设置页

`SETTINGS_SECTIONS` 加 `{ id: "agents", label: "Subagent" }`。

### 列表

一行一个 subagent，样式沿用 `SkillsPage` 的 `<details>`：名字（mono，brand 色）+
description（截字）+ 右侧标注（模型 / 工具数 / 来源目录）。`~/.claude/agents/`
来的额外挂一枚"只读"标记。有 `unknownTools` 的标注「N 个工具名无法识别」。

### 编辑

展开 = 表单，字段直接对应 frontmatter：

| 字段 | 控件 |
|---|---|
| description | 单行 input，帮助文字点明"这句话是写给模型看的" |
| model | 复用 `ModelPicker` |
| thinking | 复用 `ThinkingPicker` |
| tools | 一排 checkbox，取自当前挂载的工具表（`task` 不在其中） |
| approval | 三选一（问我 / 自动放行 / 直接拒绝） |
| instructions | textarea |

保存 = 写回那个 `.md`（重新序列化 frontmatter + 正文）。只读的那些表单禁用，给一颗
「复制到 ~/.otter/agents」。

### 其他动作

- 「新建」：弹窗填名字 → 落一个模板 `.md` → 直接展开进表单。
- 「在编辑器里打开」：逃生口，文件才是事实来源。

### bridge

```ts
listSubagents(): Promise<SubagentDef[]>;
saveSubagent(def: SubagentDef): Promise<void>;      // 写回 .md
createSubagent(name: string): Promise<SubagentDef>; // 模板
```

---

## 五、主会话时间线上的卡

从 assistant-ui elements registry 取两个新组件（本仓已有 31 个同源文件，惯例是
在文件头写「本仓改动一览」注释，升级时人工合——照 `agent-handoff.tsx` 的格式）。

### `AgentStatus`（`r.assistant-ui.com/elements-agent-status.json`）

```ts
{ state: "working" | "waiting" | "done"; label: string; elapsed?: string }
```

pill：动画点 + label + 计时 + 一颗暂停/重来按钮。派单个 subagent 时用这一枚。

- `label` = subagent 名字 + 任务首行。
- `state`：子 turn 在跑 = `working`；子 agent 卡在审批/问卷上 = `waiting`
  （这一档白捡的——父会话此刻正弹着那张冒泡上来的卡，两处状态对得上）；
  子 turn 收口 = `done`。
- `elapsed` 从 `subagent_spawned.ts` 到子 `turn_ended.ts`。
- 按钮接父 turn 的停止键。

**为什么不用 `job-progress`**（本地已有，otto-blocks 在用）：它要 stages + weights
+ ETA，我们三样都没有，硬套就得拿步数当 stage、造一个假百分比。`AgentStatus` 天生
就是"一句话 + 计时 + 停"，零假数据。

### `SubagentList`（`r.assistant-ui.com/elements-subagent-list.json`）

```ts
{ agents: readonly SubagentItem[]; completedCount: number; progress: readonly number[];
  showSummary: boolean; summaryAgent: SubagentItem }
```

一行一个 agent：状态图标（打勾 / 转圈）+ 名字 + 模型（mono）+ 进度条（跑着灰、
完了 emerald）。模型一次发多个 `task` 调用时用它。

它是**并行**语义，而本版串行——串行只是"一个转圈、其余打勾"，同一个组件原样成立，
将来换并行零改动。与 ADR-0047 代价一节那句"日志格式不用改"配套：UI 也不用改。

`progress` 我们没有真百分比，取二值（跑着 0.4 恒定 / 完了 1）——进度条在这里是
状态色带不是进度，不假装知道跑了多少。`showSummary` 用不上，传 `false`。

### 收口态与进出

- 收口后那一行本身就是收口态（打勾 + 满格），末尾补 `12 步 · 4.2k tokens`，
  从子日志求和（`deriveUsage` / 数 `assistant_message`，都是现成投影）。
- 跑的时候底下挂一行子会话的 `toolOutput` 直播尾巴（`ToolLiveTail` 现成的）。
- 点一行 = 跳子会话。子会话不进侧栏（`spawnedBy` 滤掉），只能从这里进；
  顶部一颗「← 回到父会话」。

### 存着将来用（并行版才需要）

- `Parallel tools`（gallery #32）：折叠的并发调用，展开看详情。
- `Trace waterfall`（#71）：嵌套 span 排在时间轴上。

`Agent plan`（#59）本地 `todo-list.tsx` 已覆盖；`AgentCard`（#66）看着像设置页那一行，
但 `endpoint` / `version` / `provider` / `connected` / `onConnect` 对本地文件全无意义，
能留的只有 name/description/model/skills——要改的字段比留的多，不引，只参考排版分寸。

视觉细节实现时再抠，那会儿先过 `emil-design-eng`。

---

## 六、测试（`tests/` 镜像 `src/`）

- `tests/main/subagents.test.ts`：frontmatter 解析、缺省值、同名覆盖、工具名过滤
  （含 Claude Code 名字、含 `task`、丢完一把不剩）、无 frontmatter 跳过。
- `tests/tools/task.test.ts`：def 随清单现算、清单为空不挂、enum 内容、runner 抛错
  变 `tool_result: error`、signal 传播。
- `tests/session/`：`subagent_spawned` / `subagent_briefed` 的投影（前者丢弃、后者
  投成 user 消息）；旧日志（无 `spawnedBy`）照常重放的回归。
- `tests/main/subagentRunner.test.ts`：落盘顺序（briefed → spawned → runTurn）、
  汇报取最后一条 assistant_message、空汇报回退文案、审批卡冒泡到父 sessionId。

---

## 七、实施顺序（每步自带门禁）

1. `src/shared/subagent.ts` 类型 + `src/main/subagents.ts` 扫描/解析 + 测试。
2. 事件 schema 三处改动 + 投影 + 旧日志回归测试。
3. `Tool.def` 改 getter（纯重构，行为不变）+ 现有工具不动的回归。
4. `src/tools/task.ts` + 测试（runner 喂假实现）。
5. `src/main/subagentRunner.ts` + `index.ts` 接线 + push 包装 + 测试。
6. bridge 三个方法 + 序列化写回。
7. 设置页 Subagent 栏目。
8. 时间线卡 + 子会话进出。

1–6 是后端，可以一路 TDD；7–8 碰 UI，动手前过 `emil-design-eng`。
