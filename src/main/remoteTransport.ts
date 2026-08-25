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
  /** 当前的 Supabase access token。没登录回 null —— 那就不连 */
  authToken: () => string | null;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export function createSseTransport(opts: SseTransportOpts): RemoteTransport {
  const doFetch = opts.fetchImpl ?? ((u: string | URL | Request, i?: RequestInit) => fetch(u, i));
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const q = `?role=${opts.role}`;

  let onMsg: (p: string) => void = () => {};
  let onPeer: () => void = () => {};
  let onClose: () => void = () => {};

  let closed = false;
  let attempt = 0;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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

  /** SSE 的最小解析:事件之间空行分隔,':' 开头是注释行(控制信道),'data: ' 是载荷 */
  function feed(buf: string): string {
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) return buf; // 半条帧:留着等下一块。TCP 想在哪断就在哪断
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (ev.startsWith(":")) {
        // 控制信道。`:peer` = 对端到场(ADR-0100),`:ok` 开场白,`:` 心跳
        if (ev.slice(1) === "peer") onPeer();
      } else if (ev.startsWith("data: ")) {
        onMsg(ev.slice(6));
      }
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const token = opts.authToken();
    if (!token) {
      log("远程传输:还没登录,不连");
      return; // 登录之后由调用方重新建这条传输
    }
    const ac = new AbortController();
    abort = ac;
    let openedAt: number | null = null;
    try {
      const res = await doFetch(`${base}/rl/v1/stream${q}`, {
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
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = feed(buf + dec.decode(value, { stream: true }));
      }
    } catch {
      // abort 也走这里。closed 时下面不会重连
    }
    if (closed || ac !== abort) return; // 已经被 close 或被更新的一条连接接替
    if (openedAt !== null && Date.now() - openedAt >= STABLE_MS) attempt = 0;
    log("远程传输:流断了");
    onClose();
    scheduleReconnect();
  }

  void connect();

  return {
    send(payload) {
      const token = opts.authToken();
      if (closed || !token) return;
      // 刻意不 await、刻意不因失败触发 onClose:
      // 409(对端不在线)是常态而不是"连接断了",而 send → onClose → startRound
      // → send 会当场变成同步死循环(见 RemoteTransport 的合同)
      void doFetch(`${base}/rl/v1/send${q}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: payload,
      }).then(
        (r) => { if (r.status !== 204 && r.status !== 409) log(`远程传输:上行 ${r.status}`); },
        () => { log("远程传输:上行发不出去"); }
      );
    },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      abort?.abort();
      abort = null;
    },
  };
}
