# ADR-0274：自己的 reasoning 随投影带出，reasoning_content 回不传回传按厂商门控

（原为 ADR-0272——#1174 的语音招呼 ADR 先占 0272 改 0273；合并落地时 #1178 的语音 STT ADR 又先占 0273，再改 0274。均按项目 ADR-0074：号在合并时 claim）

- 状态：已接受
- 日期：2026-09-09
- 关联：#1151（本决定）/ #1146 与 ADR-0268（别人的发言那一半）/ ADR-0219（agentView 是变换不是过滤）/ `tests/session/deriveMessages.test.ts`（投影契约）/ `tests/model/openaiCompatible.test.ts`（门控契约）

## 背景

events.ts 的 `assistant_message.reasoning` 字段注释写着「API 明令禁止塞回上下文（塞了 400）→ 投影必须丢弃它」——那是 DeepSeek R1 时代的规矩。V3.2 起反过来了：thinking 模式 + 请求带 tools 时，**最后一条 user 之后的每一条 assistant 消息都必须带 `reasoning_content`**（#1146 真机 400）。自己的工具回合当时能过，是因为 DeepSeek 按它发出的 tool_call id 在服务端缓存了思考、客户端不传就去查——每一轮工具调用都在赌那份缓存：turn 里等一次长审批（ask 最长 10 分钟）、daemon 重启后补跑、或对方缩短 TTL，都会变成 turn 中途一句 400。

## 探针（2026-09-09，真接口，DeepSeek 直连 / GLM 直连 / Kimi Code 订阅端点）

形状对齐真 turn：`[user, assistant(tool_calls, id 现编), tool]`（末尾是 tool，assistant 落在最后一条 user 之后）。

DeepSeek（deepseek-v4-flash）：

| 形状 | 结果 |
|---|---|
| thinking 开 + tools + 不带 rc | **400**（复现缓存失效） |
| thinking 开 + tools + 带 rc（内容现编，id 也现编） | 200 —— rc 在场就不查 id |
| thinking 开 + tools + rc="" | 200 —— 键在即可 |
| thinking **关** + tools + 带 rc | 200 —— 非 thinking 模式也收 |
| 两圈工具调用，第一圈带 rc 第二圈不带 | **400** —— 最后一条 user 之后每条都要 |
| 老轮次（最后一条 user 之前）也带 rc | 200 —— 任何位置都收 |
| 不带 thinking 字段 + 不带 rc | **400** —— 服务端默认思考（runtime 的形状） |
| 不带 thinking 字段 + 带 rc / rc="" | 200 |

GLM（glm-4.7-flash）/ Kimi Code（kimi-for-coding、k3）：不带 rc 全 200（**不要求**），带 rc 全 200（**接受**；GLM 含 thinking 关）。

Qwen 没验成：网关只收有效 JWT，本机存的 token 过期（脚本刷新会顶掉正在跑的 app 的会话，不干）。云 runtime 从不发 thinking 字段，Qwen 若只在 thinking 模式查这条就咬不到；维持不开，是真机咬了再开的那一类。

## 决定

1. **投影把 `reasoning` 带出来**：`AssistantChatMessage` 加可选 `reasoning`，deriveMessages 从 `assistant_message.reasoning` 原样填。没有该字段的旧日志投影逐字节不变（不出空字段）。
2. **发不发由 adapter 按厂商门控**：`createOpenAICompatibleAdapter` 加 `reasoningPassback`（默认关）。关 = 剥掉不发（多数 API 拒陌生字段，这是保命闸）；开 = 每条 assistant 消息发 `reasoning_content`，有原文发原文、没有发空串。
3. **门控名单在目录**：`ModelChoice.reasoningPassback` 由 `REASONING_PASSBACK` 厂商集合派生，初值只有 `deepseek`。逐家验过才准进；验过「接受但不要求」的不进（GLM/Kimi）；目录外兜底型号与 Ollama 一律 false。
4. **开启后不做位置 / tools / 档位判断**：DeepSeek 探针证明任何位置（含最后一条 user 之前）、thinking 关、空串都收。位置判断（「最后一条 user 之后」）是把 API 文档句子翻成代码里一份会漂移的逻辑，全量回声是它自己验过的超集。
5. **接线两处**：桌面 `makeAdapter`（agent.ts）按 `choice.reasoningPassback`；云 runtime（hostedRoute.ts）按 `findModel(route.model)?.reasoningPassback ?? false`——目录认不出的型号 = 没验过 = 不开。

## 否决的

- **只在「最后一条 user 之后 + 带 tools」才发**：那是 DeepSeek 文档句子的直译。探针证明全量回声全收，位置逻辑是一份会漂移的假设（压缩、接力、补跑都会挪动「最后一条 user」）。
- **按 thinking 档位门控**（关 thinking 时不发）：DS 4 证明 thinking 关也收；而 runtime 压根不发 thinking 字段（服务端默认思考），按请求字段判会把 runtime 判成「不用发」。
- **GLM / Kimi 顺手也开**：探针验了不要求。开了白开——多一份线上字段就多一份对方哪天严格化时炸掉的面。收紧那天开是一行的事。
- **Qwen 靠文档定性**：没验成就不开，不拿文档当探针（ADR-0134）。

## 代价 / 已知

- DeepSeek 请求的输入 token 从此包含回传的思考原文——这是对方规矩的定价，不传的替代品是 turn 中途 400。上下文估算（contextEstimate）不按厂商分，对 DeepSeek 会略低估锚点之后的 pending（思考文本不计）；锚点（真账单）自带真值，会自我纠正。
- GLM / Kimi / Qwen / 其余各家维持赌缓存（如果对方也有缓存机制的话）——探针没验出要求，与改动前相同，不是回退。
- 云会话要**重新部署 runtime** 才生效（#791）。
- 「投影带出来」对一切 ChatMessage 消费方可见：压缩 / 分区分类等走非 passback adapter（默认剥），行为不变；`request_envelope` 不含 messages，不受影响。
