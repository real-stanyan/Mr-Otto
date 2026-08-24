// 浏览器在渲染层可见的形态 + URL 归一化。
// 住在 shared/ 的理由同 terminal.ts:三边(main/renderer/preload)共 import,
// 零运行时依赖,不知道背后是 WebContentsView 还是别的什么。

/** 一个会话的浏览器。MVP 一个会话只有一个,但 id 留着——
    将来加多标签时 schema 不用动(向后兼容,同 SessionEvent 的规矩) */
export interface BrowserTabInfo {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 上一次加载失败的人话。成功一次就清掉——
      失败必须看得见,否则面板只是静默白屏 */
  lastError?: string;
}

/** 「选取元素」的结果:页面自证的部分(selector/tag/html/text + React 尽力而为)
    加上主进程补的权威 url。页面侧字段全部过了截断闸门(browserPicker.parsePickPayload) */
export interface BrowserPickedElement {
  selector: string;
  tag: string;
  html: string;
  text: string;
  /** React dev build 的 "文件:行号",生产页没有 */
  source?: string;
  /** React 组件名链(由内向外),dev 尽力而为 */
  components?: string[];
  /** 选中时页面的地址。主进程 getURL() 的权威值,不收页面报的 */
  url: string;
}

/** WebContentsView 的窗口内坐标(DIP)。null = 从窗口上摘下来(面板收起) */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** 地址栏输入 → 可加载的 URL。
    本地地址补 http:本地开发服务器基本不上 TLS,补 https 等于直接连不上,
    而"看 agent 改出来的页面"正是这个浏览器的头号用途。
    LOCAL_HOST 必须先判——"localhost:5173" 本身就满足 HAS_SCHEME(把 "localhost"
    当成了协议名),顺序反了会把本地端口地址原样放行,连不上。 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("请输入网址");
  if (LOCAL_HOST.test(s)) return "http://" + s;
  if (HAS_SCHEME.test(s)) return s;
  return "https://" + s;
}

/** CSS 像素 → DIP。
    渲染层量出来的 getBoundingClientRect 是 CSS 像素,而 WebContentsView.setBounds
    认的是 DIP;两者只在 zoomFactor 恰好为 1 时相等。缩放屏上 Electron 会给渲染层
    一个非 1 的 zoomFactor(实测某台 1.577,devicePixelRatio 3.155 = 2 × 1.577),
    直接把 CSS 像素当 DIP 传下去,网页就落在应有位置的 1/1.577 处、尺寸也缩水同样倍数
    ——症状是"网页整块偏出面板",而不是显而易见的错位,所以值得单独一个函数把它钉住。

    zoomFactor 非正(0 / NaN)时按 1 处理:拿到 0 会把网页缩成一个点,宁可不缩放。 */
export function cssBoundsToDip(bounds: BrowserBounds, zoomFactor: number): BrowserBounds {
  const z = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1;
  return {
    x: Math.round(bounds.x * z),
    y: Math.round(bounds.y * z),
    width: Math.round(bounds.width * z),
    height: Math.round(bounds.height * z),
  };
}
