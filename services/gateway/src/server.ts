// node:http ⇄ Web Request/Response 的桥 + 进程入口。
// 逻辑全在 gateway.ts,这一层只做协议转换和读 env,所以它没有单测——
// 能出错的地方都在被测的那一侧。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { grantFor, TIERS } from "./buckets.js";
import { createGateway, type GatewayConfig } from "./gateway.js";
import { createRelay } from "./relay.js";
import { createSupabaseWallet } from "./wallet.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[otto-gateway] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, body: Buffer | undefined, origin: string): Request {
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

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 回压:write 返回 false 说明内核缓冲满了,等 drain 再继续,
      // 否则慢客户端会把网关的内存吃光
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch {
    // 客户端断开:reader 的 cancel 已经在 gateway 那侧触发了记账
  } finally {
    res.end();
  }
}

const config: GatewayConfig = {
  jwtSecret: required("SUPABASE_JWT_SECRET"),
  upstreamBaseUrl: process.env.OTTO_UPSTREAM_BASE_URL ?? "https://api.deepseek.com/v1",
  upstreamApiKey: required("OTTO_UPSTREAM_API_KEY"),
};

const supabase = {
  url: required("SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
};
const onError = (where: string, err: unknown) =>
  console.error(`[otto-gateway] ${where}:`, err);

const handle = createGateway({
  config,
  wallet: createSupabaseWallet(supabase),
  relay: createRelay(),
  onError,
});

const port = Number(process.env.PORT ?? "8787");

createServer((req, res) => {
  void (async () => {
    try {
      const body = await readBody(req);
      const response = await handle(toRequest(req, body, `http://localhost:${port}`));
      await writeResponse(res, response);
    } catch (err) {
      console.error("[otto-gateway] 未捕获:", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "网关内部错误", type: "otto_gateway" } }));
    }
  })();
}).listen(port, () => {
  console.log(`[otto-gateway] 监听 :${port} → ${config.upstreamBaseUrl}`);
  for (const tier of TIERS) {
    console.log(`[otto-gateway] ${tier} 桶赠额 ${grantFor(tier).toLocaleString("en-US")} token`);
  }
});
