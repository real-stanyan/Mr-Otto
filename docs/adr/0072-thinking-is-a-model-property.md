# ADR-0072：thinking 是型号的属性，不是一个全局布尔

> 原为 ADR-0031。撞号改号（issue #230）：`docs/adr/` 下 0031 曾同时有两份，
> 本篇是较晚合并的那份。**2026-08-23 之前的 commit message 和已关闭的 issue
> 里仍写着 ADR-0031**——那些改不动，靠这一行认领。留在 0031 的那份是
> 「终端挂在 ExecutionWorld 上」（`0031-terminal-rides-the-world-seam-and-stays-out-of-the-log.md`）。

日期：2026-08-19
状态：已采纳

## 背景

需求原话很短："切换模型时，thinking 的选项要同步选中模型的不同 thinking 可选模式。"

它撞到的是一个更早的假设：`ModelChoice.supportsThinking: boolean`。这个布尔隐含了两件事——
① 思考只有"开/关"两态；② 全行业用同一种写法把这个开关发给 API。两件事都不成立：

| 型号 | 可选档 | 请求体写法 |
|---|---|---|
| GLM / DeepSeek | 开 / 关 | `thinking: {type: "enabled"\|"disabled"}` |
| Gemini Flash / 本机 Ollama | 关 / 低 / 中 / 高 | `reasoning_effort` |
| GPT-5 / Gemini 2.5 Pro / Groq gpt-oss | 低 / 中 / 高（**关不掉**） | `reasoning_effort` |
| Qwen(DashScope) / 硅基流动 | 开 / 关 | `enable_thinking: bool` |
| OpenRouter | 关 / 低 / 中 / 高 | `reasoning: {effort} \| {enabled:false}` |
| Grok 4 / MiniMax M2 | 无（一直思考） | 没有请求级开关 |

旧实现给**所有** `supportsThinking` 的型号发同一个 `thinking:{type}`。对 GLM 是对的，
对其余各家要么被忽略（用户以为关了、账单说没关），要么直接 400。UI 那边同样写死两条
"开/关"，等于给出了型号并不存在的选择。

## 决策

挡位是**型号目录的一个字段**，不是一个全局偏好：

```ts
interface ThinkingSpec { wire: ThinkingWire; modes: ThinkingMode[]; default: ThinkingMode }
ModelChoice.thinking: ThinkingSpec   // 取代 supportsThinking: boolean
```

三条随之而来的规则：

1. **换型号要钳位**（`clampThinking`）。新型号的挡位表未必装得下手上那一档。
   按强度就近落地，而不是一律回默认——用户刚调好的"高"不该被悄悄改成"中"。
   一条硬规则：**只有本来就想关的人才会被给"关"**；否则"低"碰上 `{关, 高}`
   按纯距离会落到"关"，而用户明明要它思考。
2. **方言只翻译一次**（`openaiCompatible.thinkingBody`）。挡位→线上字段的映射只有这一处，
   翻错的后果是 400 或者静默按对方默认来。
3. **没有挡位的型号一个字段都不发**。"不确定人家认不认"时，宁可不发——
   陌生参数的代价是整条 turn 失败。

钳位在主进程和渲染层都会发生，但用的是**同一个纯函数**；主进程的结果是权威，
`switchModel` / `setThinking` 都把钳完的档回流给渲染层（两边各钳各的迟早分叉）。

## 本机 Ollama

Ollama 的挡位同样不写死，探测得来：`/api/show` 的 `capabilities` 里有没有 `"thinking"`。
方言经本机 0.32.14 实测：`/v1/chat/completions` 认 `reasoning_effort`，`"none"` 关、
`low/medium/high` 开；原生 API 那个 `think` 布尔在 `/v1` 上**不生效**（发了也照样思考）。
返回体里思考过程的字段名是 `reasoning` 而不是 `reasoning_content`——两个都收，
少收一个的后果是思考过程当场丢失。

顺带修掉一个同源的谎：渲染层算上下文占用一直只查目录，而目录对 Ollama 只有一份没出处的
兜底常量（32k）。实测 `qwen3:30b` 是 256k。`describeModelWith` 把探测结果叠在目录上，
主进程与渲染层共用这一个口径——同一个型号不该在两边显示成两种能力。

## 代价

- 各家方言中，只有 GLM（`glm-4.5-flash`）与本机 Ollama 是**实测**过的，其余依据公开文档。
  猜错的表现是某一家的挡位不生效或报错，改一行目录即可，不牵动其它家。
- Anthropic 一栏刻意留空（`THINKING_NONE`）：Claude 的扩展思考是原生 API 的
  `thinking.budget_tokens`，OpenAI 兼容层没有对应开关，手上也没有 key 可验。
  UI 上会显示"当前型号没有请求级 thinking 开关"——这比亮出一个点了没反应的开关诚实。

## 影响

- 事件日志不受影响：thinking 是运行时偏好，从来不落盘（旧日志照常重放）。
- `ShellBridge.setThinking` / `switchModel` 的返回值从 `void` 变成钳位后的档；
  这是渲染层与主进程之间的线上类型，不是 SessionEvent，不涉及向后兼容约束。
