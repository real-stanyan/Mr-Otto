# 子智能体：作用域与前置提示词 — 设计

**日期**：2026-08-21
**ADR**：`docs/adr/0048-子智能体的作用域与三层前置词.md`
**前置**：ADR-0047（子 agent 是一次独立会话）已落地并合进 main（PR #131）

## 1. 目标

三件事，一次做完：

1. 设置页那一栏从「Subagent」改叫**子智能体**，正文里所有面向用户的说法跟着改。
   代码标识符、`task` 工具名、frontmatter 字段名一律不动。
2. **可选作用域**：子智能体可以是用户级（处处可用）或工作区级（只在本工程可用）。
3. **可配置前置提示词**：全局一份可编辑的、每个子智能体可覆盖、外加工作区文档注入。

非目标：颜色标记、启用/停用开关、内置子智能体、搜索框（参照图里有，这次不做）。

## 2. 作用域

### 2.1 根目录

`scanSubagents` 的 roots 按覆盖优先级排（同名先到先得）：

| 顺序 | 目录 | readOnly | scope |
|---|---|---|---|
| 1 | `<工作区>/.otter/agents/` | false | `workspace` |
| 2 | `<工作区>/.claude/agents/` | true | `workspace` |
| 3 | `~/.otter/agents/` | false | `user` |
| 4 | `~/.claude/agents/` | true | `user` |

没有工作区（设置页选「用户」、或探针装配）时只有 3、4 两条。

### 2.2 运行时

`task` 工具看到的清单 = **该会话 workspace 那次扫描的结果**。绑定点在
`index.ts` 的 `createSessionAgent`：那里已经有 `args.workspace`，用它闭包出
`listForSession = () => listSubagents(args.workspace)`，同时喂给 `listSubagents`
选项和 `subagentRunner` 的 `list`。`SubagentRunner` / `createTaskTool` 的签名
不变 —— 工作区在组装根绑定，工具那层不需要知道有这回事。

### 2.3 保存与查重都在选中作用域里做

同名可以两个作用域各一份，所以 `saveSubagent` / `createSubagent` 的 IPC 必须
连作用域一起传，落地路径仍从**信任侧**（主进程现扫一遍磁盘）按 `(name, scope)`
查出来。渲染层传来的 `path` / `source` / `readOnly` 照旧不采信。

作用域的表达：IPC 参数 `workspace: string | null`（`null` = 用户级）。

### 2.4 设置页的作用域候选从哪来

不新开 IPC。渲染层用已经在 store 里的会话列表跑 `groupSessionsByWorkspace`，
得到「有过会话的工程文件夹」，加上一项「用户」。这与参照界面里那份列表同源。

## 3. 前置提示词

派活时拼装：

```
前置词  +  工作区文档注入  +  def.instructions
```

### 3.1 全局前置词

- 文件：`~/.otter/subagent-preamble.md`，纯文本，**无 frontmatter**。
- 不存在 / 读不到 / 去空白后为空 → 用内置默认（现在 `subagentRunner.ts` 里那段
  `PREAMBLE` 常量，原样搬进 `shared/subagent.ts` 成为 `DEFAULT_PREAMBLE`）。
- 这个文件落在 `~/.otter/` 而不是 `~/.otter/agents/`：`agents/` 下每一个 `.md`
  都会被 `scanSubagents` 读一遍，虽然没有 frontmatter 会被 `parseSubagentMd`
  丢掉、不会显示成一个子智能体，但让「配置文件」和「定义文件」混住是在等一个
  未来的坑。

### 3.2 每个子智能体的前置块（覆盖全局）

frontmatter 字段 `preamble`，三态：

| 写法 | 语义 |
|---|---|
| 不写 | 用全局前置词 |
| `preamble: off` | 一段前置词都不加 |
| `preamble: \|` + 缩进块 | 用这段，**替换**全局 |

`off` 是保留字：一个想让自己的自定义前置词正好是 `off` 两个字母的用户，得用
块标量写法（`preamble: \|` 换行缩进 `off`）。

### 3.3 工作区文档注入

frontmatter 字段 `context`，逗号分隔的**文件名**列表，缺席 = 不注入。

- 只收 basename：`/`、`\`、`..`、绝对路径一律在解析时丢掉。这是安全边界不是
  格式洁癖 —— 定义文件可能是用户从别处抄来的，不能让它变成任意文件读取原语。
- 运行时（`subagentRunner`）**再校验一次**才读盘（defense in depth，同
  `saveSubagent` 那条「两处独立判断比互相信任更皮实」）。
- 按会话 workspace 拼绝对路径读；读不到就跳过，不报错、不中断派活。
- 拼进去的形状：每份文件一段

  ```
  ## 工作区文档：AGENTS.md

  <正文>
  ```

  多份之间空行隔开，整块之后再空一行接 `instructions`。
- 有上限：单份文件超过 64 KiB 时截断，并在该段末尾附一行
  `（本文件过长，已截断）`。截断这件事进日志快照，不藏。

### 3.4 拼装是纯函数

新模块 `src/main/subagentPrompt.ts`：

```ts
export function composeSubagentPrompt(opts: {
  def: SubagentDef;
  globalPreamble: string;
  docs: readonly { file: string; text: string }[];
}): string;
```

读盘的两个小函数（`readGlobalPreamble` / `readContextDocs`）以 reader 接口注入，
与 `subagents.ts` 的 `SubagentDirReader` 同一套路，测试喂假实现。

### 3.5 落进日志

`subagent_briefed` 事件的 `instructions` 字段照旧记「模型看到的全部」，
现在就是 `composeSubagentPrompt` 的返回值。事件 schema 不变，向后兼容。

## 4. 重建历史子会话一律信快照（了结 #140）

`childAgentConfig(events, defs)` → `childAgentConfig(events)`：不再读磁盘定义。

- 装备来自 `subagent_briefed.tools`（当时实际挂上的那几把）。
- 审批档快照里没有，所以**一律 `deny`** —— 现在的磁盘分支能带出 `ask`/`auto`，
  去掉之后重建的子会话一律最严。这是收权不是放权。
- 没有快照（理论不可达）→ 零工具 + deny，与现状一致。

理由见 ADR-0048 决策 3：快照是日志的一部分（事实来源），磁盘定义是可变外部状态；
用磁盘重建等于让历史会话随文件改动而改写。

## 5. 数据形状

### 5.1 `src/shared/subagent.ts`

```ts
export type SubagentScope = "user" | "workspace";

export type SubagentPreamble =
  | { mode: "default" }
  | { mode: "off" }
  | { mode: "custom"; text: string };

export const DEFAULT_PREAMBLE: string;   // 从 subagentRunner.ts 搬过来

/** 只收 basename —— 见 §3.3 */
export function isSafeContextFile(name: string): boolean;
```

`SubagentDef` 新增三个字段（都必填，解析时一定给得出值）：

```ts
  scope: SubagentScope;
  preamble: SubagentPreamble;
  context: string[];
```

### 5.2 磁盘格式（示例）

```markdown
---
name: repo-reviewer
description: 按本仓 AGENTS.md 的规矩审查改动。需要判断一个 diff 合不合规矩时派它。
tools: read_file, bash
approval: ask
context: AGENTS.md, CONTEXT.md
preamble: |
  你只输出发现的问题，一条一行，不写总结段。
  没有发现就输出一行「没有发现」。
---

审查范围以任务里给的路径为准……
```

### 5.3 解析器

`parseFrontmatter` 加块标量分支：值恰好是 `|` 时，吃掉后续**缩进比键行深**的
连续行，去掉公共缩进，作为该键的值。只支持这一种块写法；`>`、`|-`、`|+` 等
YAML 变体不认（认不出就当普通单行值处理，行为与今天一致）。

`serializeSubagent` 对称输出：`preamble.mode === "custom"` 时写块标量（每行两格
缩进），`"off"` 时写 `preamble: off`，`"default"` 时整行不写。`context` 非空时
写逗号列表。

## 6. 桥面（`ShellBridge`）

```ts
listSubagents(workspace: string | null): Promise<SubagentDef[]>;
saveSubagent(def: SubagentDef, workspace: string | null): Promise<SubagentDef[]>;
createSubagent(name: string, workspace: string | null): Promise<SubagentDef[]>;
getSubagentPreamble(): Promise<{ text: string; isDefault: boolean }>;
/** text === null = 删掉文件 = 恢复内置默认 */
saveSubagentPreamble(text: string | null): Promise<{ text: string; isDefault: boolean }>;
```

前三个是签名变更（加一个必填参数），后两个是新通道。`CHANNELS` 加两个常量。

## 7. UI

栏目标题 `Subagent` → `子智能体`；正文里「subagent」的说法一律改成「子智能体」，
`task`、`tools`、`description` 这些代码/字段名保持原文。

### 7.1 头部

标题右侧一枚作用域下拉（参照图里那个位置）：`用户` / 各工作区短名（
`folderName(workspace)`）。选中值只活在组件 state 里，不持久化 —— 每次进设置页
默认「用户」，因为那才是处处生效的那一份。选中工作区时下拉旁边一行小字给出
绝对路径，避免两个工程重名分不清。

「新建」建在**当前选中的作用域**里，对话框描述里写明建在哪。

### 7.2 全局前置词卡

列表上方一张卡：标题「全局前置词」，副标题「拼在每个子智能体正文前面；单个
子智能体可以覆盖它」。内容是一个 `Textarea`（等宽、min-h-32），底部一排：
「保存」+「恢复默认」+ 一行状态字（用的是内置默认 / 自定义，以及文件路径）。
「恢复默认」= `saveSubagentPreamble(null)`，删文件，textarea 回落成内置默认文本。

### 7.3 行内新增两块

在「正文」上方插入：

- **前置词**：三档 segmented（跟审批档同一套控件样式）—— `全局` / `不加` /
  `自定义`；选「自定义」时下面展开一个 `Textarea`。默认值来自 `def.preamble`。
- **工作区文档**：两枚勾选（`AGENTS.md` / `CLAUDE.md`），样式复用工具那排 pill。
  下面一行 `HINT`：「派活时按会话所在工程读这些文件；读不到就跳过」。
  用户级子智能体也能勾 —— 它在哪个工程里被派出去，就读哪个工程的。

`dirty` 判定、`resetDraft`、`save` 三处都要带上这两个新字段。

### 7.4 动效与手感

不新增动画。新控件复用既有的 `press-scale`（`:active` 时 `scale(0.97)`）和
`transition-colors duration-150`；segmented 与工具 pill 的样式一字不改地复用。
「自定义」展开那段用高度自适应的条件渲染，不做展开动效 —— 设置页是低频且用户
正盯着看的界面，多一段 200ms 只是让人等。

## 8. 测试

`tests/` 镜像 `src/`：

- `tests/main/subagents.test.ts`（已存在，补）：块标量解析（含缩进、空块、
  `off`、多行）、`context` 的 basename 过滤（`../x`、`/etc/passwd`、`a/b`）、
  `scope` 赋值、序列化往返（parse ∘ serialize = 恒等）、老文件（无新字段）
  解析后 `preamble.mode === "default"` 且 `context` 为空。
- `tests/main/subagentPrompt.test.ts`（新）：三态前置词 × 有无文档注入的拼装、
  截断、文档读不到时跳过。
- `tests/main/scanSubagents`（在既有文件里）：四条根目录的覆盖顺序、无工作区时
  只扫两条。
- `tests/main/resumeChild.test.ts`（已存在，改）：`childAgentConfig` 只吃一个
  参数；有快照 → 用快照的 tools + deny；无快照 → 零工具 + deny。
- `tests/renderer/`：作用域下拉的候选来自会话分组；切换作用域会重新请求清单。

门禁 `npm test` 全绿是收工条件，不另加门禁。

## 9. 向后兼容

- 老的 `.md` 定义文件：没有 `preamble` / `context` 字段 → 前置词走全局、不注入
  文档，行为与今天一字不差。
- 老日志：`subagent_briefed` schema 未变。
- `~/.claude/agents/` 里 Claude Code 写的定义：多出来的字段它不认，我们也不会
  往只读目录里写。
