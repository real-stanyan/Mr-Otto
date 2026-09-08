# ADR-0260：模型选单的「文字 / 图像」开关 —— 出图目录扩到七款，整条出图路换到网关的 `/images`

- 状态：已采纳
- 日期：2026-09-08
- 关联：#1086；ADR-0257（出图走网关不走客户端直连）、ADR-0237（`me.models` 从便宜到贵有序 = 一个承诺）、ADR-0244 / ADR-0249（这枚选单列哪几款）、ADR-0248（订阅用户不许自带 key）、ADR-0134（「做不了」先验前提）
- 来源：维护者原话 ——「模型选择弹窗最上面，像任务和项目一样加一个 switch，让用户可以切换，分别选择文字模型和图像模型」「帮我接入 seedream 4.5，seedream 5pro，seedream 5 lite，gpt image 2，nano banana」

## 背景

ADR-0257 把出图这条路修通了，但目录里只有一款（`gemini-3.1-flash-image`）。0031 的
头注写着「要加只是再插一行，不改代码」。#1086 要在选单上加一枚开关，而**一个只有
一行、且那一行已经选中的选择器不提供任何选择** —— 目录这一侧不补，那枚开关就是
#722「撒谎的勾」的近亲。

于是这条 issue 实际是三件事：目录扩容、出图型号变成一个可选的东西、选单上那枚开关。
其中第一件在动手之后长出了第四件（见决策一）。

## 决策

### 一、整条出图路从 `/chat/completions` 换到 OpenRouter 的 `/api/v1/images`

「插一行就行」这半句**不成立**，而这件事只有真打一次才知道：

纯出图模型（`output_modalities` 只有 `["image"]` —— Seedream 三款与 GPT Image 2）
在 `/chat/completions` 上一律 404，上游原话：

> `No endpoints found that support the requested output modalities: image, text`

OpenRouter 另有 `/api/v1/images`（`{model, prompt, input_references}` 进、
`data[].b64_json` 出）。**决定性的一条事实是它的 `/images/models` 清单里连 Gemini
那三款也在** —— 也就是说这条端点是**所有**出图模型的统一入口，不是纯出图款的特例。
所以修法不是「按模型分两种形状」（两套请求体、两套回包解析、两条失败路径），
而是整条出图路换过去，一种形状。

落地只有一格：`upstreamPathFor(route.kind)` 决定打上游哪个端点。
**判据是路由行自己的 `kind`，不是客户端敲的那个路径** —— 照客户端判会让「这款模型
该怎么调」有两份事实，而其中一份在用户的机器上（装着旧版桌面的人会把每一次出图都
打成 404）。edge 多开一扇 `/llm/v1/images` 的门，两扇门通到同一个处理函数：路径只是
给读代码的人看的，因为请求体与回包确实是另一套形状，挂在一个叫 `chat/completions`
的路径上会让下一个人以为它们同形。

**`usage` 形状两条端点逐字相同**，所以 `parseUsage` / `costMicro` / hold-settle
整套一个字都没动。这也是为什么这条改动敢做：它的半径就是「打哪个 URL」这一格。

顺带修掉一个超收：`gemini-3-pro-image` 走 `/chat/completions` 时回 2 张图 + 251 个
reasoning token，而 `costMicro` 只有一个输出单价，会按出图价算那 251 个 token、
超收约 20%；走 `/images` 回 1 张、0 个 reasoning，实测与账单**逐 micro 相等**。

### 二、目录扩到七款，价按两族两种算法填 —— 都是真机打出来的

| 型号 | id | 每张 |
|---|---|---|
| Seedream 5.0 Lite | `seedream-5-0-lite` | $0.035 |
| Seedream 4.5 | `seedream-4.5` | $0.040 |
| Seedream 5.0 Pro | `seedream-5-0-pro` | $0.090 |
| GPT Image 2 | `gpt-image-2` | $0.0061 |
| Nano Banana | `gemini-2.5-flash-image` | $0.0387 |
| Nano Banana 2（原有） | `gemini-3.1-flash-image` | $0.0672 |
| Nano Banana Pro | `gemini-3-pro-image` | $0.1344 |

计价那一层只有一个算式（`costMicro`：prompt × price_in + completion × price_out），
所以「填什么价」这个问题真正要问的是**上游报的 `completion_tokens` 是什么**。
两族的答案不一样，而元数据里看不出来：

- **Gemini 一族**：`completion_tokens` 是真实出图 token 数（1120 / 1290 / 1120），
  单价取 `pricing.image_output`，换算 `price_out = image_output × 1e12`。
- **Seedream 一族**：OpenRouter **按张收费**，回包里 `completion_tokens` 恒等于
  `16384`（一个常数，与图的大小无关）。照上面那个算法填就会把每张图算成真实价的
  2～4 倍 —— **第一版填错的正是这个**，实测超收 3.9× / 3.9× / 2.0×。改成
  `price_out = 每张实际价 ÷ 16384 × 1e12` 之后 `costMicro` 在这一族上退化成一个
  按张的定价，而算式本身不用改。

**这一族的保鲜期是脆的**：那个 16384 是 OpenRouter 的记账约定，不是我们能断言的东西；
它一变、或者 Seedream 调价，我们就会安静地多收或少收。所以有一条纪律写进了 0032 的
头注：**加一款出图模型之前先打一次真调用对账单**。

`default_max_tokens` 要**不低于**真实值（低了预扣少于实收），Seedream 一族因此填
16384、Gemini / OpenAI 一族沿用 1500。

已知偏差与少收各一笔，理由在 `0032_more_image_models.sql` 头注：`gpt-image-2` 的
prompt 实测 $5/M 而公布价 $8/M（一次调用 +0.6%，照公布价填是因为那 $5 解释不了，
而编一个自己讲不出理由的数更糟）；`seedream-5-0-pro` 的参考图按 $0.003/张 另计而
`model_route` 没有这一列（只在图生图时少收这一笔）。

### 三、默认款跟着变，不给谁钉 `priority`

`imageModels[0]` = 没选过的人用的那一款，排序键是 `priority, price_out, id`
（ADR-0237）。改价之后默认从 Nano Banana 2（$0.067/张）换成 Seedream 5.0 Lite
（$0.035/张）。**不给谁钉 priority**：那会让这一列同时承担「排序」和「钉默认」两件事，
而 ADR-0237 那条「最便宜那款是个承诺」正是靠这一列只说一件事才成立的。

注意排序键排的是**每 M token 的价**，而七行的 token 口径已经不是同一把尺（Seedream
一张图 16384 token、Gemini 一张 1120）。巧的是按每张实际价排也是同一个顺序 ——
**这是巧合不是保证，再加新款时要按每张价复核一遍**。

### 四、出图型号跟会话走，载体是新事件类型 `image_model_changed`

维护者定的作用域。于是它与型号 / lane / Auto 同一族：日志投影、resume 自动回来、
分享 / 重放全部免费拿到，不加第二种持久化。

**与 `model_changed` 分成两条事件不是洁癖**：合成一条的话，每次换文字模型都得把出图
那格一并带上，否则「这一条里出图那格缺席」到底是「没变」还是「清空了」就说不清 ——
而换文字模型是每天做很多次的动作，换出图型号一年也未必一次。

新事件类型走 AGENTS.md 那份检查清单。实际是**十一处**：清单上那十处之外，第十一处是
`Timeline.tsx` 的 `EventRow` —— 而它不是靠人记住的，是
`tests/renderer/timelineLists.test.ts` 那条「两份名单一致」当场翻红抓出来的。
（这条断言的价值在这次得到了验证：`isAuditEvent` 放行而 `EventRow` 没有 case，
时间线上的表现是一行空白。）

`preferred` 不在网关清单里就**回落 `imageModels[0]` 不报错**（`pickImageModel`，
主进程解路与选单画勾共用这一份）：同 `visionModelFor` / `helperModelFor` 的纪律 ——
网关下架一款不该让出图整个不通，而「你选的那款没了」这件事没有任何用户能据此行动的
出路。

**turn 进行中允许换**（与 `switchModel` 相反）：出图那把刀每次调用才现解一次路，
换完下一次 `generate_image` 就生效，不会把正在跑的这一轮劈成两半。

### 五、选单顶上那枚开关：四条判据

用的是侧栏「任务 / 项目」那一套同一个 `Tabs` 组件（同一种交互在两处长一样，共用骨架
才不会漂移），钉在 `ModelSelectorList` **外面**（列表可滚，开关跟着滚走就不知道自己
在哪一格了）。

1. **清单空 = 整枚开关不画**，下面一切退回改动前的样子。没订阅 / 还没查到 / 网关不供
   出图，三种情形同一个答案 —— 同 `modelMenu` 对 `hosted` 的处置（ADR-0244）。
   给了清单但没给回调也不画：一颗点了什么都不会发生的开关就是 #722 那个撒谎的勾。
2. **图像那一格不走 `ModelSelectorItem`**：它的选中态与 `setValue` 都挂在 Root 的
   `value` 上，而 Root 的 `value` 是文字模型 —— 借它画出图清单，触发器上那行字会跟着
   变成出图型号，也就是那颗按钮开始说假话。这一段自己用 `CommandItem`（类名抄
   `ModelSelectorItem`，两格看起来是一列），勾自己画。
3. **勾落在会被用到的那一款**（`pickImageModel` 的结果），不是落在 `imageModel` 上：
   没选过时用户看到的该是网关会替他挑的那款而不是一行都不勾；选过但网关下架了它时，
   勾也该落在真会跑的那款上。
4. **浮层每次打开回到「文字」那一格**：触发器上写的是文字模型，开出来停在图像那一格
   就是按钮说一件事、浮层说另一件事。代价是连着改两次出图型号要各点一下「图像」。

**图像那一格不画厂商标**：`model_route.platform` 对七行出图路由全是 `openrouter`
（那说的是上游是谁，不是厂商是谁），画出来是七行同一个标；按 id 猜厂商则是给一列本仓
没有的字形安一家厂（同 ADR-0254「认不出的型号不画标」）。名字走
`IMAGE_MODEL_LABELS` 这张**人手维护、会过时**的表（同 `mcpCatalog.ts` 的立场），
认不出的**原样显示 id** —— 网关上了新款而这张表还没跟上时，裸 id 至少是真的。

## 代价与已知未做

1. **新会话卡那一处不给这一格**：它还没有会话可落事件，给了就是一颗点了报「还没有
   会话」的钮。想在开局就定出图型号的人得先发一句话。
2. **Seedream 的价靠一个外部常数（16384）成立**，见决策二。失败模式是静默的（只有
   账单会说话），缓解措施只有 0032 头注里那条纪律。
3. **`/images` 的回包里没有一格「模型说了什么」**。chat 那条端点在内容政策拒绝时
   常把理由写在 `message.content` 里，换端点之后拒绝时说不出原因，只能给一句通用的
   「最常见的原因是内容政策拒绝」。这是换来七款可用付的代价。
4. **勾分不出「我选的」和「默认就是它」**：没选过时最便宜那款也带勾。与文字那格
   （永远有一个当前型号）同构，暂不区分。
5. 云会话那侧不挂这枚开关（`generate_image` 本来就只在装配了托管的桌面会话上）。
6. 七款目录里 OpenRouter 还有 30 多款没上（Flux / Recraft / Qwen Image / MAI…），
   要加就是往 `model_route` 插行 + 按决策二的纪律核一次价。
