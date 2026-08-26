// otto-edge 的地址。共享常量:主进程接线用,手机端也 import 同一份
// (mobile/src/oauth.ts、mobile/src/session.ts)——两个客户端连的必须是同一处。
//
// 这里只有 URL,不是秘密。
//
// ADR-0129 之前它叫 gatewayConfig,基址带 `/v1` 后缀,因为那时这个服务的主业是
// 拿官方 key 代理 OpenAI 兼容的 `/v1/chat/completions`。那条通路删掉之后
// `/v1` 下面一个端点都不剩,基址于是退回到服务根,两个 helper 各自往后拼。

/** 生产地址。ADR-0129 的迁移落地(#519)时改成 workers.dev 那一个 */
export const DEFAULT_EDGE_BASE_URL = "https://otto-auth.stan.damianslife.com/gw";

/**
 * 覆盖用的环境变量。本地起服务调试时用(例:`http://127.0.0.1:8787`)。
 *
 * **这个机制别删**:生产地址是编译期常量,写死在每个发出去的包里,回滚它得发新包
 * (GitHub releases,还不强制)。出事时让用户设一个环境变量指回旧地址,是唯一
 * 不用等新包过审的退路(ADR-0129 的回滚一节)。
 */
export const EDGE_BASE_URL_ENV = "OTTO_EDGE_URL";

export function edgeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env[EDGE_BASE_URL_ENV] ?? DEFAULT_EDGE_BASE_URL).replace(/\/+$/, "");
}

/**
 * OAuth 落地页（edge 的 GET /auth/landing）。
 * OAuth 的 redirect_to 指它而不是直接指 mrotto:// 深链：浏览器渲染不了深链，
 * 标签页会停在 Google 的旧页面上像卡死；落地页给流程一个看得见的终点，
 * 再由页内 JS 转发 code 唤起 app（services/edge/src/authLanding.ts）。
 * 跟着 edgeBaseUrl 走：本地起服务调试时全链路照样通。
 */
export function authLandingUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${edgeBaseUrl(env)}/auth/landing`;
}

/** 远程中继的根(`/rl/v1/*` 挂在这里)。跟着 edgeBaseUrl 走 */
export function relayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return edgeBaseUrl(env);
}
