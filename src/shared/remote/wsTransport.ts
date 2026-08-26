// RemoteTransport 的真实现:一条 WebSocket,上下行同一条连接。
// **桌面和手机共用这一份**(Electron 主进程和 RN 都有原生 WebSocket)。
//
// 之前是两份 447 行:桌面 fetch 流式 SSE 下行 + POST 上行,手机 XMLHttpRequest
// 增量 responseText 下行 + POST 上行。合得成一份是因为换了协议之后,
// 那两份各自绕开的东西都不存在了(ADR-0129):
//
//   1. **上行队列没了。** 之前两边都维护 `uplink[] + sending` 锁,因为密封流按
//      严格递增的计数器收帧,而并发 POST 的到达顺序由 HTTP 栈说了算 —— 后 seal
//      的先到,先 seal 的就成了"迟到帧"被永久丢弃。WS 是一条连接、有序交付,
//      这个根因消失了,不是被绕过。
//   2. **上行重试没了。** WS 下没有"HTTP 请求失败"这回事:连接活着就发出去了,
//      断了就丢帧 + 重连,靠 `:peer` 重开一轮恢复。
//   3. **4MB 主动回收没了。** 那是 XHR 的 responseText 只增不减留下的后遗症。
//   4. **`:ok` 开场白没了。** 它只是因为 node:http 不写第一个字节就不冲刷响应头。
//      101 响应本身就是信号。
//
// **一户多连接,按 cid 寻址**(ADR-0130):send 必须指名发给哪一条,onMessage 带
// 发件人。收发两个方向同一条帧规则 `<cid> <payload>`(src/shared/remote/wire.ts) ——
// SSE 那版为此加了 `event:` 行和 `v=2` 协商,WebSocket 是离散消息,两样都不需要。
//
// 加密边界:这一层只见 base64url 密文和明文握手包,不认识任何一个字段。

import { CTRL_PING, SUBPROTOCOL, decodeFrame, encodeFrame, parseControl } from "./wire.js";
import type { RemoteTransport } from "./transport.js";

/** 退避阶梯(毫秒)。到顶就一直用 30s —— 不放弃,只是别把服务刷爆 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/** 连接活满这么久才算"这次是真连上了",退避才归零。
    只看"连上了"是不够的:一条连上就断的连接(网络在抖、代理在掐)会让退避
    永远停在第一档,变成 1 秒一次的热循环 */
const STABLE_MS = 30_000;

/** 心跳间隔。中继侧用 setWebSocketAutoResponse 在边缘直接回 `:pong`,
    **不唤醒 DO** —— 所以这个心跳既探得出半开连接,又不产生计费时长 */
const PING_MS = 20_000;

/** 这么久没收到任何字节(含 `:pong`)就当连接已经死了,主动换一条。
    iOS 切后台会把 socket 掐掉而 WebSocket 未必立刻 onclose:表现是
    "手机看着连着、其实什么都收不到",比断线难查得多 */
const SILENT_MS = PING_MS * 2.5;

export interface WsTransportOpts {
  /** 服务根,不含 /rl。例:https://otto-auth.example/gw */
  baseUrl: string;
  role: "desktop" | "mobile";
  /** 当前的 Supabase access token。没登录回 null —— 那就不连。
      异步是因为上游 AccountManager.getAccessToken() 每次读 supabase 的 session
      而不是缓存令牌:令牌会过期,缓存一份等于把"过期"变成一次静默失联 */
  authToken: () => Promise<string | null>;
  /** 注入 WebSocket 实现。测试用;生产上两个运行时都有全局的 */
  wsImpl?: typeof WebSocket;
  log?: (m: string) => void;
}

export function createWsTransport(opts: WsTransportOpts): RemoteTransport {
  const WS = opts.wsImpl ?? WebSocket;
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/rl/v1/connect?role=${opts.role}`;

  let onMsg: (p: string, from: string) => void = () => {};
  let onPeer: (cid: string) => void = () => {};
  let onGone: (cid: string) => void = () => {};
  let onClose: () => void = () => {};
  /** 中继给我们编的号。只用于日志——发帧带的是**收件人**的 cid,不是自己的 */
  let myCid = "";

  let closed = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let openedAt: number | null = null;
  let lastRxAt = 0;

  /**
   * 回调里的异常**不是网络故障**,必须在这里落地。
   *
   * 桥里抛一个异常,如果不拦,会一路窜进 onmessage 的调用栈,被外层当成
   * "连接出问题了"并触发退避重连 —— 连接其实好端端的。
   *
   * 真机联调踩过:Electron 的 BoringSSL 没有 chacha20-poly1305 这个 EVP 名字
   * (见 remoteCryptoNode.ts 的头注),握手一开就抛 Unknown cipher,日志上却显示成
   * 一条条断线 + 1s/2s/5s/15s/30s 退避,把排查带偏了一整轮。
   *
   * 吞掉之后连接继续跑:一帧解不开不该让整条连接陪葬(sealedStream 本来就按帧丢弃)。
   *
   * 这层保护之前**只有桌面那份有**,手机侧是裸调的。合并顺带把它补齐。
   */
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e: unknown) {
      log(`远程传输:${what}的回调抛了(不是断线):${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  }

  function stopBeat(): void {
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
  }

  function scheduleReconnect(): void {
    if (closed || retryTimer) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    log(`远程传输:${wait}ms 后重连`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, wait);
  }

  /** 一条连接走到头。**只有还是当前那条时才算数** —— 否则旧连接的收尾
      会把刚建起来的新连接的状态清掉 */
  function finish(sock: WebSocket, why: string): void {
    if (closed || sock !== ws) return;
    ws = null;
    stopBeat();
    const lived = openedAt === null ? null : Date.now() - openedAt;
    if (lived !== null && lived >= STABLE_MS) attempt = 0;
    openedAt = null;
    log(`远程传输:连接断了(活了 ${lived === null ? "?" : lived}ms,${why})`);
    onClose();
    scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (closed || ws) return;
    const token = await opts.authToken();
    if (closed || ws) return;
    if (!token) {
      // 没登录不连,**也不重连** —— 退避重连一个必然失败的东西没有意义。
      // 出路是登录时由调用方叫 reconnectNow()
      log("远程传输:还没登录,不连");
      return;
    }

    let sock: WebSocket;
    try {
      // token 走子协议的第二个值:标准 WebSocket 构造函数带不了自定义头,
      // 而放 query 参数等于把 access token 写进各层访问日志(见 edge.ts 的注释)
      sock = new WS(url, [SUBPROTOCOL, token]);
    } catch (e: unknown) {
      log(`远程传输:建连接就抛了:${e instanceof Error ? e.message : String(e)}`);
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      if (sock !== ws) return;
      openedAt = Date.now();
      lastRxAt = Date.now();
      stopBeat();
      beat = setInterval(() => {
        if (sock !== ws) return;
        if (Date.now() - lastRxAt > SILENT_MS) {
          // 半开:发得出去、收不回来。close() 会走到 onclose → finish → 重连
          log("远程传输:心跳没回来,当它已经死了");
          try { sock.close(4000, "silent"); } catch { /* 已经在关了 */ }
          return;
        }
        try { sock.send(CTRL_PING); } catch { /* 下一次 onclose 会收拾 */ }
      }, PING_MS);
    };

    sock.onmessage = (ev: MessageEvent) => {
      if (sock !== ws) return;
      lastRxAt = Date.now();
      const data = ev.data;
      if (typeof data !== "string") return; // 载荷是 base64url 文本,二进制帧不该出现
      const ctrl = parseControl(data);
      if (ctrl) {
        switch (ctrl.kind) {
          case "cid":
            myCid = ctrl.cid;
            log(`远程传输:本条连接是 ${myCid}`);
            break;
          case "peer":
            // 握手唯一的起点(ADR-0100)。**每条对端连接各一次** ——
            // 同一个 cid 再来 = 那边重连了,旧密钥作废,桥该重开一轮
            guard("在场信号", () => onPeer(ctrl.cid));
            break;
          case "gone":
            guard("离场信号", () => onGone(ctrl.cid));
            break;
          case "pong":
          case "ping":
            break; // 心跳回声,收下即可
        }
        return;
      }
      // 载荷帧:`<发件人 cid> <密文>`。解不开就丢 —— 线上的字节永远可能是垃圾,
      // 而一帧解不开不该让整条连接陪葬
      const frame = decodeFrame(data);
      if (!frame) {
        log("远程传输:收到一帧解不开的东西,丢了");
        return;
      }
      guard("下行帧", () => onMsg(frame.payload, frame.cid));
    };

    sock.onerror = () => {
      // 浏览器/RN 的 error 事件不带原因(安全考虑)。真正的收尾在 onclose,
      // 这里只留一行日志 —— 断在第几秒、是被谁断的,不记就再也看不到
      log("远程传输:连接报错");
    };

    sock.onclose = (ev: CloseEvent) => {
      finish(sock, `code=${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`);
    };
  }

  void connect();

  return {
    /**
     * 立刻换一条连接,不等退避。两个平台各有各的触发时机,合成同一个方法:
     *
     * - 桌面:**登录那一刻**。没登录时 connect() 直接返回、不排重连,所以没有它
     *   的话,冷启动时未登录的用户登录之后要重开 app 才连得上(issue #484)。
     * - 手机:**回到前台**。iOS 切后台会把 socket 掐掉,而退避的 setTimeout 在
     *   后台也不走 —— 回来最长要再等 30s。
     *
     * 不能拿它当通用重连:退避存在的理由是别把服务刷爆。
     */
    reconnectNow(why: string) {
      if (closed) return;
      log(`远程传输:${why},立刻换一条连接`);
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const dying = ws;
      ws = null; // 先摘,免得 close 触发的 onclose 把它当"当前连接"
      stopBeat();
      openedAt = null;
      myCid = ""; // 换一条连接就换一个号,旧的立刻作废
      if (dying) {
        try { dying.close(1000, "reconnect"); } catch { /* 已经在关了 */ }
        onClose(); // 桥要知道这一轮作废了(密钥跟着连接走)
      }
      attempt = 0; // 主动换,不是失败重试,退避从头算
      void connect();
    },
    send(payload, to) {
      if (closed) return;
      // **必须指名。** 每条对端连接有自己一套会话密钥,发错了对面解不开,
      // 而 sealedStream 的计数器还会把它判成异常(ADR-0130)
      if (!to) {
        log("远程传输:没有收件人,这一帧丢了");
        return;
      }
      const sock = ws;
      // 连接不在/没开:丢掉。**刻意不触发 onClose** —— 对端不在线和连接没建好
      // 都是常态,而 send → onClose → startRound → send 会当场变成同步死循环
      // (见 RemoteTransport 的合同)。丢掉是安全的:重连后中继会重发 `:peer`,
      // 下一轮由那条信号开
      if (!sock || sock.readyState !== 1 /* OPEN */) {
        log("远程传输:连接没开,这一帧丢了");
        return;
      }
      try {
        sock.send(encodeFrame(to, payload));
      } catch (e: unknown) {
        log(`远程传输:上行发不出去:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onGone(cb) { onGone = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      stopBeat();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const dying = ws;
      ws = null;
      if (dying) {
        try { dying.close(1000, "bye"); } catch { /* 已经在关了 */ }
      }
    },
  };
}
