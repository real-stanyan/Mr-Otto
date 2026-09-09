# ADR-0267：云会话输入框右下角的上下文用量环——按 agent 视野算，环画最吃紧那只，额度那半只给 owner

- 状态：已接受
- 日期：2026-09-09
- 关联：#1138 / #985（云会话输入框换成本地同款时刻意少掉的三样，本篇拿回一样）/ ADR-0219（agentView：每只 agent 各自的视野，本篇的视野判据直接复用它）/ ADR-0233（云会话统一走 owner 的订阅额度——额度那半为什么只给 owner）/ ADR-0209 & ADR-0254（上下文浮层那张卡；`bindingWindow`「吃紧的那扇」的取法）/ ADR-0246（团队默认型号与真跑那款可以不是同一款）/ #193（窗口未知不画环）

## 背景

维护者：「团队会话input框右下角也要显示context window」。

#985 把云会话输入框换成本地同款 `ComposerBar` 时，本地偏好栏上那三样（型号 / thinking / 用量环）一起被判成「团队的属性不是这条会话的」而没有搬。前两样确实是（ADR-0202 / 0233：云会话的型号由 runtime 按 agent 白名单 / Auto 现取，桌面上摆一个选择器点了不生效）；用量环不是——上下文是这条会话里每只 agent 各自的事实，日志里就推得出来，本地那枚环读的就是同一份 `contextBreakdown`。当年把它一并划进去是分类错了，不是取舍。

## 诊断：云会话与本地会话在「上下文是谁的」上不同

本地会话一条日志一只 agent，`contextBreakdown(events, toolDefs)` 直接就是答案。云会话是群聊（ADR-0219），三件事都不一样：

1. **视野按 agent 分**。runtime 给每只 agent 一台 engine，读的是 `agentView(store, agentId)` 变换过的日志——别人的 tool_result 丢掉、别人的 assistant_message 剥成只剩说出口的那半、别人的 context_compacted 不认。整份日志当一只算的话，`billingAnchor` 取的是最后一条带 usage 的 assistant_message：A 刚报了 50K 的账，B 回一句 8K 的话，环从 40% 掉到 6%，而谁都没压缩。
2. **工具表桌面没有**。本地那枚环的 tools 是主进程报的 `toolDefs`；云会话的工具挂在 VPS 上。日志里唯一的快照是 engine 落的 `request_envelope`（全量 tools，带 agentId）。
3. **窗口不是一个**。每只 agent 各有型号白名单 / Auto，`welcome.modelRoute` 带回的只是团队默认款（ADR-0246 已点名两者可以不是同一款）。

## 决策

### 1. 每只 agent 一行，视野判据复用 agentView

`src/renderer/src/lib/cloudContext.ts` 的 `cloudContextRows(events, fallbackModel)`：露过面的 agent（发过 `request_envelope` 或回过 `assistant_message`）各一行——

- 视野 = `projectForAgent(events, agentId)`，与 runtime 同一个函数，不另写一份判据；
- 工具表 = 这只**自己**最后一条信封的 `tools`；
- 型号 = 这只自己最后一次真跑的（信封 / 回复的 `model`，事实不是配置）；一次都没跑过时退回团队默认款；
- 窗口 = 目录 `findModel(model).contextWindow`，`contextWindowKnown` 为假一律 null（同 daemon 的 `contextWindowOf` 判据；#193：按假分母报百分比比不报更糟）。

一只都没露面时整份日志当一行（多智能体上线前的旧云会话，或还没人开过口），型号退回团队默认款——于是第一轮还没跑完时环就画得出来。就位了却没跑过的 agent（`agent_briefed`）不占一行：没有上下文可言。

倒着扫最后一次请求时**按 agentId 过滤**：`projectForAgent` 会把别人说出口的那半留在我的视野里（剥掉 usage，但 model 与 agentId 还在），不过滤就会拿别人的型号当我的窗口。

### 2. 环画最吃紧那只，浮层逐只列

`bindingContextRow`：窗口已知的里面已用占比最高的；并列取先露面的；一只都没有已知窗口 = 整枚不画。同 `PlanQuotaSection` 的 `bindingWindow`——两扇窗谁先拦住人谁就是主，这里是几只 agent 谁先撞墙。

浮层（`CloudContextRing.tsx` 的 `CloudCtxDetails`）：群里不止一只时逐只列一行（名字 · 百分比 · 已用 / 窗口），色档与环共用 `context-display` 的 75 / 90 两道（为此多导一个 `usageSeverity`——阈值只能有一份），最吃紧那只用前景色，段头写清画的是谁的（`「运营」的上下文`）；只有一只时不列名单，段头就是「会话上下文」。窗口未知的那一行说出原因：「窗口未知（xxx 不在目录里）」与「还没跑过」该做的事不一样，前者是目录欠一行。

### 3. 额度那半只给 owner

告警点（`ContextRingTrigger` 右上角，ADR-0255）与套餐额度两只表（`PlanQuotaSection`）读的都是 `store.billing`——**我的**订阅；云会话烧的是 owner 的额度（ADR-0233）。`quotaApplies = cs.ownerUid === selfUid`：不是 owner 时两样都不画，钮的名字也不多一个字。判据是稳定键，不从「谁建的会话」推。`ContextRingTrigger` 为此多了 `quotaApplies` 一个可选 prop，缺省 true，本地那处调用一字不改。

### 4. 钱那段永远不画

云会话没有 direct 这一档（ADR-0233），`showsCost` 那道分叉在这里只可能说假话（旧 runtime 落的 `context_compacted` 缺 `route` 会被判成 direct，#1091 那一族）。脚注「调了哪几款 · 多少 token」照画，**按整条会话算**不按最吃紧那只的视野——它答的是「这条会话调过谁」，不是「这只 agent 看见了谁」。

### 5. 卡的中段抽成共用组件

`CtxBreakdownSection.tsx`（壳 `CtxCard` + hero / 分段条 / 图例）从 App.tsx 的 `CtxDetails` 抽出，本地与云会话两张卡共用；上下两段（套餐额度 / 钱或脚注）归各自的调用方，本地那张卡与云那张差的正是那两段。两处各画一遍的话，段宽算法、图例排序、零值行的处置迟早分家。

### 6. 位置

发送键左边，`ComposerActions` 里——本地那枚就在发送键左边的右簇里。判据是 #985 那句「和本地一个样」。

## 否决的候选

- **整份日志当一只算、窗口取团队默认款**：最省事，但诊断 1 那个跳变是必然的（两只 agent 一来一回就会发生），且窗口对不上真跑的那款。
- **每只 agent 各画一枚环**：一行输入框放不下，且「有几只」是变量。
- **额度那半按「有订阅就画」**：对非 owner 的成员报一份与这条会话无关的额度，同 ADR-0217 对 `unknown` 的纪律——宁可少画。
- **改协议让 runtime 下发每只 agent 的窗口 / 用量**：桌面从日志 + 目录就推得出来（runtime 自己算压缩阈值也是同一条路：`contextUsed(agentView) / contextWindowOf(model)`），加字段是第二份事实。

## 代价 / 已知未做

1. **第一笔账单之前是估算**：`contextBreakdown` 的 system 估算按本地提示词文案算，云会话的 system 多出几段（容器 / 群聊 / agent 就位）没算进去；误差在这只 agent 第一次回话后消失。估算 ±30% 本来就是那个文件头承认的。
2. **目录不认识的型号整只不画、不比**：网关新供一款目录还没跟上时，那只 agent 在浮层里写「窗口未知」，环由别的 agent 决定；全群都用它时整枚环消失。目录欠一行的信号就是那句话。
3. **每只 agent 一次全量投影**：memo 在 `[events, fallbackModel]` 上，流式碎片（`cloudStreaming`）不触发重算；群很大、日志很长时每来一条事件多扫几遍。
4. **Auto 那次分类调用不在账上**：它不落 `request_envelope` 也不落 `assistant_message`（同 ADR-0238 的已知漏项）；接力 / Auto 挑出来的型号本身走的是同一条信封，所以窗口照常正确。
5. **真机一次都没跑过**：只有 jsdom 下的组件测试（含 Radix Tooltip 聚焦即开那条）。
