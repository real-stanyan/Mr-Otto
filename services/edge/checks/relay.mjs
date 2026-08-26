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

const BASE = (process.argv[2] ?? "https://edge.mrotto.workers.dev").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const SUBPROTOCOL = "mrotto.v1";
const PING = ":ping";
const PONG = ":pong";
const MAX_FRAME = 256 * 1024;
// 控制消息解析与帧编解码：与 src/shared/remote/wire.ts 同一套约定
// （这个脚本要能单独 node 跑，不走打包，所以是刻意的一小段重复）
const ctrl = (msg) => {
  if (!msg.startsWith(":")) return null;
  const sp = msg.indexOf(" ");
  return { kind: (sp === -1 ? msg : msg.slice(0, sp)).slice(1), cid: sp === -1 ? "" : msg.slice(sp + 1) };
};
const frame = (cid, payload) => `${cid} ${payload}`;
const unframe = (msg) => {
  const sp = msg.indexOf(" ");
  return sp <= 0 ? null : { cid: msg.slice(0, sp), payload: msg.slice(sp + 1) };
};

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(BASE);

function secret() {
  if (process.env.SUPABASE_JWT_SECRET) return process.env.SUPABASE_JWT_SECRET;
  // 本地 wrangler dev 用 .dev.vars（里面是假值）
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n").find((l) => l.startsWith("SUPABASE_JWT_SECRET="));
    if (line) {
      // ↓ 拿本地假 secret 打生产,所有中继断言都会 401,而那看起来像"服务坏了"。
      //   这是这个脚本最容易骗到人的一种失败,所以直接拦掉而不是只警告
      if (!LOCAL) {
        console.error(`打的是 ${BASE}，但 secret 取自 .dev.vars（本地假值）。`);
        console.error("中继那些断言会全部 401 —— 那不是服务坏了，是签的 token 对不上。");
        console.error("传真的进来：SUPABASE_JWT_SECRET='...' node checks/relay.mjs " + BASE);
        process.exit(2);
      }
      return line.slice("SUPABASE_JWT_SECRET=".length).trim();
    }
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
    ws.rx = [];       // 载荷帧 {cid, payload}
    ws.peers = [];    // 收到的 :peer <cid>
    ws.gone = [];     // 收到的 :gone <cid>
    ws.cid = "";      // 中继给这条连接编的号
    ws.pongs = 0;
    ws.onmessage = (e) => {
      const c = ctrl(e.data);
      if (!c) { ws.rx.push(unframe(e.data)); return; }
      if (c.kind === "cid") ws.cid = c.cid;
      else if (c.kind === "peer") ws.peers.push(c.cid);
      else if (c.kind === "gone") ws.gone.push(c.cid);
      else if (c.kind === "pong") ws.pongs += 1;
    };
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

// ---- 真配对（cid 寻址，ADR-0130）----
const uid = randomUUID();
const d = await open("desktop", uid);
check("回 echo 的是常量子协议，不含 token", d.protocol === SUBPROTOCOL, `protocol=${d.protocol}`);
await wait(300);
check("接上先拿到自己的 cid", d.cid !== "", `cid=${d.cid}`);
check("独自在线时没有在场信号", d.peers.length === 0, JSON.stringify(d.peers));

const m1 = await open("mobile", uid);
await wait(400);
check("对端到场 → 两侧各一条 :peer <cid>",
  d.peers.includes(m1.cid) && m1.peers.includes(d.cid),
  `d.peers=${JSON.stringify(d.peers)} m1.peers=${JSON.stringify(m1.peers)}`);

d.rx.length = 0; m1.rx.length = 0;
d.send(frame(m1.cid, "AAAA-ciphertext"));
await wait(400);
check("桌面→手机 字节原样到达，且带发件人",
  d.rx.length === 0 && m1.rx.some((f) => f?.payload === "AAAA-ciphertext" && f.cid === d.cid),
  JSON.stringify(m1.rx));
m1.send(frame(d.cid, "BBBB-ciphertext"));
await wait(400);
check("手机→桌面 字节原样到达", d.rx.some((f) => f?.payload === "BBBB-ciphertext" && f.cid === m1.cid));

// ---- 两台手机同时在线，各是各的（ADR-0130 的核心）----
const m2 = await open("mobile", uid);
await wait(500);
check("第二台手机上线：桌面收到第二条 :peer", d.peers.includes(m2.cid), JSON.stringify(d.peers));
check("第一台没被顶下线", m1.readyState === 1, `readyState=${m1.readyState}`);
check("新来的那台也知道桌面在", m2.peers.includes(d.cid), JSON.stringify(m2.peers));

m1.rx.length = 0; m2.rx.length = 0;
d.send(frame(m2.cid, "ONLY-FOR-M2"));
await wait(400);
check("按 cid 寻址，不广播",
  m2.rx.some((f) => f?.payload === "ONLY-FOR-M2") && m1.rx.length === 0,
  `m1.rx=${JSON.stringify(m1.rx)}`);

d.rx.length = 0;
d.send(frame("c-nobody", "SHOULD-DROP"));
await wait(300);
check("收件人认不出 → 丢弃，不猜一条发",
  m1.rx.length === 0 && m2.rx.every((f) => f?.payload !== "SHOULD-DROP"));

// ---- 离场 ----
d.gone.length = 0;
m1.close();
await wait(500);
check("一台走了 → 桌面收到 :gone <cid>", d.gone.includes(m1.cid), JSON.stringify(d.gone));

// ---- 心跳在边缘应答（不唤醒 DO）----
d.pongs = 0;
d.send(PING);
await wait(400);
check("心跳回 :pong", d.pongs === 1, `pongs=${d.pongs}`);

// ---- 不同用户不串线 ----
const other = await open("desktop", randomUUID());
await wait(300);
check("另一个用户收不到别人的 :peer", other.peers.length === 0, JSON.stringify(other.peers));

// ---- 单帧上限 ----
d.send(frame(m2.cid, "x".repeat(MAX_FRAME)));
await wait(500);
check("超 256 KiB → 关掉发送方", d.readyState === 3, `readyState=${d.readyState}`);

for (const ws of [d, m1, m2, other]) { try { ws.close(); } catch { /* 已关 */ } }

console.log(`\n${BASE}\n通过 ${ok.length} 条：`);
for (const o of ok) console.log(`  ✓ ${o}`);
if (bad.length) {
  console.log(`\n失败 ${bad.length} 条：`);
  for (const b of bad) console.log(`  ✗ ${b}`);
}
process.exit(bad.length ? 1 : 0);
