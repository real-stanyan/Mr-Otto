// 托管网关 + 计费面的真机自检。**跑在任何一台能看见目标地址的机器上**——它现签一个
// 短命 token，所以要能拿到 SUPABASE_JWT_SECRET（env 或 .dev.vars）。
//
//   node checks/llm.mjs                        # 打生产（默认）
//   node checks/llm.mjs http://127.0.0.1:8799  # 打本地 wrangler dev
//
// 为什么要有它：单测跑的是纯逻辑（quota / llmGateway / billing / billingQueries），
// **覆盖不到**运行时那一层——Quota DO 的实例名取身份、storage 读改写、冷启动重建、
// ctx.waitUntil 让流式 settle 活到响应发出之后、以及 workerd 上 TransformStream 的
// cancel 行为。那几件事坏掉的样子是「请求成功了但额度没动」，没有报错。
//
// **这一笔会真扣被签用户的额度**（走真上游、真花钱）。默认签一个随机 uuid：
// 它没有订阅，应当得到 402 no_subscription——那已经验完了身份 → 选路 → hold 这一整条链，
// 且一分钱不花。要验真扣账，用 OTTO_CHECK_UID 指定一个测试账号。
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://edge.mrotto.agency").replace(/\/+$/, "");
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(BASE);

function secret() {
  if (process.env.SUPABASE_JWT_SECRET) return process.env.SUPABASE_JWT_SECRET;
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n").find((l) => l.startsWith("SUPABASE_JWT_SECRET="));
    if (line) {
      // 同 checks/relay.mjs：拿本地假 secret 打生产，所有断言都会 401，
      // 而那看起来像「服务坏了」。直接拦掉，不是只警告
      if (!LOCAL) {
        console.error(`打的是 ${BASE}，但 secret 取自 .dev.vars（本地假值）。`);
        console.error("所有断言会 401 —— 那不是服务坏了，是签的 token 对不上。");
        console.error(`传真的进来：SUPABASE_JWT_SECRET='...' node checks/llm.mjs ${BASE}`);
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
const UID = process.env.OTTO_CHECK_UID ?? randomUUID();
const REAL_USER = Boolean(process.env.OTTO_CHECK_UID);
const head = b64({ alg: "HS256", typ: "JWT" });
const claims = b64({ sub: UID, email: "check@otto", exp: Math.floor(Date.now() / 1000) + 300 });
const TOKEN = `${head}.${claims}.${createHmac("sha256", SECRET).update(`${head}.${claims}`).digest("base64url")}`;

const ok = [];
const bad = [];
const check = (name, cond, extra = "") => (cond ? ok : bad).push(`${name}${extra ? " — " + extra : ""}`);
const billingHeaders = (h) => Object.fromEntries([...h.entries()].filter(([k]) => k.startsWith("x-otto-")));

console.log(`目标 ${BASE}`);
console.log(`uid ${UID}${REAL_USER ? "（OTTO_CHECK_UID：真会扣这个账号的额度）" : "（随机 uuid：没有订阅，预期 402）"}`);

// ── 1. /billing/v1/me：Quota DO 的 view op + model_route 的型号清单 ──
const meRes = await fetch(`${BASE}/billing/v1/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
const meBody = await meRes.text();
console.log("me", meRes.status, meBody.slice(0, 400));
check("/billing/v1/me 回 200", meRes.status === 200, `实得 ${meRes.status}`);
let me = null;
try { me = JSON.parse(meBody); } catch { /* 下面那条断言会报 */ }
check("me 是 BillingMe 形状", me !== null && typeof me === "object" && "status" in me && Array.isArray(me.models));
if (me) {
  check("models 非空（model_route 里有 enabled 的行）", me.models.length > 0, "DB 里没 seed 过 model_route？");
  if (!REAL_USER) check("随机 uid 没有订阅", me.status === "none", `实得 ${me.status}`);
}

// ── 2. 无凭据：401，且不该泄露端点存在与否之外的任何东西 ──
const anon = await fetch(`${BASE}/billing/v1/me`);
check("没带 token 回 401", anon.status === 401, `实得 ${anon.status}`);

// ── 3. 一次非流式 chat：身份 → 选路 → hold →（有订阅才）真转发 ──
const model = me && me.models.length > 0 ? me.models[0] : "deepseek-v4-flash";
const chat = await fetch(`${BASE}/llm/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "回复一个字：好" }], max_tokens: 5 }),
});
const chatBody = await chat.text();
console.log("chat", chat.status, billingHeaders(chat.headers), chatBody.slice(0, 300));
if (REAL_USER) {
  check("chat 回 200", chat.status === 200, `实得 ${chat.status}：${chatBody.slice(0, 200)}`);
  check("响应带剩余额度头", chat.headers.has("x-otto-window-5h-remaining"));
  // settle 是异步的（非流式也在响应前完成，但 DO 写盘 + usage_event 落库要一拍）
  await new Promise((r) => setTimeout(r, 1500));
  const after = await fetch(`${BASE}/billing/v1/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const a = await after.json();
  const used = a && a.windows ? a.windows.h5.usedMicro : null;
  console.log("settle 后的 5h 窗用量", used);
  check("5h 窗用量 > 0（settle 真的落地了）", typeof used === "number" && used > 0,
    "投影没动 —— 看 wrangler tail 里有没有 usage_event 落库失败");
} else {
  check("随机 uid 得 402 no_subscription", chat.status === 402, `实得 ${chat.status}：${chatBody.slice(0, 200)}`);
  check("402 也带剩余额度头（客户端不用再问一次）", chat.headers.has("x-otto-window-5h-remaining"));
}

// ── 4. 不认识的型号：400 unknown_model，且**不该**先扣一笔 hold ──
const unknown = await fetch(`${BASE}/llm/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "no-such-model-x", messages: [{ role: "user", content: "hi" }] }),
});
check("未知型号回 400 unknown_model", unknown.status === 400, `实得 ${unknown.status}`);

// ── 5. webhook：没签名一律 400（这条路没有 JWT 挡在前面） ──
const wh = await fetch(`${BASE}/billing/v1/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("webhook 没签名回 400", wh.status === 400, `实得 ${wh.status}`);

console.log(`\n通过 ${ok.length}：`);
for (const line of ok) console.log("  ✓ " + line);
if (bad.length) {
  console.log(`\n失败 ${bad.length}：`);
  for (const line of bad) console.log("  ✗ " + line);
  process.exit(1);
}
console.log("\n全绿。");
