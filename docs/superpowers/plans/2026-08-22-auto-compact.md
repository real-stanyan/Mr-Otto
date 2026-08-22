# 自动压缩 + 压缩前记忆上下文 实施计划 — issue #178

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上下文占用超过阈值时自动 `compact()`（hermes 的 0.50 / 0.75 两档），摘要 prompt 带上长期记忆快照（脱敏 + 截断）避免重复；设置页可关、可调阈值。

**Architecture:** 纯函数 `src/shared/autoCompact.ts`（阈值判定）与 `src/shared/redact.ts`（脱敏）；`LoopEngine.compact({trigger})` 扩展 + `context_compacted.trigger` 字段（可选，向后兼容）；触发点在 `LoopEngine.loop` 每次模型调用前（工具密集的 turn 中途也能压）。设置走 `src/main/autoCompactStore.ts`（JSON，permissionStore 同款）+ ShellBridge。记忆上下文直接从日志里的 `memory_loaded` 事件取——不需要新管线。

**Tech Stack:** TypeScript strict / vitest / Electron / shadcn Switch + Slider（Slider 未装，用 `npx shadcn@latest add slider`）

**Spec:** `docs/superpowers/specs/2026-08-22-memory-design.md` 第三节

## Global Constraints

- 阈值：`contextWindow ≥ 512_000` → 0.50，否则 0.75（hermes small-ctx floor）；用户覆盖值范围 0.3–0.9；未知模型（catalog 无 contextWindow）不自动触发。
- `context_compacted` 新字段 `trigger?: "auto" | "manual"`；旧事件无此字段 = manual（投影/UI 都按此解读）。
- 摘要 prompt 的记忆段：`MEMORY CONTEXT（已在长期记忆里的事实，摘要里不要重复）:` + 脱敏后文本，头 4000 / 尾 1500 字符截断，中间 `...[memory context truncated]...`；两个文件都空则不加这段。
- 脱敏规则（移植 hermes `redact_sensitive_text(force=True, redact_url_credentials=True)` 的要点）：`sk-…`/`AKIA…`/`ghp_…`/`xox[abp]-…` 类 key、`Bearer <token>`、`api[_-]?key\s*[:=]\s*\S+`、`password\s*[:=]\s*\S+`、URL 里的 `user:pass@` → `[REDACTED]`。
- 自动压缩与手动一样贵：一次全量输入。触发后落事件并推给 UI；**同一 turn 内最多触发一次**（防摘要本身超阈值时死循环）。
- Hard rules：先落盘再喂模型（compact 事件落盘后下一次投影才带摘要）；schema 只加不改；渲染层只走 ShellBridge。
- 翻案 ADR-0003「只手动触发」→ 本次 ADR 记录理由。
- 分支 `claude/auto-compact`；测试镜像 `src/`。

---

### Task 1: 纯函数——阈值判定 + 脱敏

**Files:**
- Create: `src/shared/autoCompact.ts`、`src/shared/redact.ts`
- Test: `tests/shared/autoCompact.test.ts`、`tests/shared/redact.test.ts`

**Interfaces:**
```ts
// autoCompact.ts
export interface AutoCompactSettings { enabled: boolean; threshold?: number } // threshold 缺省 = 按窗口两档
export const DEFAULT_AUTO_COMPACT: AutoCompactSettings = { enabled: true };
export const SMALL_CTX_WINDOW_LIMIT = 512_000;
export function defaultThreshold(contextWindow: number): number;           // ≥512K → 0.5，否则 0.75
export function effectiveThreshold(settings: AutoCompactSettings, contextWindow: number): number; // clamp 0.3–0.9
export function shouldAutoCompact(used: number, contextWindow: number | undefined, settings: AutoCompactSettings): boolean;
// redact.ts
export function redactSensitiveText(text: string): string;
export function clipHeadTail(text: string, head = 4000, tail = 1500, marker = "...[memory context truncated]..."): string;
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/autoCompact.test.ts
import { describe, it, expect } from "vitest";
import { defaultThreshold, effectiveThreshold, shouldAutoCompact, DEFAULT_AUTO_COMPACT } from "../../src/shared/autoCompact.js";

describe("autoCompact", () => {
  it("两档默认阈值", () => {
    expect(defaultThreshold(1_000_000)).toBe(0.5);
    expect(defaultThreshold(512_000)).toBe(0.5);
    expect(defaultThreshold(200_000)).toBe(0.75);
  });
  it("用户覆盖值钳在 0.3–0.9", () => {
    expect(effectiveThreshold({ enabled: true, threshold: 0.1 }, 200_000)).toBe(0.3);
    expect(effectiveThreshold({ enabled: true, threshold: 0.95 }, 200_000)).toBe(0.9);
    expect(effectiveThreshold({ enabled: true, threshold: 0.6 }, 200_000)).toBe(0.6);
    expect(effectiveThreshold(DEFAULT_AUTO_COMPACT, 200_000)).toBe(0.75);
  });
  it("判定：关了不触发；未知窗口不触发；刚好等于阈值触发", () => {
    expect(shouldAutoCompact(150_000, 200_000, DEFAULT_AUTO_COMPACT)).toBe(true);
    expect(shouldAutoCompact(149_999, 200_000, DEFAULT_AUTO_COMPACT)).toBe(false);
    expect(shouldAutoCompact(199_000, 200_000, { enabled: false })).toBe(false);
    expect(shouldAutoCompact(999_999, undefined, DEFAULT_AUTO_COMPACT)).toBe(false);
  });
});
```

```ts
// tests/shared/redact.test.ts
import { describe, it, expect } from "vitest";
import { clipHeadTail, redactSensitiveText } from "../../src/shared/redact.js";

describe("redactSensitiveText", () => {
  it.each([
    ["OPENAI key sk-abcdefghijklmnopqrstuvwxyz123456", /sk-\w/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", /eyJ/],
    ["api_key = 123456789abcdef", /123456789/],
    ["password: hunter2", /hunter2/],
    ["https://alice:s3cret@example.com/x", /s3cret/],
    ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", /ghp_A/],
    ["AKIAIOSFODNN7EXAMPLE", /AKIA/],
  ])("遮掉 %s", (text, leak) => {
    const out = redactSensitiveText(text);
    expect(out).not.toMatch(leak);
    expect(out).toContain("[REDACTED]");
  });
  it("普通文本原样", () => {
    expect(redactSensitiveText("用户偏好简短回复，项目用 pnpm")).toBe("用户偏好简短回复，项目用 pnpm");
  });
});

describe("clipHeadTail", () => {
  it("短文本原样；长文本头+标记+尾，按码点", () => {
    expect(clipHeadTail("短")).toBe("短");
    const long = "头".repeat(5000) + "尾".repeat(2000);
    const out = clipHeadTail(long);
    expect(out.startsWith("头".repeat(4000))).toBe(true);
    expect(out.endsWith("尾".repeat(1500))).toBe(true);
    expect(out).toContain("...[memory context truncated]...");
    expect([...out].length).toBe(4000 + 1500 + "...[memory context truncated]...".length);
  });
});
```

- [ ] **Step 2: 红** — `npx vitest run tests/shared/autoCompact.test.ts tests/shared/redact.test.ts`

- [ ] **Step 3: 实现**

```ts
// src/shared/autoCompact.ts
// 自动压缩的阈值判定。对标 hermes：窗口 ≥512K 用 0.50，更小的窗口用 0.75——
// 小窗口上 50% 就压等于半个窗口白放着。纯函数放 shared：engine 判定、设置页显示默认值，同一把尺子。
export interface AutoCompactSettings {
  enabled: boolean;
  /** 用户覆盖（0.3–0.9）。缺省 = 按窗口两档 */
  threshold?: number;
}
export const DEFAULT_AUTO_COMPACT: AutoCompactSettings = { enabled: true };
export const SMALL_CTX_WINDOW_LIMIT = 512_000;
export const THRESHOLD_MIN = 0.3;
export const THRESHOLD_MAX = 0.9;

export function defaultThreshold(contextWindow: number): number {
  return contextWindow >= SMALL_CTX_WINDOW_LIMIT ? 0.5 : 0.75;
}
export function effectiveThreshold(settings: AutoCompactSettings, contextWindow: number): number {
  const t = settings.threshold ?? defaultThreshold(contextWindow);
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, t));
}
/** 未知窗口（catalog 没写）不触发：宁可让用户手动压，也别按猜的数字烧一次全量 */
export function shouldAutoCompact(used: number, contextWindow: number | undefined, settings: AutoCompactSettings): boolean {
  if (!settings.enabled || !contextWindow) return false;
  return used >= contextWindow * effectiveThreshold(settings, contextWindow);
}
```

```ts
// src/shared/redact.ts
// 喂给摘要模型之前的脱敏。对标 hermes redact_sensitive_text(force=True, redact_url_credentials=True)。
// 记忆文件是用户/模型写的自由文本，难免混进 key；摘要是另一次模型调用，等于把 key 再发一遍。
const RULES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|密码|密钥)\s*[:=：]\s*\S+/gi,
  /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
];
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const re of RULES) {
    out = out.replace(re, (m, ...groups) => {
      // URL 凭据：保留协议，只遮 user:pass
      if (m.startsWith("http")) return `${groups[0] as string}[REDACTED]@`;
      // key=value 类：保留键名，遮值
      const kv = /^([^:=：]+[:=：]\s*)/.exec(m);
      return kv ? `${kv[1]}[REDACTED]` : "[REDACTED]";
    });
  }
  return out;
}
export function clipHeadTail(text: string, head = 4000, tail = 1500, marker = "...[memory context truncated]..."): string {
  const cps = [...text];
  if (cps.length <= head + tail) return text;
  return cps.slice(0, head).join("") + marker + cps.slice(-tail).join("");
}
```

（`kv` 分支对 `Bearer …` 不命中 → 整段换成 `[REDACTED]`，测试里 `Bearer` 那条只断言 token 消失、含 REDACTED，满足。）

- [ ] **Step 4: 绿** — 同上 + `npx tsc --noEmit`
- [ ] **Step 5: 提交** — `feat(compact): 自动压缩阈值两档 + 摘要前脱敏——纯函数层`

---

### Task 2: `compact()` 带 trigger + 记忆上下文；事件字段

**Files:**
- Modify: `src/session/events.ts`（`ContextCompactedEvent.trigger?: "auto" | "manual"`）
- Modify: `src/loop/engine.ts`（`compact(opts?)`）
- Test: `tests/loop/engine.compact.test.ts`（新）

**Interfaces:**
```ts
compact(opts: { trigger: "auto" | "manual" } = { trigger: "manual" }): Promise<void>
```
摘要 prompt 组装：从 `store.load(sessionId)` 找最新 `memory_loaded`；若 `memory || user` 非空 → `MEMORY CONTEXT（…）:\n` + `clipHeadTail(redactSensitiveText(memory + "\n§\n" + user))` 作为一条 user 消息插在摘要指令之前；摘要指令末尾追加「MEMORY CONTEXT 里已有的事实不要重复写进摘要。」

- [ ] **Step 1: 写失败测试**

```ts
// tests/loop/engine.compact.test.ts
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function adapterCapturing(reply: string) {
  const calls: unknown[][] = [];
  const adapter: ModelAdapter = {
    model: "m",
    async chat(messages) { calls.push(messages as unknown[]); return { content: reply } as ModelReply; },
  } as unknown as ModelAdapter;
  return { adapter, calls };
}
const world = {} as ExecutionWorld;

function engineWith(store: EventStore, adapter: ModelAdapter) {
  return new LoopEngine({ store, adapter, tools: [], world, sessionId: "s" });
}

describe("compact()", () => {
  it("默认 trigger=manual；事件带 trigger 字段", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    expect(store.load("s").at(-1)).toMatchObject({ type: "context_compacted", summary: "摘要", trigger: "manual" });
    await engineWith(store, adapter).compact({ trigger: "auto" });
    expect(store.load("s").at(-1)).toMatchObject({ trigger: "auto" });
  });

  it("有 memory_loaded 时摘要 prompt 带脱敏 + 截断的 MEMORY CONTEXT 段", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "memory_loaded", memory: "项目用 pnpm；api_key = sk-abcdefghijklmnopqrstuvwxyz", user: "x".repeat(6000) });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter, calls } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain("MEMORY CONTEXT");
    expect(sent).toContain("项目用 pnpm");
    expect(sent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(sent).toContain("...[memory context truncated]...");
    expect(sent).toContain("不要重复");
  });

  it("记忆为空 = prompt 不带那段（和从前逐字节一致）", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "memory_loaded", memory: "", user: "" });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter, calls } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    expect(JSON.stringify(calls[0])).not.toContain("MEMORY CONTEXT");
  });
});
```

> `ModelAdapter` 的真实形状以 `src/model/adapter.ts` 为准（`chat(messages, tools?, opts?)`、`model` 字段）；照 `tests/loop/engine.test.ts` 的 `fakeAdapter` 写法改。

- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**

events.ts：
```ts
  /** 谁触发的。缺省（旧事件）= 用户手动 /compact；"auto" = 上下文超阈值自动（ADR-00NN） */
  trigger?: "auto" | "manual";
```

engine.ts `compact`：
```ts
  async compact(opts: { trigger: "auto" | "manual" } = { trigger: "manual" }): Promise<void> {
    const { store, sessionId } = this.opts;
    const log = store.load(sessionId);
    const messages = deriveMessages(log, COMPACT_COMPRESSION);
    // 压缩前把长期记忆递给摘要人（hermes 的 on_pre_compress 同款）：已在记忆里的事实
    // 不必再进摘要；脱敏 + 截断——记忆是自由文本，难免混进 key，而摘要是另一次外发
    const mem = [...log].reverse().find((e): e is MemoryLoadedEvent => e.type === "memory_loaded");
    const memText = mem ? [mem.memory, mem.user].filter(Boolean).join("\n§\n") : "";
    const memoryContext = memText
      ? [{ role: "user" as const, content: `MEMORY CONTEXT（已在长期记忆里的事实，摘要里不要重复）:\n${clipHeadTail(redactSensitiveText(memText))}` }]
      : [];
    const reply = await this.adapter.chat([
      ...messages,
      ...memoryContext,
      { role: "user", content: "请把以上对话压缩成一份摘要，供后续对话作为唯一的历史记忆使用。保留：任务目标、已完成的动作（含涉及的文件路径与命令）、关键决定及其理由、未完成事项。" + (memText ? "MEMORY CONTEXT 里已有的事实不要重复写进摘要。" : "") + "直接输出摘要正文，不要开场白。" },
    ]);
    if (!reply.content.trim()) throw new Error("模型没有产出摘要，compact 已放弃（未写入任何事件）");
    this.append({ ...this.env(), type: "context_compacted", summary: reply.content, model: this.adapter.model, trigger: opts.trigger, ...(reply.usage ? { usage: reply.usage } : {}) });
  }
```
import `MemoryLoadedEvent`、`clipHeadTail`、`redactSensitiveText`。注意 `trigger` 对新事件总是写（manual 也写）——旧事件缺省才是 manual，新事件明说。

- [ ] **Step 4: 绿** — `npx vitest run tests/loop && npx tsc --noEmit`
- [ ] **Step 5: 提交** — `feat(compact): compact 带 trigger 字段；摘要 prompt 先递脱敏后的长期记忆`

---

### Task 3: 自动触发——loop 每次模型调用前判定

**Files:**
- Modify: `src/loop/engine.ts`（`LoopEngineOptions.autoCompact?`；loop 内判定）
- Modify: `src/main/agent.ts`（传 `contextWindow: () => current.contextWindow`，`settings` 由 opts 注入）
- Test: `tests/loop/engine.autoCompact.test.ts`

**Interfaces:**
```ts
// LoopEngineOptions
autoCompact?: {
  contextWindow: () => number | undefined;      // 当前型号的窗口；换型号后现算
  settings: () => AutoCompactSettings;          // 现读（设置页改了当场生效）
};
```
loop 每圈：`const used = contextUsed(store.load(sessionId))`；`if (!compactedThisTurn && shouldAutoCompact(used, cw(), settings())) { await this.compact({trigger:"auto"}); compactedThisTurn = true; }`。`compactedThisTurn` 是 `runTurn` 作用域的局部（每 turn 重置）。compact 抛错不毁 turn：catch → `console.warn`，继续（摘要失败 = 没压，下一圈不再试）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/loop/engine.autoCompact.test.ts
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 脚本化 adapter：按顺序吐回复；记录每次收到的消息数 */
function scripted(replies: ModelReply[]) {
  const seen: number[] = [];
  let i = 0;
  const adapter = { model: "m", async chat(messages: unknown[]) { seen.push(messages.length); return replies[i++]!; } } as unknown as ModelAdapter;
  return { adapter, seen };
}
const world = {} as ExecutionWorld;
function seeded() {
  const store = new EventStore(":memory:");
  store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
  // 一条带账单的 assistant_message 把占用锚到 80k（窗口 100k 的 80%）
  store.append({ sessionId: "s", ts: 0, type: "user_message", content: "早先" });
  store.append({ sessionId: "s", ts: 0, type: "assistant_message", content: "…", model: "m", usage: { promptTokens: 79_000, completionTokens: 1_000 } });
  store.append({ sessionId: "s", ts: 0, type: "turn_ended", outcome: "completed" });
  return store;
}

describe("自动压缩", () => {
  it("超阈值：先 compact（auto）再答；同一 turn 只压一次", async () => {
    const store = seeded();
    const { adapter } = scripted([{ content: "摘要" } as ModelReply, { content: "答" } as ModelReply]);
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) } });
    await engine.runTurn("新问题");
    const types = store.load("s").map((e) => e.type);
    const ci = types.indexOf("context_compacted");
    expect(ci).toBeGreaterThan(types.indexOf("user_message", 1)); // 在新 user_message 之后
    expect(store.load("s")[ci]).toMatchObject({ trigger: "auto" });
    expect(types.filter((t) => t === "context_compacted")).toHaveLength(1);
    expect(types.at(-2)).toBe("assistant_message");
  });
  it("关闭 / 未知窗口 / 未超阈值：不压", async () => {
    for (const ac of [
      { contextWindow: () => 100_000, settings: () => ({ enabled: false }) },
      { contextWindow: () => undefined, settings: () => ({ enabled: true }) },
      { contextWindow: () => 1_000_000, settings: () => ({ enabled: true }) },
    ]) {
      const store = seeded();
      const { adapter } = scripted([{ content: "答" } as ModelReply]);
      await new LoopEngine({ store, adapter, tools: [], world, sessionId: "s", autoCompact: ac }).runTurn("新问题");
      expect(store.load("s").some((e) => e.type === "context_compacted")).toBe(false);
    }
  });
  it("compact 失败不毁 turn", async () => {
    const store = seeded();
    const { adapter } = scripted([{ content: "" } as ModelReply, { content: "答" } as ModelReply]); // 空摘要 = compact 抛
    await new LoopEngine({ store, adapter, tools: [], world, sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) } }).runTurn("新问题");
    const types = store.load("s").map((e) => e.type);
    expect(types).not.toContain("context_compacted");
    expect(types.at(-1)).toBe("turn_ended");
    expect(store.load("s").at(-2)).toMatchObject({ type: "assistant_message", content: "答" });
  });
});
```

> `ModelReply` 真实形状（`content`、`toolCalls?`、`usage?`）以 adapter.ts 为准。

- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**

engine.ts：`loop(signal)` 签名加 `compactedThisTurn` 状态——最简单：`runTurn` 里 `this.compactedThisTurn = false`（私有字段），loop 每圈开头：

```ts
      // 自动压缩（ADR-00NN）：每次模型调用前看一眼占用。放在 loop 里而不是 turn 开头——
      // 工具密集的 turn 中途也会胀。同一 turn 只压一次：摘要本身若仍超阈值，再压只是烧钱
      if (this.opts.autoCompact && !this.compactedThisTurn) {
        const { contextWindow, settings } = this.opts.autoCompact;
        if (shouldAutoCompact(contextUsed(store.load(sessionId)), contextWindow(), settings())) {
          this.compactedThisTurn = true;
          try { await this.compact({ trigger: "auto" }); }
          catch (err) { console.warn("自动压缩失败，本 turn 不再尝试", err); }
        }
      }
```
import `contextUsed`（`src/shared/contextEstimate.ts`）、`shouldAutoCompact`。

agent.ts：`createAgent` 选项加 `autoCompactSettings?: () => AutoCompactSettings`；engine 构造传 `autoCompact: { contextWindow: () => current.contextWindow, settings: opts.autoCompactSettings ?? (() => DEFAULT_AUTO_COMPACT) }`。子 agent（subagentRunner）也自然带上——子会话一样会胀。

- [ ] **Step 4: 绿** — `npm test`
- [ ] **Step 5: 提交** — `feat(compact): 上下文超阈值自动压缩——loop 每次模型调用前判定，一 turn 一次，失败不毁 turn`

---

### Task 4: 设置持久化 + ShellBridge

**Files:**
- Create: `src/main/autoCompactStore.ts`（`load(path)` / `save(path, settings)`，permissionStore 同款，文件 `<configDir>/auto-compact.json`）
- Modify: `src/shared/shellBridge.ts`（`getAutoCompact(): Promise<AutoCompactSettings>`、`setAutoCompact(s): Promise<void>` + CHANNELS）
- Modify: `src/preload/index.ts`、`src/main/index.ts`（handlers；所有 `createAgent` 传 `autoCompactSettings: () => loadAutoCompact(path)`）
- Test: `tests/main/autoCompactStore.test.ts`

- [ ] **Step 1: 测试**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutoCompact, saveAutoCompact } from "../../src/main/autoCompactStore.js";

describe("autoCompactStore", () => {
  it("没文件 = 默认开；坏 JSON = 默认；round-trip；threshold 非数字丢弃", () => {
    const p = join(mkdtempSync(join(tmpdir(), "otto-ac-")), "auto-compact.json");
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
    saveAutoCompact(p, { enabled: false, threshold: 0.6 });
    expect(loadAutoCompact(p)).toEqual({ enabled: false, threshold: 0.6 });
    saveAutoCompact(p, { enabled: true, threshold: "x" as unknown as number });
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2–3: 红 → 实现**（`load`：`enabled` 非布尔 → true；`threshold` 非有限数 → 省略）
- [ ] **Step 4: `npm test`**
- [ ] **Step 5: 提交** — `feat(compact): 自动压缩设置落 auto-compact.json，ShellBridge 读写`

---

### Task 5: UI——设置页开关 + 阈值滑块；压缩行标注「自动」

> 写 UI 前 `Skill: emil-design-eng`。

**Files:**
- Run: `npx shadcn@latest add slider`（只要 `src/renderer/src/components/ui/slider.tsx`；拒绝无关改动）
- Create: `src/renderer/src/components/AutoCompactSettings.tsx`
- Modify: `src/renderer/src/App.tsx`（挂在「记忆」卡下方或同一 section；若 SETTINGS_SECTIONS 有「上下文/模型」类 section 就放那）
- Modify: `src/renderer/src/aui/toThreadMessages.ts` 或压缩行的渲染组件（找 `context_compacted` 的文案处）：`trigger === "auto"` → 文案「上下文已自动压缩」，否则「上下文已压缩」
- Test: `tests/renderer/…`（若有压缩行文案的纯函数测试则追加；UI 交互无 RTL 不测）

设计：Switch（开/关）+ Slider（0.3–0.9，step 0.05，关时禁用）+ 说明「默认：窗口 ≥512K 时 50%，否则 75%」+ 当前型号的实际阈值文案（需要当前 contextWindow：从 `useChat` 的 model 取 `findModel(model)?.contextWindow`，shared 可 import）。保存即时（onChange 去抖 200ms 调 `setAutoCompact`）。动效约束同前（无 transition-all，≤200ms，motion-reduce）。

- [ ] **Step 1–3: 实现**
- [ ] **Step 4: `npm test` + `npm run e2e`**
- [ ] **Step 5: 提交** — `feat(compact-ui): 设置页自动压缩开关 + 阈值；压缩行标注自动`

---

### Task 6: ADR + CONTEXT

- ADR 号 = 合并时下一个空号（#189 的 0061 若先合则本次 0062）：「自动压缩：推翻 ADR-0003 的只手动触发」——决定：loop 内每次模型调用前判定；两档阈值 + 用户覆盖；一 turn 一次；失败不毁 turn；摘要 prompt 带脱敏后的记忆快照；`trigger` 字段向后兼容。理由：手动触发实际没人按，上下文撑爆比一次摘要贵；记忆快照递给摘要人避免两层重复。推翻条件：模型侧原生支持服务端压缩/缓存式上下文时，本地摘要退为兜底。
- ADR-0003 文件头加一行「状态：被 ADR-00NN 部分推翻（触发方式）」。
- CONTEXT.md 一行：「自动压缩（auto compact）」。
- `npm test` 绿 → push → PR `Closes #178`，body 贴 e2e；**开 PR 就停**。
