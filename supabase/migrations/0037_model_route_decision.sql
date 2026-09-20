-- 0037_model_route_decision.sql —— model_route 加 kind='decision' + 上决策模型 Jev 那一款（issue #1281）。幂等，重跑不炸。
-- 与 0024–0036 同一约定：Supabase SQL editor / Management API 手动执行一次（多条语句分开发，
-- Management API 一次只回最后一条的结果）。
--
-- **顺序：先部署 edge worker，再跑本条。反过来是一次事故，不是一次小毛病。**
-- 旧 worker 的 `parseRouteRows` 对认不出的 kind 按 chat 处理（那是故意的：一个拼错的 kind
-- 不该让一款模型从网关上消失），而这一行的 `price_out` 是 **0**、`routesQuery` 按
-- `priority, price_out, id` 升序——本条先跑的话，这一行会在新 worker 上线之前排到
-- `me.models[0]`，也就是**所有订阅用户的默认聊天款 + Auto 的 simple 档**（ADR-0237：
-- 「默认款 = 最便宜那款，是个承诺」），而它压根不会聊天：每一条没指定型号的消息都会 502。
-- 0033 的头注写过同一条规则（那次是语音行漏进选单当 hard 档），这一次锋利得多——那次漏的
-- 是清单的末尾，这次漏的是开头。反过来（worker 先）什么都不会发生：没有这一行 =
-- `me.decision.models` 为空 = 三端五处全部按原样走。
--
-- 背景：Otto 里有五处拿便宜聊天模型当分类器（派活 / Auto 判难度 / 云会话重命名 / 语音断句 /
-- 记忆分档）。Jev（TypeSafe AI，2026-09-15 发布）不生成文字，收 state + 一组类型化问题，
-- 一次前向回类型化答案 + 校准概率。路是「桌面 / runtime → edge 网关 `/llm/v1/decision` →
-- OpenRouter 的 Decisions 端点」，官方 key 只在 Worker secret（`OPENROUTER_API_KEY`，出图那条路
-- 已经在用的那一把）。网关按路由行的 `kind` 决定打 `/decisions`（`upstreamPathFor`）。
--
-- **这一行上线之后五处仍然全关**：真正的开关是 edge 里的常量 `DECISION_USES`
-- （services/edge/src/decisionUses.ts，初始 `{}`），随 `/billing/v1/me` 下发三端。这一行只回答
-- 「网关供不供」，那张表回答「哪一处开着哪一档」。停掉整条路：把这一行 `enabled` 改成 false。
--
-- **价怎么定的**：OpenRouter 模型页（2026-09-20）`typesafe/jev-1.13` = $0.042 / 百万输入 token，
-- 输出免费。本仓 micro = 1e-6 美元（对过 0031 那行 `$60/M ↔ 60000000`）→ `price_in = 42000`，
-- `price_cache = 0`（这条路没有 cache 一说）、`price_out = 0`。网关只把上游报的 `input_tokens`
-- 填进 `prompt_tokens`，于是现成的 `costMicro()` 一个字不用改。量级：一次派活判定约 300–800
-- 输入 token ≈ 13–34 micro。
--
-- `default_max_tokens` 只是名义值：决策的预扣不走 `estimateMicro`（那条按 max_tokens 顶格估
-- 输出），而是按请求体字节 ÷ 3 估输入，所以这一格不参与任何计算；填 1 只为过表上的正数约束。
--
-- `base_url` 里真的有 `alpha`：OpenRouter 把这个端点挂在 `/api/alpha/decisions`（2026-09-20 实测：
-- 不带凭据打过去回 401，`/api/v1/decisions` 回 404）。它改路径那天，三端五处一起回落到原来
-- 那条 LLM 路——不会坏，只是安静地失效；改这一行的 `base_url` 即可，不用发版。

-- ① 认得的值多一种。约束用 check 不用 enum（0031 的理由：加一种改一条 alter 就够）
alter table public.model_route drop constraint if exists model_route_kind_check;
alter table public.model_route add constraint model_route_kind_check check (kind in ('chat', 'image', 'tts', 'decision'));

-- ② 决策那一款。id 沿用既有的 `<logical>@<platform>` 格式
insert into public.model_route (
  id, logical_model, platform, base_url, wire_model,
  price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m,
  default_max_tokens, quantization, priority, enabled, kind
) values (
  'jev-1.13@openrouter', 'jev-1.13', 'openrouter',
  'https://openrouter.ai/api/alpha', 'typesafe/jev-1.13',
  42000, 0, 0,
  1, 'none', 10, true, 'decision'
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
