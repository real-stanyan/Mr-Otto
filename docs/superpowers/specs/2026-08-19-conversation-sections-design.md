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
复用 `createOpenAICompatibleAdapter`，非流式、不带工具。**不做 429 重试**——
vision-bridge 必须重试是因为它失败等于 turn 失败；分类员失败无害且自愈（见下），
再挂一套退避是白加复杂度。

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
  /** 本分区第一条事件的 seq——点击跳转的锚点，也是滚动定位的唯一依据 */
  startSeq: number;
}

export function deriveSections(events: SessionEvent[]): Section[];
```

刻意没有 `endSeq`：分区的结束 = 下一个分区的开始，推得出；而 UI 只用 `startSeq`
（锚点 + scrollspy）。推得出的不落进接口。

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

## UI：正文左侧的刻度堆

**文件** `src/renderer/src/components/SectionRail.tsx`。三版形态，每一版都是被上一版
的毛病逼出来的：

| 版本 | 形态 | 为什么被推翻 |
|---|---|---|
| ① | 常驻 184px 竖栏（改自 react-bits `LineSidebar`，MIT） | 等距刻度在撒谎（分区长短差好几倍）；目录离它索引的内容几百像素远；偶尔用一次的东西占了一条常驻长条 |
| ② | 右缘浮层，刻度按滚动比例定位 | 映射诚实了，但玻璃面板大得离谱（两行字撑满一整屏高的玻璃）、贴着滚动条、每条标题一枚常驻胶囊仍是一片长期占着视线的文字 |
| ③ | 同样的刻度堆，但用**刻度宽度编码分区体量** | 长度同时背了两件事（数据 + 反馈），而且要一条 36px 的动态范围，正文得为此永久让出一条留白 |
| ④ | **正文左内边距里的一小撮等长刻度堆；长度归交互，颜色归位置** | —— |

### 现在的形态

一小撮**紧凑等距、且长度一律相同**的短横线，浮在正文左内边距里，整簇垂直居中，
**随视口固定，不跟着内容滚**（轨挂在滚动元素外面的 `relative` 上，`absolute` 定位，
占 0 布局宽度）。默认状态下**屏幕上一个字都没有**，也没有任何长短之分——
只有当前分区那条是蓝的。
悬停某条刻度 → 紧挨它右侧弹出一张卡片：标题 + 正文预览（三行截断）。

`lg:` 断点门与「分区数 ≥ 2 才渲染」两道门都保留。

### 长度归交互，位置归颜色

②的按比例定位是诚实的，但它要求刻度沿整条滚动区散开——这跟"紧凑成簇"直接冲突。
③试过把丢掉的位置映射换成**体量映射**（刻度宽度 ∝ 分区事件数），也撤掉了，两条理由：

- **长度不能同时背两件事**。既要它编码数据，又要它做"你正指着这条"的反馈，
  两个语义抢同一个视觉通道，谁也说不清。
- **代价不成比例**。体量编码要一条 12–36px 的动态范围才有分辨力，而消息列本来只有
  `px-5` 那 20px 的左内边距——为一个导航件让整列正文永久右移 28px，这笔账不划算。

**现在三条规则，各管一件事，互不越界：**

1. **所有刻度默认等长**（10px），宽度不编码任何数据。
2. **只有被 hover 的那一条变长**（`scaleX(2.8)` → 28px，origin 在左端，往正文那边探）。
   长度 = 交互反馈，不是数据。
3. **当前所在分区那条是 `--brand`**。"我在哪"完全由颜色回答，跟长度无关。

两条规则正交，所以：hover 当前分区那条 → 又蓝又长；hover 别的 → 那条变长但保持中性色，
蓝色仍留在当前分区那条上（CSS 里 `[data-active]` 排在 `[data-hovered]` 之后，
同 specificity 源序靠后者赢）。

伸长要跟手：指针驱动的即时反馈，140ms 强 ease-out（`--ease-strong`）。
用 `scaleX` 不用 `width`——不碰布局。

### deriveSections 只多给一样东西

- **`preview`** —— 本分区第一条 `user_message` 的正文，空白压平、截断到 120 字；
  整段没人说话就是空串（不拿模型输出冒充用户的话）。
  分区开头无人说话时，用延续段的第一句补上。
  它是**投影**（同样的日志推得出同样的预览），住在 `deriveSections` 里比住在组件里对；
  而且它要扫整段事件才拿得到，`Section` 自己推不出来。

`endSeq` 依旧不加。③曾经为宽度编码加过一个 `eventCount`，随着宽度编码撤销一并删掉
（连同它的测试）——**推得出的、没人消费的，都不进接口**，加它的唯一理由已经消失。

### 常驻部分住得进现成的内边距

Mr Otto 的消息列本来没有左侧留白：模型回复无框、`self-stretch` 占满行宽，
左边只有 `px-5` 那 20px。刻度堆的**常驻**部分（左偏移 6 + 基础长 10 = 16px）
正好住得进去，命中带也按 20px 收齐，**一格都不越到正文上**。
③为了体量编码加过的 `pl-5 lg:pl-12` 因此撤掉，正文的左右内边距回到对称的 `px-5`。

hover 时伸到 34px 会探出内边距一点点——**允许**：它是瞬时的，不常驻，
不会长期压住任何字。常驻的东西一寸都不该占正文的地方，瞬时的可以借一点。

### 交互

- **悬停**（只认 `pointerType === "mouse"`——触屏点一下会派发 `pointerenter` 却没有
  配对的 `leave`，卡片会永久卡在屏幕上）→ 卡片出现在刻度右侧，
  `transform-origin` 钉在**那条刻度**上（不是卡片中心），materialize 进场。移开消失。
- 卡片本身 `pointer-events: none`：它是预览不是控件，指针滑到它上面应该照样收回去。
- **点击** → `[data-section]` 锚点 `scrollIntoView`，逻辑没变。
- **当前所在分区**那条刻度用 `--brand`（见上，颜色是"我在哪"的唯一答案）。
  刻度是 2px 的图形，纯主色没有对比度问题；
  卡片标题混主色时只混到 65%（深色主题下 `--brand` 压在玻璃底上只有约 3:1，
  12px 的字读不动）。
- **换区瞬时提示砍掉了**：紧凑刻度堆本身已经很轻，再加一层会跟悬停卡片抢同一件事。
- **临近效果（rAF 指数平滑）也删掉了**：12px 行距上做"指针附近变亮"只会让邻居一起糊，
  而离散的悬停卡片本来就把"你指的是哪一条"说得很清楚。颜色交给 150ms 的 CSS 过渡，
  组件里因此一个 rAF、一个计时器都不剩。

### 边界情况

- **卡片被视口切掉**：卡片上沿是 `clamp(8px, 锚在刻度上, calc(100% - 卡片高上界 - 8px))`，
  纯 CSS，不测量。
- **分区多到撑破视口**：刻度堆高度是 `min(n × 12px, 70%)` —— 分区一多就按比例压扁，
  而不是让头尾几条滑出屏幕外。等距关系不变，只是行距变密。
- **卡片的 `top` 刻意不进 transition**：刻度只隔 12px，让卡片花 200ms 滑过去，
  指针扫过几条时它就一直落在后面。悬停反馈要跟手，所以瞬时重定位。
  （不是能力问题：实测 Chromium 在两个带百分比的 `clamp()` 之间插值正常。）

### 动效与材质

- **材质到场，不是图片淡入**：模糊半径、缩放、位移和透明度一起走。
  自定义属性必须 `@property` 注册，否则过渡是离散的（中点硬跳）。
- 位移/缩放走注册过的 `--card-x` / `--card-scale`，不直接给 `transform` 挂 transition。
- 进退同一条路径：往左收回去的，从左边长回来。缓动一律 `--ease-strong`，不过冲。
- 卡片常驻挂载（第一次悬停之后），靠 `data-visible` 进退 + `@starting-style` 进场——
  两端同一条路径，**一个离场计时器都不需要**。
- 材质：`saturate(0.85)`（压住背景，不是让它更艳）、底色自带 88% 不透明度
  （对比度不能指望模糊提供）、`blur(10px)`。预览文字用 `--foreground` 的 72%，
  比 `--muted-foreground`（56%）实一档——它压在正文上。

### 无障碍

- **`prefers-reduced-motion: reduce`**：`--card-x` / `--card-scale` / `--glass-blur` 直接给
  终值，`transition-property` 收窄到只剩 `opacity` —— 交叉淡入淡出，无位移无模糊过场。
  跳转的 `scrollIntoView` 仍按偏好切 `auto`。
- **`prefers-reduced-transparency: reduce`**：卡片底色提到 `var(--card)` 实心，
  `backdrop-filter: none`。
- 保留 `<nav aria-label="会话分区">` 地标和当前项 `aria-current`。
  每条刻度里挂一个 `sr-only` 的标题——屏幕上只有横线，读屏器上不能全是没名字的刻度。
- **键盘导航不在这一版**（issue #112 单独跟）。

**当前分区判定**：滚动容器上挂 IntersectionObserver 当廉价触发器，
回调里一次性读那几个锚点的 rect（判定线 = 容器顶部往下 15%）。
不用 scroll 事件轮询 `getBoundingClientRect`——那是每帧一次强制重排。

## 测试（`tests/` 镜像 `src/`）

- `tests/session/deriveSections.test.ts`：空日志 / 单分区 / 多分区 /
  未分类尾巴 / `title: null` 只延续不开区 / startSeq 落在分类事件之后那条；
  外加 `preview`（取第一条 user_message、空白压平、超长截断、整段无人说话 = 空串、
  空白正文不算说话、开头无人说话时用延续段补）。
- `tests/session/deriveMessages.test.ts` 补一条：日志里有 `section_classified` 时，
  投影**逐字节等于**没有它时的投影（不喂回模型这条硬约束的回归锁）。
- `tests/main/sectionClassifier.test.ts`：JSON 解析的好/坏形状（含 ```json 围栏）；
  网络/HTTP 失败时**返回 null 不抛**（turn 不受影响）；
  「当前还没有分区」时模型回延续 → 当作失败，不落事件。
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
