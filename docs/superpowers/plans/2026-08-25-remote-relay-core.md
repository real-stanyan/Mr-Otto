# 手机端远程中继 · 核心管道（切片 1–4）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一条「桌面 → 网关 → 手机」的端到端加密命令/状态管道，全程零 UI、零 Apple 账号、零 React Native 工具链，用假传输在单测里跑通。

**Architecture:** 帧协议与握手全是纯函数，住在 `src/shared/remote/`（手机端将来直接 import 同一份）；
密码学原语走注入接口，桌面实现用 `node:crypto`（零新依赖）；网关只做盲管道，
用 SSE 下行 + POST 上行，不引入 `ws`；桌面 `remoteBridge.ts` 与 `islandBridge.ts` 平级，
共用 `IslandFleet` 投影源，传输层收窄成可注入接口。

**Tech Stack:** TypeScript (strict) · `node:crypto`（X25519 / Ed25519 / HKDF-SHA256 / ChaCha20-Poly1305-IETF）· vitest · Supabase Postgres + RLS · 网关 = 纯 `node:http`

**Spec:** `docs/superpowers/specs/2026-08-25-mobile-remote-control-design.md`

## Global Constraints

- 门禁 = `npm test`（`tsc --noEmit` + `vitest run` 两段都要绿，项目 ADR-0053）。**每个 Task 结束前必须跑一次整条门禁**，不只是跑自己那个测试文件。
- 测试统一放 `tests/`，镜像 `src/` 结构，**不与源码同目录**（AGENTS.md Tech stack）。
- **`src/shared/**` 不许 import 任何 node builtin 或 electron**——这批文件手机端也要跑。要用 Node 能力放 `src/main/`。Task 8 会把这条变成会红的断言。
- **不新增 npm 运行时依赖**：桌面侧用 `node:crypto`，网关侧保持 `package.json` 只有 `tsx` 一个 devDep。
- **AEAD 全程只有一种**：ChaCha20-Poly1305-IETF，12 字节 nonce，16 字节 tag。不许出现 AES-GCM 或 XChaCha20。
- **HKDF info 串是协议的一部分，逐字照抄**：`"otto-stream-v1:d2m"` / `"otto-stream-v1:m2d"` / `"otto-push-v1"`。
- 手机端命令词汇**恰好五个**：`approve` / `deny` / `send` / `watch` / `unwatch`。**没有 `focusSession`，没有 `grant` 字段**（spec 第二节的安全取舍）。
- 小步 commit，message 写清 **why**（AGENTS.md While working）。
- 本计划**不含** ADR。ADR 在整条分支合并前单独补，编号 claim-at-merge（ADR-0074）。

## 本计划的边界（刻意不做的事）

计划 A 的交付物是**一条被单测钉死的加密管道**，不是一个能用的功能。以下都不在本计划内，
不要顺手做掉——它们各自属于计划 B / C：

| 不做 | 属于 | 为什么现在不做 |
|---|---|---|
| 把 `remoteBridge` 接进 `src/main/index.ts` 的装配 | 计划 B | 没有手机端可连，接进去只是多一条不跑的代码 |
| 桌面身份私钥落 macOS Keychain | 计划 B | 需要一个 Keychain 封装，且它的第一个真实消费者在 B |
| 真 SSE/POST transport 壳（`fetch` 那一层） | 计划 B | 是薄壳，但没有对端就无从验证 |
| `trimForMobile` 与 `timeline` 帧的**生产** | 计划 B（切片 6） | 本计划只定义帧的**类型**，不产出内容 |
| `pushKey` 派生、APNs、NSE | 计划 C（切片 7–8） | 卡在付费开发者账号 |
| Expo 侧的 `RemoteCryptoPrimitives` 实现 | 计划 B | 需要 RN 工具链 |

### 一个已知风险，留给计划 B 验

`src/shared/shellBridge.ts` 里有 `import type { SessionSummary, FtsHit } from "../session/store.js"`，
而 `store.ts` 里有 `better-sqlite3`。**`import type` 在编译期被完全擦除**，metro 不会顺着它
解析下去，所以今天不成问题。但这是一根细线：哪天有人把它改成值导入（比如想用 store 里的
某个常量），RN 那条路就在无人察觉时断了。

Task 8 的 grep 级断言看不出「type-only」和「值导入」的区别，所以**这条不做断言，只记风险**。
计划 B 第一次真起 metro 时会立刻暴露；那时再决定是拆类型文件还是加更聪明的断言。

跑完计划 A 的验收标准：`npm test` 全绿，且 `tests/shared/remote/` + `tests/main/remoteBridge.test.ts`
能在**零网络**下证明「握手 → 加密 → 中继 → 解密 → 命令白名单」这条链是通的。

---

## File Structure

| 文件 | 职责 | Task |
|---|---|---|
| `src/shared/remote/frames.ts` | 上下行帧的类型 + 编解码 + 白名单校验。纯。 | 1 |
| `src/shared/remote/b64.ts` | base64url 编解码。手写而不用 `btoa`——RN 的 Hermes 不保证有它。纯。 | 2 |
| `src/shared/remote/crypto.ts` | `RemoteCryptoPrimitives` 接口定义（只有类型，零实现）。纯。 | 2 |
| `src/shared/remote/sealedStream.ts` | 计数器 nonce 序列 + 封/拆包 + 重放拒收。纯，吃注入的原语。 | 2 |
| `src/shared/remote/handshake.ts` | 签名的临时公钥交换 + 密钥派生 + 6 位指纹。纯，吃注入的原语。 | 3 |
| `src/main/remoteCryptoNode.ts` | `RemoteCryptoPrimitives` 的 `node:crypto` 实现。主进程专属。 | 4 |
| `supabase/migrations/0011_remote_devices.sql` | `devices` 表 + RLS。 | 5 |
| `services/gateway/src/relay.ts` | 盲管道：连接登记 + 字节转发。零解析。 | 6 |
| `services/gateway/src/gateway.ts:263-290` | 挂 `/rl/v1/*` 路由。 | 6 |
| `src/main/remoteBridge.ts` | 桌面侧装配：注入式传输 + 重连 + 去重推送。与 `islandBridge.ts` 平级。 | 7 |
| `tests/architecture.test.ts` | 加两条边界断言。 | 8 |

---

## Task 1: 帧协议与命令白名单

**Files:**
- Create: `src/shared/remote/frames.ts`
- Test: `tests/shared/remote/frames.test.ts`

**Interfaces:**
- Consumes: 无（本计划第一个 Task）
- Produces:
  - `type DownFrame = { type: "hello"; ... } | { type: "fleet"; fleet: IslandFleet } | { type: "timeline"; sessionId: string; messages: MobileMessage[] } | { type: "ping"; ts: number }`
  - `type UpFrame = { type: "approve" | "deny"; sessionId: string; callId: string } | { type: "send"; sessionId: string; text: string } | { type: "watch" | "unwatch"; sessionId: string }`
  - `encodeFrame(f: DownFrame | UpFrame): string`
  - `decodeDownFrame(line: string): DownFrame | null`
  - `decodeUpFrame(line: string): UpFrame | null`

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/remote/frames.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeDownFrame, decodeUpFrame, encodeFrame } from "../../../src/shared/remote/frames.js";
import type { IslandFleet } from "../../../src/shared/shellBridge.js";

const IDLE: IslandFleet = { agents: [], focusedSessionId: null };

describe("encodeFrame", () => {
  it("一行 JSON，不带换行（换行由传输层决定）", () => {
    const line = encodeFrame({ type: "fleet", fleet: IDLE });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line).type).toBe("fleet");
  });
});

describe("decodeUpFrame", () => {
  it("解 approve", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s","callId":"c"}')).toEqual({
      type: "approve", sessionId: "s", callId: "c",
    });
  });
  it("解 deny", () => {
    expect(decodeUpFrame('{"type":"deny","sessionId":"s","callId":"c"}')).toEqual({
      type: "deny", sessionId: "s", callId: "c",
    });
  });
  it("解 send / watch / unwatch", () => {
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi"}')).toEqual({
      type: "send", sessionId: "s", text: "hi",
    });
    expect(decodeUpFrame('{"type":"watch","sessionId":"s"}')).toEqual({ type: "watch", sessionId: "s" });
    expect(decodeUpFrame('{"type":"unwatch","sessionId":"s"}')).toEqual({ type: "unwatch", sessionId: "s" });
  });

  // ↓ spec 第二节的安全取舍，具名钉死。有人想「顺手开一下」时这两条会红。
  it("approve 带 grant 字段 → 整条丢弃，不是剥掉字段放行", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}')).toBeNull();
  });
  it("approve_always / approve_session 不是合法 type", () => {
    expect(decodeUpFrame('{"type":"approve_always","sessionId":"s","callId":"c"}')).toBeNull();
    expect(decodeUpFrame('{"type":"approve_session","sessionId":"s","callId":"c"}')).toBeNull();
  });
  it("focusSession 是岛的词汇，手机端不认（远程操纵桌面窗口不在范围内）", () => {
    expect(decodeUpFrame('{"type":"focusSession","sessionId":"s"}')).toBeNull();
  });

  it("缺字段 / 类型不对 / 坏 JSON / 未知 type → null", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s"}')).toBeNull();
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":123}')).toBeNull();
    expect(decodeUpFrame("not json")).toBeNull();
    expect(decodeUpFrame('{"type":"wat"}')).toBeNull();
    expect(decodeUpFrame("null")).toBeNull();
  });
});

describe("decodeDownFrame", () => {
  it("解 fleet", () => {
    const f = decodeDownFrame(encodeFrame({ type: "fleet", fleet: IDLE }));
    expect(f).toEqual({ type: "fleet", fleet: IDLE });
  });
  it("解 ping", () => {
    expect(decodeDownFrame('{"type":"ping","ts":17}')).toEqual({ type: "ping", ts: 17 });
  });
  it("上行词汇不能从下行口进来", () => {
    expect(decodeDownFrame('{"type":"approve","sessionId":"s","callId":"c"}')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/shared/remote/frames.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/shared/remote/frames.js"`

- [ ] **Step 3: 写实现**

Create `src/shared/remote/frames.ts`:

```ts
// 远程中继的线格式。照 islandBridge.ts 的 decodeCommand 同一套规矩：
// 逐字段类型检查，认不出来的整条丢弃——不是"剥掉不认识的字段然后放行"。
// 这个区别是安全性质：上行帧从公网来，剥字段等于替攻击者做了归一化。
//
// 纯文件：不许 import node builtin / electron（手机端也要跑这一份）。

import type { IslandFleet } from "../shellBridge.js";

/** 移动端时间线的一条消息（timeline 帧的元素，Task 之外由 trimForMobile 产出） */
export interface MobileMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** 被 trimForMobile 截断过 → UI 显示"在电脑上看全文" */
  truncated?: boolean;
}

/** 桌面 → 手机 */
export type DownFrame =
  | { type: "hello"; deviceId: string; fingerprint: string }
  | { type: "fleet"; fleet: IslandFleet }
  | { type: "timeline"; sessionId: string; messages: MobileMessage[] }
  /** 保活。nginx 的 proxy_read_timeout 是 600s，心跳必须比它短得多 */
  | { type: "ping"; ts: number };

/** 手机 → 桌面。恰好五个词，没有 focusSession，approve 没有 grant 档 */
export type UpFrame =
  | { type: "approve"; sessionId: string; callId: string }
  | { type: "deny"; sessionId: string; callId: string }
  | { type: "send"; sessionId: string; text: string }
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string };

export function encodeFrame(f: DownFrame | UpFrame): string {
  return JSON.stringify(f);
}

function parseObject(line: string): Record<string, unknown> | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return o as Record<string, unknown>;
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

/** 认得的字段集合之外还有别的键 = 整条丢弃。
    这一条挡的是「approve 带 grant」这类：剥掉多余字段放行，等于替攻击者归一化 */
function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

export function decodeUpFrame(line: string): UpFrame | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.type) {
    case "approve":
    case "deny":
      return exactKeys(o, ["type", "sessionId", "callId"]) && str(o.sessionId) && str(o.callId)
        ? { type: o.type, sessionId: o.sessionId, callId: o.callId }
        : null;
    case "send":
      return exactKeys(o, ["type", "sessionId", "text"]) && str(o.sessionId) && str(o.text)
        ? { type: "send", sessionId: o.sessionId, text: o.text }
        : null;
    case "watch":
    case "unwatch":
      return exactKeys(o, ["type", "sessionId"]) && str(o.sessionId)
        ? { type: o.type, sessionId: o.sessionId }
        : null;
    default:
      return null;
  }
}

export function decodeDownFrame(line: string): DownFrame | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.type) {
    case "hello":
      return str(o.deviceId) && str(o.fingerprint)
        ? { type: "hello", deviceId: o.deviceId, fingerprint: o.fingerprint }
        : null;
    case "fleet":
      return o.fleet && typeof o.fleet === "object" && Array.isArray((o.fleet as IslandFleet).agents)
        ? { type: "fleet", fleet: o.fleet as IslandFleet }
        : null;
    case "timeline":
      return str(o.sessionId) && Array.isArray(o.messages)
        ? { type: "timeline", sessionId: o.sessionId, messages: o.messages as MobileMessage[] }
        : null;
    case "ping":
      return typeof o.ts === "number" ? { type: "ping", ts: o.ts } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/frames.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/remote/frames.ts tests/shared/remote/frames.test.ts
git commit -m "feat(remote): 上下行帧协议与命令白名单

上行帧从公网来，所以校验规矩比岛严一档：不只是逐字段查类型，还要求键集合
完全相等。剥掉不认识的字段再放行等于替攻击者做归一化——'approve 带 grant'
这条具名测试钉的就是它。手机端词汇恰好五个，没有 focusSession（远程操纵
桌面窗口不在范围内），approve 没有 grant 档（误触永久授权和误触一次执行
不是一个量级的代价，spec 第二节）。"
```

---

## Task 2: 密码学原语接口 + 计数器 nonce 流

**Files:**
- Create: `src/shared/remote/b64.ts`
- Create: `src/shared/remote/crypto.ts`
- Create: `src/shared/remote/sealedStream.ts`
- Test: `tests/shared/remote/b64.test.ts`
- Test: `tests/shared/remote/sealedStream.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface RemoteCryptoPrimitives`（下面 Step 3 给全签名）
  - `b64encode(u: Uint8Array): string` / `b64decode(s: string): Uint8Array | null`（base64url，无填充）
  - `createSealer(p: RemoteCryptoPrimitives, key: Uint8Array, noncePrefix: Uint8Array): { seal(plain: Uint8Array): Uint8Array }`
  - `createOpener(p: RemoteCryptoPrimitives, key: Uint8Array, noncePrefix: Uint8Array): { open(box: Uint8Array): Uint8Array | null }`
  - 线格式：`[8 字节大端计数器][密文][16 字节 tag]`

- [ ] **Step 1a: 写 base64url 的失败测试**

Create `tests/shared/remote/b64.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { b64decode, b64encode } from "../../../src/shared/remote/b64.js";

describe("base64url", () => {
  it("往返任意字节", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 64, 255]) {
      const u = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256);
      expect([...b64decode(b64encode(u))!]).toEqual([...u]);
    }
  });
  it("用 url 安全字母表，不带填充", () => {
    const u = new Uint8Array([251, 255, 190]);
    const e = b64encode(u);
    expect(e).not.toMatch(/[+/=]/);
  });
  it("与 Node 的 base64url 逐字节一致（跨实现互通的凭证）", () => {
    const u = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
    expect(b64encode(u)).toBe(Buffer.from(u).toString("base64url"));
    expect([...b64decode(Buffer.from(u).toString("base64url"))!]).toEqual([...u]);
  });
  it("非法字符 → null，不抛", () => {
    expect(b64decode("abc!def")).toBeNull();
    expect(b64decode("a+b/c=")).toBeNull(); // 标准 base64 的字母表不收
  });
  it("长度非法（余数为 1）→ null", () => {
    expect(b64decode("A")).toBeNull();
  });
});
```

- [ ] **Step 1b: 跑测试确认它失败，然后写实现**

Run: `npx vitest run tests/shared/remote/b64.test.ts` → FAIL（解析不到 `b64.js`）

Create `src/shared/remote/b64.ts`:

```ts
// base64url 编解码,手写。
//
// 为什么不用 btoa/atob:RN 的 Hermes 引擎不保证提供它们(Node 有,浏览器有,
// Hermes 要看版本和 polyfill)。src/shared 是三边共享层,不能押在某个宿主的全局上。
// 为什么不用 Buffer:那是 node builtin,这一层不许碰。
//
// 无填充(不带 =)。线上所有字节字段都走这一份,两端必须逐字节一致 ——
// 有一条测试对着 Node 的 Buffer.toString("base64url") 比对,守的就是互通。

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) REVERSE[ALPHABET[i]!] = i;

export function b64encode(u: Uint8Array): string {
  let out = "";
  for (let i = 0; i < u.length; i += 3) {
    const a = u[i]!;
    const b = i + 1 < u.length ? u[i + 1]! : -1;
    const c = i + 2 < u.length ? u[i + 2]! : -1;
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]!;
    if (b < 0) break;
    out += ALPHABET[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]!;
    if (c < 0) break;
    out += ALPHABET[c & 63]!;
  }
  return out;
}

/** 非法输入回 null 而不是抛:这些字节从公网来,坏输入是常态分支 */
export function b64decode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null; // 4n+1 不是任何字节串的编码长度
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = REVERSE[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return out.subarray(0, o);
}
```

Run: `npx vitest run tests/shared/remote/b64.test.ts` → PASS

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/remote/sealedStream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";
import type { RemoteCryptoPrimitives } from "../../../src/shared/remote/crypto.js";

/** 测试替身：把 ChaCha 换成"异或 key[0] 再挂一个把 nonce 也算进去的 tag"。
    真算法的正确性由 libsodium/node 自己保证，这里要测的是**我们写的那部分**：
    计数器怎么走、重放怎么拒、nonce 有没有真的进到 AEAD 里。 */
const fake: Pick<RemoteCryptoPrimitives, "chachaSeal" | "chachaOpen"> = {
  chachaSeal(key, nonce, plaintext) {
    const ct = plaintext.map((b) => b ^ key[0]!);
    const tag = new Uint8Array(16);
    tag.set(nonce.slice(0, 12));
    tag[15] = key[0]!;
    return new Uint8Array([...ct, ...tag]);
  },
  chachaOpen(key, nonce, box) {
    if (box.length < 16) return null;
    const ct = box.slice(0, box.length - 16);
    const tag = box.slice(box.length - 16);
    const want = new Uint8Array(16);
    want.set(nonce.slice(0, 12));
    want[15] = key[0]!;
    if (!tag.every((b, i) => b === want[i])) return null; // nonce/key 不对 → 认证失败
    return ct.map((b) => b ^ key[0]!);
  },
};

const P = fake as RemoteCryptoPrimitives;
const KEY = new Uint8Array(32).fill(7);
const PREFIX = new Uint8Array([1, 2, 3, 4]);
const msg = (s: string) => new TextEncoder().encode(s);
const str = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null);

describe("sealedStream", () => {
  it("往返：封进去什么，拆出来还是什么", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    expect(str(o.open(s.seal(msg("hello"))))).toBe("hello");
    expect(str(o.open(s.seal(msg("world"))))).toBe("world");
  });

  it("计数器每封一次 +1，前 8 字节是大端计数器", () => {
    const s = createSealer(P, KEY, PREFIX);
    const a = s.seal(msg("x"));
    const b = s.seal(msg("x"));
    expect([...a.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...b.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    // 同一段明文，两次密文不同 —— nonce 真的变了
    expect([...a.slice(8)]).not.toEqual([...b.slice(8)]);
  });

  it("重放同一帧 → 拒（计数器必须严格递增）", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    const frame = s.seal(msg("once"));
    expect(str(o.open(frame))).toBe("once");
    expect(o.open(frame)).toBeNull(); // 第二次
  });

  it("乱序/迟到帧 → 拒", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    const f0 = s.seal(msg("a"));
    const f1 = s.seal(msg("b"));
    expect(str(o.open(f1))).toBe("b"); // 先收到 1
    expect(o.open(f0)).toBeNull();     // 0 迟到 → 丢
  });

  it("nonce 前缀不同 → 认证失败（前缀真的进了 AEAD）", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, new Uint8Array([9, 9, 9, 9]));
    expect(o.open(s.seal(msg("x")))).toBeNull();
  });

  it("密钥不同 → 认证失败", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, new Uint8Array(32).fill(8), PREFIX);
    expect(o.open(s.seal(msg("x")))).toBeNull();
  });

  it("截断的帧 → null，不抛", () => {
    const o = createOpener(P, KEY, PREFIX);
    expect(o.open(new Uint8Array(3))).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/shared/remote/sealedStream.test.ts`
Expected: FAIL — 解析不到 `sealedStream.js` / `crypto.js`

- [ ] **Step 3: 写实现（两个文件）**

Create `src/shared/remote/crypto.ts`:

```ts
// 密码学原语的注入接口。这里只有类型，零实现——
// 桌面用 node:crypto（src/main/remoteCryptoNode.ts），手机用 react-native-libsodium，
// 而握手/流封装那些**我们自己写的逻辑**只依赖这个接口，因此可以在单测里
// 用假原语跑，既不慢也不把平台依赖拖进 src/shared。
//
// 纯文件：不许 import node builtin / electron。

export interface KeyPair {
  /** 原始字节，不是 KeyObject —— 接口要能被 RN 侧实现 */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface RemoteCryptoPrimitives {
  randomBytes(n: number): Uint8Array;

  generateX25519(): KeyPair;
  /** 原始 32 字节共享秘密（未经 KDF，调用方必须再过 HKDF） */
  x25519(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array;

  generateEd25519(): KeyPair;
  ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array;
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;

  /** ChaCha20-Poly1305-IETF。nonce 恒为 12 字节，返回 密文||16 字节 tag */
  chachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** 认证失败回 null,不抛 —— 解密失败是常态分支(乱序/篡改),不是异常 */
  chachaOpen(key: Uint8Array, nonce: Uint8Array, box: Uint8Array): Uint8Array | null;
}
```

Create `src/shared/remote/sealedStream.ts`:

```ts
// 单向加密流。丢掉 libsodium secretstream 之后,nonce 管理和乱序/重放检测
// 就是我们自己的责任了(spec 第二节订正),所以它们住在这个可单测的纯文件里。
//
// 线格式:[8 字节大端计数器][密文][16 字节 tag]
// nonce = [4 字节前缀(握手派生,每方向一条)][8 字节计数器]
//
// 计数器明文出现在帧头,是故意的:收端要先知道 nonce 才能验签。
// 它不是秘密——泄漏的只是"这是第几帧",而帧数本来就是网关可见的元数据。

import type { RemoteCryptoPrimitives } from "./crypto.js";

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const PREFIX_BYTES = NONCE_BYTES - COUNTER_BYTES; // 4

function nonceFor(prefix: Uint8Array, counter: bigint): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  n.set(prefix.slice(0, PREFIX_BYTES), 0);
  new DataView(n.buffer).setBigUint64(PREFIX_BYTES, counter, false); // 大端
  return n;
}

export function createSealer(
  p: RemoteCryptoPrimitives,
  key: Uint8Array,
  noncePrefix: Uint8Array
): { seal(plain: Uint8Array): Uint8Array } {
  let counter = 0n;
  return {
    seal(plain) {
      const c = counter;
      // 不回绕:到顶就抛,让上层断开重连换一把新密钥。
      // 静默回绕 = 同一把 key 复用同一个 nonce = ChaCha 的灾难性失效
      if (c === 0xffffffffffffffffn) throw new Error("远程流计数器耗尽,必须重连");
      counter += 1n;
      const box = p.chachaSeal(key, nonceFor(noncePrefix, c), plain);
      const out = new Uint8Array(COUNTER_BYTES + box.length);
      new DataView(out.buffer).setBigUint64(0, c, false);
      out.set(box, COUNTER_BYTES);
      return out;
    },
  };
}

export function createOpener(
  p: RemoteCryptoPrimitives,
  key: Uint8Array,
  noncePrefix: Uint8Array
): { open(box: Uint8Array): Uint8Array | null } {
  // -1 表示"还没收过任何一帧",这样第 0 帧(counter=0)才收得进来
  let highest = -1n;
  return {
    open(frame) {
      if (frame.length < COUNTER_BYTES + TAG_BYTES) return null;
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const counter = view.getBigUint64(0, false);
      // 严格递增:重放(==)和迟到(<)一起挡掉。
      // 先查计数器再验签,省掉一次白费的 AEAD
      if (counter <= highest) return null;
      const plain = p.chachaOpen(key, nonceFor(noncePrefix, counter), frame.slice(COUNTER_BYTES));
      if (!plain) return null;
      // 只有验签通过才推进水位线——否则伪造一个大计数器就能把后续真帧全饿死
      highest = counter;
      return plain;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/sealedStream.test.ts`
Expected: PASS（7 条用例）

- [ ] **Step 5: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/remote/b64.ts src/shared/remote/crypto.ts src/shared/remote/sealedStream.ts tests/shared/remote/b64.test.ts tests/shared/remote/sealedStream.test.ts
git commit -m "feat(remote): 密码学原语注入接口 + 计数器 nonce 的单向加密流

丢掉 libsodium secretstream(spec 订正)换来桌面侧零依赖,代价是 nonce 管理
和乱序/重放检测从'库送的'变成'自己写的'。所以它们住在一个纯文件里,并且
被逐条钉住:重放拒、迟到拒、前缀不对拒、密钥不对拒、截断不抛。

两个不显眼但要命的选择,都在注释里写了理由:
- 计数器到顶抛异常而不是回绕 —— 同 key 复用同 nonce 是 ChaCha 的灾难性失效
- 水位线只在验签通过后推进 —— 否则伪造一个大计数器就能饿死后续所有真帧

原语走注入接口而不是直接 import:src/shared 要能在 RN 上跑,不能拖进 node:crypto。"
```

---

## Task 3: 握手、密钥派生、指纹

**Files:**
- Create: `src/shared/remote/handshake.ts`
- Test: `tests/shared/remote/handshake.test.ts`

**Interfaces:**
- Consumes: `RemoteCryptoPrimitives`（Task 2）
- Produces:
  - `type Role = "desktop" | "mobile"`
  - `interface HandshakeHello { role: Role; deviceId: string; ephPub: string; nonceHalf: string; sig: string }`（`string` = base64url）
  - `buildHello(p, args): HandshakeHello`
  - `deriveSession(p, args): { send: {key, prefix}; recv: {key, prefix} } | null`
  - `fingerprint(p, edPubA, edPubB): string`（6 位十进制）

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/remote/handshake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { b64encode } from "../../../src/shared/remote/b64.js";
import { buildHello, deriveSession, fingerprint } from "../../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

function party(role: "desktop" | "mobile", deviceId: string) {
  const identity = P.generateEd25519();
  const eph = P.generateX25519();
  const nonceHalf = P.randomBytes(16);
  return { role, deviceId, identity, eph, nonceHalf } as const;
}

function connect(a: ReturnType<typeof party>, b: ReturnType<typeof party>) {
  const helloA = buildHello(P, a);
  const helloB = buildHello(P, b);
  const sa = deriveSession(P, { self: a, peerHello: helloB, peerIdentityPub: b.identity.publicKey });
  const sb = deriveSession(P, { self: b, peerHello: helloA, peerIdentityPub: a.identity.publicKey });
  return { helloA, helloB, sa, sb };
}

describe("握手", () => {
  it("双方派生出对得上的两条单向密钥", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const { sa, sb } = connect(d, m);
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    // 桌面的发 = 手机的收
    expect([...sa!.send.key]).toEqual([...sb!.recv.key]);
    expect([...sa!.send.prefix]).toEqual([...sb!.recv.prefix]);
    // 反向同理，且两条方向的密钥必须不同
    expect([...sa!.recv.key]).toEqual([...sb!.send.key]);
    expect([...sa!.send.key]).not.toEqual([...sa!.recv.key]);
  });

  it("端到端：桌面封，手机拆", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const { sa, sb } = connect(d, m);
    const sealer = createSealer(P, sa!.send.key, sa!.send.prefix);
    const opener = createOpener(P, sb!.recv.key, sb!.recv.prefix);
    const plain = new TextEncoder().encode('{"type":"ping","ts":1}');
    expect([...opener.open(sealer.seal(plain))!]).toEqual([...plain]);
  });

  it("签名被篡改 → 拒", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const helloD = buildHello(P, d);
    const tampered = { ...helloD, sig: helloD.sig.slice(0, -2) + (helloD.sig.endsWith("A") ? "B" : "A") };
    expect(deriveSession(P, { self: m, peerHello: tampered, peerIdentityPub: d.identity.publicKey })).toBeNull();
  });

  it("pin 住的公钥对不上 → 拒（TOFU 的执行面）", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const impostor = party("desktop", "d1"); // 同一个 deviceId，不同身份密钥
    const helloImpostor = buildHello(P, impostor);
    expect(
      deriveSession(P, { self: m, peerHello: helloImpostor, peerIdentityPub: d.identity.publicKey })
    ).toBeNull();
  });

  it("临时公钥被换掉（签名仍是原主的）→ 拒", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const helloD = buildHello(P, d);
    const evil = P.generateX25519();
    const swapped = { ...helloD, ephPub: b64encode(evil.publicKey) };
    expect(deriveSession(P, { self: m, peerHello: swapped, peerIdentityPub: d.identity.publicKey })).toBeNull();
  });

  it("角色相同 → 拒（两台桌面之间不该建连）", () => {
    const d1 = party("desktop", "d1");
    const d2 = party("desktop", "d2");
    const hello2 = buildHello(P, d2);
    expect(deriveSession(P, { self: d1, peerHello: hello2, peerIdentityPub: d2.identity.publicKey })).toBeNull();
  });

  it("重放上一次连接的 hello → 派生出的密钥不同（nonce 参与了 KDF）", () => {
    const d = party("desktop", "d1");
    const m1 = party("mobile", "m1");
    const m2 = { ...m1, nonceHalf: P.randomBytes(16) }; // 同一台手机，新一次连接
    const helloD = buildHello(P, d);
    const s1 = deriveSession(P, { self: m1, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    const s2 = deriveSession(P, { self: m2, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    expect([...s1!.recv.key]).not.toEqual([...s2!.recv.key]);
  });
});

describe("指纹", () => {
  it("6 位数字，与两把公钥的顺序无关", () => {
    const a = P.generateEd25519().publicKey;
    const b = P.generateEd25519().publicKey;
    const f = fingerprint(P, a, b);
    expect(f).toMatch(/^\d{6}$/);
    expect(fingerprint(P, b, a)).toBe(f);
  });
  it("换一把公钥就换一个指纹", () => {
    const a = P.generateEd25519().publicKey;
    const b = P.generateEd25519().publicKey;
    const c = P.generateEd25519().publicKey;
    expect(fingerprint(P, a, c)).not.toBe(fingerprint(P, a, b));
  });
});
```

> 注意：这个测试文件 import 了 `src/main/remoteCryptoNode.js`（Task 4 才创建）。
> 先写 Task 4 的实现再回来跑本任务的测试，或者按下面 Step 2 的顺序做——
> **两个 Task 合并成一次红-绿循环**：先建 `remoteCryptoNode.ts`（Task 4 的 Step 3），
> 再写 `handshake.ts`。这是刻意的：握手的正确性只有对着**真**原语才有意义，
> 用假原语测密钥派生等于什么都没测。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/shared/remote/handshake.test.ts`
Expected: FAIL — 解析不到 `handshake.js` 和 `remoteCryptoNode.js`

- [ ] **Step 3: 先做 Task 4 的实现（`src/main/remoteCryptoNode.ts`）**

跳到 Task 4 的 Step 3，把 `remoteCryptoNode.ts` 建好再回来。

- [ ] **Step 4: 写 `src/shared/remote/handshake.ts`**

```ts
// 每次连接一轮的握手:签名的临时公钥交换 + 双向密钥派生 + 指纹。
//
// 形状约等于 Noise 的 KK:静态 Ed25519 身份密钥只用来**签临时 X25519 公钥**,
// 会话密钥完全由临时密钥算出。于是拿到静态私钥也解不开旧密文(前向保密),
// 而临时公钥被换掉会因为签名对不上被拒(双向认证)。
//
// 信任的来源是**已 pin 住的** peerIdentityPub —— TOFU 在这里落地:
// 调用方负责首次 pin 与后续比对,本文件只负责"对不上就回 null"。
//
// 纯文件:不许 import node builtin / electron。

import { b64decode, b64encode } from "./b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";

export type Role = "desktop" | "mobile";

/** 线上的握手包(JSON 安全:字节一律 base64url) */
export interface HandshakeHello {
  role: Role;
  deviceId: string;
  ephPub: string;
  nonceHalf: string;
  sig: string;
}

export interface SelfParty {
  role: Role;
  deviceId: string;
  identity: KeyPair;
  eph: KeyPair;
  nonceHalf: Uint8Array;
}

export interface DirectionKeys {
  key: Uint8Array;
  prefix: Uint8Array;
}

export interface SessionKeys {
  send: DirectionKeys;
  recv: DirectionKeys;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 被签的字节:角色 + 设备 id + 临时公钥 + 自己那半个 nonce。
    角色进签名,是为了让"把桌面的 hello 原样转发给另一台桌面"这种反射攻击签不过 */
function signedPayload(role: Role, deviceId: string, ephPub: Uint8Array, nonceHalf: Uint8Array): Uint8Array {
  const head = utf8(`otto-remote-hello-v1|${role}|${deviceId}|`);
  const out = new Uint8Array(head.length + ephPub.length + nonceHalf.length);
  out.set(head, 0);
  out.set(ephPub, head.length);
  out.set(nonceHalf, head.length + ephPub.length);
  return out;
}

export function buildHello(p: RemoteCryptoPrimitives, self: SelfParty): HandshakeHello {
  const payload = signedPayload(self.role, self.deviceId, self.eph.publicKey, self.nonceHalf);
  return {
    role: self.role,
    deviceId: self.deviceId,
    ephPub: b64encode(self.eph.publicKey),
    nonceHalf: b64encode(self.nonceHalf),
    sig: b64encode(p.ed25519Sign(self.identity.privateKey, payload)),
  };
}

/** 双方的 nonceHalf 拼成 KDF 的 salt。拼接顺序按角色钉死(desktop 在前),
    两边才能算出同一个 salt —— 不能按"我的在前" */
function connectionNonce(selfRole: Role, selfHalf: Uint8Array, peerHalf: Uint8Array): Uint8Array {
  const [first, second] = selfRole === "desktop" ? [selfHalf, peerHalf] : [peerHalf, selfHalf];
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

function directionKeys(
  p: RemoteCryptoPrimitives,
  shared: Uint8Array,
  salt: Uint8Array,
  info: string
): DirectionKeys {
  const out = p.hkdfSha256(shared, salt, utf8(info), 36);
  return { key: out.slice(0, 32), prefix: out.slice(32, 36) };
}

export function deriveSession(
  p: RemoteCryptoPrimitives,
  args: { self: SelfParty; peerHello: HandshakeHello; peerIdentityPub: Uint8Array }
): SessionKeys | null {
  const { self, peerHello, peerIdentityPub } = args;

  // 两台桌面 / 两台手机之间不该建连
  if (peerHello.role === self.role) return null;
  if (peerHello.role !== "desktop" && peerHello.role !== "mobile") return null;

  const ephPub = b64decode(peerHello.ephPub);
  const peerHalf = b64decode(peerHello.nonceHalf);
  const sig = b64decode(peerHello.sig);
  if (!ephPub || !peerHalf || !sig) return null;
  if (ephPub.length !== 32 || peerHalf.length !== 16 || sig.length !== 64) return null;

  // TOFU 的执行面:验的是**调用方 pin 住的**那把公钥,不是 hello 自称的身份
  const payload = signedPayload(peerHello.role, peerHello.deviceId, ephPub, peerHalf);
  if (!p.ed25519Verify(peerIdentityPub, payload, sig)) return null;

  const shared = p.x25519(self.eph.privateKey, ephPub);
  const salt = connectionNonce(self.role, self.nonceHalf, peerHalf);
  const d2m = directionKeys(p, shared, salt, "otto-stream-v1:d2m");
  const m2d = directionKeys(p, shared, salt, "otto-stream-v1:m2d");
  return self.role === "desktop" ? { send: d2m, recv: m2d } : { send: m2d, recv: d2m };
}

/** 两端各自显示的 6 位安全码。排序后哈希 —— 两边看到同一个数,
    而"看到同一个数"正是它唯一要做的事 */
export function fingerprint(p: RemoteCryptoPrimitives, a: Uint8Array, b: Uint8Array): string {
  const [x, y] = b64encode(a) <= b64encode(b) ? [a, b] : [b, a];
  const buf = new Uint8Array(x.length + y.length);
  buf.set(x, 0);
  buf.set(y, x.length);
  const h = p.sha256(buf);
  const n = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % 1000000;
  return String(n).padStart(6, "0");
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/handshake.test.ts`
Expected: PASS（9 条用例）

- [ ] **Step 6: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/remote/handshake.ts tests/shared/remote/handshake.test.ts
git commit -m "feat(remote): 握手、双向密钥派生、6 位指纹

形状约等于 Noise KK:静态 Ed25519 只用来签临时 X25519 公钥,会话密钥完全由
临时密钥算出。于是拿到静态私钥也解不开旧密文(前向保密),临时公钥被换掉会
因为签名对不上被拒(双向认证)。TOFU 在这里落地:验的是调用方 pin 住的那把
公钥,不是 hello 自称的身份 —— 具名测试'pin 住的公钥对不上 → 拒'钉的就是它。

三个不显眼的决定,注释里写了理由:
- 角色进签名 —— 挡住'把桌面的 hello 原样转发给另一台桌面'这种反射攻击
- nonce 拼接顺序按角色钉死而不是'我的在前' —— 否则两边算出的 salt 不同
- 指纹排序后再哈希 —— 两端要看到同一个数,这是它唯一的职责"
```

---

## Task 4: `node:crypto` 实现原语

**Files:**
- Create: `src/main/remoteCryptoNode.ts`
- Test: `tests/main/remoteCryptoNode.test.ts`

**Interfaces:**
- Consumes: `RemoteCryptoPrimitives`（Task 2）
- Produces: `nodeRemoteCrypto(): RemoteCryptoPrimitives`

> 本任务的 Step 3 在 Task 3 的 Step 3 被提前调用过——那是刻意的（握手要对着真原语测）。
> 若已经写过，这里只补测试。

- [ ] **Step 1: 写失败的测试**

Create `tests/main/remoteCryptoNode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

describe("nodeRemoteCrypto", () => {
  it("x25519 双方算出同一个共享秘密", () => {
    const a = P.generateX25519();
    const b = P.generateX25519();
    expect([...P.x25519(a.privateKey, b.publicKey)]).toEqual([...P.x25519(b.privateKey, a.publicKey)]);
    expect(P.x25519(a.privateKey, b.publicKey).length).toBe(32);
  });

  it("ed25519 签名可验，改一个字节就验不过", () => {
    const k = P.generateEd25519();
    const msg = new TextEncoder().encode("hello");
    const sig = P.ed25519Sign(k.privateKey, msg);
    expect(sig.length).toBe(64);
    expect(P.ed25519Verify(k.publicKey, msg, sig)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[0] ^= 1;
    expect(P.ed25519Verify(k.publicKey, msg, bad)).toBe(false);
  });

  it("ed25519Verify 遇到畸形公钥回 false 而不是抛", () => {
    const k = P.generateEd25519();
    const msg = new TextEncoder().encode("hello");
    const sig = P.ed25519Sign(k.privateKey, msg);
    expect(P.ed25519Verify(new Uint8Array(5), msg, sig)).toBe(false);
  });

  it("chacha 往返；nonce 改一位就认证失败（回 null 不抛）", () => {
    const key = P.randomBytes(32);
    const nonce = P.randomBytes(12);
    const plain = new TextEncoder().encode("secret payload");
    const box = P.chachaSeal(key, nonce, plain);
    expect([...P.chachaOpen(key, nonce, box)!]).toEqual([...plain]);
    const other = new Uint8Array(nonce);
    other[0] ^= 1;
    expect(P.chachaOpen(key, other, box)).toBeNull();
  });

  it("hkdf 长度可控且随 info 变化", () => {
    const ikm = P.randomBytes(32);
    const salt = P.randomBytes(16);
    const enc = new TextEncoder();
    const a = P.hkdfSha256(ikm, salt, enc.encode("a"), 36);
    const b = P.hkdfSha256(ikm, salt, enc.encode("b"), 36);
    expect(a.length).toBe(36);
    expect([...a]).not.toEqual([...b]);
  });

  it("randomBytes 长度对且不重复", () => {
    expect(P.randomBytes(12).length).toBe(12);
    expect([...P.randomBytes(16)]).not.toEqual([...P.randomBytes(16)]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/remoteCryptoNode.test.ts`
Expected: FAIL — 解析不到 `remoteCryptoNode.js`

- [ ] **Step 3: 写实现**

Create `src/main/remoteCryptoNode.ts`:

```ts
// RemoteCryptoPrimitives 的桌面实现。全部走 node:crypto —— 零新 npm 依赖。
//
// 为什么是 ChaCha20-Poly1305 而不是 AES-GCM:三家的交集在这里。
// node ✅ / CryptoKit ChaChaPoly ✅ / libsodium 的 chacha ietf 恒有 ✅,
// 而 libsodium 的 AES-GCM 要 AES-NI 硬件支持,在 ARM 上
// crypto_aead_aes256gcm_is_available() 会回 false —— 真机上会踩(spec 第二节订正)。
//
// 主进程组装根特权:允许直接 import node builtin(src/shared 那边不行)。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";

const TAG_BYTES = 16;

/** node 的 KeyObject ⇄ 原始字节。接口收原始字节是为了 RN 侧也能实现,
    代价是每次用都要重新包一层 DER —— 握手一轮几次调用,可忽略 */
const DER_PREFIX = {
  x25519Priv: Buffer.from("302e020100300506032b656e04220420", "hex"),
  x25519Pub: Buffer.from("302a300506032b656e032100", "hex"),
  ed25519Priv: Buffer.from("302e020100300506032b657004220420", "hex"),
  ed25519Pub: Buffer.from("302a300506032b6570032100", "hex"),
} as const;

function privKey(raw: Uint8Array, kind: "x25519Priv" | "ed25519Priv"): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([DER_PREFIX[kind], Buffer.from(raw)]),
    format: "der",
    type: "pkcs8",
  });
}

function pubKey(raw: Uint8Array, kind: "x25519Pub" | "ed25519Pub"): KeyObject {
  return createPublicKey({
    key: Buffer.concat([DER_PREFIX[kind], Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function rawOf(k: KeyObject, kind: "private" | "public"): Uint8Array {
  const der = k.export(
    kind === "private" ? { format: "der", type: "pkcs8" } : { format: "der", type: "spki" }
  ) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32)); // 两种曲线的原始密钥都是尾部 32 字节
}

function generate(type: "x25519" | "ed25519"): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync(type);
  return { privateKey: rawOf(privateKey, "private"), publicKey: rawOf(publicKey, "public") };
}

export function nodeRemoteCrypto(): RemoteCryptoPrimitives {
  return {
    randomBytes: (n) => new Uint8Array(randomBytes(n)),

    generateX25519: () => generate("x25519"),
    x25519: (priv, peerPub) =>
      new Uint8Array(
        diffieHellman({ privateKey: privKey(priv, "x25519Priv"), publicKey: pubKey(peerPub, "x25519Pub") })
      ),

    generateEd25519: () => generate("ed25519"),
    ed25519Sign: (priv, msg) =>
      new Uint8Array(edSign(null, Buffer.from(msg), privKey(priv, "ed25519Priv"))),
    ed25519Verify: (pub, msg, sig) => {
      // 畸形公钥会让 createPublicKey 抛。验签失败是常态分支(公钥 pin 不上就是要走到这),
      // 不能让它变成异常把整条连接炸掉
      try {
        return edVerify(null, Buffer.from(msg), pubKey(pub, "ed25519Pub"), Buffer.from(sig));
      } catch {
        return false;
      }
    },

    hkdfSha256: (ikm, salt, info, length) =>
      new Uint8Array(hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), length)),
    sha256: (data) => new Uint8Array(createHash("sha256").update(Buffer.from(data)).digest()),

    chachaSeal: (key, nonce, plaintext) => {
      const c = createCipheriv("chacha20-poly1305", Buffer.from(key), Buffer.from(nonce), {
        authTagLength: TAG_BYTES,
      });
      const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
      return new Uint8Array(Buffer.concat([ct, c.getAuthTag()]));
    },
    chachaOpen: (key, nonce, box) => {
      if (box.length < TAG_BYTES) return null;
      try {
        const d = createDecipheriv("chacha20-poly1305", Buffer.from(key), Buffer.from(nonce), {
          authTagLength: TAG_BYTES,
        });
        d.setAuthTag(Buffer.from(box.slice(box.length - TAG_BYTES)));
        return new Uint8Array(
          Buffer.concat([d.update(Buffer.from(box.slice(0, box.length - TAG_BYTES))), d.final()])
        );
      } catch {
        return null; // 认证失败是常态分支(乱序/篡改),不是异常
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/remoteCryptoNode.test.ts tests/shared/remote/handshake.test.ts`
Expected: PASS（两个文件都绿）

- [ ] **Step 5: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/remoteCryptoNode.ts tests/main/remoteCryptoNode.test.ts
git commit -m "feat(remote): 用 node:crypto 实现密码学原语,桌面侧零新依赖

本机 Node 22 实测过 x25519 / ed25519 / hkdf / chacha20-poly1305 全都原生可用,
所以 spec 里原写的 libsodium-wrappers 依赖删掉了。

两处防御性写法有原因:
- ed25519Verify 吞掉 createPublicKey 的异常回 false —— 验签失败是常态分支
  (公钥 pin 不上就是要走到这),不能让它把整条连接炸掉
- chachaOpen 同理

接口收原始字节而不是 node 的 KeyObject,是为了 RN 侧也能实现同一个接口;
代价是每次用要重包一层 DER,握手一轮几次调用,可忽略。"
```

---

## Task 5: `devices` 表与 RLS

**Files:**
- Create: `supabase/migrations/0011_remote_devices.sql`
- Test: `tests/docs/` 无需改动；migration 由人工在 Supabase SQL editor 执行（ADR-0071）

**Interfaces:**
- Consumes: 无
- Produces: 表 `public.devices`，列：`user_id uuid` / `device_id text` / `kind text` / `identity_pub text` / `kx_pub text` / `push_token text` / `label text` / `last_seen timestamptz`

- [ ] **Step 1: 写 migration**

Create `supabase/migrations/0011_remote_devices.sql`:

```sql
-- 远程中继的设备登记表(spec: docs/superpowers/specs/2026-08-25-mobile-remote-control-design.md)。
--
-- 这是手机端功能**唯一**新增的持久化。会话内容一个字节都不落库:
-- 网关是盲管道,桌面不在线时手机显示"你的 Mac 不在线"。
--
-- 公钥进库是故意的,私钥永远不进:身份私钥只在各自设备的 Keychain/Keystore 里。
-- 库里泄漏这张表 = 泄漏"谁有几台设备",不等于泄漏任何一条会话。

create table if not exists public.devices (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  device_id    text        not null,
  kind         text        not null check (kind in ('desktop', 'mobile')),
  -- base64url 的原始公钥(各 32 字节 → 43 字符)
  identity_pub text        not null,
  kx_pub       text        not null,
  -- APNs/FCM token,只有 mobile 有
  push_token   text,
  label        text        not null default '',
  last_seen    timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.devices enable row level security;

-- 和 profiles 的 select policy(对所有登录用户开放,ADR-0055 订正里记着)**刻意不同**:
-- 那张表要支持"按邮箱精确搜好友",这张表没有任何跨用户的用途。
-- 别人能读到我的设备列表 = 别人知道我有几台机器、什么时候在线,没有任何收益。
create policy devices_select_own on public.devices
  for select using (auth.uid() = user_id);

create policy devices_insert_own on public.devices
  for insert with check (auth.uid() = user_id);

-- 只允许改自己的行,且不允许把行改到别人名下(using 管旧行,with check 管新行)
create policy devices_update_own on public.devices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy devices_delete_own on public.devices
  for delete using (auth.uid() = user_id);

-- 网关按 user_id 找同户的另一端;last_seen 用于清理僵尸登记
create index if not exists devices_user_kind_idx on public.devices (user_id, kind);
```

- [ ] **Step 2: 跑整条门禁**

Run: `npm test`
Expected: PASS（migration 不进 TS 编译，这一步是确认没碰坏别的）

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0011_remote_devices.sql
git commit -m "feat(remote): devices 表 + RLS —— 手机端功能唯一新增的持久化

会话内容一个字节都不落库:网关是盲管道,桌面不在线手机就显示'不在线'。
这张表只存公钥、推送 token 和 last_seen;私钥永远只在各自设备的
Keychain/Keystore 里,泄漏这张表 = 泄漏'谁有几台设备',不等于泄漏任何一条会话。

select policy 刻意收成'只能看自己的',与 profiles 那张表不同 —— profiles 对
所有登录用户开放是为了支持按邮箱搜好友(ADR-0055 订正里记着),而设备表没有
任何跨用户用途,开放只会白送'谁几点在线'。

按 ADR-0071,migration 是编号文件,人工在 SQL editor 执行,不改旧文件。"
```

- [ ] **Step 4: 人工执行（不是代码步骤，但必须做完才能进 Task 6 的真机验证）**

在 Supabase SQL editor 粘贴执行本文件。执行后跑一遍自查：

```sql
-- 应当回 4 行策略
select policyname from pg_policies where tablename = 'devices';
-- 应当回 t
select relrowsecurity from pg_class where relname = 'devices';
```

---

## Task 6: 网关盲管道

**Files:**
- Create: `services/gateway/src/relay.ts`
- Modify: `services/gateway/src/gateway.ts:263-290`（路由表加一条）
- Test: `tests/gateway/relay.test.ts`

**Interfaces:**
- Consumes: `verifyJwt`（`services/gateway/src/jwt.ts`，已存在）
- Produces:
  - `createRelay(): { attach(userId, role, sink): () => void; deliver(userId, fromRole, payload): boolean; peerOnline(userId, role): boolean }`
  - `type RelaySink = { write(chunk: string): void }`
  - HTTP：`GET /rl/v1/stream`（SSE 下行）、`POST /rl/v1/send`（上行）

- [ ] **Step 1: 写失败的测试**

Create `tests/gateway/relay.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createRelay } from "../../services/gateway/src/relay.js";

function sink() {
  const chunks: string[] = [];
  return { chunks, write(c: string) { chunks.push(c); } };
}

describe("createRelay", () => {
  it("同一 user 的两端互转字节", () => {
    const r = createRelay();
    const desktop = sink();
    const mobile = sink();
    r.attach("u1", "desktop", desktop);
    r.attach("u1", "mobile", mobile);

    expect(r.deliver("u1", "desktop", "AAAA")).toBe(true);
    expect(mobile.chunks.join("")).toContain("AAAA");
    expect(desktop.chunks.join("")).toBe(""); // 不回声给发送方

    expect(r.deliver("u1", "mobile", "BBBB")).toBe(true);
    expect(desktop.chunks.join("")).toContain("BBBB");
  });

  it("不同 user 之间绝不串线", () => {
    const r = createRelay();
    const a = sink();
    const b = sink();
    r.attach("u1", "mobile", a);
    r.attach("u2", "mobile", b);
    r.deliver("u1", "desktop", "SECRET");
    expect(b.chunks.join("")).toBe("");
  });

  it("对端不在线 → deliver 回 false，字节丢弃", () => {
    const r = createRelay();
    r.attach("u1", "desktop", sink());
    expect(r.deliver("u1", "desktop", "X")).toBe(false);
    expect(r.peerOnline("u1", "desktop")).toBe(false);
  });

  it("detach 之后不再收", () => {
    const r = createRelay();
    const m = sink();
    const off = r.attach("u1", "mobile", m);
    off();
    expect(r.deliver("u1", "desktop", "X")).toBe(false);
    expect(m.chunks.join("")).toBe("");
  });

  it("同角色重连顶掉旧连接（一户一桌面一手机）", () => {
    const r = createRelay();
    const old = sink();
    const fresh = sink();
    r.attach("u1", "mobile", old);
    r.attach("u1", "mobile", fresh);
    r.deliver("u1", "desktop", "X");
    expect(old.chunks.join("")).toBe("");
    expect(fresh.chunks.join("")).toContain("X");
  });

  // ↓ 盲管道这个性质要有测试守着，否则三个月后有人为调试加一行 console.log
  it("负载从不被解析：deliver 收到坏 JSON 也照转不误", () => {
    const r = createRelay();
    const m = sink();
    r.attach("u1", "mobile", m);
    expect(r.deliver("u1", "desktop", "{{{ not json at all")).toBe(true);
    expect(m.chunks.join("")).toContain("{{{ not json at all");
  });

  it("负载从不进日志", () => {
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createRelay();
    r.attach("u1", "mobile", sink());
    r.deliver("u1", "desktop", "TOP-SECRET-PAYLOAD");
    const all = [...spyLog.mock.calls, ...spyErr.mock.calls].flat().join(" ");
    expect(all).not.toContain("TOP-SECRET-PAYLOAD");
    spyLog.mockRestore();
    spyErr.mockRestore();
  });

  it("SSE 线格式：data: 一行 + 空行收尾", () => {
    const r = createRelay();
    const m = sink();
    r.attach("u1", "mobile", m);
    r.deliver("u1", "desktop", "PAYLOAD");
    expect(m.chunks.join("")).toBe("data: PAYLOAD\n\n");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/gateway/relay.test.ts`
Expected: FAIL — 解析不到 `relay.js`

- [ ] **Step 3: 写实现**

Create `services/gateway/src/relay.ts`:

```ts
// 盲管道。它做的全部事情:按 user_id 把桌面那一端和手机那一端的字节互转。
//
// 三条它**不做**的事,每一条都是安全性质,不是懒:
//   1. 不解析负载 —— 端到端加密的密文对它就该是不透明字节
//   2. 不落盘 —— 会话内容一个字节都不进库(spec 第一节不变量 3)
//   3. 不打印负载 —— tests/gateway/relay.test.ts 有一条测试专门钉这个,
//      因为"调试时顺手 console.log 一下"是这类系统最常见的泄漏方式
//
// 一户一桌面一手机:同角色重连顶掉旧连接。多设备是后话,现在多开只会让
// "该发给谁"变成一个需要路由的问题,而那不是这一版要解决的。

export type RelayRole = "desktop" | "mobile";

export interface RelaySink {
  write(chunk: string): void;
}

interface UserSlot {
  desktop: RelaySink | null;
  mobile: RelaySink | null;
}

const other = (r: RelayRole): RelayRole => (r === "desktop" ? "mobile" : "desktop");

/** SSE 的一条事件。负载是 base64url 密文,天然没有换行,不用转义 */
const sseEvent = (payload: string): string => `data: ${payload}\n\n`;

export function createRelay(): {
  attach(userId: string, role: RelayRole, sink: RelaySink): () => void;
  deliver(userId: string, fromRole: RelayRole, payload: string): boolean;
  peerOnline(userId: string, role: RelayRole): boolean;
} {
  const slots = new Map<string, UserSlot>();

  const slotOf = (userId: string): UserSlot => {
    let s = slots.get(userId);
    if (!s) {
      s = { desktop: null, mobile: null };
      slots.set(userId, s);
    }
    return s;
  };

  const gc = (userId: string): void => {
    const s = slots.get(userId);
    if (s && !s.desktop && !s.mobile) slots.delete(userId);
  };

  return {
    attach(userId, role, sink) {
      const s = slotOf(userId);
      s[role] = sink; // 同角色重连顶掉旧的
      return () => {
        // 只有还是自己那条连接时才摘 —— 否则"旧连接的清理"会把新连接踢下线
        if (s[role] === sink) s[role] = null;
        gc(userId);
      };
    },

    deliver(userId, fromRole, payload) {
      const peer = slots.get(userId)?.[other(fromRole)];
      if (!peer) return false; // 对端不在线:丢弃,不排队(排队 = 落盘)
      peer.write(sseEvent(payload));
      return true;
    },

    peerOnline(userId, role) {
      return Boolean(slots.get(userId)?.[other(role)]);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/gateway/relay.test.ts`
Expected: PASS（8 条用例）

- [ ] **Step 5: 挂路由**

Modify `services/gateway/src/gateway.ts`。

① `GatewayDeps` 里加一条（照 `poker` 的写法，不注入就没有这组端点）：

```ts
  /** 远程中继(spec 2026-08-25)。不注入就没有 /rl/v1/* */
  relay?: {
    attach(userId: string, role: "desktop" | "mobile", sink: { write(c: string): void }): () => void;
    deliver(userId: string, fromRole: "desktop" | "mobile", payload: string): boolean;
    peerOnline(userId: string, role: "desktop" | "mobile"): boolean;
  };
```

② 在 `createGateway` 内、`handle` 之前加两个处理函数：

```ts
  const MAX_UPLINK_BYTES = 256 * 1024;
  const HEARTBEAT_MS = 25_000;

  function relayRole(req: Request): "desktop" | "mobile" | null {
    const r = new URL(req.url).searchParams.get("role");
    return r === "desktop" || r === "mobile" ? r : null;
  }

  function relayStream(req: Request): Response {
    const who = identify(req);
    if (who instanceof Response) return who;
    if (!deps.relay) return apiError(404, "这个网关没开远程中继", "relay_disabled");
    const role = relayRole(req);
    if (!role) return apiError(400, "role 必须是 desktop 或 mobile", "bad_role");
    const relay = deps.relay;

    let detach: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const write = (s: string) => {
          // 客户端已断开时 enqueue 会抛。这里静默吞掉:掉线是常态,
          // 而 cancel 回调未必先于最后一次心跳到达
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            /* 连接没了 */
          }
        };
        detach = relay.attach(who.userId, role, { write });
        // nginx 的 proxy_read_timeout 是 600s,不发东西就会被掐。
        // 注释行(以 ':' 开头)不是 data 帧,客户端的 SSE 解析器会跳过它
        timer = setInterval(() => write(":\n\n"), HEARTBEAT_MS);
      },
      cancel() {
        detach?.();
        if (timer) clearInterval(timer);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        // 双保险:nginx 那侧已经 proxy_buffering off,这个头让任何一层代理都别攒
        "x-accel-buffering": "no",
      },
    });
  }

  async function relaySend(req: Request): Promise<Response> {
    const who = identify(req);
    if (who instanceof Response) return who;
    if (!deps.relay) return apiError(404, "这个网关没开远程中继", "relay_disabled");
    const role = relayRole(req);
    if (!role) return apiError(400, "role 必须是 desktop 或 mobile", "bad_role");

    const body = await req.text();
    // 只看长度,不看内容 —— 盲管道。上限挡的是内存,不是"内容不合法"
    if (body.length > MAX_UPLINK_BYTES) {
      return apiError(413, "单帧超过 256 KiB", "frame_too_large");
    }
    return deps.relay.deliver(who.userId, role, body)
      ? new Response(null, { status: 204 })
      : apiError(409, "对端不在线", "peer_offline");
  }
```

③ 在 `handle` 的路由表里、`/v1/wallet` 之后、`return apiError(404, ...)` 之前插入：

```ts
    if (pathname === "/rl/v1/stream") {
      return req.method === "GET" ? relayStream(req) : apiError(405, "只收 GET", "method_not_allowed");
    }
    if (pathname === "/rl/v1/send") {
      return req.method === "POST" ? relaySend(req) : apiError(405, "只收 POST", "method_not_allowed");
    }
```

④ `services/gateway/src/server.ts` 的装配处，`createGateway` 的参数里加 `relay: createRelay()`
（并 `import { createRelay } from "./relay.js";`）。

- [ ] **Step 5b: 补路由层的测试**

追加到 `tests/gateway/relay.test.ts`（用 `createGateway` 的既有测试写法，注入假 wallet 与固定时钟）：

```ts
describe("/rl/v1 路由", () => {
  it("没 token → 401；role 非法 → 400；方法不对 → 405", async () => {
    const g = makeGateway(); // 与本文件其他网关测试同一个工厂
    expect((await g(new Request("http://x/rl/v1/stream?role=desktop"))).status).toBe(401);
    expect((await g(authed("http://x/rl/v1/stream?role=wat"))).status).toBe(400);
    expect((await g(authed("http://x/rl/v1/send?role=desktop", { method: "GET" }))).status).toBe(405);
  });

  it("对端不在线 → POST /send 回 409", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/send?role=desktop", { method: "POST", body: "AAAA" }));
    expect(r.status).toBe(409);
  });

  it("超过 256 KiB → 413，且不解析内容", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/send?role=desktop", {
      method: "POST",
      body: "A".repeat(256 * 1024 + 1),
    }));
    expect(r.status).toBe(413);
  });

  it("SSE 响应头带 text/event-stream 与 x-accel-buffering: no", async () => {
    const g = makeGateway();
    const r = await g(authed("http://x/rl/v1/stream?role=desktop"));
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
  });
});
```

- [ ] **Step 6: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/gateway/src/relay.ts services/gateway/src/gateway.ts tests/gateway/relay.test.ts
git commit -m "feat(gateway): /rl/v1 盲管道 —— SSE 下行 + POST 上行

不用 WebSocket 有两条硬理由,不是偏好:nginx-gw-location.conf 里
proxy_set_header Connection ''; 这一行直接掐死 WS upgrade;而网关目前零运行时
依赖,加 ws 会破了它。SSE 那条路 nginx 早为 /v1/chat/completions 调好了。
上行命令稀疏(点一次审批一条),一条一个 POST 够用。

盲管道的三条'不做'各自有测试守着,其中'负载从不进日志'那条是专门写的 ——
调试时顺手 console.log 一下是这类系统最常见的泄漏方式,靠自觉挡不住。

保活 25s 一条 SSE 注释行:nginx proxy_read_timeout 是 600s,不发就会被掐。"
```

---

## Task 7: 桌面 remoteBridge

**Files:**
- Create: `src/main/remoteBridge.ts`
- Test: `tests/main/remoteBridge.test.ts`

**Interfaces:**
- Consumes: `encodeFrame` / `decodeUpFrame`（Task 1）、`b64encode` / `b64decode` / `createSealer` / `createOpener`（Task 2）、`buildHello` / `deriveSession`（Task 3）、`nodeRemoteCrypto`（Task 4）
- Produces:
  - `interface RemoteTransport { send(payload: string): void; onMessage(cb: (payload: string) => void): void; onClose(cb: () => void): void; close(): void }`
  - `createRemoteBridge(opts): { pushFleet(f: IslandFleet): void; dispose(): void }`

> **线上怎么区分握手包和密文帧**：握手包是明文 JSON，第一个字符必然是 `{`；
> 密文帧是 base64url，字母表里没有 `{`。零歧义，不需要额外的类型字节。

- [ ] **Step 1: 写失败的测试**

Create `tests/main/remoteBridge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createRemoteBridge } from "../../src/main/remoteBridge.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";
import { b64decode, b64encode } from "../../src/shared/remote/b64.js";
import {
  buildHello, deriveSession,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../src/shared/remote/sealedStream.js";
import type { IslandFleet } from "../../src/shared/shellBridge.js";

const P = nodeRemoteCrypto();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

const IDLE: IslandFleet = { agents: [], focusedSessionId: null };
const BUSY: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "t", phase: "active", currentTool: null,
    turnStartedAt: 1, pendingApproval: null, workspace: "/w",
  }],
  focusedSessionId: "s1",
};

function fakeTransport() {
  const sent: string[] = [];
  let onMsg: (p: string) => void = () => {};
  let onClose: () => void = () => {};
  return {
    sent,
    send(p: string) { sent.push(p); },
    onMessage(cb: (p: string) => void) { onMsg = cb; },
    onClose(cb: () => void) { onClose = cb; },
    close: vi.fn(),
    emit(p: string) { onMsg(p); },
    emitClose() { onClose(); },
  };
}

function newPeer(): SelfParty {
  return {
    role: "mobile", deviceId: "m1",
    identity: P.generateEd25519(),
    eph: P.generateX25519(),
    nonceHalf: P.randomBytes(16),
  };
}

/** 走一次**真**握手：拿桌面发出的 hello 算手机侧的密钥，再把手机的 hello 喂回去。
    没有任何测试后门——加密路径和生产环境完全一致，只是传输被替换成了数组。 */
function shake(
  t: ReturnType<typeof fakeTransport>,
  peer: SelfParty,
  desktopIdentityPub: Uint8Array,
  helloIndex: number
): SessionKeys {
  const desktopHello = JSON.parse(t.sent[helloIndex]!) as HandshakeHello;
  const keys = deriveSession(P, {
    self: peer, peerHello: desktopHello, peerIdentityPub: desktopIdentityPub,
  });
  expect(keys).not.toBeNull();
  t.emit(JSON.stringify(buildHello(P, peer)));
  return keys!;
}

function harness() {
  const identity = P.generateEd25519();
  const t = fakeTransport();
  const onCommand = vi.fn();
  const b = createRemoteBridge({
    crypto: P, identity, deviceId: "d1", transport: t, onCommand,
    peerIdentity: () => peer.identity.publicKey,
  });
  const peer = newPeer();
  return { identity, t, onCommand, b, peer };
}

describe("createRemoteBridge", () => {
  it("构造即发出自己的 hello（明文 JSON）", () => {
    const { t, b } = harness();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.startsWith("{")).toBe(true);
    expect(JSON.parse(t.sent[0]!).role).toBe("desktop");
    b.dispose();
  });

  it("握手完成前不发任何状态帧", () => {
    const { t, b } = harness();
    b.pushFleet(BUSY);
    expect(t.sent).toHaveLength(1); // 还是只有那条 hello
    b.dispose();
  });

  it("握手后推 fleet；手机侧能解出原样的帧", () => {
    const { t, b, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const opener = createOpener(P, keys.recv.key, keys.recv.prefix);

    b.pushFleet(BUSY);
    const wire = t.sent[t.sent.length - 1]!;
    expect(wire.startsWith("{")).toBe(false); // 密文，不是明文
    const plain = opener.open(b64decode(wire)!);
    expect(JSON.parse(dec(plain!))).toEqual({ type: "fleet", fleet: BUSY });
    b.dispose();
  });

  it("同一份 fleet 连推两次，第二次不过线（去重，同 islandBridge）", () => {
    const { t, b, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);
    const before = t.sent.length;
    b.pushFleet(BUSY);
    b.pushFleet(BUSY);
    expect(t.sent.length).toBe(before + 1);
    b.pushFleet(IDLE);
    expect(t.sent.length).toBe(before + 2);
    b.dispose();
  });

  it("合法上行命令 → 回调；带 grant 的 approve 整条丢弃且不回调", () => {
    const { t, b, onCommand, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const sealer = createSealer(P, keys.send.key, keys.send.prefix);
    const up = (json: string) => t.emit(b64encode(sealer.seal(enc(json))));

    up('{"type":"approve","sessionId":"s","callId":"c"}');
    expect(onCommand).toHaveBeenCalledWith({ type: "approve", sessionId: "s", callId: "c" });

    onCommand.mockClear();
    up('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}');
    expect(onCommand).not.toHaveBeenCalled();
    b.dispose();
  });

  it("垃圾字节 / 别人的密钥封的帧 → 丢弃，不抛", () => {
    const { t, b, onCommand, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);

    expect(() => t.emit("not-even-base64!!!")).not.toThrow();
    const wrong = createSealer(P, P.randomBytes(32), P.randomBytes(4));
    expect(() => t.emit(b64encode(wrong.seal(enc('{"type":"watch","sessionId":"s"}'))))).not.toThrow();
    expect(onCommand).not.toHaveBeenCalled();
    b.dispose();
  });

  it("身份 pin 不上的对端 hello → 不进 ready，状态帧仍不过线（TOFU 的执行面）", () => {
    const { t, b } = harness();
    const impostor = newPeer(); // peerIdentity() 返回的不是它的公钥
    t.emit(JSON.stringify(buildHello(P, impostor)));
    b.pushFleet(BUSY);
    expect(t.sent).toHaveLength(1);
    b.dispose();
  });

  it("断开 → 重发 hello；重握手当场把快照补推给新对端（去重基线已清）", () => {
    const { t, b, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    t.emitClose();
    expect(t.sent.length).toBe(afterFirst + 1); // 新一轮 hello
    expect(t.sent[t.sent.length - 1]!.startsWith("{")).toBe(true);

    // 同一台手机、新一次连接：身份密钥不变，临时密钥和 nonce 换新
    const fresh = newPeer();
    const keys2 = shake(
      t,
      { ...peer, eph: fresh.eph, nonceHalf: fresh.nonceHalf },
      identity.publicKey,
      t.sent.length - 1
    );

    // 关键断言:握手完成这一刻就该有一帧快照过线 —— 对端是新的,它什么都还没有。
    // 内容和断线前**一样**,所以这一帧能过线,证明去重基线确实被清掉了。
    const wire = t.sent[t.sent.length - 1]!;
    expect(wire.startsWith("{")).toBe(false);
    const opener = createOpener(P, keys2.recv.key, keys2.recv.prefix);
    expect(JSON.parse(dec(opener.open(b64decode(wire)!)!))).toEqual({ type: "fleet", fleet: BUSY });

    // 补推之后基线重新生效:同一份再推一次不该过线
    const before = t.sent.length;
    b.pushFleet(BUSY);
    expect(t.sent.length).toBe(before);
    b.dispose();
  });

  it("dispose 之后不再发、不再回调、传输被关掉", () => {
    const { t, b, onCommand, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const sealer = createSealer(P, keys.send.key, keys.send.prefix);
    const frame = b64encode(sealer.seal(enc('{"type":"watch","sessionId":"s"}')));

    b.dispose();
    const before = t.sent.length;
    b.pushFleet(BUSY);
    t.emit(frame);
    expect(t.sent.length).toBe(before);
    expect(onCommand).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/remoteBridge.test.ts`
Expected: FAIL — 解析不到 `remoteBridge.js`

- [ ] **Step 3: 写实现**

Create `src/main/remoteBridge.ts`:

```ts
// 桌面侧的远程中继装配。与 islandBridge.ts 平级:同一个投影源(IslandFleet),
// 同一套"状态下行、命令上行"的契约,只是传输从 stdio 管道换成了隔着公网的
// 加密 SSE + POST。
//
// 传输收窄成 RemoteTransport 接口而不是直接 fetch:单测能塞假连接、零网络
// (同 islandBridge 的 SpawnFn 注入)。真实现(fetch SSE + POST)是一层薄壳,
// 放在装配处,不混进这里的状态机。
//
// 线上两种东西,靠首字符区分,零歧义:
//   握手包 = 明文 JSON,首字符必然 '{'
//   数据帧 = base64url,字母表里没有 '{'
//
// 加密边界:本文件之外只见明文(IslandFleet / UpFrame),
// 本文件之内的 transport 只见 base64url 密文。两侧互不知道对方存在。

import { b64decode, b64encode } from "../shared/remote/b64.js";
import { decodeUpFrame, encodeFrame, type UpFrame } from "../shared/remote/frames.js";
import {
  buildHello, deriveSession,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../shared/remote/handshake.js";
import { createOpener, createSealer } from "../shared/remote/sealedStream.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import type { IslandFleet } from "../shared/shellBridge.js";

export interface RemoteTransport {
  /** 发一帧。对端不在线不是错误(网关回 409),由实现自己吞掉——桥不关心 */
  send(payload: string): void;
  onMessage(cb: (payload: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

type Phase = "handshaking" | "ready" | "closed";

export function createRemoteBridge(opts: {
  crypto: RemoteCryptoPrimitives;
  /** 本机身份密钥(私钥来自 Keychain,不是 keyVault.ts 那个明文文件) */
  identity: KeyPair;
  deviceId: string;
  transport: RemoteTransport;
  onCommand: (c: UpFrame) => void;
  /** 已 pin 住的对端身份公钥。null = 还没配对过 → 一律拒绝握手。
      TOFU 的存储与首次确认在调用方,本文件只负责"对不上就不进 ready" */
  peerIdentity: () => Uint8Array | null;
  log?: (m: string) => void;
}): { pushFleet(f: IslandFleet): void; dispose(): void } {
  const p = opts.crypto;
  const log = opts.log ?? (() => {});

  let phase: Phase = "handshaking";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  /** 最后一份 fleet。重连后要靠它把快照补推给新的对端 */
  let last: IslandFleet | null = null;
  /** 上一次真正写下去的线格式(明文帧,不是密文——密文每次都不同,去重不了) */
  let lastEncoded: string | null = null;

  function startHandshake(): void {
    if (phase === "closed") return;
    phase = "handshaking";
    sealer = null;
    opener = null;
    // 新连接 = 新密钥 + 对端是空的。基线不清的话"和上次一样"会把整份快照吞掉
    // (islandBridge 里 helper 重启踩过同一个坑)
    lastEncoded = null;
    self = {
      role: "desktop",
      deviceId: opts.deviceId,
      identity: opts.identity,
      eph: p.generateX25519(),
      nonceHalf: p.randomBytes(16),
    };
    opts.transport.send(JSON.stringify(buildHello(p, self)));
  }

  function onHello(line: string): void {
    if (!self) return;
    const pinned = opts.peerIdentity();
    if (!pinned) {
      log("远程桥:还没配对过任何手机,拒绝握手");
      return;
    }
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("远程桥:握手包不是合法 JSON,丢弃");
      return;
    }
    const keys: SessionKeys | null = deriveSession(p, {
      self, peerHello: hello, peerIdentityPub: pinned,
    });
    if (!keys) {
      // 这里包含了 TOFU 报警的那一路:公钥对不上就是对不上,不静默接受
      log("远程桥:对端身份验不过(公钥 pin 不上 / 签名不对),不建立会话");
      return;
    }
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    if (last) pushFleet(last); // 补推快照:对端是新的,它什么都还没有
  }

  function onSealed(payload: string): void {
    if (!opener) return;
    const raw = b64decode(payload);
    if (!raw) {
      log("远程桥:收到非 base64url 的帧,丢弃");
      return;
    }
    const plain = opener.open(raw);
    if (!plain) {
      // 解不开 = 篡改 / 重放 / 迟到。日志里**不带负载**
      log("远程桥:帧解密或计数器校验失败,丢弃");
      return;
    }
    const cmd = decodeUpFrame(new TextDecoder().decode(plain));
    if (!cmd) {
      log("远程桥:命令不在白名单里,整条丢弃");
      return;
    }
    opts.onCommand(cmd);
  }

  function pushFleet(f: IslandFleet): void {
    last = f;
    if (phase !== "ready" || !sealer) return;
    const wire = encodeFrame({ type: "fleet", fleet: f });
    if (wire === lastEncoded) return;
    lastEncoded = wire;
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))));
  }

  opts.transport.onMessage((payload) => {
    if (phase === "closed") return;
    // 首字符定型:'{' = 明文握手包,其余 = base64url 密文帧
    if (payload.startsWith("{")) onHello(payload);
    else onSealed(payload);
  });

  opts.transport.onClose(() => {
    if (phase === "closed") return;
    log("远程桥:连接断开,重新握手");
    startHandshake();
  });

  startHandshake();

  return {
    pushFleet,
    dispose() {
      phase = "closed";
      sealer = null;
      opener = null;
      opts.transport.close();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/remoteBridge.test.ts`
Expected: PASS（9 条用例）

- [ ] **Step 5: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/remoteBridge.ts tests/main/remoteBridge.test.ts
git commit -m "feat(remote): 桌面侧 remoteBridge,与 islandBridge 平级

同一个投影源(IslandFleet)、同一套'状态下行命令上行'的契约,只换传输。
传输收窄成 RemoteTransport 接口而不是直接 fetch,单测因此零网络 ——
照 islandBridge 的 SpawnFn 注入同一个套路。

测试里没有任何后门:握手是真的,加密路径和生产环境完全一致,只是传输被换成
一个数组。这是刻意的 —— 如果测试绕开加密直接塞明文,'带 grant 的 approve
被丢弃'那条就退化成 decodeUpFrame 的第二份测试,白测。

两处不显眼的决定:
- 断连时清 lastEncoded —— 新连接是新密钥、对端是空的,不清的话'和上次一样'
  会把整份快照吞掉。islandBridge 里 helper 重启踩过同一个坑。
- 去重比的是**明文**线格式而不是密文 —— 密文每帧的 nonce 都不同,比了等于没比。

握手包和数据帧靠首字符区分:握手包是明文 JSON 必然以 '{' 开头,数据帧是
base64url 而字母表里没有 '{'。零歧义,不用额外的类型字节。"
```

## Task 8: 门禁加两条边界断言

**Files:**
- Modify: `tests/architecture.test.ts`（在现有四条 `it` 之后追加）

**Interfaces:**
- Consumes: 现有的 `offenders` / `NODE_BUILTIN` 辅助函数
- Produces: 无（纯断言）

- [ ] **Step 1: 写会红的断言**

在 `tests/architecture.test.ts` 的 `describe` 块末尾追加：

```ts
  it("src/shared 不 import 任何 node builtin / electron —— 这批文件手机端也要跑", () => {
    const bad = offenders(join(ROOT, "shared"), NODE_BUILTIN);
    expect(
      bad,
      `这些 shared 文件碰了 Node/Electron:\n  ${bad.join("\n  ")}\n` +
        "修法:src/shared 是三边共享的纯类型/纯逻辑层,手机端(Expo/RN)会直接 import 同一份," +
        "碰了 Node 就断了那条路。要用 Node 能力请放 src/main,或把能力收成一个注入接口" +
        "(见 src/shared/remote/crypto.ts 的 RemoteCryptoPrimitives)"
    ).toEqual([]);
  });

  it("移动端复用的那批 src/session 文件不 import node builtin", () => {
    // store.ts(better-sqlite3)与 attachments.ts(node:fs)是**桌面专属**,不在复用面内。
    // 其余的投影函数手机端要跑 —— 名单写死在这里,新增文件想进复用面要显式加进来,
    // 而不是"碰巧还没碰 Node 就算数"
    const MOBILE_SAFE = [
      "events.ts", "deriveMessages.ts", "deriveSections.ts", "deriveTodos.ts",
      "deriveUsage.ts", "barrenTurns.ts", "activeSkills.ts", "microCompact.ts",
      "modelContextScan.ts", "persistencePolicy.ts",
    ];
    const bad = MOBILE_SAFE.filter((f) =>
      imports(join(ROOT, "session", f)).some(NODE_BUILTIN)
    );
    expect(
      bad,
      `这些 session 文件在移动端复用名单里,却碰了 Node:\n  ${bad.join("\n  ")}\n` +
        "修法:要么把 Node 依赖挪走,要么把文件从 MOBILE_SAFE 名单里去掉" +
        "(去掉意味着手机端不能用它投影,想清楚再改)"
    ).toEqual([]);
  });
```

- [ ] **Step 2: 跑测试确认它现在就是绿的（这两条是守护，不是修 bug）**

Run: `npx vitest run tests/architecture.test.ts`
Expected: PASS —— 现状本来就合规，这两条是把「碰巧成立的事实」钉成「破了会红的规则」

- [ ] **Step 3: 验证它真的会红**

临时在 `src/shared/remote/frames.ts` 顶部加一行 `import { readFileSync } from "node:fs";`，
再跑一次：

Run: `npx vitest run tests/architecture.test.ts`
Expected: FAIL，错误信息里带 `remote/frames.ts` 和修法

**然后把那一行删掉**，重跑确认回绿。这一步不能跳——一条从没红过的断言不算断言。

- [ ] **Step 4: 跑整条门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/architecture.test.ts
git commit -m "test(architecture): 把'shared 层是纯的'从事实钉成规则

src/shared 目前零 node builtin、零 electron —— 但那是碰巧成立的现状,
下一个顺手 import node:fs 的人不会知道自己断了 Expo 那条路。加两条断言,
按 AGENTS.md'新增更严的断言 = L2',跟本 PR 走。

session 那条用显式白名单而不是扫全目录:store.ts 和 attachments.ts 是桌面专属,
本来就该碰 Node。新增文件想进复用面要显式加进名单,而不是'碰巧还没碰 Node
就算数' —— 后者会让名单在无人察觉时悄悄变宽。

两条都按'先让它红一次'验过(临时加一行 node:fs import,确认错误信息带修法)。"
```

---

## 收尾（不属于任何 Task，但必须做完才算这条分支完成）

- [ ] 补 4 份 ADR 到 `docs/adr/`，编号**合并前**再 claim（ADR-0074：先 `git fetch`，撞号就改到 `max + 1` 并加 `原为 ADR-00XX` 行）。四份的主题见 spec 第三节。
- [ ] `CONTEXT.md` 的**产品/技术术语**节补词条（ADR-0070）：盲管道、TOFU pin、上行帧 / 下行帧、`pushKey`。
- [ ] `AGENTS.md` 的 **Where to find things** 加两行（`src/main/remoteBridge.ts`、`src/shared/remote/`）。**这是 L2**（索引区，ADR-0005），可自merge，但仍要 issue + ADR + PR 三件套。
- [ ] 开一个 Task issue 承载这条分支，后续切片 5–8 各自 `Blocked by:` 挂它（ADR-0044）。
- [ ] 计划 B（Expo app）与计划 C（APNs + NSE）另写，不在本文件内。
