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
  capabilities = excluded.capabilities,
  -- 故意不刷 stripe_price_id：那一列由维护者在 Stripe 后台建完后手填，重跑 seed 不能把它清回 ''
  updated_at = now();

-- quantization 由 seed 显式声明（不留给列默认值 'none' 隐式决定）：ADR-0175 把它定成必填项，
-- 「unknown」按量化处理——insert 列表里漏了它，excluded.quantization 会静默取列默认值，
-- 每次重跑 seed 都把量化状态悄悄扳回 'none'（round 1 修 enabled/effective_* 时留下的同款坑）。
insert into public.model_route (id, logical_model, platform, base_url, wire_model, price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m, default_max_tokens, quantization, priority)
values
  -- DeepSeek V4 Flash：¥1.00 / ¥0.02 / ¥2.00
  ('deepseek-v4-flash@deepseek', 'deepseek-v4-flash', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash', 138889, 2778, 277778, 8192, 'none', 10),
  -- DeepSeek V4 Pro：¥3.00 / ¥0.025 / ¥6.00（cache 价是异常值，ADR-0174「会被推翻的前提」——核实后改这一行）
  ('deepseek-v4-pro@deepseek', 'deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', 416667, 3472, 833333, 8192, 'none', 10),
  -- GLM-5.3：¥8.00 / ¥2.00 / ¥28.00（2026-09-07 智谱定价页现价，已核）。
  --   改前这一行是照 **GLM-5.1** 的 ¥6 / ¥1.3 / ¥24 抄的，少算输入 25%、缓存 35%、输出 14%——
  --   窗口按 micro-USD 计，价目就是 token 换算成窗口百分比的汇率，填低了等于我们贴差额（#1003）。
  --   直接改现有行、不靠 effective_* 排期：那两列在 routesQuery 里没有过滤（billingQueries.ts:106），
  --   填一行「将来生效」的价会当场被用上
  ('glm-5.3@zhipu', 'glm-5.3', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 1111111, 277778, 3888889, 8192, 'none', 10),
  -- GLM-5.3-Flash：¥0.80 / ¥0.23 / ¥2.80（2026-09-07 智谱定价页原价；页面上另挂着「5折限时两周」的
  --   ¥0.40 / ¥0.115 / ¥1.40，**按原价登记**——促销到期那天按促销价记账就成了低于真实成本扣额度）
  ('glm-5.3-flash@zhipu', 'glm-5.3-flash', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 111111, 31944, 388889, 8192, 'none', 10),
  -- 千问 = 阿里云百炼 DashScope **国际站**：官方直接报 USD，不像智谱/DeepSeek 那样按 7.2 折算。
  --   缓存命中价 = 输入价的 10%（官方原文 "cache hits at 10%"）。
  --   只收**全程一个价**的两款：model_route 一款只有一组价，表达不了按上下文长度分档，
  --   而 qwen3.7-flash 是 $0.03/$0.10/$0.20 三档——登记成最便宜那档 = 长上下文时少扣自己的钱。
  -- Qwen3.8-Max：$2 / $0.20 / $6
  ('qwen3.8-max@qwen', 'qwen3.8-max', 'qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max', 2000000, 200000, 6000000, 8192, 'none', 10),
  -- Qwen3.8-Flash：$0.15 / $0.015 / $0.47
  ('qwen3.8-flash@qwen', 'qwen3.8-flash', 'qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.8-flash', 150000, 15000, 470000, 8192, 'none', 10)
on conflict (id) do update set
  platform = excluded.platform,
  base_url = excluded.base_url,
  wire_model = excluded.wire_model,
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens,
  quantization = excluded.quantization,
  priority = excluded.priority;
  -- 故意不刷 enabled / effective_from / effective_to：那三列是运维在 DB 里手动切换的开关，重跑 seed 不能把它们扳回去
