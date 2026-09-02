-- supabase/seed/0017_plans_routes.sql
-- 档位与首批路由。**价格是抄的**（2026-09-02，DeepSeek 官网 CNY 价 + ADR-0175 表；
-- GLM-5.3 按 GLM-5.1 价抄，待核），汇率按 1 USD = 7.2 CNY 折。
-- 抄表日期比价格本身重要——改价直接 update 这几行，不发版。
-- stripe_price_id 由维护者在 Stripe 后台建完 Product/Price 后填。
--
-- 换算：CNY X /M → micro-USD/M = round(X / 7.2 * 1_000_000)

insert into public.plan (id, price_usd_cents, monthly_budget_micro, week_limit_micro, window5h_limit_micro, addon_unit_micro, capabilities)
values
  ('lite', 1900, 13300000, 3325000, 665000, 0, '{"image":false,"video":false}'),
  ('pro',  5900, 41300000, 10325000, 2065000, 0, '{"image":false,"video":false}'),
  ('max',  8900, 62300000, 15575000, 3115000, 0, '{"image":false,"video":false}'),
  -- 加购：一个单位 $10，折 70% = 7 USD credit
  ('addon', 1000, 0, 0, 0, 7000000, '{}')
on conflict (id) do update set
  price_usd_cents = excluded.price_usd_cents,
  monthly_budget_micro = excluded.monthly_budget_micro,
  week_limit_micro = excluded.week_limit_micro,
  window5h_limit_micro = excluded.window5h_limit_micro,
  addon_unit_micro = excluded.addon_unit_micro,
  updated_at = now();

insert into public.model_route (id, logical_model, platform, base_url, wire_model, price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m, default_max_tokens, priority)
values
  -- DeepSeek V4 Flash：¥1.00 / ¥0.02 / ¥2.00
  ('deepseek-v4-flash@deepseek', 'deepseek-v4-flash', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash', 138889, 2778, 277778, 8192, 10),
  -- DeepSeek V4 Pro：¥3.00 / ¥0.025 / ¥6.00（cache 价是异常值，ADR-0174「会被推翻的前提」——核实后改这一行）
  ('deepseek-v4-pro@deepseek', 'deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', 416667, 3472, 833333, 8192, 10),
  -- GLM-5.3：按 GLM-5.1 ¥6.00 / ¥1.30 / ¥24.00 抄，待核
  ('glm-5.3@zhipu', 'glm-5.3', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 833333, 180556, 3333333, 8192, 10)
on conflict (id) do update set
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens;
