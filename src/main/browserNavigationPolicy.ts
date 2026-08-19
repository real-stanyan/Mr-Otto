// 内置浏览器的三条放行/拦截判断,从 webContentsViewFactory 里拎出来的。
//
// 拎出来的唯一理由是能测:那个文件顶上 import electron,vitest 里根本加载不起来,
// 判断逻辑留在里面就等于永远没有测试。这里只处理"给一个 url / 一组事件参数,
// 放不放行",不碰任何 Electron 对象,是普通纯函数。

/** 取协议名;url 畸形解析不出来时给 null(调用方一律按"不放行"处理——
    一个连协议都认不出的地址,没有理由放它过去) */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** window.open 的目标准不准接进当前 view。
    只认 http(s):browser_read 工具拒绝 file:// 参数,防的就是模型直接读本机文件;
    可一个不可信页面能自己 window.open("file:///…"),照单全收就等于把同一份
    本地文件内容从后门喂给"读当前页"的 agent */
export function isAllowedPopupTarget(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme === "http:" || scheme === "https:";
}

/** 顶层框架准不准导到这个 url。
    要挡的是自定义协议:app 注册了 mrotto:// 处理器(index.ts 的
    setAsDefaultProtocolClient + open-url 监听),回调里带的 code 会被直接喂进
    登录流程(account.ts)。一个不可信页面若能把顶层框架导向
    mrotto://auth-callback?code=…,就等于隔着浏览器往 Otto 的认证流里塞参数。
    about:blank 要放行:它是新建 view 的初始地址,也是页面自己清空框架的常规做法 */
export function isAllowedTopLevelNavigation(url: string): boolean {
  const scheme = schemeOf(url);
  if (scheme === "http:" || scheme === "https:") return true;
  return url === "about:blank";
}

/** did-fail-load 报上来的这一条,算不算"这一页失败了" */
export function shouldReportLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  // 子框架(广告 iframe 之类)加载失败不是这一页失败,报上去只会误导人
  if (!isMainFrame) return false;
  // -3 = ABORTED,用户/我们自己中途换页触发的,不是错
  if (errorCode === -3) return false;
  return true;
}
