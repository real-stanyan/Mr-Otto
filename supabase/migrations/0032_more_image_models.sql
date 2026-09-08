-- 0032_more_image_models.sql —— 出图目录从一款扩到七款（issue #1086）。幂等，重跑不炸。
--
-- 背景：0031 只上了一款（`gemini-3.1-flash-image`），头注原话「要加只是再插一行，不改
-- 代码」。#1086 要在模型选单里加一枚「文字 / 图像」开关，而一个只有一行、且那一行
-- 已经选中的选择器不提供任何选择 —— 目录这一侧不补，那枚开关就是 #722「撒谎的勾」的
-- 近亲。维护者点名了 Seedream 4.5 / 5.0 Pro / 5.0 Lite / GPT Image 2 / Nano Banana，
-- 这里连 Nano Banana Pro 一起补齐（同一族三代摆在一起，选单里「便宜 / 中 / 贵」才读得出）。
--
-- 「不改代码」这半句这次**不成立**：纯出图模型（`output_modalities` 只有 `["image"]`，
-- 即 Seedream 三款与 GPT Image 2）在 `/chat/completions` 上一律 404，要走 OpenRouter 的
-- `/api/v1/images`。网关那半的改动与理由在 `llmGateway.ts` 的 `upstreamPathFor`。
--
-- ── 价怎么定的：两族两种算法，**都是真机打出来的** ──────────────────────────
--
-- 计价这一层只有一个算式（`costMicro`）：prompt × price_in + completion × price_out。
-- 所以「填什么价」这个问题真正要问的是：**上游报的 `completion_tokens` 是什么**。
-- 两族的答案不一样，而这件事只有真打一次才知道（元数据里看不出来）：
--
-- ① Gemini（Nano Banana 一族）：`completion_tokens` 是**真实的出图 token 数**
--    （实测 1120 / 1290 / 1120），单价就是 OpenRouter `pricing.image_output` 那一格。
--    换算 `price_out_micro_per_m = image_output × 1e12`。三款实测与上游账单逐 micro 相等：
--      gemini-2.5-flash-image  1290 tok  上游 $0.0387021  我们 38703 micro
--      gemini-3.1-flash-image  1120 tok  上游 $0.0672035  我们 67204 micro
--      gemini-3-pro-image      1120 tok  上游 $0.134414   我们 134414 micro
--
-- ② Seedream：OpenRouter **按张收费**，而回包里的 `completion_tokens` 恒等于 16384
--    （2^14，一个常数，跟图的大小无关；三款三次调用全都是这个数）。照 ① 的算法填
--    `image_token` 那格的单价，就会把每张图算成真实价的 2～4 倍 —— 第一版填错的正是
--    这个，实测超收 3.9×/3.9×/2.0×。
--    所以这三行的 `price_out_micro_per_m = 每张实际价 ÷ 16384 × 1e12`，于是
--    `costMicro` 在这一族上退化成一个按张的定价，而算式本身不用改：
--      seedream-5-0-lite  $0.035 ÷ 16384 → 2_136_230   16384 × 该价 = 35_000 micro
--      seedream-4.5       $0.040 ÷ 16384 → 2_441_406   16384 × 该价 = 40_000 micro
--      seedream-5-0-pro   $0.090 ÷ 16384 → 5_493_164   16384 × 该价 = 90_000 micro
--    **这一族的保鲜期是脆的**：那个 16384 是 OpenRouter 的记账约定，不是我们能断言的
--    东西；它一变、或者 Seedream 调价，我们就会安静地多收或少收。加一款出图模型之前
--    先打一次真调用对账单 —— 这条纪律就是这段注释存在的全部理由。
--
-- **`default_max_tokens` 填的是「一张图大概几个输出 token」**，只参与预扣估算
-- （`estimateMicro` = body 字节÷3 × in + max_tokens × out），不是上限。它要**不低于**
-- 真实值：低了就是预扣少于实收（额度窗口上会短暂透支），高了只是多冻一会儿。
-- Seedream 一族填 16384（恒等于实测值，于是预扣正好等于实收）；Gemini / OpenAI 一族
-- 沿用 0031 实测的 1120 → 1500。
--
-- **已知偏差 +0.6%（gpt-image-2）**：它的 prompt 实测是 $5/M（13 token 收 $0.000065），
-- 而 OpenRouter 公布的 `pricing.prompt` 是 $8/M。一次调用差 39 micro（$0.006134 vs
-- $0.006095）。照公布价填而不是照实测反推，是因为那 $5 解释不了（多半是文本输入与
-- 图片输入两档价），而编一个自己讲不出理由的数比留 0.6% 的保守余量更糟。
--
-- **默认款会变，这是有意的**：`imageModels[0]` = 没选过的人用的那一款，而排序键是
-- `priority, price_out, id`（ADR-0237）。改价之后 Seedream 三款的 `price_out` 反而
-- 低于 Gemini 一族，默认从 Nano Banana 2（$0.067/张）换成 seedream-5-0-lite
-- （$0.035/张）。**不给谁钉 priority**：那会让这一列同时承担「排序」和「钉默认」两件事，
-- 而 ADR-0237 那条「最便宜那款是个承诺」正是靠这一列只说一件事才成立的。
-- 注意排序键排的是**每 M token 的价**，而这七行的 token 口径已经不是同一把尺
-- （Seedream 一张图 16384 token、Gemini 一张 1120）—— 巧的是按每张实际价排也是同一个
-- 顺序（0.035 / 0.040 / 0.006 …），但这是巧合不是保证：**再加新款时要按每张价复核一遍**。
--
-- **已知少收的一笔**：`seedream-5-0-pro` 的参考图按 $0.003/张 单独计价（`pricing.image`），
-- 而 `model_route` 没有「每张输入图多少钱」这一列，`costMicro()` 只按 token 算。于是走
-- `edit_last`（图生图）时我们每张少收 $0.003。不为它加一列：加了就要让计价函数多认一种
-- 单位，而这笔钱比一次出图本身小一个量级，且只在图生图时发生。

insert into public.model_route (
  id, logical_model, platform, base_url, wire_model,
  price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m,
  default_max_tokens, quantization, priority, enabled, kind
) values
  -- ① Seedream 三款（ByteDance）。`prompt` 报 0，所以 in / cache 都是 0：
  -- 这一家把钱全算在出图那一格上。price_out 见上面 ②：按张价 ÷ 16384
  ('seedream-5-0-lite@openrouter', 'seedream-5-0-lite', 'openrouter',
   'https://openrouter.ai/api/v1', 'bytedance-seed/seedream-5-0-lite',
   0, 0, 2136230, 16384, 'none', 10, true, 'image'),

  ('seedream-4.5@openrouter', 'seedream-4.5', 'openrouter',
   'https://openrouter.ai/api/v1', 'bytedance-seed/seedream-4.5',
   0, 0, 2441406, 16384, 'none', 10, true, 'image'),

  ('seedream-5-0-pro@openrouter', 'seedream-5-0-pro', 'openrouter',
   'https://openrouter.ai/api/v1', 'bytedance-seed/seedream-5-0-pro',
   0, 0, 5493164, 16384, 'none', 10, true, 'image'),

  -- ② GPT Image 2（OpenAI）。cache 这一格填的是它真报的 `input_cache_read` $2/M，
  -- 不是照 0031 那样填成与 in 相同 —— 0031 那么填是因为 Gemini 那款压根不报 cache
  ('gpt-image-2@openrouter', 'gpt-image-2', 'openrouter',
   'https://openrouter.ai/api/v1', 'openai/gpt-image-2',
   8000000, 2000000, 30000000, 1500, 'none', 10, true, 'image'),

  -- ③ Nano Banana 一族的另外两代（第二代 `gemini-3.1-flash-image` 已由 0031 上了）
  ('gemini-2.5-flash-image@openrouter', 'gemini-2.5-flash-image', 'openrouter',
   'https://openrouter.ai/api/v1', 'google/gemini-2.5-flash-image',
   300000, 30000, 30000000, 1500, 'none', 10, true, 'image'),

  ('gemini-3-pro-image@openrouter', 'gemini-3-pro-image', 'openrouter',
   'https://openrouter.ai/api/v1', 'google/gemini-3-pro-image',
   2000000, 200000, 120000000, 1500, 'none', 10, true, 'image')

on conflict (id) do update set
  logical_model = excluded.logical_model, platform = excluded.platform,
  base_url = excluded.base_url, wire_model = excluded.wire_model,
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens,
  quantization = excluded.quantization, priority = excluded.priority,
  enabled = excluded.enabled, kind = excluded.kind;
