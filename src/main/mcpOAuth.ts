// MCP OAuth 的 loopback 回调 —— 授权码从浏览器回到主进程的那一段路。
//
// 零 SDK import（ADR-0050 的单点约束）：OAuth 协议本身（元数据发现、动态
// 客户端注册、PKCE、code 换 token、refresh 续期）由 SDK 的 authProvider 走完，
// 这里只解决两个 SDK 不管的问题——"code 怎么从浏览器回来"，以及"回来的
// 这一次是不是我们发出去的那一次"。
//
// 为什么是 loopback 而不是 mrotto:// 深链（spec §3.2）：RFC 8252 的标准做法，
// 动态客户端注册时服务端对 http://127.0.0.1 的 redirect_uri 几乎都接受，
// 而自定义 scheme 有一部分服务端直接拒绝。

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** 等授权的上限。人要在浏览器里登录、可能还要选组织、再点同意——
    一分钟根本不够，五分钟是"正常人走完这套"的宽松上界 */
export const AUTH_TIMEOUT_MS = 5 * 60_000;

export interface LoopbackCallback {
  /** redirect_uri，交给 OAuthClientProvider.redirectUrl */
  readonly redirectUri: string;
  /** 这一次授权的 state，交给 OAuthClientProvider.state() */
  readonly state: string;
  /** 等浏览器回调。校验 state；服务端回错误时抛人话。无论成败都关端口 */
  waitForCode(timeoutMs: number): Promise<string>;
  /** 提前放弃（上游抛了别的错、用户取消） */
  close(): void;
}

type Settled = { code: string } | { error: string };

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startLoopback(): Promise<LoopbackCallback> {
  // 128 位随机。这串同时交给 provider.state() 和下面的校验，
  // 是"这次回调确实来自我们发起的那次授权"的唯一凭据
  const state = randomBytes(16).toString("hex");

  // 回调可能早于 waitForCode 到达：真实时序是 client.connect() 先开浏览器、
  // 抛 UnauthorizedError，调用方接住之后才轮到 waitForCode——中间这段窗口
  // 里用户完全可能已经点完同意了。没有这个缓冲就会丢掉那次回调，然后干等
  // 到超时（一个只在"用户手速快"时复现的 bug，最难查）
  let pending: Settled | null = null;
  let settle: ((r: Settled) => void) | null = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const q = url.searchParams;
    const reply = (text: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Mr Otto</title>` +
          `<body style="font:16px/1.6 system-ui;padding:3rem;max-width:32rem">${text}</body>`
      );
    };
    // 只认第一个回调（#474）：waitForCode 之前若连来两次（浏览器重放/用户
    // 双击），从前 pending 会被后者覆盖、前者静默丢弃——而先到的那次才是
    // 授权服务器真正发的 code
    const done = (r: Settled): void => {
      if (settle) settle(r);
      else pending ??= r;
    };

    // state 不匹配 = 这次回调不是我们发出去的那一次。SDK 的 finishAuth(code)
    // 只收 code、不验 state，所以这道闸只能长在这里——它是 loopback 回调
    // 唯一的防伪造措施（本地端口对同机任何进程都是开着的）
    if (q.get("state") !== state) {
      reply("这次回调的 state 对不上，已拒绝。请回到 Mr Otto 重新发起授权。");
      done({ error: "回调的 state 与本次授权不匹配（可能是伪造的回调，或上一次授权的残留）" });
      return;
    }
    const err = q.get("error");
    if (err !== null) {
      const desc = q.get("error_description");
      reply(`授权未完成：${escapeHtml(err)}。可以关掉这个页面了。`);
      done({ error: `授权服务器拒绝了这次请求：${err}${desc !== null ? `（${desc}）` : ""}` });
      return;
    }
    const code = q.get("code");
    if (code === null || code === "") {
      reply("回调里没有授权码，已放弃。");
      done({ error: "回调里没有 code 参数，这次授权没有完成" });
      return;
    }
    reply("授权完成，回到 Mr Otto 继续。");
    done({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 端口 0 = 让系统挑一个空闲口；只绑 127.0.0.1，不对外
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    server.close();
    throw new Error("loopback 回调端口起不来，无法发起 OAuth 授权");
  }
  const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

  const close = (): void => {
    settle = null;
    server.close();
    // 已经建立的 keep-alive 连接不会被 close() 掐断，浏览器那条常常还挂着。
    // 不断开的话进程退不干净，测试里"关了之后应该连不上"也会偶发不成立
    server.closeAllConnections?.();
  };

  return {
    redirectUri,
    state,
    close,
    waitForCode(timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        const finish = (r: Settled): void => {
          // 只收一次：收完立刻关端口
          close();
          if ("code" in r) resolve(r.code);
          else reject(new Error(r.error));
        };
        if (pending !== null) { finish(pending); return; }
        const timer = setTimeout(() => {
          close();
          reject(new Error(`等授权超时（${Math.round(timeoutMs / 1000)} 秒没等到浏览器回调）`));
        }, timeoutMs);
        settle = (r) => { clearTimeout(timer); finish(r); };
      });
    },
  };
}
