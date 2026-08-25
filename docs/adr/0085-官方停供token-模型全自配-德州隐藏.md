# ADR-0085: 官方停止供 token —— 注册赠额取消、模型全用户自配、德州从 UI 隐藏

日期：2026-08-25
状态：已接受（stanyan 会话指示，issue #384）

## 决定

1. **注册赠额归零**：网关 `DEFAULT_GRANTS` 从 flash 500 万 / pro 100 万 改为 0 / 0。
   发放机制（`grant_tokens`、幂等 ledger、env 覆盖）原样保留，已发出去的余额不动。
2. **官方不再提供任何 token**：客户端整条「官方赠额/官方额度」通路隐藏 ——
   选单不列赠额组、账号页不画额度卡、路由不再走 otto-gateway。
   模型一律用户自配 key（BYO），免 key 的本机 Ollama 不受影响。
3. **德州扑克从 UI 隐藏**：Game 档、牌桌导航、约打牌、牌局邀请（抽屉 + 浮层 + 角标）
   全部不再出现。后端（gateway poker、DB migrations、IPC、组件代码）原样保留。

## 实现取向

`src/shared/features.ts` 两个编译期常量：`POKER_ENABLED = false`、
`OFFICIAL_GRANT_ENABLED = false`。结构性入口按开关藏；静态文案（DeepSeek blurb、
设置页 key 说明）直接改——文案跟产品事实走，不跟开关走。
`routeModel` 增加 `officialGrant?: boolean` 参数（缺省读开关）：两种形态的
路由规矩都钉在测试里。

## 理由

- 注册口子是敞开的（issue #122 已因此降过一轮赠额），赠额 × 任何人都能注册 =
  持续漏钱；产品转向 BYO 模型后，官方供 token 失去存在理由。
- 德州的筹码就是官方额度 token（ADR-0022 桶内零和）：赠额归零后新用户
  无码可买，功能失去经济基础，藏比留着一个"永远买不起"的入口诚实。
- 用开关而不是删除：是产品形态决定，不是代码质量决定；后端与组件保留，
  翻回来成本 = 掰开关 + 恢复网关默认赠额。

## 被本 ADR 调整的既有决定

- ADR-0019（官方 key 藏在网关后）/ ADR-0021（token 计价桶）/ ADR-0045（赠额是明路）：
  机制未推翻，**产品形态下不再启用**。ADR-0020（自带 key 优先）自然成为唯一路径。
- ADR-0022 / 0024 / 0027 / 0082（德州系）：功能整层休眠，决定本身不动。

## 恢复清单（若将来翻回）

1. `src/shared/features.ts` 两个开关掰回 `true`
2. `services/gateway/src/buckets.ts` `DEFAULT_GRANTS` 恢复非零（并改回
   `tests/gateway/buckets.test.ts` 的零值断言为成本区间断言）
3. `tests/renderer/pendingAttention.test.ts` 邀请计数断言恢复
4. 静态文案（providerCatalog blurb、ModelProviderSettings 说明）按需恢复
5. 网关侧若用 env `OTTO_GRANT_*_TOKENS` 临时开过，记得清掉

## 会被推翻的前提

「官方不供 token」若因商业化（付费充值等）重新成立，本 ADR 的第 1、2 条失效；
届时德州是否随之恢复是独立决定。
