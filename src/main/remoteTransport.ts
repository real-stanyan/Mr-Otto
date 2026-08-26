// RemoteTransport 的真实现:fetch 的 SSE 下行 + POST 上行。
//
// 合同写在 remoteBridge.ts 的 RemoteTransport 注释里,这里只补三条实现侧的理由:
//
// 1. **不用 EventSource / WebSocket。** 部署那侧的 nginx 有 `proxy_set_header
//    Connection '';`(deploy/otto-gateway/nginx-gw-location.conf),upgrade 上不去;
//    而 EventSource 不能带 Authorization 头。fetch 的流式响应两条都绕开了。
// 2. **重连整个归这里。** 桥不做退避、不数次数(与 islandBridge 的 MAX_RESTARTS
//    刻意分歧:那边的子进程生命周期归它自己,这边断开是常态 —— Wi-Fi 切蜂窝、
//    合盖、nginx 到点掐 idle。按次数放弃只会让手机在最正常的场景下永久失联)。
// 3. **重连自己不发任何东西。** 握手由中继的 `:peer` 开(ADR-0100),
//    而新连接 attach 时对端若在线,中继就会写一条 —— 不需要这里补。
//
// 加密边界:这一层只见 base64url 密文和明文握手包,不认识任何一个字段。

import { createSseParser } from "../shared/remote/sse.js";
import type { RemoteTransport } from "./remoteBridge.js";

/** 退避阶梯(毫秒)。到顶就一直用 30s —— 不放弃,只是别把网关刷爆 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/** 连接活满这么久才算"这次是真连上了",退避才归零。
    只看"拿到了 200"是不够的:一条连上就断的连接(网络在抖、代理在掐)
    会让退避永远停在第一档,变成 1 秒一次的热循环 */
const STABLE_MS = 30_000;

export interface SseTransportOpts {
  /** 网关根,不含 /v1。例:https://otto-auth.example/gw */
  baseUrl: string;
  role: "desktop" | "mobile";
  /** 当前的 Supabase access token。没登录回 null —— 那就不连。
      异步是因为上游 AccountManager.getAccessToken() 每次读 supabase 的 session
      而不是缓存令牌:令牌会过期,缓存一份等于把"过期"变成一次静默失联 */
  authToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** 真实现比 RemoteTransport 多一个 retryNow() —— 见它自己的注释。
    不加进 RemoteTransport:那个接口手机端也在实现,而这件事只有桌面有 */
export type SseTransport = RemoteTransport & { retryNow(): void };

export function createSseTransport(opts: SseTransportOpts): SseTransport {
  const doFetch = opts.fetchImpl ?? ((u: string | URL | Request, i?: RequestInit) => fetch(u, i));
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const q = `?role=${opts.role}`;

  let onMsg: (p: string, from: string) => void = () => {};
  let onPeer: (cid: string) => void = () => {};
  let onGone: (cid: string) => void = () => {};
  /** 收到过 `:cid` = 对面是新中继。之后裸 `:peer` 是发给老客户端的,不再理它 */
  let addressed = false;
  /** 中继给这条连接编的 id。发出去的每一帧都带上它,对端才知道是谁发的 */
  let myCid = "";
  let onClose: () => void = () => {};

  let closed = false;
  let attempt = 0;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** connect() 正在跑。**整条流的生命周期**都算在内(它 await 着读循环),
      所以这一个布尔量就够判断"现在有没有一条活着的连接" —— abort 判断不了:
      流结束之后它仍指着那个已经用完的 controller */
  let connecting = false;

  /** 上行队列。同时只发一条,按入队顺序 —— 理由和手机侧那份一字不差:
      密封流按严格递增的计数器收帧,计数器在 seal 那一刻就定了,而并发 POST 的
      到达顺序由 HTTP 栈说了算。后 seal 的先到,先 seal 的那条就成了"迟到帧"
      被永久丢弃。时间线帧是几十 KB 的,最容易被别人抢先 */
  const uplink: { payload: string; to: string }[] = [];
  let sending = false;

  async function pump(): Promise<void> {
    if (sending || closed) return;
    sending = true;
    try {
      while (uplink.length > 0 && !closed) {
        const { payload, to } = uplink[0]!;
        const token = await opts.authToken();
        if (closed) return;
        if (token) {
          try {
            // to 空串 = 老中继(没发过 :cid),不带这个参数走原来的单对端路径
            const url = to
              ? `${base}/rl/v1/send${q}&to=${encodeURIComponent(to)}&from=${encodeURIComponent(myCid)}`
              : `${base}/rl/v1/send${q}`;
            const r = await doFetch(url, {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: payload,
            });
            if (r.status !== 204 && r.status !== 409) log(`远程传输:上行 ${r.status}`);
          } catch {
            log("远程传输:上行发不出去");
          }
        }
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
    log(`远程传输:${wait}ms 后重连`);
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, wait);
  }

  // SSE 的解析在 shared/remote/sse.ts,和手机端共用一份 —— 手机那边的传输是
  // XMLHttpRequest(RN 的 fetch 没有可读的 body 流),拿到的字节一样,解析不该有两份
  const parser = () =>
    createSseParser({
      comment: (kind) => {
        // `:cid <id>` 自己这条连接的 id;`:peer [id]` 对端到场(ADR-0100/0129);
        // `:gone <id>` 对端某条没了;`:ok` 开场白;`` 心跳
        if (kind.startsWith("cid ")) { addressed = true; myCid = kind.slice(4); return; }
        if (kind === "peer") {
          // 裸的那条只在老中继上才算数,见 addressed
          if (!addressed) guard("在场信号", () => onPeer(""));
          return;
        }
        if (kind.startsWith("peer ")) guard("在场信号", () => onPeer(kind.slice(5)));
        else if (kind.startsWith("gone ")) guard("对端离场", () => onGone(kind.slice(5)));
      },
      data: (payload, from) => guard("下行帧", () => onMsg(payload, from)),
    });

  /**
   * 回调里的异常**不是网络故障**,必须在这里落地。
   *
   * 解析器是在读循环里同步调回调的:桥里抛一个异常,它会一路窜出 reader.read()
   * 的 for 循环,落进外层那个本来只该接网络错误的 catch,于是被报成"流断了"
   * 并触发退避重连 —— 连接其实好端端的。
   *
   * 真机联调踩的就是这个:Electron 的 BoringSSL 没有 chacha20-poly1305 这个 EVP 名字
   * (见 remoteCryptoNode.ts 的头注),握手一开就抛 Unknown cipher,日志上却显示成
   * 一条条断线 + 1s/2s/5s/15s/30s 退避,把排查带偏了一整轮。
   *
   * 吞掉之后流继续跑:一帧解不开不该让整条连接陪葬(sealedStream 本来就按帧丢弃)。
   */
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e: unknown) {
      log(`远程传输:${what}的回调抛了(不是断线):${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    connecting = true;
    try {
      await connectOnce();
    } finally {
      connecting = false;
    }
  }

  async function connectOnce(): Promise<void> {
    const token = await opts.authToken();
    if (closed) return;
    if (!token) {
      // 没登录不连,**也不重连** —— 退避重连一个必然失败的东西没有意义。
      // 出路是登录时由调用方叫 retryNow()(index.ts 的 accountManager.onChange)
      log("远程传输:还没登录,不连");
      return;
    }
    const ac = new AbortController();
    abort = ac;
    let openedAt: number | null = null;
    // 断流的原因必须进日志。第一版这里是个空 catch,结果真机联调时
    // "流断了" 是唯一的线索 —— 断在第几秒、是被谁断的,全看不到
    let why = "对端关闭";
    try {
      // v=2 = "我认按 cid 寻址那一套"(ADR-0129)。**必须自己声明**:
      // 老解析器整块前缀匹配,收到两行的事件会整条丢掉 —— 中继不能单方面改格式
      myCid = ""; // 每条新连接一个新 cid,旧的不能带过去
      const res = await doFetch(`${base}/rl/v1/stream${q}&v=2`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      if (res.status !== 200 || !res.body) {
        log(`远程传输:开流失败 ${res.status}`);
        scheduleReconnect();
        return;
      }
      openedAt = Date.now();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const feed = parser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed.push(dec.decode(value, { stream: true }));
      }
    } catch (e: unknown) {
      // abort 也走这里。closed 时下面不会重连
      why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const cause = (e as { cause?: unknown } | null)?.cause;
      if (cause instanceof Error) why += ` ← ${cause.name}: ${cause.message}`;
    }
    if (closed || ac !== abort) return; // 已经被 close 或被更新的一条连接接替
    if (openedAt !== null && Date.now() - openedAt >= STABLE_MS) attempt = 0;
    log(`远程传输:流断了(活了 ${openedAt === null ? "?" : Date.now() - openedAt}ms,${why})`);
    onClose();
    scheduleReconnect();
  }

  void connect();

  return {
    /**
     * 立刻再试一次。唯一的调用场景是**登录**:没登录时 connect() 直接返回、
     * 不排重连,所以没有 retryNow 的话,冷启动时未登录的用户登录之后要重开 app
     * 才连得上(issue #484)。
     *
     * 连接活着 / 已 close 时是空操作;正在退避等待时把等待掐掉马上连 ——
     * 「用户刚登录」是新信息,没有理由再等剩下的 30 秒。
     */
    retryNow() {
      if (closed || connecting) return;
      if (timer) { clearTimeout(timer); timer = null; }
      attempt = 0;
      void connect();
    },
    send(payload, to) {
      if (closed) return;
      // 入队即返回,刻意不因失败触发 onClose:
      // 409(对端不在线)是常态而不是"连接断了",而 send → onClose → startRound
      // → send 会当场变成同步死循环(见 RemoteTransport 的合同)
      uplink.push({ payload, to });
      void pump();
    },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onGone(cb) { onGone = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      uplink.length = 0;
      if (timer) { clearTimeout(timer); timer = null; }
      abort?.abort();
      abort = null;
    },
  };
}
