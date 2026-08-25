// node:http ⇄ Web Request/Response 的桥 + 进程入口。
// 逻辑全在 gateway.ts,这一层只做协议转换和读 env,所以它没有单测——
// 能出错的地方都在被测的那一侧。

import { createServer } from "node:http";
import { grantFor, TIERS } from "./buckets.js";
import { createGateway, type GatewayConfig } from "./gateway.js";
import { createNodeHandler } from "./nodeAdapter.js";
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

createServer(createNodeHandler(handle, {
  origin: `http://localhost:${port}`,
  onError: (err) => console.error("[otto-gateway] 未捕获:", err),
})).listen(port, () => {
  console.log(`[otto-gateway] 监听 :${port} → ${config.upstreamBaseUrl}`);
  for (const tier of TIERS) {
    console.log(`[otto-gateway] ${tier} 桶赠额 ${grantFor(tier).toLocaleString("en-US")} token`);
  }
});
