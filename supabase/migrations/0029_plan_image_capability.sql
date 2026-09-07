-- 0029_plan_image_capability.sql —— 三个订阅档打开图像能力（issue #1040）。幂等，重跑不炸。
--
-- **这不是补一枚 chip，是开一个从来没开过的功能。** `plan.capabilities.image` 是一道
-- 真闸：`src/main/modelRoute.ts` 的多模态分支在 `hosted.subscribed && wantsVision &&
-- !caps.image && ownKey === ""` 时直接回 `blocked`。而真库里三个档的 image **全是 false**，
-- 于是今天：
--
--   · 付费用户选一款视觉模型且没配自己的 key → 被拦，文案让他「升档」，
--     而**没有任何一档有 image**，这条建议无法执行；
--   · 配了自己 key 的 → 静默改走自己的 key（`hostedOk` 为 false，hosted 分支整个跳过），
--     烧的不是他买的订阅 —— 这正是 ADR-0233 点名不许的那个失败模式的另一种形状。
--
-- 网关此刻供 6 款，其中 `glm-5.3-flash` 与 `qwen3.8-max` 是 supportsVision。
--
-- **`video` 保持 false**：产品上暂时不做视频（维护者 2026-09-07；ADR-0239 决定 3 已经
-- 把「视频」那格从界面上撤掉了）。这一条只开图像。
--
-- `addon` 那一行不动 —— 它是一次性加购的单价，不是档位（/me 下发时就被滤掉）。

update public.plan set capabilities = coalesce(capabilities, '{}'::jsonb) || '{"image": true}'::jsonb
  where id in ('lite', 'pro', 'max');
