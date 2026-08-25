// 中继的真机自检。**在服务器上跑**(它要读 .env 里的 SUPABASE_JWT_SECRET 现签一个短命 token,
// 那个 secret 不出机器)。默认打公网地址而不是 127.0.0.1:8787 —— 要验的东西有一半在 nginx:
// proxy_buffering 关没关、`Connection ''` 会不会掐流、`:peer` 那条注释行能不能原样穿过去。
//
//   cd ~/otto-gateway && node checks/relay.mjs [base]
//
// base 默认 https://otto-auth.stan.damianslife.com/gw,给 http://127.0.0.1:8787 就跳过 nginx。
//
// 它不写库、不留痕:user_id 是现场生成的随机 uuid,中继本来就不落盘。

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://otto-auth.stan.damianslife.com/gw").replace(/\/+$/, "");

function secret() {
  if (process.env.SUPABASE_JWT_SECRET) return process.env.SUPABASE_JWT_SECRET;
  // systemd 用 EnvironmentFile,手跑时进程里没有,自己读一次
  const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").find((l) => l.startsWith("SUPABASE_JWT_SECRET="));
  if (!line) throw new Error("找不到 SUPABASE_JWT_SECRET");
  return line.slice("SUPABASE_JWT_SECRET=".length).trim();
}

function token(sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" });
  const body = b({ sub, email: "relay-check@local", exp: Math.floor(Date.now() / 1000) + 120 });
  return `${head}.${body}.${createHmac("sha256", secret()).update(`${head}.${body}`).digest("base64url")}`;
}

const TOKEN = token(randomUUID());
const H = { authorization: `Bearer ${TOKEN}` };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? "  " + detail : ""}`);
};

/** 开一条流,把控制行和 data 行分开收集 */
async function open(role) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/rl/v1/stream?role=${role}`, { headers: H });
  const firstByteAt = Date.now() - t0;
  if (res.status !== 200) throw new Error(`${role} 开流 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const comments = [], data = [];
  let buf = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        if (ev.startsWith(":")) comments.push(ev.slice(1));
        else if (ev.startsWith("data: ")) data.push(ev.slice(6));
      }
    }
  })();
  return { comments, data, firstByteAt, close: () => reader.cancel().catch(() => {}), done };
}

const post = (role, body) =>
  fetch(`${BASE}/rl/v1/send?role=${role}`, { method: "POST", headers: H, body });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`中继自检 → ${BASE}\n`);

// 1. 对端不在线 → 409,不排队
check("对端不在线时上行回 409（不排队 = 不落盘）", (await post("mobile", "x")).status === 409);

// 2. 开流立刻有字节(否则 node:http 不冲刷响应头,客户端要卡满一个 25s 心跳)
const desktop = await open("desktop");
check("桌面开流的首字节 < 3s（响应头有冲刷）", desktop.firstByteAt < 3000, `${desktop.firstByteAt}ms`);
await wait(300);
check("开流第一条是 :ok 开场白", desktop.comments[0] === "ok", JSON.stringify(desktop.comments));

// 3. 手机接上 → 两侧各收到一条 :peer(握手唯一的起点,ADR-0100)
const mobile = await open("mobile");
await wait(800);
check("手机接上后桌面收到 :peer", desktop.comments.includes("peer"));
check("手机自己也收到 :peer", mobile.comments.includes("peer"));

// 4. 字节原样对转
check("手机 → 桌面上行 204", (await post("mobile", "PAYLOAD-M2D")).status === 204);
check("桌面 → 手机上行 204", (await post("desktop", "PAYLOAD-D2M")).status === 204);
await wait(800);
check("桌面收到的就是原样的字节", desktop.data.includes("PAYLOAD-M2D"), JSON.stringify(desktop.data));
check("手机收到的就是原样的字节", mobile.data.includes("PAYLOAD-D2M"), JSON.stringify(mobile.data));

// 5. 上限
check("单帧超过 256 KiB → 413", (await post("mobile", "x".repeat(257 * 1024))).status === 413);

// 6. 断开要腾出槽位(否则对端一直拿到 204 而字节进虚空)
await mobile.close();
let freed = false;
for (let i = 0; i < 40 && !freed; i += 1) {
  if ((await post("desktop", "x")).status === 409) freed = true;
  else await wait(100);
}
check("手机断开后槽位腾出（对端不再假装在线）", freed);

await desktop.close();

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad === 0 ? 0 : 1);
