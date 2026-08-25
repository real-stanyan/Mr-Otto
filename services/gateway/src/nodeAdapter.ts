// node:http ⇄ Web Request/Response 的适配层。
//
// 从 server.ts 里拆出来是有代价换来的:这一层原本被认为"没什么能出错的",
// 直到计划 B 的集成探针在这儿一口气撞出两条 —— 响应头不冲刷(SSE 卡满一个心跳
// 才到客户端)、客户端断开不取消读端(中继的槽位永远占着、心跳定时器永久泄漏)。
// 两条都不可能在 gateway.ts 那侧的 Response 层面被测到,必须有一台真的 http server。
// 拆完之后 server.ts 就只剩读 env 和 listen。

import { type IncomingMessage, type ServerResponse } from "node:http";

export async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function toRequest(req: IncomingMessage, body: Buffer | undefined, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // 客户端消失时**必须**主动取消读端。没有这一句,上游那条 ReadableStream 就永远
  // 活着:对中继来说是槽位永远占着(对端一直拿到 204,而字节进虚空)、25s 心跳的
  // setInterval 每条死连接泄漏一个。ReadableStream 的 cancel 回调不会自己触发 ——
  // 它等的就是这里这一次 reader.cancel()。
  // 单测:tests/gateway/nodeAdapter.test.ts「客户端断开 → 中继的槽位要腾出来」。
  const abort = (): void => { void reader.cancel(); };
  res.on("close", abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 回压:write 返回 false 说明内核缓冲满了,等 drain 再继续,
      // 否则慢客户端会把网关的内存吃光
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          // close 也要解锁:客户端在缓冲满的时候断开,drain 永远不会来
          const wake = (): void => {
            res.off("drain", wake);
            res.off("close", wake);
            resolve();
          };
          res.once("drain", wake);
          res.once("close", wake);
        });
      }
    }
  } catch {
    // 客户端断开:上面的 abort 已经把读端取消了
  } finally {
    res.off("close", abort);
    res.end();
  }
}


/** 把一个 Web 风格的 handler 包成 node:http 的请求回调 */
export function createNodeHandler(
  handle: (req: Request) => Promise<Response>,
  opts: { origin: string; onError?: (err: unknown) => void }
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const response = await handle(toRequest(req, body, opts.origin));
        await writeResponse(res, response);
      } catch (err) {
        opts.onError?.(err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "网关内部错误", type: "otto_gateway" } }));
      }
    })();
  };
}
