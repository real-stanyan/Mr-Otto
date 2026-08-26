// node:http ⇄ Web Request/Response 的桥 + 进程入口。
// 逻辑全在 edge.ts,这一层只做协议转换和读 env,所以它没有单测——
// 能出错的地方都在被测的那一侧。
//
// 这个进程是 VPS 部署形态的入口。ADR-0129 之后它是**过渡件**:
// Cloudflare Worker 的入口落地(#518)之前,生产上跑的仍然是这个,
// 而 main 上必须留一份能构建的源码 —— 否则过渡期里想在旧网关上改点什么
// 会发现无从构建。#518 落地时连同 nodeAdapter.ts 一起删。

import { createServer } from "node:http";
import { createEdge, type EdgeConfig } from "./edge.js";
import { createNodeHandler } from "./nodeAdapter.js";
import { createRelay } from "./relay.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[otto-edge] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

const config: EdgeConfig = {
  jwtSecret: required("SUPABASE_JWT_SECRET"),
};

const handle = createEdge({ config, relay: createRelay() });

const port = Number(process.env.PORT ?? "8787");

createServer(createNodeHandler(handle, {
  origin: `http://localhost:${port}`,
  onError: (err) => console.error("[otto-edge] 未捕获:", err),
})).listen(port, () => {
  console.log(`[otto-edge] 监听 :${port}(落地页 + 远程中继)`);
});
