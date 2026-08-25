// OAuth 落地页：GoTrue 授权完成后浏览器先到这，再由本页转发深链唤起 app。
//
// 为什么要这一跳：redirect_to 直接指 mrotto:// 时，浏览器把深链丢给系统后
// 标签页原地不动——用户盯着 Google 的账号选择页以为"卡住了"（实际 app 已
// 登录成功）。落地页给浏览器一个明确的终点：显示结果 + JS 转发 code。
//
// code 只在 URL query 里过一手，页面不存不发；换 token 发生在 app 内
// （PKCE，code 单独没有 verifier 换不出任何东西）。

import { OTTO_MARK_DATA_URI } from "./ottoMark.js";

/** 深链前缀。app 侧的解析在 src/main/account.ts parseAuthCallback，两边要一致 */
const DEEP_LINK = "mrotto://auth-callback";

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mr Otto 登录</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #101014; color: #f2f2f5;
  }
  @media (prefers-color-scheme: light) { body { background: #fafafa; color: #1c1c1e; } }
  main { text-align: center; padding: 32px; max-width: 420px; }
  /* 这一屏是 app 的门口:摆 app 自己的 logo,不是随便一个水獭 emoji
     （emoji 由系统字体渲染,每个平台长得都不一样,更谈不上是我们的标识）。
     圆角同 app 内的图标块,尺寸取 56 —— 比标题重,但不至于喧宾夺主 */
  .mark { width: 56px; height: 56px; border-radius: 14px; display: block; margin: 0 auto; }
  h1 { font-size: 19px; margin: 14px 0 8px; }
  p { font-size: 14px; opacity: .75; line-height: 1.6; margin: 0; }
  a.open {
    display: inline-block; margin-top: 18px; padding: 9px 18px; border-radius: 10px;
    background: #4f7cf7; color: #fff; text-decoration: none; font-size: 14px;
  }
</style>
</head>
<body>
<main id="main"><img class="mark" src="${OTTO_MARK_DATA_URI}" alt="Mr Otto"><h1>正在回到 Mr Otto…</h1><p>请稍候</p></main>
<script>
  (function () {
    // 重绘时复用同一份 data URI:两个分支各内联一份等于把 10KB 抄两遍
    var MARK = document.querySelector(".mark").src;
    var q = new URLSearchParams(location.search);
    var main = document.getElementById("main");
    if (q.has("code")) {
      var target = ${JSON.stringify(DEEP_LINK)} + location.search;
      main.innerHTML =
        '<img class="mark" src="' + MARK + '" alt="Mr Otto"><h1>登录成功</h1>' +
        '<p>已回到 Mr Otto，本页可以关掉了。<br>如果 app 没有自己跳出来，点下面的按钮。</p>' +
        '<a class="open" href="' + target + '">打开 Mr Otto</a>';
      // 自动唤起放在渲染之后:location.replace 触发系统弹"打开 Mr Otto?"确认框,
      // 页面内容此刻已经是成功态,不会出现空白页顶着确认框的样子
      location.replace(target);
    } else {
      var reason = q.get("error_description") || q.get("error") || "回调里没有授权码";
      main.innerHTML =
        '<img class="mark" src="' + MARK + '" alt="Mr Otto"><h1>登录没成功</h1>' +
        '<p>' + reason.replace(/[<>&]/g, "") + '</p>' +
        '<p style="margin-top:10px">回 Mr Otto 里重新点一次登录即可。</p>';
    }
  })();
</script>
</body>
</html>`;

/** GET /auth/landing。无鉴权：这是浏览器裸访问的公开页面 */
export function authLandingResponse(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // code 是一次性敏感参数,这页不该被任何中间层缓存
      "cache-control": "no-store",
    },
  });
}
