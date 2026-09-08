# ADR-0257：会话里出图 —— 走 edge 网关而不是客户端直连，官方 key 永不落地

- 状态：已采纳
- 日期：2026-09-08
- 关联：#1081；ADR-0144（工具产出的图落附件库、卡上显示真图）、ADR-0248（订阅用户不许自带 key）、ADR-0233（云会话同一条纪律）、ADR-0237（`me.models` 从便宜到贵有序 + Auto）、ADR-0244（「那一层收的是一份算好的 headers」）、ADR-0176 决定二（托管优先）、ADR-0009（附件库 / 视觉桥）
- 来源：维护者原话 ——「生图统一走的是用户订阅额度，然后我给你的 key 是官方 key，所有用户都走这个 key」「文生图、图生图都做」「不过审批门」「先不做比例尺寸」

## 背景

ADR-0144 造好了「一张图怎么从工具走到时间线上」的全部管道：`Tool.run` 能挂
`images`、`imageIntake` 中间件落附件库、`ToolResultEvent.images` 只记 ref、
`ImageGeneration` 卡显示真图。那份 ADR 的背景里写着一句欠账：

> 除 MCP 外，将来经会话调用的图片生成 API（Midjourney 之类）没有任何可落地的出口。

管道在，但没有一把刀往里送图。本 ADR 补的就是那把刀。

## 决策

### 一、做工具，不做「可以选的出图模型」

需求原话是「实现可以图片生成的模型」，落地成的是一把工具 `generate_image`。

因为 Otto 是一个 agent loop：出图模型不会调工具，把它放进那枚模型选择器、让用户
选中它，整条 loop 当场就废了。做成工具之后**任何**主模型（DeepSeek / GLM / 托管的
那几款）都能出图，而 ADR-0144 那条管道正是为这个形状造的。

### 二、路是「桌面 → edge 网关 → OpenRouter」，不是桌面直连

维护者的两条口径合起来只有这一个正确落点：

- 「生图统一走用户订阅额度」→ 必须经过 hold / settle / `usage_event` 那一整套；
- 「官方 key 所有用户共用一把」→ 那把 key 不能在客户端。

**把 key 写进桌面包的方案否掉了**（这是本 ADR 唯一一个真正的分叉）。仓里确实有
先例——`BUILTIN_ANYSEARCH_KEY` 就是明文写在 `agent.ts` 里的。但两者差三个数量级：
anysearch 是搜索限额、无支付面；出图一张 $0.067 且没有任何配额闸。app bundle 是
用户机器上的可读文件，`strings` 一把就挖得出来，挖出来 = 无限花维护者的钱。而
「额度记在用户头上」这件事**在客户端根本无法实现**：客户端自报花了多少钱，就是
把钱那条链交给了它。

好消息是网关几乎不用改。`llmGateway.ts` 转发请求体是 `{...body, model, stream}`
展开的，所以 `modalities: ["image","text"]` 原样到上游、`message.images` 原样回来；
非流式那条路已经会读 usage、settle、回额度头。新增的只有一行
`UPSTREAM_KEY_ENV.openrouter`——那张表的注释本来就写着「加一家上游只改这张表」。

**透传这件事补了一条断言**（`tests/edge/llmGateway.test.ts`）。它今天是实现的一个
副产品，不是一条被声明过的契约：哪天有人给转发体加一层字段白名单，出图会**安静地**
退化成一次纯文本回复，而那时候错的表现是「模型说它画好了，但一张图都没有」。

### 三、计价按输出 token，不按张

真机打过 OpenRouter：`google/gemini-3.1-flash-image` 一张图 prompt 11 token /
completion 1120 token，账单 $0.0672055。`model_route` 那一行填
`price_in = $0.5/M`、`price_out = $60/M` 之后，网关现成的 `costMicro()` 算出
67205.5 micro —— **与上游账单逐 micro 相等**。

于是「出图怎么计价」这个问题在我们这儿根本不用回答：它就是一次输出 token 特别贵的
普通调用。按张收费的方案会要求网关里另开一条计价路径，而那条路径不存在。

`default_max_tokens` 取 1500 而不是 8192：这个数只用在**预扣估算**上
（`estimateMicro` = body 字节÷3 × in + max_tokens × out）。填 8192 会让每次出图先
冻结 $0.49、结算再退到 $0.067 —— 额度窗口在那几秒里凭空少了七倍，并发几张就会把一个
正常用户误判成额度用尽。

### 四、`model_route.kind` —— 出图行不许漏进模型选择器

`me.models`（`/billing/me` 下发的型号清单）= `model_route` 里所有 enabled 行，而它
正是输入框那枚模型选择器的数据源。出图行不隔离的话：

- 那枚选单里会多出一款「纳米香蕉」，选中它整条 agent loop 跑不动；
- 更糟的是 **ADR-0237 的 Auto 拿 `models.at(-1)` 当「最贵 = 最强」**，而出图那一行
  $60/M 比现有最贵的 `qwen3.8-max`（$6/M）还贵十倍 —— 于是一次正常的难题提问会被
  Auto 路由到出图模型上，用户得到一张图。

加一列 `kind`，`/me` 分两张清单下发（`models` / `imageModels`）。**选路不看这一格**：
`pickRoute` 只按 `logical_model` 匹配，出图请求点名的就是出图那款。

默认值 `'chat'`、解析层对缺席和认不出的值一律按 `'chat'`：迁移跑之前、旧 edge 上、
拼错一个字符时，行为都与改动前一字不差。`imageModels` 缺席 = 空数组 = 这台网关不供
出图 = 工具不挂 —— 也正是改动前的行为。

这段判断从 `worker.ts` 搬进了 `billingQueries.modelsForMe`：worker.ts 不进 vitest，
留在那儿就是唯一的判断零执行覆盖（同 `usageAttribution` 与 `UPSTREAM_KEY_ENV` 那两次
的教训）。`imageModels` 加在 `meFromParts` 的**最末**——那是个七位置参数的函数，插在
中间会让既有调用把 `modelPlatforms` 悄悄喂给新参数，而两者都是「数组或对象」，
tsc 拦不住这一类。

### 五、出图没有「自带 key」这一档，所以只有两态

`routeImage` 与 `routeModel` 的差别只有一处，但那一处是根本的：**没有 `direct`**。
官方 key 只活在 Worker secret 里，客户端一个字节都拿不到，所以要么走托管、要么走不通。

这意味着 ADR-0233 点名的那个静默失败模式（「额度用完悄悄改烧你自己的账号」）在这条路上
**结构性地不存在**：没有可改道的第二条路。

四种 blocked 分开措辞，纪律与 ADR-0248 那张表逐条对应。两条最要紧的：

| 情形 | 说什么 | 为什么不能合并 |
|---|---|---|
| 网关一款出图模型都不供 | `订阅网关暂时不供出图。` | 写成「你没订阅」会让一个正在付钱的人去点续费解决一个不存在的问题 |
| 拿不到 JWT / 网关地址 | `连不上订阅网关（多半是网络或登录状态），稍后再试。` | 同上 |

额度用完排在「不供出图」前面：前者是网关亲口说的那句「拦住你了」，后者只是一张清单
读出来的推断（同 ADR-0255 让 `exhausted` 排在百分比前面）。

### 六、`imageBlocked` 与 `routeImage` 拆成两半

`generate_image` 的 `available()`（决定这把刀进不进模型的工具表）**必须同步**作答，
而拿 JWT 是异步的。于是判据拆成两半：快照就能答的那三条（订阅 / 额度 / 网关供不供
出图）是同步的 `imageBlocked`，token 那一条留在 `routeImage` 里。

两个消费方共用同一份 —— 各写一遍的结果会是「工具表里有这把刀、点下去说你没订阅」
那种自相矛盾。`hostedQuota.imageInput` 同理与 `routeInput` 同源：各判一遍会出现
「聊天说额度用完了、出图却照跑」。

**没订阅 = 这把刀在工具表里根本不存在**（维护者定的口径）。这不只是少一个选项：
挂着它意味着模型会先说「我给你画一张」再失败，而那是一句它本可以不说的话。

### 七、图生图靠 `edit_last`，不靠 id 也不靠路径

模型看得见图，却**看不见附件 id**：`deriveMessages` 把附件折成 `image_ref` part，
id 一个字都不进模型正文。所以它没有办法「点名那一张」。

于是 `edit_last: true` 由 `latestImageRef` 从日志里倒着扫出最近一张图 —— 用户贴的
（`user_message.attachments`）和工具产出的（`tool_result.images`）合成一条时间线。
后者不是补充：「把刚画的这张改成夜景」正是最常走的那条路。

`image_path`（工作区里的文件）这条路**没做**：`world.fs.read` 只回 string，读 PNG 会
烂码，要给 `ExecutionWorld.fs` 加一个 `readBytes`。真有人要改工作区里的图再说。

没有底图时不照发：那样得到的是一张凭空捏的图，而用户以为你改了他那张。

### 八、`HttpPostOptions.timeoutMs`

出图是整张图算完才回：实测 `gemini-3.1-flash-image` 10.4s、`gpt-5-image-mini`
44.5s。LocalWorld 写死的 30s 会让后者永远超时，而超时在用户眼里是「说好了画，
然后报了个网络错」。

**不是把默认放宽**：那等于让每一个卡住的普通请求都多占半分钟。这一格是「我知道
这一次会很慢」的调用方自己声明的，缺席仍是 30s。

### 九、UI 零改动

这是本次唯一一件不用做的事。`generatedImagesOf` 遍历一组里的每次工具调用、读
`tool_result.images`，说明文字取参数里那个叫 `prompt` 的字段（ADR-0144 决定五：
**只认这一个名字**）。工具的参数就叫 `prompt`，于是那张卡自己亮起来。

## 范围外 / 已知代价

- **出图这笔钱进 `usage_event`，但 `CostPanel` 看不到**：那块面板读的是本机日志里
  `assistant_message.credit`，而出图不产出 assistant_message。账没丢，只是那个界面
  不报它。
- **不带归因头**（`x-otto-session` 等）：桌面的聊天调用今天也不带，只有 runtime 带。
  保持一致，不在这一条里单独开个头。
- **云会话（`services/runtime/`）那侧不挂这把刀。**
- **不过审批门**（维护者定）：与 `web_search` 同级——纯外呼、无本地副作用，而它也花钱。
- **不做比例/尺寸参数**（维护者定）：得先验各家透传不透传。
- **只上一款**（`google/gemini-3.1-flash-image`）：`openai/gpt-5-image` 那几款实测
  44.5s / $0.041，慢且贵。要加只是再插一行 `model_route`，不改代码。
- **本条要部署才生效**：migration 0031 + `wrangler secret put OPENROUTER_API_KEY`
  + 部署 edge worker（#791：edge 不跟发版走）。顺序上 migration 要先于 worker ——
  `routesQuery` 的 select 带了 `kind`，列还不存在时 PostgREST 会整条查询报错。
- **桌面 → edge → OpenRouter 这条全链路没有在真机上跑过一次**（部署之后才跑得起来）。
  已经真打过的是 OpenRouter 那一段：请求体形状、响应形状、延迟、账单都是实测值，
  不是推的（ADR-0134 的纪律）。
