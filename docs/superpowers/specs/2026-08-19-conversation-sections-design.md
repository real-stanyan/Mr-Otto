# 会话分区总结 + 侧边跳转条（Conversation Sections）

日期：2026-08-19
状态：设计已定，待实现

## 一句话

长会话里，模型每个 turn 结束后判断「这一段还属于当前话题，还是开了个新话题」，
开新话题时给一个短标题；右侧一条竖轨把这些分区排成目录，点一下滚到那一段。

## 为什么

会话一长，滚动条就是唯一的导航手段——用户记得「刚才聊过 xx」，但找不回那一段。
目录必须由模型来分，因为分界线是语义的（话题变了），不是结构的（turn 边界到处都是，
一个话题常常跨好几个 turn）。

## 硬约束（AGENTS.md）

- 分区标题**出自模型**，日志里任何事件都推不出它 → **必须落盘成事件**。
  同 `reasoning` / `image_described` / `context_compacted` 的先例。
- 分区标题**不喂回模型** → 投影（`deriveMessages`）必须丢弃它。
  logged ≠ model-visible，`AssistantMessageEvent.reasoning` 已经是这个形状。
- schema 只加不改：新增事件类型 = union 加宽，旧日志照常重放。
- 渲染进程只经 `ShellBridge`，不碰 Node。分区数据走既有的事件推送通道，不开新 IPC。

## 事件

`src/session/events.ts` 新增：

```ts
/** 额外 10：分区分类（会话目录）。每个 turn 收口后跑一次便宜模型：
    这一段是延续当前分区，还是开了新分区。标题出自模型、日志推不出 → 必须落盘；
    但它是给人看的目录，不喂回模型 → 投影必须丢弃（同 reasoning：logged ≠ model-visible）。
    title 非空 = 从本条 seq 起进入新分区；null = 延续上一分区。
    延续那次也落一条（而不是只在开新区时落）：每次模型调用的 usage 都要有账，
    否则 token 统计从此少算一截（TokenUsage 注释：消耗统计必须可从日志求和推导）。 */
export interface SectionClassifiedEvent extends SessionEventBase {
  type: "section_classified";
  /** 非空 = 新分区标题（建议 ≤ 12 字）；null = 延续上一分区 */
  title: string | null;
  model: string;                 // 分类出自哪个模型（溯源）
  usage?: TokenUsage;            // 本次分类烧的 token
}
```

加进 `SessionEvent` union。

**为什么不是「只在开新区时落一条 `section_started`」**：那样更省，也更符合
「推得出的不落盘」；但延续那几次调用的 usage 会就地蒸发，token 统计开始说谎。
用几十字节换账单诚实，划算。

## 分区怎么跑

**位置**：`src/main/index.ts` 的 send handler，`await agent.engine.runTurn(...)` **之后**。
和 vision-bridge 严格对称——那个是 turn 前的代读员，这个是 turn 后的分类员，
都住在 engine 外面（engine 只管闭环，不认识这些外挂）。

**新文件** `src/main/sectionClassifier.ts`，抄 `visionBridge.ts` 的形状：
复用 `createOpenAICompatibleAdapter`，非流式、不带工具，429 走同一套退避。

```ts
export const SECTION_MODEL = "glm-4.5-flash";  // 目录里的免费款；换分类员改这一行
```

**输入**：从「日志里最后一条 `section_classified` 之后」到「日志末尾」的全部事件，
不是「本 turn 的事件」。两者通常相同，但分类失败时会拉开——见下面的失败处理。
喂给模型的是这段事件的紧凑摘要（user_message 正文 + assistant_message 正文截断 +
工具名列表），不是全文：分类只需要知道在聊什么，不需要读完 bash 输出。
再加上「当前分区标题」（日志里最后一个非空 title）作为对照。

**输出**：要求模型回 JSON `{"newSection": boolean, "title": string}`。
解析防御同 `parseTodoArgs`——形状不对就当作解析失败（见失败处理），不硬塞。

**什么时候跑**：`runTurn` 正常返回后（`completed` 和 `aborted` 都算）。
`error` 时 `runTurn` 抛异常 → 直接跳过，失败的 turn 不值得分区。

**失败处理**：分类失败（无 key / 限流耗尽 / JSON 烂 / 断网）**绝不让 turn 失败**——
它是事后的锦上添花，不像 vision-bridge 是模型能不能看见图的先决条件。
catch 住、不落事件、turn 照常成功。下一个 turn 的分类员会看到「上次之后的全部事件」
（因为输入锚点是最后一条 `section_classified`，不是 turn 边界），自动把漏掉的那段补进来。
自愈，不需要重试队列。

## 投影

**新文件** `src/session/deriveSections.ts`，纯函数，对标 `deriveTodos.ts`：

```ts
export interface Section {
  /** 分区标题（模型给的） */
  title: string;
  /** 本分区第一条事件的 seq——点击跳转的锚点 */
  startSeq: number;
  /** 本分区最后一条事件的 seq；最后一个分区 = 日志末尾 */
  endSeq: number;
}

export function deriveSections(events: SessionEvent[]): Section[];
```

规则：扫 `section_classified`，`title` 非空的每一条开一个新分区。
分区的 `startSeq` = **上一条 `section_classified` 之后的第一条事件**——
分区覆盖的是「被分类的那段对话」，不是分类事件自己所在的位置
（分类事件永远落在它所描述的那段的**末尾**，这是时间顺序决定的，不能改）。
第一个分区从日志第一条事件起算。还没被分类的尾巴不成区（不猜标题）。

`deriveMessages.ts` 的 switch 加一个 `case "section_classified":` 到已有的
「落盘但不投影」那组里（和 `turn_ended` / `approval_decision` 并列）。TS 穷尽检查会逼着加。

`App.tsx:99` 的 `totalTokens()` 加上 `section_classified`——这是选 A 方案的全部理由，
漏了这一行方案 A 就退化成方案 B 且多存了字节。

`EventRow`（App.tsx:803）加 `case "section_classified": return null`——
分区事件不进消息流。目录在轨上，不在正文里。

## UI：右侧竖轨

**新文件** `src/renderer/src/components/SectionRail.tsx`，
改自 react-bits `LineSidebar`（MIT，TS + Tailwind 版）。改动三处：

1. **`activeIndex` 改成受控 prop**。原组件的 active 是点击驱动的内部 state；
   我们要它跟着滚动位置走——用户手动滚到哪一段，轨上就亮哪一条。
2. **收起态**：轨宽固定 ~180px 不变，收起时**只有当前分区的标题可见**，
   其余分区只剩刻度线（`opacity: 0`，不是 `display: none`——保住布局）。
   指针进入轨区，全部标题淡入。
   **宽度全程不变** = hover 不引起消息栏重排。hover 时整栏抖一下是这类
   交互最常见的翻车方式，避开。
3. **`prefers-reduced-motion`**：关掉 proximity 的 rAF 位移/缩放，
   保留颜色状态（可读性不是动效）。原组件没做这个。

保留原组件的：单条 rAF 循环 + 帧率无关的指数平滑（颜色/位移/缩放同步移动，
不用一堆 CSS transition 各跑各的）、刻度线、序号。

**位置**：消息滚动区（App.tsx:2309 那个 `<section>`）右侧并排，
两者外面套一层 `flex`。轨不参与消息区的滚动，自己 `sticky`。

**什么时候出现**：分区数 ≥ 2 且窗口宽度够（`hidden lg:flex`）。
只有一个分区时目录没有意义，藏掉，把宽度还给对话。

**跳转**：`EventRow` 外层加 `data-seq={event.seq}`。
点击第 i 个分区 → 找 `[data-seq]` 里第一个 `seq >= section.startSeq` 的元素
→ `scrollIntoView({ block: "start", behavior: "smooth" })`。
`prefers-reduced-motion` 时 `behavior: "auto"`。

**当前分区判定**：滚动容器上挂 IntersectionObserver（`rootMargin` 顶部 -20%），
取当前视口顶部附近最靠上的 `data-seq`，二分落到它属于哪个分区。
不用 scroll 事件 + getBoundingClientRect 轮询——那是每帧一次强制重排。

## 测试（`tests/` 镜像 `src/`）

- `tests/session/deriveSections.test.ts`：空日志 / 单分区 / 多分区 /
  未分类尾巴 / `title: null` 只延续不开区 / startSeq 落在分类事件之后那条。
- `tests/session/deriveMessages.test.ts` 补一条：日志里有 `section_classified` 时，
  投影**逐字节等于**没有它时的投影（不喂回模型这条硬约束的回归锁）。
- `tests/main/sectionClassifier.test.ts`：JSON 解析的好/坏形状；
  429 重试后成功；彻底失败时**不抛**（turn 不受影响）。
- 组件层不写测试（项目现状：renderer 无组件测试，不在这个改动里开这个头）。

## 明确不做（YAGNI）

- **用户手动改名 / 合并 / 拆分分区**。要做的话得再加一个事件类型
  （同 `session_renamed` 的形状：手动改名是新信息，必须落盘）。等有人真的被
  烂标题烦到再说。
- **历史会话回填分区**。旧日志没有 `section_classified` 就是没有目录，不批量补跑。
- **分区可折叠**（点标题折叠该段消息）。目录先做成导航，不做成大纲编辑器。
- **分区标题进模型上下文**。它是给人的目录；真要给模型省 token 那是 `/compact` 的活。

## 需要的流程动作（AGENTS.md）

实现前：开一个 Task issue；写 `docs/adr/0031-会话分区事件.md`（下一个可用编号，合并前重新确认没被别的 lane 占用）
（架构决策：新事件类型 + 每 turn 一次额外模型调用 + 为什么是方案 A 不是方案 B）。
实现走分支 + PR，PR 引用该 issue，合并时关掉它。门禁 `npm test` 全绿。
