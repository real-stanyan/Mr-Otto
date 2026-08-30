// otto-edge 的地址。共享常量:主进程接线用,手机端也 import 同一份
// (mobile/src/oauth.ts、mobile/src/session.ts)——两个客户端连的必须是同一处。
//
// 这里只有 URL,不是秘密。
//
// ADR-0129 之前它叫 gatewayConfig,基址带 `/v1` 后缀,因为那时这个服务的主业是
// 拿官方 key 代理 OpenAI 兼容的 `/v1/chat/completions`。那条通路删掉之后
// `/v1` 下面一个端点都不剩,基址于是退回到服务根,两个 helper 各自往后拼。

/**
 * 生产地址。Mr Otto 自己那个 Cloudflare 账号下的 worker(ADR-0129)。
 *
 * **改这一行就是一次发版,而且是一次带过渡期的发版。** 它是编译期常量,写死在
 * 每个发出去的包里,而更新走 GitHub releases、不强制 —— 旧安装会在很长一段
 * 时间里继续打旧地址。所以 workers.dev 子域名、worker 名、账号这些都是先定死、
 * 最后才动这一行,不是反过来。
 *
 * 旧地址 `https://otto-auth.stan.damianslife.com/gw` 在过渡期里**仍然活着**:
 * 那台 VPS 上的旧网关还在跑,旧客户端连的是它。两套中继并存,互不相识 ——
 * 所以**桌面和手机必须一起更新**(旧桌面 + 新手机永远配不上对,表现是两边都
 * 显示在线但什么都传不过去)。停机与善后见 #521。
 *
 * 2026-08-30 起换到自有域名(issue #802):`workers.dev` 整域在大陆被 DNS 污染,
 * 老地址对大陆用户从来就不可达。`edge.mrotto.workers.dev` 是**同一个 worker**
 * 的另一个门牌,继续活着服务存量客户端 —— 这次过渡没有第二套服务,只有第二个名字。
 */
export const DEFAULT_EDGE_BASE_URL = "https://edge.mrotto.agency";

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
