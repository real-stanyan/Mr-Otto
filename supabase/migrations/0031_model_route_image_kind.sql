-- 0031_model_route_image_kind.sql —— model_route 分出「这一行是给谁用的」+ 上出图那一款（issue #1081）。幂等，重跑不炸。
--
-- 背景：会话里要能出图（`generate_image` 工具），而维护者定的口径是「生图统一走用户
-- 订阅额度、官方 key 所有用户共用一把」。这两条合起来只有一个正确落点：出图请求走
-- **已有的 edge 网关**（`services/edge/src/llmGateway.ts`），OpenRouter 的 key 作为
-- Worker secret 存在云上，永不进客户端。网关本身几乎不用改——它转发请求体时是
-- `{...body}` 展开的，`modalities:["image","text"]` 原样到上游，`message.images`
-- 原样回来；hold / settle / usage_event 全套现成。
--
-- **为什么要 `kind` 这一列**：`me.models`（`/billing/me` 下发给桌面的型号清单，也就是
-- 输入框那枚模型选择器的数据源）= `model_route` 里所有 enabled 行。出图行不隔离的话
-- 它会漏进那枚选单，而 ADR-0237 的 Auto 拿 `models.at(-1)` 当「最贵 = 最强」——出图那
-- 一行 $60/M（比现有最贵的 qwen3.8-max 还贵十倍），于是纳米香蕉会变成 Auto 的 hard 档
-- 主模型，一次正常提问会得到一张图。选路（`pickRoute`）**不看**这一格：它只按
-- logical_model 匹配，出图请求点名的就是出图那款。
--
-- 默认值 `'chat'` = 存量六行行为一字不变；客户端侧 `parseRouteRows` 对缺席和认不出的
-- 值同样按 chat，所以**这条 migration 跑之前**发出去的 edge 也不会炸（列不存在 →
-- PostgREST 报错 → 那是 select 带了不存在的列，所以顺序上要先跑本条再部署 worker）。
--
-- **价怎么定的**：真机打过 OpenRouter（#1081）。`google/gemini-3.1-flash-image`
-- 一张图 prompt 11 token / completion 1120 token，OpenRouter 账单 $0.0672055。
-- 按 in $0.5/M + out $60/M 算：11×0.5 + 1120×60 = 67205.5 micro —— **与上游账单逐
-- micro 相等**。也就是说出图在我们这儿是按输出 token 计价的，不是按张，网关那条
-- 现成的 `costMicro()` 一个字都不用改。
--
-- `price_cache_micro_per_m` 填得与 in 相同：OpenRouter 这一款不报 cache 命中，
-- `costMicro` 里 cached 恒为 0，填多少都不参与计算；填成 in 价是为了让「万一将来
-- 报了 cache」这件事不会凭空变便宜或变贵。
--
-- `default_max_tokens` 取 1500 而不是 8192：这个数只用在**预扣估算**上
-- （`estimateMicro` = body 字节÷3 × in + max_tokens × out）。出图实测输出 1120 token，
-- 填 8192 会让每次出图先冻结 $0.49、结算时再退到 $0.067 —— 额度窗口在那几秒里凭空
-- 少了七倍，并发几张就会把一个正常用户误判成额度用尽。
--
-- **只上一款**：`openai/gpt-5-image` 那几款实测 44.5s / $0.041，慢且贵；要加只是再
-- 插一行，不改代码。

-- ① 这一行路由是给谁用的
alter table public.model_route add column if not exists kind text not null default 'chat';

-- 认得出的值只有两个。约束用 check 不用 enum：加一种新 kind 时改 check 是一条
-- alter，改 enum 要 `alter type ... add value` 且不能在事务里回滚
alter table public.model_route drop constraint if exists model_route_kind_check;
alter table public.model_route add constraint model_route_kind_check check (kind in ('chat', 'image'));

-- ② 出图那一款。id 沿用既有的 `<logical>@<platform>` 格式
insert into public.model_route (
  id, logical_model, platform, base_url, wire_model,
  price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m,
  default_max_tokens, quantization, priority, enabled, kind
) values (
  'gemini-3.1-flash-image@openrouter', 'gemini-3.1-flash-image', 'openrouter',
  'https://openrouter.ai/api/v1', 'google/gemini-3.1-flash-image',
  500000, 500000, 60000000,
  1500, 'none', 10, true, 'image'
)
on conflict (id) do update set
  logical_model = excluded.logical_model, platform = excluded.platform,
  base_url = excluded.base_url, wire_model = excluded.wire_model,
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens,
  quantization = excluded.quantization, priority = excluded.priority,
  enabled = excluded.enabled, kind = excluded.kind;
