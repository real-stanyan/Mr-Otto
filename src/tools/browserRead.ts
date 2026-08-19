// browser_read —— 读内置浏览器的当前页面。纯读不落地,不需要审批(同 web_extract)。
//
// 与 web_extract 的分工:web_extract 走第三方 API 抓公开网页的正文,便宜、无状态;
// 这个走用户自己的浏览器,能读登录态之后的页面、重度 JS 渲染的页面,以及 localhost。
//
// 只读:导航 + 抽正文,不点不打字。工具名里的 read 就是这条边界。

import type { Tool } from "./tool.js";

export const browserReadTool: Tool = {
  def: {
    name: "browser_read",
    description:
      "读内置浏览器页面的正文。给了 url 就先导航过去再读,不给就读用户当前正看的那一页。" +
      "它用的是用户自己的浏览器:能读需要登录的页面、重度 JS 渲染的页面,以及 localhost 上的本地服务。" +
      "公开网页的正文用 web_extract 更省;这个工具留给 web_extract 拿不到的场合。" +
      "导航会改变用户屏幕上正显示的那一页。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的 http(s) 网址。省略 = 读当前页面" },
      },
      required: [],
    },
  },
  requiresApproval: false,

  async run(args, world) {
    const { url } = (args ?? {}) as { url?: unknown };
    if (url !== undefined) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        // file:// 能读到本机任意文件,不该由模型随口指定——要读文件有 read_file,
        // 那条路上有工作区围栏
        throw new Error("browser_read: 参数 url 必须是 http(s) 网址");
      }
    }
    if (!world.browser) {
      throw new Error("browser_read: 这个世界没有内置浏览器");
    }
    const r = await world.browser.read(url === undefined ? {} : { url });
    const head = `# ${r.title || "(无标题)"}\n${r.url}\n\n`;
    // 落地地址和请求地址不一致就明说。这块屏人和 agent 共用,人随时可能在
    // 读取途中把它导去别处;不说的话,下面的正文会被记在一个它并不属于的地址上
    const moved = r.requestedUrl
      ? `[注意：请求的是 ${r.requestedUrl}，实际读到的是 ${r.url}（重定向，或用户在读取过程中切换了页面）。` +
        `以下正文属于 ${r.url}，不要当成 ${r.requestedUrl} 的内容]\n\n`
      : "";
    const tail = r.truncated ? "\n\n[正文超长已截断,以上不是全文]" : "";
    return head + moved + r.text + tail;
  },
};
