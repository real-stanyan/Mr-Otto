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

function open(role, sub, channel) {
  const q = channel ? `&channel=${encodeURIComponent(channel)}` : "";
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS_BASE}/rl/v1/connect?role=${role}${q}`, [SUBPROTOCOL, token(sub)]);
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

// ---- 好友代理：按 channel 分房，两个**不同用户**同房（issue #622 / #657）----
// 自远程按 userId 分房（上面那一段），好友代理按 channelId 分房：A 和 B 是两个
// 不同的 Supabase 用户，靠同一个 channelId 进同一个房间。这一段是那件事的运行时验证——
// 单测跑的是纯逻辑 + 假 DO，"跨用户能不能互相看见"只有真 workerd 说了算。
const chan = randomUUID();
const aUid = randomUUID();
const bUid = randomUUID();
const hostWs = await open("host", aUid, chan);
await wait(300);
check("代理：host 独自在房里，没有在场信号", hostWs.peers.length === 0, JSON.stringify(hostWs.peers));

const guestWs = await open("guest", bUid, chan);
await wait(500);
check("代理：不同用户同 channel → 两侧各一条 :peer",
  hostWs.peers.includes(guestWs.cid) && guestWs.peers.includes(hostWs.cid),
  `host.peers=${JSON.stringify(hostWs.peers)} guest.peers=${JSON.stringify(guestWs.peers)}`);

hostWs.rx.length = 0; guestWs.rx.length = 0;
guestWs.send(frame(hostWs.cid, "PROXY-REQ"));
await wait(400);
check("代理：guest→host 字节原样到达，且带发件人",
  hostWs.rx.some((f) => f?.payload === "PROXY-REQ" && f.cid === guestWs.cid),
  JSON.stringify(hostWs.rx));
hostWs.send(frame(guestWs.cid, "PROXY-RES"));
await wait(400);
check("代理：host→guest 字节原样到达",
  guestWs.rx.some((f) => f?.payload === "PROXY-RES" && f.cid === hostWs.cid));

// 别的房间看不见这一间：channelId 是分房键，不是"同一个 worker 就都在一起"
const otherChan = await open("guest", randomUUID(), randomUUID());
await wait(400);
check("代理：另一个 channel 收不到别人的 :peer", otherChan.peers.length === 0, JSON.stringify(otherChan.peers));

// ---- 单帧上限 ----
d.send(frame(m2.cid, "x".repeat(MAX_FRAME)));
await wait(500);
check("超 256 KiB → 关掉发送方", d.readyState === 3, `readyState=${d.readyState}`);

for (const ws of [d, m1, m2, other, hostWs, guestWs, otherChan]) { try { ws.close(); } catch { /* 已关 */ } }

// ---- 好友代理云端执行面：workspace 授权变体接在籍查询（ADR-0198 切片 1）----
// 单测跑的是纯逻辑 + 假 escrow stub，覆盖不到 Escrow DO 真打 Supabase REST
// 查在籍那一跳——只有真 workerd + 真 env 说了算。
// workspaceId 要过 WORKSPACE_ID_RE（UUID 形状）：用真 UUID 而不是占位符，
// 否则托管文档在结构门就被 parseEscrowDoc 判 400，PUT 断言不到 200
const pxHostUid = randomUUID();
const pxWsId = randomUUID();
const pxDoc = {
  v: 1, hostUid: pxHostUid, services: [],
  grants: [{ workspaceId: pxWsId, allow: [{ serverId: "s", tools: [] }] }],
  updatedTs: Date.now(),
};
const pxPut = await fetch(`${BASE}/px/v1/escrow`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token(pxHostUid)}`, "content-type": "application/json" },
  body: JSON.stringify(pxDoc),
});
const pxPutBody = await pxPut.json().catch(() => ({}));
check("px：PUT 托管箱（workspace 授权变体）200 + grants:1",
  pxPut.status === 200 && pxPutBody.grants === 1, JSON.stringify(pxPutBody));

// 随机 uid 不在任何真 workspace 的在籍名单里——不管在籍查询这一跳是打空、
// 打不通还是查无成员，workspaceOk 都该是空集，grants 端点回空清单而不是 500
// （查询失败关闭，不是崩）
const pxGrants = await fetch(`${BASE}/px/v1/grants?host=${pxHostUid}`, {
  headers: { authorization: `Bearer ${token(randomUUID())}` },
});
const pxGrantsBody = await pxGrants.json().catch(() => ({}));
check("px：grants 查不到在籍 → 空清单而不是 500",
  pxGrants.status === 200 && Array.isArray(pxGrantsBody.servers) && pxGrantsBody.servers.length === 0,
  JSON.stringify(pxGrantsBody));

// 清理：删掉这次探针建的箱子，不留痕（中继本来就不落盘，px 的箱子探针要自己收）
await fetch(`${BASE}/px/v1/escrow`, { method: "DELETE", headers: { authorization: `Bearer ${token(pxHostUid)}` } });

// ---- runtime 服务身份（ADR-0199）----
// 单测（tests/edge/runtimeAuth.test.ts）钉的是纯路由逻辑，覆盖不到真 workerd
// 那一层——子协议 token 真的能不能换来一次 101 upgrade，只有真跑一次说了算。
// 没配 RUNTIME_SECRET 就跳过：本地/dev 环境常常没这个 secret，那不该让整个
// 脚本报红，跳过是这段检查自己的前提没满足，不是被测的东西坏了
const RUNTIME_SECRET = process.env.RUNTIME_SECRET;
if (!RUNTIME_SECRET) {
  console.log("跳过 runtime 服务身份检查：没有 RUNTIME_SECRET（本地/dev 环境常见，传 env 才会跑）");
} else {
  // ① 用 secret 连 relay 成功收到 :cid
  const svcWs = await new Promise((res, rej) => {
    const ws = new WebSocket(`${WS_BASE}/rl/v1/connect?role=host`, [SUBPROTOCOL, RUNTIME_SECRET]);
    ws.cid = "";
    ws.onmessage = (e) => {
      const c = ctrl(e.data);
      if (c?.kind === "cid") ws.cid = c.cid;
    };
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("runtime secret 连不上 relay"));
  });
  await wait(300);
  check("runtime：用 RUNTIME_SECRET 连 relay 成功收到 :cid", svcWs.cid !== "", `cid=${svcWs.cid}`);
  try { svcWs.close(); } catch { /* 已关 */ }

  // ② 不带 secret 的普通请求，伪造一个错的 x-runtime-secret 想蹭平台身份 →
  // 401/403（错 secret 不该比"没带这个 header"多换来任何东西——同一条鉴权
  // 失败路径，见 tests/edge/runtimeAuth.test.ts 的防 oracle 那条）
  const forged = await fetch(`${BASE}/px/v1/call`, {
    method: "POST",
    headers: { "x-runtime-secret": "wrong-secret-guess", "content-type": "application/json" },
    body: JSON.stringify({ hostUid: randomUUID(), serverId: "s", tool: "t", fromUid: randomUUID() }),
  });
  check("runtime：伪造错的 x-runtime-secret 打 /px/v1/call → 401/403（不给白嫖）",
    forged.status === 401 || forged.status === 403, `status=${forged.status}`);
}

console.log(`\n${BASE}\n通过 ${ok.length} 条：`);
for (const o of ok) console.log(`  ✓ ${o}`);
if (bad.length) {
  console.log(`\n失败 ${bad.length} 条：`);
  for (const b of bad) console.log(`  ✗ ${b}`);
}
process.exit(bad.length ? 1 : 0);
