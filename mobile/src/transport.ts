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

import { createSseParser } from "../../src/shared/remote/sse.js";
import type { RemoteTransport } from "../../src/shared/remote/transport.js";

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** 连接活满这么久才算"真连上了",退避才归零 —— 只看"拿到 200" 的话,
    一条连上就断的连接会让退避永远停在第一档(同桌面侧 remoteTransport.ts) */
const STABLE_MS = 30_000;

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

  function scheduleReconnect(): void {
    if (closed || timer) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, wait);
  }

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
    };
    req.onerror = finish;
    req.onabort = () => { /* 主动 close,不重连 */ };
    req.onload = finish;

    req.open("GET", `${base}/rl/v1/stream${q}`);
    req.setRequestHeader("authorization", `Bearer ${token}`);
    req.send();
  }

  void connect();

  return {
    send(payload) {
      if (closed) return;
      // 不 await、不因失败触发 onClose:409(对端不在线)是常态而不是"连接断了",
      // 而 send → onClose → startRound → send 会当场变成同步死循环
      void (async () => {
        const token = await opts.authToken();
        if (closed || !token) return;
        const r = await fetch(`${base}/rl/v1/send${q}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: payload,
        });
        if (r.status !== 204 && r.status !== 409) log(`手机传输:上行 ${r.status}`);
      })().catch(() => log("手机传输:上行发不出去"));
    },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      xhr?.abort();
      xhr = null;
    },
  };
}
