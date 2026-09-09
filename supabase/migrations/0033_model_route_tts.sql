-- 0033_model_route_tts.sql —— model_route 加 kind='tts' + 上语音合成那一款（issue #1163）。幂等，重跑不炸。
-- 与 0024–0032 同一约定：Supabase SQL editor / Management API 手动执行一次（多条语句分开发，
-- Management API 一次只回最后一条的结果）。
--
-- 背景：团队云会话里要能开「语音通话」——拉进通话的 agent 之后的回复由 MiniMax
-- speech-2.8-turbo 读出来。路是「桌面 → edge 网关 → MiniMax」，官方 key 只在 Worker
-- secret（同 0031 出图那条路的口径）；网关按路由行的 `kind` 决定打 MiniMax 的 `/t2a_v2`
-- 而不是 `/chat/completions`（`llmGateway.ts` 的 `upstreamPathFor`）。
--
-- **为什么是第三种 kind 而不是复用 image**：`/me` 分三张清单下发（`models` / `imageModels` /
-- `ttsModels`），消费方三不相通——语音行漏进对话选单就是一款点了不干活的型号，漏进出图
-- 清单则 generate_image 会点名它。**顺序上要先部署 worker 再跑本条**（与 0031 相反）：旧 worker 的
-- `parseRouteRows` 对认不出的 kind 按 chat，本条先跑的话这一行会在新 worker 上线之前漏进
-- 对话选单——而它的 `price_out` 比最贵的对话款还高，ADR-0237 的 Auto 拿 `at(-1)` 当 hard 档，
-- 一次难题提问会得到一段 hex。反过来（worker 先）什么都不会发生：没有这一行 = `ttsModels`
-- 为空 = 桌面不画语音钮。
--
-- **价怎么定的**：MiniMax 官网按量计费页（2026-09-09）speech-2.8-turbo = ¥2.00 / 万字符，
-- 计费单位是回包里的 `extra_info.usage_characters`（1 个汉字算 2 个字符，英文字母 / 标点 /
-- 空格 / 回车各算 1，真机对账：41 字汉语句 → 41）。汇率沿用 seed 0017 的 1 USD = 7.2 CNY：
--   ¥2 / 万字符 = ¥200 / 百万字符 → 200 / 7.2 × 1_000_000 = 27_777_778 micro-USD / M 字符
-- 网关把字符数填进 `completion_tokens` 那一格，于是现成的 `costMicro()` 逐字符相等，
-- 算式一个字不用改（同 0032 让 Seedream 按张退化成按 token 的手法）。`price_in` / `price_cache`
-- 填 0：这条路没有输入 token 一说。
--
-- `default_max_tokens` 只是名义值：语音的预扣不走 `estimateMicro`（那条按 body 字节和
-- max_tokens 估），而是按 `ttsUnits(text)` 精确算，所以这一格不参与任何计算；填 400 是
-- 「一段气泡大概几个字符」的量级，给读表的人一个参照。
--
-- base_url 是**国内站** `api.minimaxi.com`：维护者给的 key 在 `.io` 国际站回 2049 invalid api key。

-- ① 认得的值多一种。约束用 check 不用 enum（0031 的理由：加一种改一条 alter 就够）
alter table public.model_route drop constraint if exists model_route_kind_check;
alter table public.model_route add constraint model_route_kind_check check (kind in ('chat', 'image', 'tts'));

-- ② 语音那一款。id 沿用既有的 `<logical>@<platform>` 格式
insert into public.model_route (
  id, logical_model, platform, base_url, wire_model,
  price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m,
  default_max_tokens, quantization, priority, enabled, kind
) values (
  'speech-2.8-turbo@minimax', 'speech-2.8-turbo', 'minimax',
  'https://api.minimaxi.com/v1', 'speech-2.8-turbo',
  0, 0, 27777778,
  400, 'none', 10, true, 'tts'
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
