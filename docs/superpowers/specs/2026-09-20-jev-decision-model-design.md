# 决策模型（Jev）经网关接入：五处分类器前置、LLM 兜底、分处三态开关

- 日期：2026-09-20
- 状态：三条关键决策已由维护者拍板（§3），整份 spec 待维护者过一遍，过了才写实现计划
- 起因：维护者问「最新的决策模型 jev 可以在 otto 里帮上什么忙」，看完五处对得上的地方之后说「对得上的地方全做」
- Task：#1281
- 关联：ADR-0237 / 0244（Auto）、ADR-0270 / 0275（派活）、ADR-0283（云会话标题）、ADR-0273 / 0277（语音断句）、ADR-0269 / 0143（记忆分档与点名守卫）、ADR-0257 / 0261 / 0271（网关加新 `kind` 的三次先例）、ADR-0248（订阅用户不带 key）、ADR-0258（服务端部署跟着发版走）、#1280（团队改单智能体为主，agent-A 的 lane）

---

## 1. 问题

Otto 里有五处在做同一件事：**拿一款便宜的聊天模型当分类器**——写一段「只回一个词」的提示词，再用正则去认它回了什么。

| 处 | 今天怎么判 | 今天怎么坏 |
|---|---|---|
| 派活 `services/runtime/src/dispatch.ts` | 名册编号 + 最近 8 句 → 回编号或 none → `parseDispatchReply` 抠数字 | 便宜档是推理模型（8 个 completion token 里 7 个是 reasoning），5 秒超时；「编号不在名单 / 认不出」各一条 `failed`；none 与 picked 之间没有可调的量，只能改提示词或加规则兜（ADR-0275） |
| Auto 判难度 `src/shared/autoModel.ts` | 回 `simple` / `hard` | 「拿不准算 hard」写在提示词里，是请求不是机制；接力链每棒判一次 |
| 云会话重命名 `services/runtime/src/sessionTitler.ts` | 每 5 句人话打一次 LLM，多数轮回 `KEEP` | 为了一个「不用改」的答案付一次完整调用 |
| 语音断句 `native/MrOttoSpeech` 的 `utteranceLooksFinished` | 句末标点 = 说完，≤3 字短答 = 说完 | 识别器在人换气时就补句号 → 700ms 收口 → 一句话切成几条（#1196 的同一族） |
| 记忆写入分档 `src/tools/memory.ts` | 模型自己挑 `target`，点名守卫只做子串匹配 | 项目事实落进全局档（ADR-0269：11 条里 7 条） |

Jev（TypeSafe AI，2026-09-15 发布）是为这个形状造的：不生成文字，收 `state` + 一组类型化问题，一次前向回**类型化答案 + 校准概率**。

## 2. 已核实的事实（来源写在每条后面，没验过的单列）

**线上格式**（TypeSafe 官方 API 文档 `docs.typesafe.ai/api`；OpenRouter 官方 SDK 文档 `Alpha.Decisions`；LiteLLM 透传文档里的 curl 与回包逐字段对上）：

```
请求  { "model": string, "state": string | object | array, "questions": { "<id>": Question } }
  noul   { "type":"noul",   "instructions": string, "criteria": { "true": string, "false": string } }
  choice { "type":"choice", "instructions": string, "criteria": { "<option>": string } }
  score  { "type":"score",  "instructions": string, "criteria": [ "<level 0>", "<level 1>", … ] }
回包  { "model": string, "answers": { "<id>": Answer }, "usage": { "input_tokens": n, "output_tokens": n } }
  noul   { "type":"noul",   "noul": 0..1 }                      —— 没有 confidence 一格
  choice { "type":"choice", "choice": string, "probabilities": {…}, "confidence": 0..1 }
  score  { "type":"score",  "score": number, "legend": {…}, "probabilities": {…}, "confidence": 0..1 }
```

- 同一请求里的问题**并行且互相独立**（一个答案不会成为另一个问题的上下文）；多选 = 多个 noul（官方 primitives 页的原话）。问题数只受 token 预算限制。
- 不支持流式。

**OpenRouter 这条路**（维护者选的，§3）：

- 端点 `POST https://openrouter.ai/api/alpha/decisions`，型号 `typesafe/jev-1.13`，OpenRouter 的 key。**2026-09-20 实测**：不带凭据打过去回 `401 {"error":{"message":"No cookie auth credentials found"}}`，而 `/api/v1/decisions` 回 404——路由真实存在，且确实在 `alpha` 底下。
- 与 TypeSafe 直连的三处差别（第三方逐字段 diff 过 OpenRouter 的 OpenAPI，与官方 SDK 文档一致）：① noul 的 `criteria` 一旦出现，`true` / `false` **两个都必填**；② 回包是超集（多 `id` / `provider` / `usage.cost`）；③ 上下文 32k（直连是 64k）。
- 错误码（官方 SDK 文档）：400 / 401 / 402 / 403 / 404 / 413 / 429 / 500 / 502 / 503 / 524 / 529。
- 价：$0.042 / 百万输入 token，输出免费 → `price_in_micro_per_m = 42000`（本仓 micro = 1e-6 美元，对过 0031 那行 `$60/M ↔ 60000000`）。

**没验过的**（本机没有 OpenRouter key，那把 key 只活在 Worker secret 里——所以第一次真调用只能发生在网关部署之后，§9）：

- 真实延迟（厂商自报 70–500ms，经 OpenRouter 再经 edge 各多一跳）
- **中文校准**：官方自认英语为主，别的语言「拿自己的数据验」。Otto 的输入几乎全是中文。这是整件事最大的未知数，§7 的影子模式就是为它设计的
- `alpha` 端点的稳定性：路径里写着 alpha，随时可能改

## 3. 维护者已拍板的三条

1. **访问路径：走 OpenRouter**（`OPENROUTER_API_KEY` 已在 Worker secret 里，不用排 TypeSafe 的 early access）。
2. **语音断句：渲染层扣住再合并**，不动 Swift、不触发 TCC 重授权。只治「切碎」，不治「没标点的整句白等 2.5s」。
3. **上线开关：分处开关，初始全关**。

## 4. 不变量

1. **判不出来一律回落到今天的行为**（ADR-0237 的原话）。在这里是**两层**：Jev 没答案（超时 / 非 2xx / 形状不对 / 这一处没开）→ 走今天那条 LLM 路；LLM 路再失败 → 今天的 null / `failed`。五处没有任何一处会因为 Jev 不可用而比今天更差，除了一段有上限的等待（§8）。
2. **概率模型只许加严，不许放行**。审批、`gitSafety`、沙箱免审、`scanThreat`、周期护栏、接力上限、额度闸——一处都不接。Jev 读的也是不可信输入（用户的话、成员可写的名字与职责），它只回数字，所以被带偏的最坏结果是「这五处里某一个判断错了」，而这五处每一个判错的代价都是有界的（派给了名册里的另一只 / 这一轮多花点钱 / 标题晚改一轮 / 一句话多等 1.8 秒 / 一次记忆写入被劝一次）。
3. **订阅用户不带 key（ADR-0248）→ 只经 edge 网关**。不给 BYOK 用户加「TypeSafe」这一家 provider：Auto / 派活 / 重命名本来就只在托管路上存在，语音与记忆那两处没订阅就保持今天的样子。
4. **不改 SessionEvent schema，不进协议位**。诊断走日志行（§7），不落事件。
5. **`usage_event` 照常落**：一次用户看不见的模型调用不进账，那本账就不再是「钱的唯一事实」（ADR-0237）。

## 5. 架构

```
桌面 main ──(用户 JWT)──┐
                        ├─ POST {edge}/llm/v1/decision ── serveDecision ── POST openrouter.ai/api/alpha/decisions
runtime ──(x-runtime-secret + on-behalf-of 所有者)──┘            │
                                                                  └ hold / settle（Quota DO）+ usage_event
```

### 5.1 三端共用的纯层 `src/shared/decision.ts`

- 类型：`DecisionUse = "dispatch" | "auto" | "title" | "endpoint" | "memory"`；`DecisionMode = "shadow" | "on"`；三种问题与三种答案的线上类型；`DecisionRequest = { model, use, state, questions }`；`DecisionReply = { model, answers, inputTokens }`。
- `noul(instructions, yes, no)` / `choice(instructions, options)` 两个构造函数。**noul 的 `criteria` 两格都必填**——构造函数的签名就不给省略的机会，OpenRouter 那条差别由构造保证。`score` 只有线上类型，不给构造函数（五处一处都用不到）。
- `parseDecisionReply(payload, questions)`：**不信上游的「0% 类型错误」，自己验一遍**——问了的每一个 id 都要有答案、类型对得上、noul 在 [0,1]、choice 回的那一项必须是我们给过的选项。任何一处不对整份回 `null`（不挑着用）。
- `requestDecision(deps, req)`：`POST ${llmBase}/decision`，`AbortController` 超时，任何失败回 `null` 并 `deps.log` 一句原因。依赖全部注入（`llmBase` / `headers` / `fetchImpl?` / `timeoutMs` / `log?`），同 `autoModel.ts` 的形状。
- `withDecision({ use, mode, viaDecision, viaLegacy, show, log })`：五处共用的三态包装。决策那条路有三种结局——有答案（`{ value }`，`value` 可以是 `null`，例如重命名的 KEEP）/ 拿不准（`{ escalate: true }`）/ 没问出来（`null`）；后两种都落到 `viaLegacy`。`shadow` 时 `viaLegacy` 说了算且**不等** `viaDecision`，它回来之后记一行对照。
- `modeOf(me, use)`：`BillingMe` → `"off" | "shadow" | "on"`；`me` 为 null、没有 `decision` 一格、清单为空、这一处没列，全部回 `"off"`。

### 5.2 edge：`kind='decision'`

照 `serveTts` 的形状抄（ADR-0271），十一处：

1. `RouteKind` += `"decision"`；`upstreamPathFor("decision")` = `"/decisions"`（route 行的 `base_url` 是 `https://openrouter.ai/api/alpha`）。
2. 平台仍是 `openrouter`，`UPSTREAM_KEY_ENV` 里那一格已经有；顺手把 `OPENROUTER_API_KEY?: string` 补进 `worker.ts` 的 `Env`（0031 那次漏了，靠索引签名才没红）。
3. `services/edge/src/decisionUpstream.ts`（与 `ttsUpstream.ts` 并排）：`parseDecisionRequest`（校验 + 上限：问题 ≤ 64 个、id 匹配 `^[A-Za-z0-9_]{1,32}$`、choice 选项 ≤ 64、整个请求体 ≤ 96 KiB ≈ 32k token）、`decisionUpstreamBody`（换成 `wire_model`、**摘掉 `use`**）、`parseDecisionUpstreamReply`。
4. `serveDecision(route, key)`：预扣 = `costMicro({promptTokens: ceil(请求体字节 / 3)})`；三条 release-then-502 路径照抄 `serveTts`；结算用上游回的 `usage.input_tokens`（缺席退回估算）；回包原样（`model` / `answers` / `usage`）+ `remainingHeaders` + `BILLING_HEADERS.cost`。不 failover（只有一家上游）。
5. `edge.ts` 那道门 += `/llm/v1/decision`。
6. **分处开关**：`services/edge/src/decisionUses.ts` 导出常量 `DECISION_USES: Partial<Record<DecisionUse, DecisionMode>> = {}`（**初始为空**）。`serveDecision` 第一件事：`use` 不在表里 → `403 decision_use_disabled`，一个上游字节都不发。
7. `parseRouteRows` 的 kind 阶梯 += `decision`（`chat` 仍是末端兜底）。
8. `modelsForMe` 多回一份 `decisionModels`；`meFromParts` **末尾追加一个对象参数** `decision: { models, uses } = { models: [], uses: {} }`——一个参数、带结构，插不错位置（那个函数已经有八个位置参数，其中三个是「数组或对象」，tsc 拦不住插在中间）。`uses` = `DECISION_USES` 且仅当 `decisionModels` 非空，否则 `{}`。
9. `src/shared/billing.ts`：`BillingMe.decision: { models: string[]; uses: Partial<Record<DecisionUse, DecisionMode>> }`；`parseBillingMe` 里**缺席 = `{ models: [], uses: {} }`，不是解析失败**（新客户端连老网关那一页还得画得出来）；不认识的 use、不认识的 mode 逐项丢掉。
10. migration `0037_model_route_decision.sql`：`model_route_kind_check` 重建成 `('chat','image','tts','decision')` + 幂等 upsert 一行 `jev-1.13@openrouter`（`logical_model='jev-1.13'`、`wire_model='typesafe/jev-1.13'`、`price_in=42000`、`price_cache=0`、`price_out=0`、`default_max_tokens=1`、`kind='decision'`）。**只写不跑**（生产库动作等维护者明说）。
11. 测试：`tests/edge/decisionUpstream.test.ts`（纯映射）、`tests/edge/llmGateway.test.ts`（复用 `quotaStub` / `upstream`：预扣 / 结算 / 三条 release 路径 / `use` 没开回 403 且 `seen` 为空 / 透传 `answers` 不改形状）、`tests/edge/billingQueries.test.ts`（kind 阶梯、`decision` 不进 `models`、`meFromParts` 第九参）、`tests/edge/edge.test.ts`（那道门回 `llm_disabled` 不是 `not_found`）。

**部署顺序：worker 先，migration 后**——0033 的头注已经写过这条规则，这里是它最锋利的一次：认不出的 `kind` 会被旧 worker 按 `chat` 处理，而这一行的输出价是 0、`routesQuery` 按 `price_out` 升序，于是它会排到 `me.models[0]` = **所有订阅用户的默认聊天款 + Auto 的 simple 档**，而它压根不会聊天。migration 的头注要把这句话写在最上面。

### 5.3 runtime：三处全在 `daemon.ts` 的注入点上包一层

`sessionService.ts` 一个字不改（三处本来就是可选注入：`pickAutoModel` :312 / `dispatch` :319 / `retitle` :366）。这同时是与 #1280 的约定：那条 lane 要动群聊的形状，这边只换分类器那一格。

新文件 `services/runtime/src/decisionOwner.ts`：`requestDecisionAsOwner(deps, req)`——拼 `llmBase` 与那四个头（`x-runtime-secret` / on-behalf / workspace / session，有 agent 时加 agent），调 5.1 的 `requestDecision`。

**① 派活** `services/runtime/src/dispatchDecision.ts`（纯逻辑 + 一个包装）

- `dispatchQuestions(input)`：`state = { roster:[{n, name, duty, fallback}], recent:[…], said:{by, text} }`（名字 / 职责过 `promptSafe`，正文过 `promptSafeBody`，截断常量复用 dispatch.ts 那几个）；问题 = 一个 `act`（「`said.text` 是在要求做事吗」，no 那一格抄今天提示词里那串：闲聊、问候、感谢、确认、对上一条回复的简单回应）+ 每只 agent 一个 `a<n>`（「这句话该由 `roster[n]` 接吗——职责对得上，或者它刚向人提了问题而这句话是在回答它」）。**键是编号不是名字**（同 ADR-0270：名字不经过模型的嘴）。
- `verdictFromScores(reply, input) → DispatchVerdict | "escalate"`：

  | 条件 | 判决 |
  |---|---|
  | `P(act) < 0.30`，且没有哪只 `P ≥ 0.60` | `none` |
  | `P(act) < 0.30`，却有一只 `P ≥ 0.60`（自相矛盾——多半是一句很短的回答，两个问题各看到了一半） | `"escalate"` |
  | 有 agent `P ≥ 0.60` | `picked`（按 P 降序，封顶 `DISPATCH_MAX_TARGETS`） |
  | 没有，且 `P(act) ≥ 0.70`，且有 fallback 那一只 | `picked [fallback]`（今天「没人对口的活归它」那条） |
  | 其余 | `"escalate"` |

- 包装 `dispatchVia({ mode, decide, llm, log })`：`off` → `llm`；`on` → `decide`（超时 1200ms），`null` 或 `"escalate"` → `llm`；`shadow` → **`llm` 说了算**，`decide` 并行发出、不等它，回来之后记一行对照日志。
- `escalate` 是校准概率真正值钱的地方：有把握的当场判，拿不准的交给慢而聪明的那条路，而不是硬猜。
- 通话里的特例（ADR-0275：只有一只时不问分类器；none / failed 落到最近开口的那只）全在 sessionService 里，原样生效。

**② Auto** `src/shared/autoModel.ts`（桌面与 runtime 共用）

- `AutoModelDeps` 加可选 `decide?: (state, questions) => Promise<DecisionReply | null>`。
- 给了 `decide`：问一个 noul「这条请求需要强模型吗」（yes / no 两格抄 `CLASSIFY_SYSTEM` 的两段）。`P(hard) ≤ 0.20` → simple；其余 → hard——**「拿不准算 hard」从提示词里的一句请求变成一个阈值**。`decide` 回 `null` → 原样走今天那条 LLM 路。
- 调用方只在 `modeOf(me, "auto") === "on"` 时传 `decide`；`shadow` 时传一个只记日志的旁路（LLM 说了算）。

**③ 重命名的 KEEP 闸** `services/runtime/src/sessionTitler.ts`

- `TitleDeps` 加可选 `decide?`。model 那一步（第 2、7、12… 句人话）先问一个 noul「当前标题还说得清这段对话在聊什么吗」：`P(fits) ≥ 0.80` → 回 `null`（= 今天的 KEEP，一次 LLM 都不打）；否则 → 今天那条 LLM 路（它自己仍然可以回 KEEP）。
- Jev 写不了标题，所以它只挡在前面，不替换后面。
- **主题桶归档不做**：它住在桌面那次合并调用里（建议 / 标题 / 主题三个任务一次 LLM 调用），把主题那一格抽出来问 Jev 一次 LLM 调用都省不掉，只是多一次网络。

### 5.4 桌面：三处

新文件 `src/main/decisionClient.ts`：`createDecisionClient({ quota, accessToken, edgeBaseUrl, fetchImpl? })` → `mode(use)` + `decide(use, state, questions, timeoutMs)`，照 `teamVoice.ts` 处理 `noteHeaders` / `quota_exhausted`。「订阅 / 额度用完」两格读 `quota.routeInput("")`（与聊天、出图、语音**同源**，不另判一遍——各判一遍就会出现「聊天说额度用完了、决策却照跑」），开关读 `quota.snapshot().me`；任何一格不过 = `mode` 回 `"off"` = 走今天的路。**不给 `hostedQuota` 加 `decisionInput()`、不给 `modelRoute` 加 `routeDecision`**（写 plan 时收掉的：那两个先例存在是因为出图 / 语音要向用户说清四种 blocked 各是什么，而决策调用永远不向用户报错，blocked 的原因只进日志）。`HostedCapability` 加可选 `decision?: DecisionClient`——缺席 = 行为一字不变，子 agent 与子会话重建两处跟着 `hostedDeps` 原样接住。

**④ Auto（桌面）**：`agent.ts` 的 `pickAutoModel` 把 `decide` 递给共用的那一份（5.3 ②）。`HostedCapability` 加可选 `decide?`——缺席 = 行为一字不变，`hosted` 没装配的那些装配（探针 / 测试 / 裸装配）不用动。

**⑤ 语音断句：渲染层扣住再合并**

- 新 IPC `ShellBridge.speechJudge(text, lastAgentLine?) → Promise<number | null>`（P(这句说完了)；主进程调 `decide("endpoint", …)`，超时 900ms）。`lastAgentLine` 是播放器最近读的那一句——「你想要哪个分支？」后面的「main」是完整的回答。
- 纯状态机 `src/renderer/src/lib/utteranceHold.ts`，`step(state, event, now) → { state, effects }`，时间与副作用全部注入（同 Swift `Endpointer` 的写法，测试不用等）：
  - `quiet(text)`（`level.active` 从真变假、且当前转写非空）→ effect `judge(text)`。同一段文字只问一次；**同一时刻最多一个在途**（新的来了旧的作废）——`MAX_INFLIGHT` 是 4，语音不该挤掉聊天那条流。
  - `verdict(text, p)` → 记下。
  - `final(text)`：这段文字的 `p` 已到且 `p < 0.35` → **扣住**（并进 buffer，起一个 1800ms 的表）；`p` 还没到 → 最多再等 200ms，到点按「说完了」算；其余 → effect `send(buffer + text)`。
  - 扣着的时候来了 `partial` → 停表（人接着说了，等下一个 `final` 来合并）；表到点 → `send(buffer)`。
  - 两道封顶：最多连扣 3 次；从第一次扣住起 8 秒无论如何发出去。
- `store.ts` 的 `speechOnEvent` 接线：`modeOf(billing.me, "endpoint") !== "on"` 时**整套状态机旁路**，`final` 直接 `cloudSay`——没开的时候零额外延迟由构造保证，不靠「judge 回得够快」。`shadow` 时照旧立刻发，另记一行「Jev 说没说完 / 1.8 秒内人有没有接着说」——**这一处的真值是观测得到的**。
- 扣着的时候字幕 = buffer + 新 partial（不然那行字会先消失再冒出来）。
- 不治的那一半写清楚：没标点的整句 Swift 仍然等 2.5s，要治得加 `commit` 命令 + 重编 helper + 维护者重新点一次 TCC。

**⑥ 记忆分档核对**

- 纯逻辑 `src/shared/memoryTierJudge.ts`：`tierQuestions(ops, projectLabel)` → 每条 add / replace 一个 choice（选项 `user` / `memory` / `project`，三格说明取自 `tierRuleText` 的同一份判据）；`tierMismatch(reply, target)` → 回的那一档 ≠ `target` 且 `confidence ≥ 0.85` 才算。
- `createMemoryTool(project, deps?: { judgeTier? })`——工具不 import 网络（Hard rule），judge 是注入进来的一个函数；缺席 = 今天的行为。
- 落点：`execute` 里点名守卫之后、拿文件锁之前（此刻一把锁都没拿，900ms 的网络等待不占任何东西）。**只在有项目根、且 `target ∈ {user, memory, project}` 时问**——要治的病是「项目事实落进全局档」，没有项目档时那一格不存在；`topic` 要连桶一起挑，不在这次范围里。
- 命中 → 抛一条与点名守卫同形的错：「这条更像 `<档>` 的事——改写 target。确认就是 `<原档>` 的话，**原样再提交一次会放行**。」放行靠工具闭包里的一个集合（`target + 内容哈希`）：这是卫生劝告不是安全闸，模型坚持一次就让它过，不然 Jev 判错一次就把一条真事实永久挡在外面（三次失败工具会进终态）。
- `shadow`：不抛，只记一行。
- **簿记由 `agent.ts` 持有**：记忆工具每轮 `buildTools` 都重建（连续失败计数因此每轮清零，那是既有行为、不动），「被劝过一次」的那个集合住在工具实例里就每轮失忆——模型原样再交一次仍然被劝，三次之后工具进终态。所以集合与 judge 建在 `buildTools` 外面，每轮递进新实例。

## 6. 开关：一处三态，初始全关

`DECISION_USES`（edge 里一个常量，随 `/billing/v1/me` 下发给桌面与 runtime）：

| 状态 | 网关 | 三端 |
|---|---|---|
| 没列（初始五处都是这样） | 这个 `use` 回 403 | 这一处一个请求都不发，行为一字不变 |
| `"shadow"` | 放行 | **今天那条路说了算**；Jev 并行问一次，只记对照日志 |
| `"on"` | 放行 | Jev 优先，§4 第 1 条那两层兜底 |

- 为什么是代码常量不是数据库列：加列就要「migration 先、worker 后」，而新 `kind` 要「worker 先、migration 后」，两条顺序相反的规则压在同一次上线上；常量改一行走 PR，git 历史里留着「哪天凭什么数据开的」，关掉也是一行。
- 为什么多一档 `shadow`：维护者定的是「分处开关，初始全关」；`shadow` 是同一个开关上多出来的一格，为的是 §2 那条最大的未知数——**用生产里真实的中文输入、在不影响任何人的前提下**量一致率与校准，替掉了原先设想的「拉真库记录离线对拍」（那条路要从日志重建每一次派活当时的名册，重建本身就是一份会错的逻辑）。
- 这张表住在 edge 而 runtime 从 `hostedProbe.me()` 读它（60s 缓存）：三端一块配电盘，翻一格最迟一分钟全部生效，不用发桌面版。

## 7. 诊断：一行可 grep 的日志，不落事件

统一前缀 `[decision]` + 一段 JSON：`{ use, mode, ms, scores, verdict, llm? }`。runtime 进 journal，桌面进主进程控制台。影子期要回答的两个问题都从这里 grep：

- 一致率：`verdict` 与 `llm` 相同的比例（派活 / Auto / 重命名）；语音看「Jev 说没说完」与「1.8 秒内有没有新 partial」；记忆看 mismatch 命中的那几条人读一遍。
- 校准：把 P 分桶，看每桶里「与真值一致」的比例是不是跟着 P 走。§5 那几个阈值（0.30 / 0.60 / 0.70 / 0.20 / 0.80 / 0.35 / 0.85）**全是初值**，每个都是文件顶上一个带注释的常量，由这份数据改。

不落事件的理由：判决的**结果**已经在日志里（`user_message{mentions, dispatch:"auto"}`、`model_changed{auto}`、`session_autotitled`），概率是调参用的诊断量；而 SessionEvent 的每一格都是永远的。

## 8. 延迟与失败

| 处 | Jev 超时 | 挂住时的最坏额外等待 | 备注 |
|---|---|---|---|
| 派活 | 1200ms | +1.2s 后才开始今天那条 5s 的 LLM 路 | 上游回 5xx / 429 是立刻回落，只有「挂住不回」才付满这一格 |
| Auto | 1200ms | 同上 | 今天那条 LLM 路**没有超时**（探查时发现的旧账），这次顺手补一个 8s 的 |
| 重命名 | 1500ms | 无感（本来就是 fire-and-forget） | |
| 语音 | 900ms | `final` 到时答案没回来最多等 200ms | 没开时零延迟由构造保证 |
| 记忆 | 900ms | +0.9s / 次写入 | 没拿任何锁 |

`shadow` 模式下 Jev 那一发永远不在关键路径上。

## 9. 上线步骤（谁做、按什么顺序）

1. 本 PR 合并：五处全部休眠（`DECISION_USES = {}`），行为不变，门禁证明这一点。**唯一的例外是有意的**：Auto 今天那条 LLM 路补上 8s 超时（§8）——一次挂住的网关调用今天会把 turn 的起跑永久卡住。
2. **维护者**：部署 edge worker（`OPENROUTER_API_KEY` 已在）→ 再跑 migration 0037。顺序不能反（§5.2）。
3. 我：拿 `mr-otto-dev` 那份 JWT 打一次 `/llm/v1/decision`，先确认回 403（开关没开）；然后开一个一行 PR 把 `dispatch` 设成 `shadow`，部署，再打一次真调用——**这是第一次有人真的看到 Jev 对一句中文回了什么**。形状对不上就在这里停，改 `decisionUpstream.ts`。
4. 部署 runtime（ADR-0258：改了 `services/` 与 `src/shared/` 就要部署才生效）。影子跑几天，grep `[decision]`，定阈值。
5. 一处一处从 `shadow` 翻到 `on`，每翻一处一个一行 PR，PR 正文贴那一处的一致率与校准数据。桌面那三处要等一次桌面发版。

## 10. 测试

- `tests/shared/decision.test.ts`：构造函数出的 noul 永远两格齐全；`parseDecisionReply` 的每一种拒收（缺答案 / 类型错位 / noul 越界 / choice 回了没给过的选项）；`modeOf` 的每一种缺席都回 `"off"`；`requestDecision` 的超时 / 非 2xx / 抛错全回 `null`。
- edge 四个文件见 §5.2 第 11 条。
- `tests/runtime/dispatchDecision.test.ts`：判决表每一行 + 边界值；键是编号不是名字；名字里带 `]` 与换行撑不破 `state`；`dispatchVia` 三种 mode（`off` 不碰 `decide`；`on` 时 `null` / `escalate` 落到 `llm`；`shadow` 时 `llm` 的判决原样返回且不等 `decide`）。
- `tests/shared/autoModel.test.ts` / `tests/runtime/sessionTitler.test.ts`：给了 `decide` 走哪条、`decide` 回 `null` 退回哪条、**不给 `decide` 时请求逐字节与今天相同**。
- `tests/renderer/utteranceHold.test.ts`：状态机每条边 + 两道封顶 + 「没开时 `final` 同一拍出 `send`」。
- `tests/tools/memory.test.ts`：命中抛错且什么都没写；原样再交一次放行；`judgeTier` 缺席 / 回 `null` / 抛错都照常写；`target: "topic"` 与无项目根不问。
- 既有用例一条不改——「休眠 = 行为不变」的证明就是它们全绿。

## 11. 已知代价

1. **合进去的那天什么都不会变好**：五处全关，价值要等 §9 走完。真机一次没跑过。
2. `alpha` 端点：OpenRouter 改路径或改形状那天，五处一起回落到今天的行为——不会坏，但会安静地失效，只有 `[decision]` 日志里的失败行会说话。
3. 新增两家数据处理方（OpenRouter、TypeSafe）：发过去的内容与今天给便宜 LLM 的那几段同类（名册、最近几句、这句话）；**语音那一处是新的**——转写片段在人还没说完时就出了门（今天 STT 全在本机，但说完之后整句本来也会进云）。
4. 每次决策调用一行 `usage_event`；语音一场 10 分钟的通话约 200 行（与 TTS 同量级）。
5. 这几笔钱 `CostPanel` 看不到、`relayStateSince.spentMicro` 也数不到（同出图、同 Auto 今天那次分类调用）。量级：100 token 一次 ≈ 5 micro。
6. 阈值七个，全是初值。
7. 派活的 `state` 里放了整份名册，32 只 agent 的团队约 3–4k token，离 32k 还远，但这是 OpenRouter 那条路比直连紧的一格。
8. 语音只治切碎那一半。
9. 记忆那一处把一次写入变成最多两次工具调用（被劝一次、坚持一次）。
10. 与 #1280 的交集：那条 lane 若把派活挪了位置，`dispatchVia` 要跟着挪注入点（纯逻辑不受影响）。

## 12. 交付形状

- 一条分支、一个 PR（`Closes #1281`），提交按切片分组：纯层 → edge → runtime 三处 → 桌面三处 → migration / ADR / 索引。不拆成多个 PR：全部休眠，没有哪一片单独合进去能提前产生价值，而拆开就要多开几条一次性 worktree（ADR-0149）。
- 项目 ADR 一份（编号合并时认领，ADR-0074），记三件事：为什么经网关、为什么是「前置 + LLM 兜底」而不是替换、为什么开关是 edge 里的三态常量。
- `AGENTS.md` 的 Where to find things 加一条索引（L2）；`CONTEXT.md` 产品/技术术语加两条：**决策模型**、**影子模式**。Tech stack 一节不动——Jev 经网关用裸 `fetch` 调，不加依赖，同 MiniMax TTS 那次。
- 实现走 SDD：一个实现者串行 + 只读审查者，终审整分支按本 spec 核。

## 13. 被否掉的方案

- **TypeSafe 直连**：文档最全、形状已钉死，但要排 early access；维护者选了 OpenRouter。翻回去的路：加一行 `platform='typesafe'` 的 route（`base_url='https://api.typesafe.ai/v1'`）+ `upstreamPathFor` 按平台分 `/systemone`，纯层与五处一个字不用动。
- **给 BYOK 用户也接**：要新增一家 provider + 设置页一格 + key 存储，而五处里三处本来就只在托管路上存在。
- **单一开关**（有 Jev 那一行 = 五处全开）：一处校准不行就得五处一起关，或者发桌面版才能单独关一处。
- **概率落进 SessionEvent**：见 §7。
- **离线对拍脚本**：见 §6，被影子模式替掉。
- **Swift 里加 `commit` / `hold` 命令**：两头都治，但每次重编 helper 都要维护者重新点一次 TCC；留给切碎那一半验证有效之后。
- **拿 Jev 做审批风险分级 / 给 `scanThreat` 加语义层**：前者是放行类的闸（§4 第 2 条）；后者是加严、原则上可以，但不在「对得上的五处」里，另开 issue。
- **对冲式并发**（Jev 600ms 没回就同时起 LLM）：能把最坏等待从 1.2s 压到 0.6s，代价是每次慢一点的 Jev 都白烧一次 LLM 调用。先量真实延迟分布再说。
