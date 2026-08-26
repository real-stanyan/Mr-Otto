// 中继的真机自检。**跑在任何一台能看见目标地址的机器上**——它现签一个短命 token,
// 所以要能拿到 SUPABASE_JWT_SECRET(env 或 .dev.vars)。
//
//   node checks/relay.mjs                       # 打生产（默认）
//   node checks/relay.mjs http://127.0.0.1:8799 # 打本地 wrangler dev
//
// 为什么要有它:单测跑的是纯逻辑 + 一个照着 worker.ts 写的假 DO,**覆盖不到
// 运行时那一层**——acceptWebSocket 的休眠语义、tag 存取、101 响应的形状、
// 子协议 echo。那几件事只有真 workerd 说了算,而它们坏掉的样子是"连上了但
// 什么都不发生",没有报错。
//
// 它不写库、不留痕:user_id 是现场生成的随机 uuid,中继本来就不落盘。

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://mrotto-edge.workers.dev").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const SUBPROTOCOL = "mrotto.v1";
const PEER = ":peer";
const PING = ":ping";
const PONG = ":pong";
const MAX_FRAME = 256 * 1024;

function secret() {
  if (process.env.SUPABASE_JWT_SECRET) return process.env.SUPABASE_JWT_SECRET;
  // 本地 wrangler dev 用 .dev.vars
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n").find((l) => l.startsWith("SUPABASE_JWT_SECRET="));
    if (line) return line.slice("SUPABASE_JWT_SECRET=".length).trim();
  } catch { /* 没有就往下报错 */ }
  console.error("没有 SUPABASE_JWT_SECRET —— 传 env 或放进 services/edge/.dev.vars");
  process.exit(2);
}
const SECRET = secret();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (sub) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, email: "check@local", exp: Math.floor(Date.now() / 1000) + 120 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
};

const ok = [];
const bad = [];
const check = (name, cond, extra = "") => (cond ? ok : bad).push(`${name}${extra ? " — " + extra : ""}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(role, sub) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS_BASE}/rl/v1/connect?role=${role}`, [SUBPROTOCOL, token(sub)]);
    ws.rx = [];
    ws.onmessage = (e) => ws.rx.push(e.data);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error(`${role} 连不上 ${WS_BASE}`));
  });
}

// ---- 落地页与路由 ----
const land = await fetch(`${BASE}/auth/landing?code=probe`);
check("落地页 200 + HTML", land.status === 200 && (land.headers.get("content-type") ?? "").includes("text/html"));
check("落地页含深链转发", (await land.text()).includes("mrotto://auth-callback"));
check("healthz 200", (await fetch(`${BASE}/healthz`)).status === 200);
check("未知路径 404", (await fetch(`${BASE}/nope`)).status === 404);
check("非 upgrade 打中继 → 426", (await fetch(`${BASE}/rl/v1/connect?role=desktop`)).status === 426);

// ---- 鉴权 ----
const noAuth = await new Promise((r) => {
  const ws = new WebSocket(`${WS_BASE}/rl/v1/connect?role=desktop`);
  ws.onopen = () => { try { ws.close(); } catch { /* 已关 */ } r("opened"); };
  ws.onerror = () => r("rejected");
});
check("不带子协议 = 没凭据 → 拒", noAuth === "rejected", noAuth);

// ---- 真配对（两个随机 user，互不干扰）----
const uid = randomUUID();
const d = await open("desktop", uid);
check("回 echo 的是常量子协议，不含 token", d.protocol === SUBPROTOCOL, `protocol=${d.protocol}`);
await wait(200);
check("独自在线时没有在场信号", d.rx.length === 0, JSON.stringify(d.rx));

const m = await open("mobile", uid);
await wait(400);
check("对端到场 → 两侧各一条 :peer", d.rx.includes(PEER) && m.rx.includes(PEER), `d=${JSON.stringify(d.rx)} m=${JSON.stringify(m.rx)}`);

d.rx.length = 0;
m.rx.length = 0;
d.send("AAAA-ciphertext");
await wait(400);
check("桌面→手机 字节原样到达", m.rx.includes("AAAA-ciphertext"));
check("不回声给发送方", d.rx.length === 0);
m.send("BBBB-ciphertext");
await wait(400);
check("手机→桌面 字节原样到达", d.rx.includes("BBBB-ciphertext"));

// ---- 心跳在边缘应答（不唤醒 DO）----
d.rx.length = 0;
d.send(PING);
await wait(400);
check("心跳回 :pong", d.rx.includes(PONG), JSON.stringify(d.rx));

// ---- 同角色重连顶掉旧的 ----
const m2 = await open("mobile", uid);
await wait(500);
check("旧手机被顶下线", m.readyState === 3, `readyState=${m.readyState}`);
d.rx.length = 0;
m2.rx.length = 0;
d.send("CCCC");
await wait(400);
check("帧走新连接不走旧的", m2.rx.includes("CCCC") && !m.rx.includes("CCCC"));

// ---- 不同用户不串线 ----
const other = await open("desktop", randomUUID());
await wait(300);
check("另一个用户收不到别人的 :peer", other.rx.length === 0, JSON.stringify(other.rx));

// ---- 单帧上限 ----
d.send("x".repeat(MAX_FRAME + 1));
await wait(500);
check("超 256 KiB → 关掉发送方", d.readyState === 3, `readyState=${d.readyState}`);

for (const ws of [d, m, m2, other]) { try { ws.close(); } catch { /* 已关 */ } }

console.log(`\n${BASE}\n通过 ${ok.length} 条：`);
for (const o of ok) console.log(`  ✓ ${o}`);
if (bad.length) {
  console.log(`\n失败 ${bad.length} 条：`);
  for (const b of bad) console.log(`  ✗ ${b}`);
}
process.exit(bad.length ? 1 : 0);
