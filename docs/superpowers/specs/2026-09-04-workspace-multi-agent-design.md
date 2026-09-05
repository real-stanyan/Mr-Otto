# 工作区多智能体设计 — 群里站着好几只水獭

日期：2026-09-04 · Task issue：#928 · 状态：待 stanyan 审阅

## 0. 背景

工作区三期（#811 定的路线：一期工作区实体 / 二期云执行面 / 三期计费）已经全部落地。
本 spec 是**四期**：一条工作区会话里从「一只水獭」变成「好几只，各管一块业务，@ 谁谁答」。

用户原话（#928）：

> 在一个新创建的工作区里默认有一个 agent 叫"管理员"，用户可以自己创建其他 agent
> 分别管理不同区块的业务，用户可以分别给这些 Agent 配置……里边可以使用的模型，以及
> 用户自己配置过的连接器给这些 agent 使用。或者用户也可以叫管理员生成用户自己描述的
> Agent，然后用户可以 @ 这些创建过的智能体来工作，这些智能体也可以互相 @ 来协同工作。
> ……每个 agent 有自己的记忆。

设计对话中澄清掉的一项：**额度不做限流，只做归因** —— 每只 agent 配的是「能用哪些
型号」，另有一处看得见「每只烧了多少周额度」。

### 0.1 这件事撞上的既有设施

| 已有 | 关系 |
|---|---|
| ADR-0047 子 agent 是一次独立会话 | 本机已有一整套子智能体（磁盘 `.md`、`task` 派活、独立日志分区）。**决定 5 硬挡「子 agent 不能再派子 agent」**，本 spec 的切片 5 是它的对立面——但那是**另一条路径**（群聊接力），不拆 `task` 那两个把守点 |
| ADR-0054 子 agent 的 MCP 工具靠白名单点名 | 「配连接器给 agent 用」直接落在这条上，口径原样沿用 |
| ADR-0198 工作区连接器池 | 池子已经有了；本 spec 只在池子之上再过一道 per-agent 白名单 |
| ADR-0199 / 0202 云执行面 | 今天一条云会话**只有一台 engine**；`say(..., mention: boolean)` 的 `mention` 是「要不要惊动水獭」的布尔，不是「@ 谁」 |
| ADR-0207 / 0211 记忆 | 记忆整层住在 `src/main/`（桌面独占）。**云 runtime 今天零记忆** |
| ADR-0212 退化循环护栏 | 切片 5 的接力护栏抄它的判据形状（周期重复，不是连续相同） |
| ADR-0217 工作区订阅闸 | 工作区的 turn 一律记在 **owner** 头上（`x-otto-on-behalf-of`）。本 spec 不动这条 |

### 0.2 一条要单独点头的边界

AGENTS.md 开篇写着「明确不做：多 agent 编排」。**切片 5（agent 互相 @）推翻它**。
按 ADR-0006 这是改协议文件，需要 issue + ADR + PR + stanyan 明确同意；单人仓
两条批准路径都有效（ADR-0034/0042），但**这次要走 PR 评论那条**——一句会话里的
「ok」半年后读不出它批的是哪一版。切片 1–4、6 不碰这条边界，可以先走。

## 1. 已定的方向性决策（本次设计对话，stanyan 选定）

1. **群聊参与者模型**，不是派活模型。agent 和人并排，@ 谁谁答，发言全落同一份日志、
   画在同一条时间线上，行上写谁说的。
2. **上下文只到发言为止**：一只 agent 看得见别人的 `assistant_message` / `chat_message`，
   **看不见**别人的 `tool_call` / `tool_result`。心智模型是「群里我听得见你说话，
   看不见你在你电脑上敲了什么」。附带结论：**每只 agent 只为自己的工具付钱**。
3. **接力刹车两层**：周期护栏先喊话（不停），棒数到顶硬停并向人汇报。
4. **额度归因不限流**：per-agent 配的是型号白名单；用量按 agent 聚合展示。
5. **权限**：建 = 任何成员；改/删 = 建的人或 owner；@ 用 = 任何成员。对称于
   `workspace_sessions` 的 RLS。
6. **记忆两档**：agent 私有 + 工作区共享。判据一句话：**「换一只 agent 还成立吗？」**

## 2. 整体形状

一条云会话从**一台 engine** 变成 **N 台 engine + 一条串行队列**。

- **每只 agent = 一台 `LoopEngine`**：自己的 system prompt（那只的 `instructions`）、
  自己的 adapter（型号白名单里选的那个）、自己的工具表（连接器白名单过滤后的）。
  复用整台 engine 而不是裸拼，理由同 ADR-0047 决定 1——审批门、直播、中断信号、
  崩溃修复、压缩全是免费的。
- **`turnCoordinator` 从「一把互斥锁」变成「一条串行队列」**：@ 谁就塞一个 job，
  前一个跑完跑下一个。**串行不并行**——并行审批卡、并行直播、中断传播要重新想一遍
  （同 ADR-0047 否掉并行派活那笔账），且决策 3 的接力形状本来就是一棒接一棒。
- **上下文隔离靠构造保证**（见 §5）。

### 2.1 否掉的备选：一台 engine 每轮换人格

省内存，但 engine 持有每会话状态——`loopFingerprints`（ADR-0212 的退化循环护栏）、
todo、压缩标记。换人格不换这些就串味：运营那只的护栏指纹会算进广告那只。要么每轮
清空（护栏失效，而护栏正是接力上限的第一层），要么按 agent 分格——那已经是 N 台
engine，只是挤在一个壳里。

### 2.2 否掉的备选：每只 agent 一个会话分区，群时间线是合流投影

上下文隔离最干净、最省，最像 ADR-0047 已验证过的形状。否掉是因为它与决策 1 冲突：
一条会话变 N 个分区之后，backlog / resume / 归档 / 计费口径全要重想，而「一份日志
一条时间线」是这次明确选定的形状。

## 3. 数据模型

Migration `0021_workspace_agents.sql`。

```sql
create table if not exists public.workspace_agents (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     text not null,                    -- 稳定键，改名不换它
  name         text not null check (char_length(name) between 1 and 32),
  description  text not null default '',
  instructions text not null default '',
  models       text[] not null default '{}',     -- 允许的逻辑型号，[0] 是默认
  tools        jsonb not null default '[]',      -- 连接器白名单，[] = 整池放行
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
-- name 是 @ 的寻址依据，一个工作区里不许重名
create unique index if not exists workspace_agents_name
  on public.workspace_agents (workspace_id, name);
```

> 三个 migration 的编号（`0021` / `0022` / `0023`）按切片分批落地，**编号在各自
> 合并前 re-fetch 复核**——同 ADR 撞号的规矩（ADR-0074）。

- **`agent_id` 与 `name` 拆开**：`name` 是 @ 打的那个词、随时会改；`agent_id` 是记忆
  和用量归因的键。合成一个的话，改个名字等于换了一只 agent——记忆和账一起断，而且
  是安静地断。
- **`models` 是数组不是单值**：用户配的是「这只能用哪些」，具体哪一次用哪个留给
  会话级选择；`[0]` 是默认。空数组 = 用工作区默认型号（ADR-0202 的 `adapterFor`）。
- **`tools` 的 `[] = 整池放行` 口径故意与 `workspace_connectors` 一致**——不一致的话
  同一个字面量在相邻两张表里意思相反。
- RLS 照 `workspace_sessions` 抄：成员可 select；成员可 insert（`created_by = auth.uid()`
  且在籍）；`created_by = auth.uid()` 或 workspace owner 可 update / delete。
- 建工作区时种一行「管理员」（`agent_id = 'admin'`，`created_by` = owner）。
  **管理员可改不可删**——一个 agent 都没有的工作区 @ 不到任何人，是死局。
  删除拦在 RLS（`agent_id <> 'admin'`）+ 界面两处。

### 3.1 与 `SubagentDef` 的关系

字段形状照 `SubagentDef` 抄（`name` / `description` / `instructions` / 型号 / 工具白名单），
但**不是同一个类型**：`SubagentDef` 有一半是磁盘概念（`path` / `source` / `readOnly` /
`scope` / `context` 收 basename / `preamble`）。

**两套并存，本机子智能体一字不动。** 理由是生命周期本来就不同：磁盘 `.md` 是你一个
人的、随时改；`workspace_agents` 一行是全工作区共享的、改了所有成员都受影响。合成
一套就要立刻回答「我改了本机这份，工作区那份跟不跟着变」，而那个问题没有好答案。

代价：同一个「广告分析员」要配两遍。缓解留给后续——设置页一个「从我的子智能体导入」
按钮（**拷贝，导完断链**），不进本 spec 的任何切片。

## 4. 事件 schema 与线协议

### 4.1 turn 期事件加可选 `agentId`

**本仓没有 `tool_call` 事件**——工具调用内嵌在 `assistant_message.toolCalls` 里
（写 spec 时查证）。所以带 `agentId` 的是这一组：`assistant_message` /
`tool_result` / `tool_execution_started` / `approval_request` / `approval_decision` /
`request_envelope` / `turn_ended`。各加一个可选 `agentId: string`。新事件 `agent_briefed`
（§4.3）的 `agentId` 是**必填**——它整条就是在说「这是谁」。

**缺席 = 单 agent 会话**——全部旧日志、全部本机会话都落在这一档，旧日志照常重放
（硬规则 4 满足）。落盘由 engine 的 `env()` 统一供料（它已经在给 `sessionId` / `ts`），
不是每个 append 点各写一遍。

### 4.2 不给 agent 发伪 uid

agent 发言走 `assistant_message`（带 `agentId`），**不走 `chat_message` + 一个编出来的
`fromUid`**。uid 是 `auth.users(id)`；编一个进去会让三处同时开始撒谎：审批链的
`initiatorUid` / `byUid`（ADR-0047 决定 4 的冒泡语义）、代理执行的身份闸（ADR-0164
第一道）、用量归因的 `usage_event.user_id`。

### 4.3 新事件 `agent_briefed`

```ts
{ type: "agent_briefed"; agentId; name; instructions; roster: { name; description }[] }
```

一只 agent 在这条会话里的自我介绍：它管哪块业务（`instructions`），群里还有谁
（`roster`，@ 得着谁靠这份名单）。没有它，一只「agent」就只是换了个型号的默认水獭。

**投影成 user 消息不是 system**，手法同 `subagent_briefed` / `skill_invoked`——中途插
system 消息各家方言兼容性参差（ADR-0047 决定 1 的原话）。云会话的 system 只从
`session_created.workspace` 产出，那是**会话级围栏**，不是 agent 级身份。

**为什么不复用 `subagent_briefed`**：那条的投影文案写着「你是 subagent「X」，
以下是你的指令，请在完成任务时遵循」——它把模型的最终一段文本定义成**返回值**
（ADR-0047 的 `DEFAULT_PREAMBLE`）。群聊里这是错的：agent 说的话是说给群里的人听的。
复用等于给模型灌一句关于自己身份的假话，而这句假话会稳定地改变它怎么说话。

落盘时机的判据有两条，缺一不可：**这只没被介绍过**，或**介绍时的那份指令和现在不一样**。
只判前者，用户改完提示词要重开会话才生效；每 turn 都落一条，日志里堆满同一段文字，
模型每轮被重新自我介绍一遍。

别人的 `agent_briefed` **不进我的上下文**（§5 的丢弃名单里有它）：我需要知道群里有
「广告」这个人——那来自我自己 briefing 里的 `roster`——不需要读它的提示词。

### 4.4 新事件 `agent_relay`

```ts
{ type: "agent_relay"; fromAgentId: string; toAgentId: string; depth: number }
```

落**群**日志（不是某只 agent 的私有分区——它描述的是两只之间的事）。必须落盘的理由同 ADR-0047 的 `subagent_spawned`：时间线上那条
接力线是 UI 投影，投影必须可从日志推导；而且**棒数上限的判据不能只活在内存里**——
daemon 重启后接力链要能续上判断。

### 4.5 `cs_say` 加 `mentions`

```ts
| { t: "say"; text: string; mention: boolean; mentions?: string[] }
```

**布尔那个字段留着**：线协议三端共用一份（`src/shared/remote/cloudSession.ts`），
手机端和旧桌面还在发布尔。`mentions` 缺席时按老语义（`true` = @ 唯一那只 / 管理员）。

**客户端给了 `mentions`（含 `[]`）就以它为准，服务端不再重解析正文**；只有这个字段**缺席**时才走老语义（ADR-0220，#932 坑 ④——`[]` 是「我确认谁都没点」，与「这台客户端算不出来」是两回事）。

### 4.6 @ 名字解析两处都要，一份纯逻辑共用

- **客户端**：用户打字时出 chip，看得见自己 @ 到了谁；发帧时带解析好的 `mentions`。
- **服务端**：agent 输出的是**文本**，只能服务端按名单匹配。

所以是一份纯逻辑两边共用（新文件 `src/shared/remote/agentMention.ts`），纪律同
`wire.ts`。名字含中文/空格时的边界判定必须只有一处——两处各写一条正则迟早分家
（`SUBAGENT_NAME_RE` 那次就是，见 `src/shared/subagent.ts` 注释）。

## 5. 上下文隔离：靠构造，不靠每处补过滤

engine 里的 model-facing 读有**三处**：

| 位置 | 读法 |
|---|---|
| `snapshot()` 首圈 | `boundedContextEvents(store, sessionId) ?? store.load(sessionId)` |
| `snapshot()` 增量圈 | `store.load(sessionId, { afterSeq })` |
| `compactInner()` | `store.load(sessionId)` 全量——喂摘要人，也是 model-facing |

（`unseenUserTail()` 也读 store，但只判断有没有 `user_message`，不进上下文。）

ADR-0047 备选里否掉「子 agent 事件写进父日志」的理由一字不改地适用：**所有现存投影
都得补一道过滤，漏一处就把别人的上下文灌进模型，而且是安静地漏**。

所以：**抽一个窄读接口**，engine 在装配那一刻拿到已经过滤的实现，三处读点一个都不改。

```ts
// src/session/eventLog.ts（新）
export interface EventLog {
  append(e: NewSessionEvent): SessionEvent;
  load(sessionId: string, opts?: { afterSeq?: number; untilSeq?: number }): SessionEvent[];
  forkOrigin(sessionId: string): ForkOrigin | null;   // 以下三个只有 boundedContextEvents 用
  lastOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent | null;
  ofType(sessionId: string, type: SessionEvent["type"]): SessionEvent[];
}
```

五个方法是实测出来的，不是猜的：`engine.ts` 只碰 `append` / `load`，另外三个来自
`boundedContextEvents`（它也收 store）。`EventStore` 结构上已经实现全部五个（只需在
类上标注 `implements EventLog`）。
`agentView(store, agentId)` 是第二个实现。`append` 原样转发（写路径不过滤）；
读路径是**变换不是过滤**——这是本切片唯一一处不小心就会安静出错的地方：

| 别人的事件 | 怎么处理 |
|---|---|
| `assistant_message` | **剥掉 `toolCalls` / `reasoning` / `usage`**，只留 `content`；剥完 `content` 为空则整条丢弃（纯工具调用那一轮它没说话） |
| `tool_result` / `tool_execution_started` / `approval_request` / `approval_decision` / `request_envelope` / `turn_ended` / `tool_hook` / `agent_briefed` | 整条丢弃 |
| **`context_compacted`** | **整条丢弃**（见下，这一条初稿写反过） |
| 其余（`chat_message` / `user_message` / `session_created` / `memory_loaded` …） | 原样放行 |

**这张表不是一张名单，是一个 `Record<SessionEvent["type"], …>`** —— 每个事件类型都必须
表态，加了新类型不来这里写一笔 `tsc` 直接红。理由是这张表初稿就漏过一次，而漏掉的代价
在下一段：名单漏一个是静默灾难，Record 漏一个是编译错误。形状照 `sessionPackage.ts` 的
`PRIVACY_VERDICTS`（本仓已经用它救过一次场，AGENTS.md 记着它是「新事件类型检查清单的第七处」）。

**`context_compacted` 为什么必须丢**（初稿把它归进「原样放行」，错得很重）：
`deriveMessages` 对它的处理是 `messages.length = 0` —— **清场重来**，摘要被注入成
「你对这段历史的全部记忆」。而摘要是**按视角**生成的（ADR-0003）。所以别人的一条压缩事件
漏进来，不是多一条噪音，是**我的整段真实历史被抹掉、换成别人视角的摘要**。不崩、不报错、
界面无痕，触发条件只是「群里任何一只压缩过一次」。`agentView` 的 `lastOfType` 单独处理它
**不够** —— `load` / `ofType` 两条通用读路径同样要过这一关。

**为什么剥 `toolCalls` 是必须的而不是顺手**：留着它、又丢掉配对的 `tool_result`，
`deriveMessages` 的悬空工具调用自愈（ADR-0005 保命层，`deriveMessages.ts:351`）
会替它**造一条「没执行」的 tool 消息**塞进我的上下文。那不是崩溃，是**一句凭空
捏造的事实**——别人明明跑成功了，我的模型读到的是它没执行。安静地错，比 400 难查。

**这是真活不是免费的**：`EventStore` 是 `class` 且有 `private` 成员（`db` / `stmts` /
`prep` / `loadRaw`），一个裸包一层的对象**过不了 TypeScript 的结构类型检查**——
必须先抽接口。`LoopEngine` 和 `boundedContextEvents` 的 `store` 参数类型跟着从
`EventStore` 收窄成 `EventLog`。

### 5.1 一条断言

`tests/architecture.test.ts` 加一条：**云会话装配处递给 `LoopEngine` 的 store
必须是 `agentView` 的产物**。这条不是洁癖——「漏一处」的失败模式是安静的，
今天读得对不保证明天加一处读点时还对。

## 6. 记忆

Migration `0022_workspace_memories.sql`。

```sql
create table if not exists public.workspace_memories (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     text not null default '',   -- '' = 工作区共享档
  content      text not null default '',
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
```

- **一档一行。** 条目切分（`ENTRY_DELIMITER` / `parseEntries` / `formatEntries`）是
  `src/shared/memoryStore.ts` 的纯层，原样复用。
- 字符上限沿用现有量级：**共享 2200**（接替 `project` 档的位置）、**私有 1100**。
  紧上限不是为了省 token，是为了逼出策展（`memoryStore.ts` 头注的同一条理由）。
- **`user` / `memory` 两档在工作区里不出**：群里「用户」是谁没有答案（多人）；
  云容器里没有本机环境事实（PATH、CLI 登录态那些）。
- **判据一句话：「换一只 agent 还成立吗？」** 成立写共享，不成立写私有。形状照抄
  `tierRuleText`——#589 的教训是判据必须是**一个可回答的问题**，不是一段描述
  （旧判据「拿不准就写 memory」的实际效果是模型几乎全写全局）。
- RLS：成员可读；成员可写（在籍即可，对称于连接器池 ADR-0198 决策③）。

### 6.1 runtime 侧要装记忆层

云 runtime 今天**零记忆**（`services/runtime/` 里所有 `Memory` 都是容器内存限额）。
要装的：

| 层 | 做法 |
|---|---|
| 纯逻辑（解析/序列化/上限/条目去重） | `src/shared/memoryStore.ts` **直接复用**，一行不改 |
| 落点（fs 口） | **不复用** `src/main/memoryFiles.ts`（它是 accountConfig 磁盘口）。新写一个 Supabase 读写口 |
| 注入 | system 尾部，照 `deriveMessages` 现有那条路 |
| `memory` 工具 | 进云 agent 的工具表。档位枚举是**云侧自己的一份**（`"shared" \| "own"`），**不动 `MemoryTarget`**——那个类型手机端也在用，收窄它会把桌面四档一起打红 |

### 6.2 共享档是多写者可变状态

两只 agent 写进矛盾事实（运营写「销量含退款」、广告写「不含」）时今天看不出来。

**决定：每条带一个写入者前缀**（`[运营] …`），吃掉预算里一小段。理由是没有这个前缀
时，矛盾的两条读起来像同一个权威说的两句话，而人要修它得先知道去问谁。前缀由写入
路径拼，不靠模型自觉。

## 7. 用量归因

- `usage_event` 加一列 `agent_id text not null default ''`（migration `0023`）。
  runtime 调网关时随 `x-otto-on-behalf-of` 一起带上。
- 展示落**工作区设置页**（和成员 / 连接器并列），不挤进上下文浮层卡——那张 300px
  的卡已经满了（ADR-0209）。
- 数据从 `usage_event` 现聚合，**不碰 Quota DO**：DO 是限流用的投影，这里要的是归因。
  周窗的起点复用 `quota.ts` 的 `weekStartFor`——同一扇窗两个界面不能给出两个数
  （ADR-0209 已经踩过一次同型问题）。

## 8. 接力护栏（切片 5）

一次**人话点火**开启一条接力链。链上带 `depth`（`agent_relay.depth`）。

1. **第一层 · 周期护栏**：判据抄 `src/shared/toolLoopGuard.ts` 的形状——**周期重复**
   不是「连续相同」（ADR-0212：真机那条轨迹里相邻两圈从来不相等，只认 `last === prev`
   的护栏会全程沉默）。命中时往群里注一条话，**不停**。
2. **第二层 · 棒数上限**：`depth` 到顶（默认 6，工作区可配）时停下，在群里说一句
   「接力到上限了，我停在这儿，还没做完的是…」，交还给人。

**为什么要第二层**：ADR-0212 只注话不硬停，那条决定成立的前提是「用户就在屏幕前」。
云会话这个前提不成立——链子跑在 VPS 上，群里可能没人看着。

**人话点火重置 `depth`**：人每说一句就是一次新的授权。

## 9. 权限矩阵

| 动作 | 谁 | 对称于 |
|---|---|---|
| 建 agent | 任何成员 | `workspace_connectors` 任何成员可贡献（ADR-0198 决策③） |
| 改 / 删 agent | 建的人 或 owner | `workspace_sessions` 发布者改/撤回 |
| 删「管理员」 | 谁都不行 | 无——见 §3 |
| @ 用 agent | 任何成员 | — |
| 读 / 写记忆 | 任何成员（经 agent） | `workspace_connectors` |

**成员建的 agent 照样花 owner 的钱**（ADR-0217 不动）。这在任何方案下都成立——成员
本来就能在工作区里开会话烧 owner 的额度。真正的刹车是 §7 那张用量表，不是「谁能建」。

## 10. 切片与顺序

`Blocked by` 边只有一条真的：**1 挡住其余全部**；2/3/4/5/6 之间互不依赖。

| 片 | 内容 | 做完能干什么 |
|---|---|---|
| **1a 骨架·服务端** | `workspace_agents` 表 + RLS + 种「管理员」；抽 `EventLog` 接口 + `agentView`；`CloudSession` 一台 engine → N 台 + 串行队列；事件加 `agentId`；`cs_say` 加 `mentions`；`agentMention.ts` 纯逻辑 | 跑得起来，界面上还看不见 |
| **1b 骨架·桌面** | @ chip 输入；时间线「谁说的」；工作区设置页 agent CRUD + 型号白名单 | @ 运营 / @ 广告，各用各的型号与提示词 |
| **2 连接器白名单** | `workspace_agents.tools` 接在 `fetchGrantedTools` 之后再过一道；设置页勾选表复用 `proxyShare.ts` 的换算 | agent 能真动 Shopify / Google Ads |
| **3 用量归因** | `usage_event.agent_id`；设置页周用量表 | 看得见每只烧了多少 |
| **4 记忆** | `workspace_memories` 表；runtime 装记忆层；`memory` 工具进云工具表；设置页能看能编 | agent 攒手感，共享档存口径 |
| **5 互相 @** | `agent_relay` 事件；周期护栏 + 棒数上限；到顶向人汇报。**含 AGENTS.md 边界变更 + ADR + PR 评论批准** | 接力协同 |
| **6 管理员生成 agent** | `create_agent` 工具过审批门（同 ADR-0118 的 `mcp_configure`），只有管理员那只有 | 说一句话生出一只 agent |

**顺序：1a → 1b → 2 → 3 → 5 → 4 → 6。**

> 2 与 3 同一条 lane 一起落地（ADR-0221，2026-09-05）；`usage_event.agent_id` 的 migration 编号实际是 0022（切片 4 的记忆表顺延为 0023）。

> 切片 4 与 5 同一条 lane 分两个 PR 落地（ADR-0222 / 0223，2026-09-05）；记忆表 migration 实际编号 0023，接力上限那列 0024。

> 切片 6 单 PR 落地（ADR-0224，2026-09-05）：不加 migration、不新增事件类型；`create_agent` 只挂管理员那台 engine，审批卡逐字段提示词全文。

3 排在 5 前面不是随手排的：**先有那张用量表，再打开 agent 互相 @**。接力链失控时
要能一眼看出是哪只在烧——反过来的话，第一次失控只看得到 owner 的周额度掉了一大块，
查不出是谁。

1 劈成 1a/1b 是**PR 边界不是发布边界**：1a 单独合进 main 不改变任何用户可见行为
（`mentions` 缺席走老语义，`agentId` 缺席走单 agent），1b 才点亮。

## 11. 天花板与已知代价（接受）

- **串行接力慢。** @ 了两只 agent 会排队跑完。事件 schema 没为并行留字段，但
  `agent_relay` 已经带 `depth` 与两端 id，将来改并行时日志格式不用改。
- **共享记忆档会分叉的那一半没修完。** §6.2 的写入者前缀让矛盾**看得见**，
  不让它**不发生**。真正的对账（两条矛盾事实自动打架）不在本 spec。
- **每会话成本口径仍不含本机子智能体。**（ADR-0047 的既有代价，本 spec 不碰。）
- **@ 名字改了之后，历史日志里那条 `agent_relay` 指向的还是 `agent_id`。** 时间线
  渲染要现查名单换成当前名字；agent 被删之后那条线只剩 id。接受——同 ADR-0047
  对「史前会话退回 sessionId」的同一条取舍。
- **型号白名单不挡越权。** 白名单跑在 runtime 里（我们自己的代码），不是 RLS 那种
  真闸。它防的是「配错了」，不防「有人改了客户端」——但云会话的模型调用一律经我们
  的网关，真正的闸在那儿。

## 12. 推翻它的前提

- **若「一只 agent 看不见别人的工具输出」被证明太窄**——用户反复要求「让广告直接读
  运营刚跑出来的表」——那么决策 2 该退回带一把 `read_transcript(agent, since)` 工具
  的形态（设计对话里的第三个选项），而不是直接改成全见。
- **若串行队列成为主要抱怨**（@ 三只要等三倍时间），并行是下一步，且日志格式已经
  为它留好了。届时要重新想的是并发审批卡与中断传播，不是事件 schema。
- **若用户开始成规模地把同一批连接器工具抄进十几只 agent**——那说明「逐个工具点名」
  的粒度太细，该谈的是可复用的工具组，而不是继续抄名字。（这条与 ADR-0054 的
  「推翻它的前提」是同一条，工作区场景把它的到来提前了。）
- **若「两套 agent 定义」（本机子智能体 / 工作区 agent）被证明是用户心智负担**——
  合并的正确起点是把 `SubagentDef` 里的磁盘概念先剥出去，而不是给 `workspace_agents`
  加 `path` 之类的字段。
