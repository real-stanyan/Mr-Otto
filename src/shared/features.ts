// 产品形态开关（ADR-0085，2026-08-25 产品转向）。
//
// 两个开关记录同一次决定的两面：官方停止供 token —— 注册赠额取消、
// 模型一律用户自配 key；德州（筹码就是官方额度 token，ADR-0022）随之失去
// 经济基础，整层从 UI 隐藏。
//
// 用编译期常量而不是 env / 远端配置：这是产品形态，不是部署差异 ——
// 每台机器都该长一样。后端（gateway / DB / IPC / 组件）原样保留，
// 翻回来 = 把开关掰回 true + 恢复网关默认赠额（见 ADR-0085 的恢复清单）。

/** 德州扑克：false = 隐藏所有 UI 入口（Game 档、约打牌、牌局邀请、邀请浮层） */
export const POKER_ENABLED = false;

/** 官方赠额/官方额度：false = 选单不列赠额组、账号页不画额度卡、
    路由不再走 otto-gateway —— 没配 key 就是 blocked，出路只有自己配 */
export const OFFICIAL_GRANT_ENABLED = false;
