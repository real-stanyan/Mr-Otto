# assistant-ui 迁移设计

日期：2026-08-19
状态：已确认；PR1 实施计划见 `docs/superpowers/plans/2026-08-19-assistant-ui-pr1-render-layer.md`

实测依据：`@assistant-ui/react@0.15.15` / `@assistant-ui/core` 的 `.d.ts`（本文所有类型均照抄自它，非推测）

## 1. 目标

把 Mr Otto 会话区的渲染层迁移到 [assistant-ui](https://www.assistant-ui.com)，一次到位覆盖 12 项能力：
thread、attachment、context-display、directive-text、composer-trigger-popover、file、
follow-up-suggestions、model-selector、sources、streamdown、syntax-highlighting、reasoning。

**视觉归属已定**：保留 Mr Otto 现有观感（ADR-0011 theme tokens），只换底层 primitives。
assistant-ui registry 装出来的组件，Tailwind 类名一律改写成本仓主题变量。

**非目标**：
- 不统一 headless 库（radix 保留，见 §4.2）
- 不改事件日志的写入路径（onNew/onCancel/onReload 全部回原路）
- 不做消息编辑 / 对话分支（本仓没有这两个功能，不凭空长出来）

## 2. 架构接缝：ExternalStoreRuntime

assistant-ui 是完整框架，`Thread` 必须包在 `AssistantRuntimeProvider` 里，runtime 持有消息流。
本仓硬规则是「append-only 事件日志是唯一事实来源」。两者的调和点是
[`useExternalStoreRuntime`](https://www.assistant-ui.com/docs/runtimes/custom/external-store)：
状态归本仓所有，adapter 只做格式翻译。

新增 `src/renderer/src/aui/`：

| 文件 | 职责 |
|---|---|
| `toThreadMessages.ts` | 纯函数：`SessionEvent[]` → `ThreadMessageLike[]`。事件日志的投影，不持状态 |
| `useOttoRuntime.ts` | 读 Zustand store，组 `ExternalStoreAdapter`，返回 runtime |
| `AuiProvider.tsx` | `AssistantRuntimeProvider` 壳，包住会话区 |

`toThreadMessages` 与 `src/session/deriveMessages.ts`（喂模型的投影）同级同性质：
都是从日志推导的只读投影，一个喂模型，一个喂 UI。硬规则「任何投影必须可从日志推导」满足。

### 2.1 adapter 字段取舍

| 字段 | 取值 | 理由 |
|---|---|---|
| `messages` | `toThreadMessages(events)` 的结果 | 事件流是多对一映射到消息，不是逐条转换 |
| `convertMessage` | 恒等函数 `(m) => m` | 类型上必填：`ExternalStoreAdapter<T>` 定义为 `T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>`，`T = ThreadMessageLike` 不满足前者。上一行已产出目标格式，所以是恒等 |
| `isRunning` | store 的流式标志 | |
| `onNew` | 现有 ShellBridge 发消息路径 | 写入方向不变 |
| `onCancel` | 现有中断（ADR-0006） | |
| `onReload` | 现有 RetryButton | |
| `onEdit` | **不提供** | 本仓无消息编辑；提供即凭空长出绕过日志的写路径 |
| `setMessages` | **不提供** | 本仓无对话分支；同上 |

### 2.2 流式

不采用官方文档里 `setMessages` 逐块 mutate 的写法。本仓 store 已在累积 assistant delta，
`toThreadMessages` 每次吃当前快照即可。渲染由 Zustand 订阅驱动，与现状一致。

### 2.3 消息部件映射

| 事件 / 字段 | ThreadMessage part | 渲染 override |
|---|---|---|
| `user_message.content` | `text` | `DirectiveText`（skill/指令渲染成 chip） |
| `user_message.attachments` / `textFiles` | `attachment` | |
| `assistant_message.content` | `text` | `streamdown` + Shiki |
| `assistant_message.reasoning` + `reasoningMs` | `reasoning` | 现有耗时展示搬进 override（ADR-0032） |
| `assistant_message.toolCalls` + `tool_result` | `tool-call` | 现有 `ToolGroup.tsx` + 审批门搬进 `ToolGroup` override |
| `context_compacted` | 分隔标记 | 现有渲染 |
| `image_described` | 注入进相邻 user 消息 | 同 `deriveMessages` 手法 |

## 3. 组件逐项处置

| assistant-ui 组件 | 本仓现状 | 处置 |
|---|---|---|
| `thread` | `App.tsx` 会话区 + `ThreadViewport.tsx` | 换 primitives，样式改本仓 token |
| `attachment` | `AttachDropZone` / `StagedChips` / `UserAttachments` | 换壳，`AttachmentAdapter` 接现有附件库（ADR-0009） |
| `context-display` | `shared/contextEstimate.ts` 圆环 | 组件收外部 `usage` prop，现有估算直接喂进去 |
| `directive-text` | 无 | 新增 |
| `composer-trigger-popover` | `App.tsx:1917` 手写 slash/$ 菜单 | 换掉，slash + skill 注册表复用 |
| `file` | 无 | 新增，见 §5.1 |
| `follow-up-suggestions` | 无 | 新增，见 §5.3 |
| `model-selector` | `ModelPicker.tsx` | 换壳，`modelCatalog` + `model_changed` 事件不动 |
| `sources` | 无组件，有 `web_search` 工具 | 新增，见 §5.2 |
| `streamdown` | react-markdown + remark-gfm | 替换，卸载旧依赖 |
| `syntax-highlighting` | `CodeBlock.tsx` + highlight.js | 替换（Shiki），清 `app.css` 里 hljs 段 |
| `reasoning` | 有 `reasoning` / `reasoningMs` | 换壳 |

## 4. 已知代价

### 4.1 装法

registry 是 copy-in 源码（`npx shadcn@latest add @assistant-ui/xxx`），不是版本化依赖。
源码进仓、进 diff 审查。升级是主动动作，不是 `npm update` 的副作用。

`components.json` 现有配置（style new-york、css 指向 `src/renderer/src/app.css`、
alias `@/components`）与 registry 兼容，无需改动。

### 4.2 base-ui 与 radix 并存

assistant-ui 组件依赖 `@base-ui/react`，本仓存量 sidebar/dialog/select 是 `radix-ui`。
不强行统一 —— 那是独立的一次重构，不该塞进本次迁移。代价是 bundle 变大。
这条写成 ADR，避免后来者误以为是疏忽。

### 4.3 覆盖风险

`shadcn add` 会尝试覆盖 `ui/button.tsx`、`ui/tooltip.tsx`、`ui/collapsible.tsx`。
前两个本仓已定制。装完逐个 `git diff` 人工审，不接受盲覆盖。

## 5. 三个新能力的数据源

### 5.1 file

不改工具。投影源 = `tool_call.args`（`write_file` 的 `path` / `content`）+ 配对
`tool_result.status`。事件日志里全有，纯投影。

### 5.2 sources

投影源 = `web_search` / `web_extract` 的 `tool_result.output`。

限制：`tools/anysearch.ts` 只把云端返回的 text 段 join 起来，**本仓保证不了输出格式**。
因此解析器写成宽松提取（markdown 链接、裸 URL、前置标题行），
**提不到就整条不渲染 sources**。降级安全，不猜不装。

### 5.3 follow-up-suggestions

唯一要动事件 schema 的一项。

产出方式：`turn_ended` 且 `outcome === "completed"` 后，拿最近几轮对话额外调一次便宜模型，
要求返回 3 条 JSON 建议。异步，不阻 UI，失败静默（无建议不是故障）。
模型档位跟随当前 provider 的最便宜档，可配。

新事件：

```ts
/** 额外 10：跟进建议。turn 收口后额外一次模型调用的产物——
    模型产出的新信息，日志推不出 → 必须落盘。但它不进模型上下文
    （投影丢弃，同 reasoning 的 logged ≠ model-visible）。 */
export interface SuggestionsGeneratedEvent extends SessionEventBase {
  type: "suggestions_generated";
  suggestions: string[];  // 3 条
  model: string;          // 出自哪个模型（溯源）
  usage?: TokenUsage;     // 这次小调用烧的 token，进消耗统计
}
```

union 加宽 + `deriveMessages` 丢弃 = 向后兼容硬规则满足（旧日志无此事件，照常重放）。

## 6. 分期

三个 PR，顺序不可反：PR1 立住 runtime，后两个才有地方挂。每个 PR 自带绿门禁、可独立回滚。

| PR | 内容 |
|---|---|
| **1 · 输出侧** | §2 三个文件 + `thread` + `streamdown` + `syntax-highlighting` + `reasoning`；卸 react-markdown / highlight.js，清 `app.css` 里 hljs 段 |
| **2 · 输入侧** | `composer` + `attachment` + `directive-text` + `composer-trigger-popover` + `model-selector` + `context-display`；`App.tsx` 两个 composer（会话内 ~1900、新会话 ~1731）一起换 |
| **3 · 新能力** | `sources` + `file` + `follow-up-suggestions` + 新事件 |

PR1 中间态必须可运行：只挂 runtime + 换渲染，composer 原样留到 PR2。

## 7. ADR

| 编号 | 主题 | 随哪个 PR |
|---|---|---|
| ADR-0034 | assistant-ui 走 ExternalStoreRuntime —— 投影，不是第二个事实来源 | PR1 |
| ADR-0035 | base-ui 与 radix 并存是刻意的 | PR1 |
| ADR-0036 | 跟进建议是独立一次调用，logged 但不 model-visible | PR3 |

编号在开 PR 前重新确认（`docs/adr/` 已到 0033，且历史上出现过重号）。

## 8. 测试

按本仓惯例：`tests/` 全是纯函数测试，不渲染 React。

| 文件 | 覆盖 |
|---|---|
| `tests/renderer/toThreadMessages.test.ts` | 主战场。纯工具调用（content 空串）、悬空 tool_call（ADR-0005）、被拒工具、compact 断层、`image_described` 注入、`reasoning` 有无、中断态 |
| `tests/renderer/parseSources.test.ts` | 提不到 URL 必须返回空数组，不许猜 |
| `tests/session/events.test.ts`（扩） | 新事件的向后兼容重放 |

视觉验收不进门禁，走 issue #123 的欠账总账。

门禁不变：`npm test`。
