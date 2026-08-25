// 手机端的 RemoteTransport。与桌面同一个契约,不同的实现手段:
//
// **RN 的 fetch 没有可读的 body 流** —— `res.body` 是 undefined(Hermes 上 fetch
// 建在 XHR 之上)。所以下行走 XMLHttpRequest 的增量 `responseText`:
// readyState 3(LOADING)期间它会一段一段变长,记住上次读到哪儿,把新增那截喂给
// 共用的 SSE 解析器(src/shared/remote/sse.ts —— 解析只有一份,两端拿到的字节一样)。
//
// 也**不用 EventSource**:RN 有 polyfill,但它带不了 Authorization 头,
// 而中继按 Supabase JWT 认人。
//
// 上行用普通 fetch POST(没有流,fetch 够用)。

import { AppState, type NativeEventSubscription } from "react-native";

import { createSseParser } from "../../src/shared/remote/sse.js";
import type { RemoteTransport } from "../../src/shared/remote/transport.js";

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** 连接活满这么久才算"真连上了",退避才归零 —— 只看"拿到 200" 的话,
    一条连上就断的连接会让退避永远停在第一档(同桌面侧 remoteTransport.ts) */
const STABLE_MS = 30_000;

/** responseText 到这么大就主动换一条连接。
    XHR 的下行是**只增不减**的一个字符串:这条流永远不结束,`responseText`
    于是把这次连接收到的每一帧都攒着,而时间线帧是几十 KB 一条、每次更新推一次。
    读增量要 `.slice(read)`,在 Hermes 上会把 rope 摊平 —— 攒得越久,每来一帧
    越慢,内存也一直涨。主动回收比等它拖垮 JS 线程好:重连只是一次握手。 */
const RECYCLE_BYTES = 4 * 1024 * 1024;

export function createXhrTransport(opts: {
  baseUrl: string;
  authToken: () => Promise<string | null>;
  log?: (m: string) => void;
}): RemoteTransport {
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const q = "?role=mobile";

  let onMsg: (p: string) => void = () => {};
  let onPeer: () => void = () => {};
  let onClose: () => void = () => {};

  let closed = false;
  let attempt = 0;
  let xhr: XMLHttpRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 上行队列。**同时只发一条,按入队顺序。**
   *
   * 不是为了省资源,是正确性:密封流(sealedStream.ts)按严格递增的计数器收帧,
   * 计数器在 seal 的那一刻就定了,而并发的 POST 到达顺序由 NSURLSession 说了算 ——
   * 后 seal 的先到,先 seal 的那条就成了"迟到帧",被**永久丢弃**。
   * 单帧的时候这个洞看不见(一条一条发,中间隔着人的操作);附件一分片就是
   * 连着几十帧,当场就会撞上。
   *
   * 失败重试两次:丢一片 = 整个附件在桌面那侧作废,而一次瞬时的网络抖动
   * 不该让用户重选一遍文件。重试仍然按顺序 —— 队列没往前走。
   */
  const uplink: string[] = [];
  let sending = false;

  async function pump(): Promise<void> {
    if (sending || closed) return;
    sending = true;
    try {
      while (uplink.length > 0 && !closed) {
        const payload = uplink[0]!;
        let ok = false;
        for (let tryNo = 0; tryNo < 3 && !closed && !ok; tryNo += 1) {
          const token = await opts.authToken();
          if (closed) return;
          if (!token) break;
          try {
            const r = await fetch(`${base}/rl/v1/send${q}`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: payload,
            });
            // 409 = 对端不在线。**这不是可重试的失败**,重试只是把同一帧
            // 再喂一次虚空;桌面重连后会自己重开一轮,那时手机会重发该发的
            if (r.status === 204 || r.status === 409) ok = true;
            else log(`手机传输:上行 ${r.status}`);
          } catch {
            log("手机传输:上行发不出去");
          }
        }
        if (!ok) log("手机传输:一帧上行放弃了(重试三次都没成功)");
        uplink.shift();
      }
    } finally {
      sending = false;
    }
  }

  function scheduleReconnect(): void {
    if (closed || timer) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, wait);
  }

  /**
   * 立刻换一条连接,不等退避。
   *
   * 只给两个**已知连接不可用**的调用者用:回前台(见下),和 responseText 撑太大。
   * 不能拿它当通用重连 —— 退避存在的理由是别把网关刷爆。
   */
  function reconnectNow(why: string): void {
    if (closed) return;
    log(`手机传输:${why},立刻换一条连接`);
    if (timer) { clearTimeout(timer); timer = null; }
    const dying = xhr;
    xhr = null;          // 先摘,免得 abort 触发的回调把它当"当前连接"
    dying?.abort();
    attempt = 0;         // 这不是失败重试,是主动换,退避从头算
    onClose();           // 桥要知道这一轮作废了(密钥跟着连接走)
    void connect();
  }

  /**
   * 回前台就换一条连接。
   *
   * iOS 会在切后台时把 socket 掐掉,**但 XHR 未必知道**:回来时它可能还停在
   * readyState 3,既不报错也再不来一个字节 —— 桥那侧仍然是 ready,发出去的
   * 每一帧都 409,而屏幕上一切正常。这是"手机看着连着、其实什么都收不到"
   * 的唯一成因,比断线难查得多。
   *
   * 反过来,就算 socket 真断了,退避的 setTimeout 在后台也不走 —— 回来最长
   * 要再等 30s。两种情况一条修法:回前台一律重连,不去猜旧连接还活着没有。
   */
  const appState: NativeEventSubscription = AppState.addEventListener("change", (next) => {
    if (next === "active") reconnectNow("回到前台");
  });

  async function connect(): Promise<void> {
    if (closed) return;
    const token = await opts.authToken();
    if (closed) return;
    if (!token) {
      log("手机传输:还没登录,不连");
      return; // 登录之后由调用方重建这条传输
    }

    const req = new XMLHttpRequest();
    xhr = req;
    let read = 0;
    let openedAt: number | null = null;
    const feed = createSseParser({
      comment: (kind) => { if (kind === "peer") onPeer(); },
      data: (payload) => onMsg(payload),
    });

    const finish = (): void => {
      if (closed || req !== xhr) return; // 已 close,或已被更新的一条连接接替
      if (openedAt !== null && Date.now() - openedAt >= STABLE_MS) attempt = 0;
      onClose();
      scheduleReconnect();
    };

    req.onreadystatechange = () => {
      // 已被 close / reconnectNow 换掉的那条连接,后续事件一律不算数
      if (closed || req !== xhr) return;
      if (req.readyState === 2) {
        // 头到了。网关开流就写一个字节(`:ok`),所以这一步不会卡到第一次心跳
        if (req.status !== 200) log(`手机传输:开流失败 ${req.status}`);
        else openedAt = Date.now();
        return;
      }
      if (req.readyState !== 3 && req.readyState !== 4) return;
      if (req.status !== 200) return;
      // 增量:responseText 一直在变长,只取上次之后新增的那一截
      const text = req.responseText;
      if (text.length > read) {
        feed.push(text.slice(read));
        read = text.length;
      }
      // 回收放在喂完之后:手里这一截先交出去,一帧都不丢
      if (read >= RECYCLE_BYTES) reconnectNow(`这条连接攒到 ${Math.round(read / 1024)}KB`);
    };
    req.onerror = finish;
    req.onabort = () => { /* 主动摘的(close 或 reconnectNow),两条路都已自己安排好后续 */ };
    req.onload = finish;

    req.open("GET", `${base}/rl/v1/stream${q}`);
    req.setRequestHeader("authorization", `Bearer ${token}`);
    req.send();
  }

  void connect();

  return {
    send(payload) {
      if (closed) return;
      // 入队即返回,失败不触发 onClose:409(对端不在线)是常态而不是"连接断了",
      // 而 send → onClose → startRound → send 会当场变成同步死循环
      uplink.push(payload);
      void pump();
    },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      uplink.length = 0;
      appState.remove();
      if (timer) { clearTimeout(timer); timer = null; }
      xhr?.abort();
      xhr = null;
    },
  };
}
