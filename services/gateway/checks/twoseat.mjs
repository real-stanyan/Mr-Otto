// 两人对局的端到端校验（issue #48 第 3/4 层唯一没被自动覆盖的路径）。
//
// 为什么需要它：引擎那层有 1200 手模糊测试，但"两个账号真的坐下、
// 经过 HTTP、经过 JWT、经过网关的内存牌局、最后落库"这条链从没被走过。
// 一个人凑不出两家 —— 但需要的是第二个**账号**，不是第二个人。
//
// 跑法（必须在网关那台机器上，要读 .env 和 docker exec 进库）：
//   scp -P 2222 services/gateway/checks/twoseat.mjs stan@<host>:/tmp/twoseat.mjs
//   ssh -p 2222 stan@<host> 'node /tmp/twoseat.mjs'
//
// 它自己造两个合成账号、互加好友、打完一手、验完就把账号删掉（auth.users 级联）。
// 全程只打公开端点，不走后门：合法性判定、牌局推进、结算都由网关和引擎自己决定。
//
// 留痕：poker_hands 是 append-only 且不挂外键（审计记录不该因为桌关了就消失），
// 所以每跑一次会在库里留下一行属于已删除账号的手牌记录。不要去删它。

import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", "otto-db-1", "psql", "-U", "postgres", "-d", "postgres", "-Atc", sql],
    { encoding: "utf8" }).trim();

const env = readFileSync(process.env.HOME + "/otto-gateway/.env", "utf8");
const SECRET = /^SUPABASE_JWT_SECRET=(.*)$/m.exec(env)[1];
const BASE = "http://127.0.0.1:8787/v1/poker";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(sub) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 900 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}

const A = randomUUID(), B = randomUUID();
const tok = { [A]: null, [B]: null };

async function api(who, path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${tok[who]}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

const fail = (m) => { throw new Error("FAIL " + m); };
const ok = (m) => console.log("PASS " + m);

try {
  // ── 造两个合成账号 + 互为好友 + 各发一点赠额 ──────────────────
  for (const u of [A, B]) {
    psql(`insert into auth.users (id, email) values ('${u}', '${u}@twoseat.test')`);
    psql(`insert into public.profiles (id) values ('${u}') on conflict (id) do nothing`);
    psql(`select public.grant_tokens('${u}', 'flash', 100000)`);
    tok[u] = mint(u);
  }
  psql(`insert into public.friendships (requester, addressee, status) values ('${A}', '${B}', 'accepted')`);

  // ── 建桌、两家入座 ─────────────────────────────────────────────
  const { table } = await api(A, "", "POST", {
    name: "twoseat", tier: "flash", smallBlind: 25, bigBlind: 50,
    minBuyin: 1000, maxBuyin: 5000, maxSeats: 2,
  });
  const T = table.id;
  await api(A, `/${T}/join`, "POST", { amount: 2000 });
  await api(B, `/${T}/join`, "POST", { amount: 2000 });
  ok(`两家入座（桌 ${T.slice(0, 8)}）`);

  await api(A, `/${T}/start`, "POST");
  let va = (await api(A, `/${T}`)).hand;
  let vb = (await api(B, `/${T}`)).hand;

  // ── 裁剪：各看各的 ─────────────────────────────────────────────
  const holeOf = (v, u) => v.seats.find((s) => s.userId === u).hole;
  if (!holeOf(va, A) || holeOf(va, B)) fail("A 看到了 B 的底牌");
  if (!holeOf(vb, B) || holeOf(vb, A)) fail("B 看到了 A 的底牌");
  if (va.commitment.deck || vb.commitment.deck) fail("摊牌前就把牌堆发出去了");
  if (JSON.stringify(holeOf(va, A)) === JSON.stringify(holeOf(vb, B))) fail("两家拿到同样的牌");
  ok("发牌后各看各的：自己两张、对家 null、牌堆未揭示");

  // ── 一路 check/call 打到摊牌 ───────────────────────────────────
  let steps = 0;
  while (!va.done) {
    if (++steps > 40) fail("牌局不收敛");
    const who = va.toAct;
    if (!who) fail("没人可行动但牌局没结束");
    const v = who === A ? va : (await api(B, `/${T}`)).hand;
    const legal = v.legal.map((o) => o.type);
    const pick = legal.includes("check") ? "check" : legal.includes("call") ? "call" : "fold";
    await api(who, `/${T}/action`, "POST", { action: { type: pick } });
    va = (await api(A, `/${T}`)).hand;
  }
  vb = (await api(B, `/${T}`)).hand;
  ok(`打到结束，共 ${steps} 个动作，公共牌 ${va.board.length} 张`);

  // ── 摊牌后：双方底牌都亮，牌堆揭示且可自验 ────────────────────
  if (!holeOf(va, B)) fail("摊牌后仍看不到对家底牌");
  if (!va.commitment.deck || !va.commitment.salt) fail("摊牌后牌堆没揭示");
  const { createHash } = await import("node:crypto");
  const recomputed = createHash("sha256")
    .update(`${va.commitment.salt}:${va.commitment.deck.join(",")}`).digest("hex");
  if (recomputed !== va.commitment.hash) fail("牌堆 hash 对不上 —— 揭示的牌堆不是开局那副");
  ok("摊牌后双方亮牌，牌堆 hash 自验通过");

  // ── 结算：零和、落库、栈与账对得上 ────────────────────────────
  const sum = Object.values(va.deltas).reduce((a, b) => a + b, 0);
  if (sum !== 0) fail(`净变动和是 ${sum}`);
  const hands = Number(psql(`select count(*) from public.poker_hands where table_id = '${T}'`));
  if (hands !== 1) fail(`poker_hands 里有 ${hands} 行`);
  ok(`零和成立，poker_hands 记了 1 手（A ${va.deltas[A] > 0 ? "+" : ""}${va.deltas[A]}）`);

  for (const u of [A, B]) {
    const stored = Number(psql(`select stack_tokens from public.poker_stacks where table_id='${T}' and user_id='${u}'`));
    const rebuilt = Number(psql(`select public.rebuild_stack('${u}', '${T}')`));
    const expected = 2000 + va.deltas[u];
    if (stored !== expected || rebuilt !== expected) {
      fail(`${u.slice(0, 8)} 栈 stored=${stored} rebuilt=${rebuilt} 期望=${expected}`);
    }
  }
  ok("两家的栈 = 买入 + 净变动，且可从记录重算");

  // ── 再打一手：庄位应当换人 ─────────────────────────────────────
  const b1 = va.button;
  await api(A, `/${T}/start`, "POST");
  const v2 = (await api(A, `/${T}`)).hand;
  if (v2.button === b1) fail("第二手庄位没挪");
  ok(`第二手庄位 ${b1} -> ${v2.button}`);

  console.log("=== 两人对局全部通过 ===");
} finally {
  // 合成账号连同它们的余额/栈/账本/手牌一起清掉（auth.users 级联）
  psql(`delete from public.poker_tables where created_by in ('${A}','${B}')`);
  psql(`delete from auth.users where id in ('${A}','${B}')`);
  console.log("清理完成");
}
