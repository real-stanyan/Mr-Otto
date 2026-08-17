# file-input-v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话内输入框加 ＋ 按钮上传图片/文本文件:图片走内容寻址附件库+日志存引用,文本文件发送时内联进消息,多模态投影到 OpenAI vision 方言。

**Architecture:** DSH-lite 三层:主进程 AttachmentStore(`userData/attachments/<sha256>`,0600)持有图片字节;`user_message` 事件只加可选 `attachments` 引用数组(向后兼容);deriveMessages 投影出 `string | UserContentPart[]`(纯函数不碰盘),openaiCompatible adapter 请求时经注入的 `readAttachment` 解 bytes 转 base64 `image_url`。文本文件不进附件库——发送时全文内联进 content(快照语义)。

**Tech Stack:** TypeScript strict / Electron(dialog+IPC) / node:crypto sha256 / vitest

**Spec:** `docs/superpowers/specs/2026-08-17-file-input-design.md`

## Global Constraints

- append-only 事件日志唯一事实源;SessionEvent schema 只加可选字段,旧日志必须永远可重放(AGENTS.md 硬规则)
- 渲染进程只通过 ShellBridge 通信,禁止直接触碰 Node API(AGENTS.md 硬规则)
- 无附件的 user_message 投影必须与改动前逐字节一致(测试钉住)
- 附件库文件 0600、目录 0700;name 只留 basename(剥 `/` 与 `\`);事件日志不含 base64
- 限额:图片 ≤10MB/张、≤4 张/条;文本文件 ≤100KB/个;头 8KB 含 `\0` 判二进制拒收
- 图片格式仅 png/jpeg/webp/gif,以 magic bytes 嗅探为准(不信任扩展名/声明)
- 测试放 `tests/` 镜像 `src/` 结构;不打真 API;gate = `npm test`
- UI 文案中文;注释风格遵循现有代码(讲 why)

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/session/attachments.ts` | 新建 | AttachmentStore(save/read)+ detectImageType + stripToBasename |
| `src/session/events.ts` | 改 | UserAttachmentRef 类型 + UserMessageEvent.attachments? |
| `src/session/deriveMessages.ts` | 改 | UserContentPart、UserChatMessage.content 加宽、投影分支 |
| `src/model/openaiCompatible.ts` | 改 | readAttachment 注入 + parts→vision 方言转换 |
| `src/main/attachmentIntake.ts` | 新建 | intakeFile:文件分类(图/文本/拒),纯逻辑可测 |
| `src/shared/shellBridge.ts` | 改 | StagedAttachment/OutgoingAttachment + 2 新频道 + sendMessage 加参 |
| `src/preload/index.ts` | 改 | 2 新方法 + sendMessage 加参 |
| `src/main/index.ts` | 改 | AttachmentStore 实例 + 3 个 IPC handler 接线 |
| `src/main/agent.ts` | 改 | makeAdapter 注入 readAttachment |
| `src/loop/engine.ts` | 改 | runTurn 加可选 attachments 参数 |
| `src/renderer/src/store.ts` | 改 | staging 状态 + pickFiles/removeStaged + send 带附件 |
| `src/renderer/src/App.tsx` | 改 | ＋ 按钮、chips 行、时间线缩略图 |
| `src/renderer/src/app.css` | 改 | 上述三处样式 |
| `docs/adr/0009-attachment-store.md` | 新建 | 架构决策记录 |

---

### Task 1: AttachmentStore + schema(TDD)

**Files:**
- Create: `src/session/attachments.ts`
- Modify: `src/session/events.ts`(UserAttachmentRef + UserMessageEvent)
- Test: `tests/session/attachments.test.ts`

**Interfaces:**
- Consumes: 无(叶子模块,仅 node:crypto / node:fs / node:path)
- Produces(后续任务依赖,签名逐字):
  - `interface UserAttachmentRef { id: string; mediaType: string; bytes: number; name?: string }`(定义在 `src/session/events.ts`,attachments.ts 从那 import)
  - `class AttachmentStore { constructor(dir: string); save(data: Uint8Array, name?: string): UserAttachmentRef; read(id: string): Uint8Array }`
  - `function detectImageType(data: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null`
  - `function stripToBasename(name: string): string | undefined`
  - `const IMAGE_MAX_BYTES = 10 * 1024 * 1024`
  - `UserMessageEvent` 加字段:`attachments?: UserAttachmentRef[]`

- [ ] **Step 1: 写失败测试**

`tests/session/attachments.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentStore,
  detectImageType,
  stripToBasename,
  IMAGE_MAX_BYTES,
} from "../../src/session/attachments.js";

// 最小合法 magic bytes 前缀 + 填充——嗅探只看头,不解码全图
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5]);
const webp = () => {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return b;
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "otter-att-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("detectImageType", () => {
  it("认全四种格式", () => {
    expect(detectImageType(png())).toBe("image/png");
    expect(detectImageType(jpeg())).toBe("image/jpeg");
    expect(detectImageType(gif())).toBe("image/gif");
    expect(detectImageType(webp())).toBe("image/webp");
  });
  it("非图片返回 null", () => {
    expect(detectImageType(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectImageType(new Uint8Array(0))).toBeNull();
  });
});

describe("stripToBasename", () => {
  it("剥 POSIX 与 Windows 路径", () => {
    expect(stripToBasename("/Users/x/secret/cat.png")).toBe("cat.png");
    expect(stripToBasename("C:\\Users\\x\\cat.png")).toBe("cat.png");
  });
  it("空串/纯路径返回 undefined", () => {
    expect(stripToBasename("")).toBeUndefined();
    expect(stripToBasename("/a/b/")).toBeUndefined();
  });
});

describe("AttachmentStore", () => {
  it("save→read 往返,id 是 sha256 形状,ref 字段齐", () => {
    const store = new AttachmentStore(dir);
    const ref = store.save(png(), "cat.png");
    expect(ref.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ref.mediaType).toBe("image/png");
    expect(ref.bytes).toBe(png().byteLength);
    expect(ref.name).toBe("cat.png");
    expect(Array.from(store.read(ref.id))).toEqual(Array.from(png()));
  });

  it("同内容去重:两次 save 同一 id,库里只有一个文件", () => {
    const store = new AttachmentStore(dir);
    const a = store.save(png(), "a.png");
    const b = store.save(png(), "b.png");
    expect(a.id).toBe(b.id);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("name 剥路径后入 ref;无 name 则缺席", () => {
    const store = new AttachmentStore(dir);
    expect(store.save(png(), "/tmp/secret/cat.png").name).toBe("cat.png");
    expect(store.save(jpeg()).name).toBeUndefined();
  });

  it("非图片字节拒收", () => {
    const store = new AttachmentStore(dir);
    expect(() => store.save(new TextEncoder().encode("plain text"))).toThrow(/png|jpeg|webp|gif/);
  });

  it("超过 IMAGE_MAX_BYTES 拒收", () => {
    const store = new AttachmentStore(dir);
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    expect(() => store.save(big)).toThrow(/10MB|超/);
  });

  it("read 不认非法 id(路径穿越无门)", () => {
    const store = new AttachmentStore(dir);
    expect(() => store.read("../../etc/passwd")).toThrow();
    expect(() => store.read("sha256:zzzz")).toThrow();
  });

  it("文件 0600,目录 0700", () => {
    const store = new AttachmentStore(dir);
    const ref = store.save(png());
    const hex = ref.id.slice("sha256:".length);
    expect(statSync(join(dir, hex)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session/attachments.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/session/events.ts` — `ToolCallRequest` 定义之前插入:

```ts
/** 用户消息附件引用(图片)。bytes 本体在附件库(userData/attachments),
    日志只存这份轻量元数据——日志永远瘦,代价是重放依赖附件库(接受的取舍,
    见 docs/adr/0009)。文本文件不走这:发送时全文内联进 content(快照语义) */
export interface UserAttachmentRef {
  id: string;        // "sha256:<hex>",内容寻址
  mediaType: string; // "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  bytes: number;
  name?: string;     // basename,剥过路径(本机目录结构不进日志)
}
```

`UserMessageEvent` 加字段:

```ts
export interface UserMessageEvent extends SessionEventBase {
  type: "user_message";
  content: string;
  /** 图片附件引用。可选 = 旧日志照常重放(schema 向后兼容硬规则) */
  attachments?: UserAttachmentRef[];
}
```

`src/session/attachments.ts` 全文:

```ts
// AttachmentStore — 图片附件的内容寻址存储(DSH lite,见 docs/adr/0009)。
// EventStore 同级的 app 资源:组装根特权,可直接碰 fs
// (ExecutionWorld 硬规则管的是工具实现,不管 app 基础设施)。
// 不可变:同内容同 id,写过即永存;孤儿文件无害(重发自动复用),GC 留将来。

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserAttachmentRef } from "./events.js";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

/** magic bytes 嗅探真实图片类型——扩展名和调用方声明都不可信,字节才是事实 */
export function detectImageType(
  data: Uint8Array
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
    return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
    return "image/gif";
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** 两种分隔符手工剥(DSH 教训:POSIX 上 path.basename 不剥 \,Windows 客户端
    的完整本机路径会原样漏进日志)。剥完为空 = 没有可用名字 */
export function stripToBasename(name: string): string | undefined {
  const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim();
  return leaf === "" ? undefined : leaf.slice(0, 255);
}

export class AttachmentStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir 的 mode 只在新建时生效,已有目录补一刀
  }

  /** 校验(类型嗅探+限额)→ 内容寻址落盘 → 返轻量 ref。同内容天然去重 */
  save(data: Uint8Array, name?: string): UserAttachmentRef {
    const mediaType = detectImageType(data);
    if (!mediaType) throw new Error("不支持的图片格式(仅收 png/jpeg/webp/gif)");
    if (data.byteLength > IMAGE_MAX_BYTES) {
      throw new Error(`图片超过 10MB 上限(实际 ${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
    }
    const hex = createHash("sha256").update(data).digest("hex");
    const path = join(this.dir, hex);
    if (!existsSync(path)) {
      writeFileSync(path, data, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const clean = name === undefined ? undefined : stripToBasename(name);
    return {
      id: `sha256:${hex}`,
      mediaType,
      bytes: data.byteLength,
      ...(clean !== undefined ? { name: clean } : {}),
    };
  }

  /** id 严格校验后才拼路径——非法 id(含路径穿越)无门 */
  read(id: string): Uint8Array {
    const m = ID_PATTERN.exec(id);
    if (!m) throw new Error(`附件 id 非法: ${id}`);
    return readFileSync(join(this.dir, m[1]!));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/session/attachments.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: 全量 gate + commit**

Run: `npm test`(确认没碰坏别人)
Expected: 全绿

```bash
git add src/session/attachments.ts src/session/events.ts tests/session/attachments.test.ts
git commit -m "feat: AttachmentStore 内容寻址图片库 + user_message 可选 attachments 字段(file-input-v1 Task 1)"
```

---

### Task 2: 投影 parts + adapter vision 方言(TDD)

**Files:**
- Modify: `src/session/deriveMessages.ts`(UserChatMessage、user_message 分支)
- Modify: `src/model/openaiCompatible.ts`(readAttachment 选项 + parts 转换)
- Test: `tests/session/deriveMessages.test.ts`(追加 describe)
- Test: `tests/model/openaiCompatible.test.ts`(追加 describe)

**Interfaces:**
- Consumes(Task 1): `UserAttachmentRef`(from `src/session/events.js`)
- Produces(后续任务依赖,签名逐字):
  - `export type UserContentPart = { type: "text"; text: string } | { type: "image_ref"; id: string; mediaType: string }`(在 deriveMessages.ts)
  - `UserChatMessage.content: string | UserContentPart[]`
  - `OpenAICompatibleOptions.readAttachment?: (id: string) => Uint8Array`

- [ ] **Step 1: 写投影失败测试**

`tests/session/deriveMessages.test.ts` 文件尾追加(沿用文件里既有的事件构造辅助;若无,按下面自建最小事件——`seq`/`ts` 字段与现有测试写法保持一致):

```ts
describe("user_message 附件投影(file-input-v1)", () => {
  it("带 attachments → content 变 parts:[text, ...image_ref]", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "看看这张图",
        attachments: [{ id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 10, name: "cat.png" }],
      },
    ];
    const out = deriveMessages(events);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("attachments 空数组 = 无附件,content 保持 string", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "hi", attachments: [] },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("无 attachments 字段投影与从前逐字节一致(老日志回归)", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "老消息" },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "老消息" }]);
  });
});
```

- [ ] **Step 2: 跑投影测试确认失败**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: 新增 3 条 FAIL(parts 分支不存在),旧用例仍 PASS

- [ ] **Step 3: 实现投影**

`src/session/deriveMessages.ts`:

UserChatMessage 定义处改为:

```ts
/** 用户消息内容分片(多模态)。image_ref 只带引用——投影是纯函数,不碰磁盘,
    解 bytes 是 adapter 的事(注入的 readAttachment) */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_ref"; id: string; mediaType: string };

export interface UserChatMessage {
  role: "user";
  /** string = 纯文本(老日志/无附件,投影逐字节不变);数组 = 带图片附件 */
  content: string | UserContentPart[];
}
```

`case "user_message":` 分支改为:

```ts
      case "user_message":
        // 有图片附件 → parts 数组(text + image_ref);没有 → string 原样,
        // 老日志投影逐字节不变(测试钉住)。附件消息不参与压缩截断:
        // image_ref 本身轻,text 部分是用户原话(压缩层从来不截用户消息)
        messages.push(
          event.attachments && event.attachments.length > 0
            ? {
                role: "user",
                content: [
                  { type: "text", text: event.content },
                  ...event.attachments.map((a) => ({
                    type: "image_ref" as const,
                    id: a.id,
                    mediaType: a.mediaType,
                  })),
                ],
              }
            : { role: "user", content: event.content }
        );
        break;
```

- [ ] **Step 4: 跑投影测试确认通过**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: PASS 全绿(含旧用例)

- [ ] **Step 5: 写 adapter 失败测试**

`tests/model/openaiCompatible.test.ts` 文件尾追加(复用文件里已有的 `mockFetchSSE`/非流式 mock 辅助;非流式 mock 若无,用 `vi.stubGlobal("fetch", vi.fn(async (_u, init) => { bodies.push(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; }))` 形状):

```ts
describe("图片附件(image_ref → image_url,file-input-v1)", () => {
  it("parts 消息转 vision 方言:text 原样,image_ref 变 base64 data URL", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "看到了" } }] }) };
    }));
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      readAttachment: (id) => {
        expect(id).toBe("sha256:" + "a".repeat(64));
        return new Uint8Array([1, 2, 3]);
      },
    });
    await adapter.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么" },
          { type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" },
        ],
      },
    ]);
    const sent = JSON.parse(bodies[0]!) as { messages: { content: unknown }[] };
    expect(sent.messages[0]!.content).toEqual([
      { type: "text", text: "这是什么" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` },
      },
    ]);
  });

  it("string content 请求体保持原样(老路径回归)", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    }));
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
    });
    await adapter.chat([{ role: "user", content: "纯文本" }]);
    const sent = JSON.parse(bodies[0]!) as { messages: unknown[] };
    expect(sent.messages).toEqual([{ role: "user", content: "纯文本" }]);
  });

  it("未注入 readAttachment 遇 image_ref 抛错(配置缺口早暴露)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
    });
    await expect(
      adapter.chat([
        { role: "user", content: [{ type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" }] },
      ])
    ).rejects.toThrow(/readAttachment|附件/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 跑 adapter 测试确认失败**

Run: `npx vitest run tests/model/openaiCompatible.test.ts`
Expected: 新增 3 条 FAIL,旧用例仍 PASS

- [ ] **Step 7: 实现 adapter**

`src/model/openaiCompatible.ts`:

import 行加类型:

```ts
import type { ChatMessage, UserContentPart } from "../session/deriveMessages.js";
```

`OpenAICompatibleOptions` 加字段:

```ts
  /** 图片附件字节读取器(组装根注入 AttachmentStore.read)。
      投影只带 image_ref 引用——bytes 在请求组装的最后一刻才解出转 base64,
      日志与上下文里永远没有 base64 大块 */
  readAttachment?: (id: string) => Uint8Array;
```

`createOpenAICompatibleAdapter` 里、`return` 之前加转换函数:

```ts
  /** image_ref → OpenAI vision 方言(data URL)。string content 原样返回——
      老路径请求体逐字节不变 */
  const toWireMessage = (m: ChatMessage): unknown => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return {
      role: "user",
      content: m.content.map((part: UserContentPart) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (!opts.readAttachment) {
          throw new Error("readAttachment 未注入,无法发送图片附件(image_ref)");
        }
        const data = opts.readAttachment(part.id);
        return {
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${Buffer.from(data).toString("base64")}` },
        };
      }),
    };
  };
```

请求体里 `messages,` 一行改为:

```ts
          messages: messages.map(toWireMessage),
```

注意:转换在 `fetch` 调用之前执行(map 是同步的),所以"未注入抛错"发生在请求发出前——测试 `expect(fetch).not.toHaveBeenCalled()` 钉住这点。

- [ ] **Step 8: 跑 adapter 测试确认通过**

Run: `npx vitest run tests/model/openaiCompatible.test.ts`
Expected: PASS 全绿

- [ ] **Step 9: 全量 gate + commit**

Run: `npm test`
Expected: 全绿

```bash
git add src/session/deriveMessages.ts src/model/openaiCompatible.ts tests/session/deriveMessages.test.ts tests/model/openaiCompatible.test.ts
git commit -m "feat: 投影多模态 parts + adapter image_ref 转 vision 方言(file-input-v1 Task 2)"
```

---

### Task 3: 文件分类 intake + 主进程/Bridge 接线(TDD)

**Files:**
- Create: `src/main/attachmentIntake.ts`
- Modify: `src/shared/shellBridge.ts`(类型 + 频道 + sendMessage 签名)
- Modify: `src/preload/index.ts`(2 新方法 + sendMessage 加参)
- Modify: `src/loop/engine.ts`(runTurn 加参)
- Modify: `src/main/agent.ts`(makeAdapter 注入 readAttachment;createAgent 收 attachments)
- Modify: `src/main/index.ts`(store 实例 + 3 个 handler)
- Test: `tests/main/attachmentIntake.test.ts`

**Interfaces:**
- Consumes(Task 1/2): `AttachmentStore`、`detectImageType`、`stripToBasename`、`UserAttachmentRef`、`OpenAICompatibleOptions.readAttachment`
- Produces(Task 4 依赖,签名逐字):
  - shellBridge:
    ```ts
    export type StagedAttachment =
      | { kind: "image"; ref: UserAttachmentRef; previewDataUrl: string }
      | { kind: "text"; name: string; content: string; bytes: number }
      | { kind: "rejected"; name: string; reason: string };
    export type OutgoingAttachment =
      | { kind: "image"; ref: UserAttachmentRef }
      | { kind: "text"; name: string; content: string };
    pickAttachments(): Promise<StagedAttachment[]>;
    attachmentDataUrl(id: string): Promise<string>;
    sendMessage(sessionId: string, text: string, skill?: string, attachments?: OutgoingAttachment[]): Promise<void>;
    ```
  - 频道:`pickAttachments: "otter:pickAttachments"`, `attachmentDataUrl: "otter:attachmentDataUrl"`
  - engine:`runTurn(userInput: string, attachments?: UserAttachmentRef[]): Promise<void>`
  - intake:`function intakeFile(path: string, data: Uint8Array, store: AttachmentStore): StagedAttachment`、`const TEXT_MAX_BYTES = 100 * 1024`

- [ ] **Step 1: 写 intake 失败测试**

`tests/main/attachmentIntake.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../src/session/attachments.js";
import { intakeFile, TEXT_MAX_BYTES } from "../../src/main/attachmentIntake.js";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

let dir: string;
let store: AttachmentStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otter-intake-"));
  store = new AttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("intakeFile 分类", () => {
  it("图片 → 入库 + previewDataUrl(data URL 形状)", () => {
    const out = intakeFile("/tmp/photos/cat.png", png(), store);
    expect(out.kind).toBe("image");
    if (out.kind !== "image") return;
    expect(out.ref.mediaType).toBe("image/png");
    expect(out.ref.name).toBe("cat.png");
    expect(out.previewDataUrl).toBe(
      `data:image/png;base64,${Buffer.from(png()).toString("base64")}`
    );
    expect(Array.from(store.read(out.ref.id))).toEqual(Array.from(png()));
  });

  it("文本文件 → 内容 + basename + bytes(不入库)", () => {
    const text = "# 标题\n正文";
    const out = intakeFile("/home/x/notes/readme.md", new TextEncoder().encode(text), store);
    expect(out).toEqual({
      kind: "text", name: "readme.md", content: text,
      bytes: new TextEncoder().encode(text).byteLength,
    });
  });

  it("头 8KB 含 \\0 → 判二进制拒收", () => {
    const bin = new Uint8Array(100);
    bin.set(new TextEncoder().encode("MZ"), 0); // 不是图片 magic
    bin[50] = 0;
    const out = intakeFile("/x/prog.exe", bin, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/二进制/);
  });

  it("文本超 100KB 拒收", () => {
    const big = new Uint8Array(TEXT_MAX_BYTES + 1).fill(0x61); // 全 'a'
    const out = intakeFile("/x/big.txt", big, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/100KB|超/);
  });

  it("图片超限 → rejected(store.save 的拒绝转分类结果,不抛)", () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    const out = intakeFile("/x/huge.png", big, store);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/10MB|超/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/attachmentIntake.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 intake**

`src/main/attachmentIntake.ts` 全文:

```ts
// attachmentIntake — ＋ 按钮选中文件的分类闸门(纯逻辑,fs 由调用方喂 bytes)。
// 三路出口:图片(嗅探认得)→ 入附件库返 ref+预览;文本(可 UTF-8、无 \0)→
// 内容直接带走(发送时内联进消息,不入库);其余 → rejected 带人话理由。

import { AttachmentStore, detectImageType, stripToBasename } from "../session/attachments.js";
import type { StagedAttachment } from "../shared/shellBridge.js";

export const TEXT_MAX_BYTES = 100 * 1024;

export function intakeFile(path: string, data: Uint8Array, store: AttachmentStore): StagedAttachment {
  const name = stripToBasename(path) ?? "(未命名)";
  const imageType = detectImageType(data);
  if (imageType) {
    try {
      const ref = store.save(data, path);
      return {
        kind: "image",
        ref,
        previewDataUrl: `data:${imageType};base64,${Buffer.from(data).toString("base64")}`,
      };
    } catch (e) {
      // 超限等入库拒绝:转成分类结果——一个坏文件不该炸掉整次多选
      return { kind: "rejected", name, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  // 二进制嗅探:头 8KB 含 \0 = 不是文本。图片之外的二进制本期不收(spec 明确不做)
  if (data.subarray(0, 8192).includes(0)) {
    return { kind: "rejected", name, reason: "二进制文件(图片之外的二进制本期不支持)" };
  }
  if (data.byteLength > TEXT_MAX_BYTES) {
    return {
      kind: "rejected", name,
      reason: `文本文件超过 100KB 上限(实际 ${(data.byteLength / 1024).toFixed(0)}KB)`,
    };
  }
  return {
    kind: "text",
    name,
    content: new TextDecoder().decode(data),
    bytes: data.byteLength,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/attachmentIntake.test.ts`
Expected: PASS(shellBridge 类型在下一步才加会先报 ts 错——那就把 Step 5 的 shellBridge 类型改动提前到本步一起做,测试再跑绿)

- [ ] **Step 5: Bridge/preload/engine/agent/index 接线**

`src/shared/shellBridge.ts`:

import 行加 `UserAttachmentRef`:

```ts
import type { SessionEvent, ToolCallRequest, UserAttachmentRef } from "../session/events.js";
```

`SkillInfo` 定义后加:

```ts
/** ＋ 按钮选完文件、主进程分类后的暂存项(渲染层 chips 用)。
    图片已即刻入库(取消发送 = 无害孤儿,内容寻址重发自动复用);
    文本内容暂存在渲染层,发送时经 OutgoingAttachment travel 回主进程 */
export type StagedAttachment =
  | { kind: "image"; ref: UserAttachmentRef; previewDataUrl: string }
  | { kind: "text"; name: string; content: string; bytes: number }
  | { kind: "rejected"; name: string; reason: string };

/** 发送时随消息走的附件(rejected 不上车) */
export type OutgoingAttachment =
  | { kind: "image"; ref: UserAttachmentRef }
  | { kind: "text"; name: string; content: string };
```

`ShellBridge` 接口:`sendMessage` 行改成:

```ts
  sendMessage(
    sessionId: string,
    text: string,
    skill?: string,
    attachments?: OutgoingAttachment[]
  ): Promise<void>;
```

`listSkills` 行后面加两个方法:

```ts
  /** ＋ 按钮:弹系统文件选择器(多选),主进程分类(图片入库/文本读内容/拒收)。
      用户取消 = 空数组 */
  pickAttachments(): Promise<StagedAttachment[]>;
  /** 按附件 id 取 data URL(时间线缩略图懒取用)。只回展示用途,不进日志 */
  attachmentDataUrl(id: string): Promise<string>;
```

`CHANNELS` 加两行(sendMessage 行附近):

```ts
  pickAttachments: "otter:pickAttachments",
  attachmentDataUrl: "otter:attachmentDataUrl",
```

`src/preload/index.ts`:sendMessage 行改成并列加两行(保持文件既有排版):

```ts
  sendMessage: (sessionId, text, skill, attachments) =>
    ipcRenderer.invoke(CHANNELS.sendMessage, sessionId, text, skill, attachments),
  pickAttachments: () => ipcRenderer.invoke(CHANNELS.pickAttachments),
  attachmentDataUrl: (id) => ipcRenderer.invoke(CHANNELS.attachmentDataUrl, id),
```

`src/loop/engine.ts`:`runTurn` 签名与首行改成:

```ts
  async runTurn(userInput: string, attachments?: UserAttachmentRef[]): Promise<void> {
    this.append({
      ...this.env(),
      type: "user_message",
      content: userInput,
      // 空数组不落字段:无附件的事件形状与从前逐字节一致(投影回归测试的前提)
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
```

import 处把 `UserAttachmentRef` 加进 `../session/events.js` 的类型 import。

`src/main/agent.ts`:

- `createAgent` 的 opts 加一项(注释同风格):

```ts
  /** 图片附件库(app 级资源,index.ts 注入)——adapter 请求时解 image_ref 用 */
  attachments: AttachmentStore;
```

- import 加:`import { AttachmentStore } from "../session/attachments.js";`
- `makeAdapter` 里 `createOpenAICompatibleAdapter({...})` 加一行:

```ts
      readAttachment: (id) => opts.attachments.read(id),
```

`src/main/index.ts`:

- import 加:`import { AttachmentStore } from "./session/attachments.js";`(按该文件实际相对路径:`../session/attachments.js`)与 `import { intakeFile } from "./attachmentIntake.js";`
- `const store = new EventStore(dbPath);` 后面加:

```ts
  // 图片附件库:EventStore 的邻居——日志存引用,bytes 在这(docs/adr/0009)
  const attachmentStore = new AttachmentStore(join(app.getPath("userData"), "attachments"));
```

- 所有 `createAgent({...})` 调用点(搜 `createAgent(`,新建会话与 resume 两处)加 `attachments: attachmentStore,`
- `sendMessage` handler 改成(签名加参 + 拼内容;skill 逻辑原样保留):

```ts
  ipcMain.handle(
    CHANNELS.sendMessage,
    async (_e, sessionId: string, text: string, skill?: string, attachments?: OutgoingAttachment[]) => {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error("会话不存在或未激活");
      if (runningSessions.has(sessionId)) throw new Error("该会话上一个 turn 还在跑");
      let invoked: { name: string; content: string } | null = null;
      if (skill) {
        const found = scanSkills(skillRoots).find((s) => s.name === skill);
        if (!found) throw new Error(`skill 不存在: ${skill}`);
        invoked = { name: found.name, content: found.content };
      }
      // 文本文件内联进 content(快照语义,同 skill_invoked:日志自包含,原文件
      // 后续改/删不影响重放);图片只走 ref。二者都在落盘前拼好——先落盘再喂模型
      let full = text;
      const refs: UserAttachmentRef[] = [];
      for (const a of attachments ?? []) {
        if (a.kind === "text") full += `\n\n[用户附上文件「${a.name}」,内容如下]\n${a.content}`;
        else refs.push(a.ref);
      }
      runningSessions.add(sessionId);
      win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "running" });
      try {
        if (invoked) {
          const fullEvent = store.append({ sessionId, ts: Date.now(), type: "skill_invoked", ...invoked });
          win.webContents.send(CHANNELS.event, fullEvent);
        }
        await agent.engine.runTurn(full, refs);
      } finally {
        runningSessions.delete(sessionId);
        win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "idle" });
      }
    }
  );
```

(import 加 `OutgoingAttachment` 与 `UserAttachmentRef` 类型。)

- `sendMessage` handler 附近加两个新 handler:

```ts
  ipcMain.handle(CHANNELS.pickAttachments, async () => {
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      // 不设 filters:什么都能选,分类闸门(intakeFile)决定收不收——
      // 拒收带人话理由,比灰掉文件更能让用户明白为什么
    });
    if (picked.canceled) return [];
    return picked.filePaths.map((p) => intakeFile(p, readFileSync(p), attachmentStore));
  });

  ipcMain.handle(CHANNELS.attachmentDataUrl, (_e, id: string) => {
    const data = attachmentStore.read(id); // id 非法/不存在 = 抛,渲染层兜
    const mediaType = detectImageType(data) ?? "application/octet-stream";
    return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
  });
```

(import 加 `readFileSync`(from `node:fs`)与 `detectImageType`。)

- [ ] **Step 6: 类型检查 + 全量 gate**

Run: `npm test`
Expected: 全绿(tsc + vitest;engine 加参是可选参数,现有 `runTurn(text)` 调用点全兼容)

- [ ] **Step 7: Commit**

```bash
git add src/main/attachmentIntake.ts src/shared/shellBridge.ts src/preload/index.ts src/loop/engine.ts src/main/agent.ts src/main/index.ts tests/main/attachmentIntake.test.ts
git commit -m "feat: 附件 intake 分类 + pickAttachments/attachmentDataUrl IPC + sendMessage 带附件(file-input-v1 Task 3)"
```

---

### Task 4: 渲染层 UI + ADR + 收尾

**Files:**
- Modify: `src/renderer/src/store.ts`(staging 状态 + 动作)
- Modify: `src/renderer/src/App.tsx`(＋ 按钮、chips 行、时间线缩略图)
- Modify: `src/renderer/src/app.css`(样式)
- Create: `docs/adr/0009-attachment-store.md`

**Interfaces:**
- Consumes(Task 3): `window.otter.pickAttachments()`、`window.otter.attachmentDataUrl(id)`、`sendMessage(sessionId, text, skill?, attachments?)`、`StagedAttachment`/`OutgoingAttachment`(from `../../shared/shellBridge.js`)、`UserMessageEvent.attachments`
- Produces: 无(终端消费者)

- [ ] **Step 1: store.ts 加 staging**

state 接口加(现有字段旁):

```ts
  /** ＋ 按钮暂存的附件(chips 数据源)。rejected 不进这——进 attachError */
  staged: (StagedAttachment & { kind: "image" | "text" })[];
  /** 最近一次选择被拒文件的提示(下次选择/发送时清) */
  attachError: string | null;
  pickFiles(): Promise<void>;
  removeStaged(index: number): void;
```

(import 类型:`import type { StagedAttachment } from "../../shared/shellBridge.js";`——对齐该文件既有的 shellBridge import 路径写法。)

初始值:`staged: [], attachError: null,`。

动作实现(send 附近):

```ts
  async pickFiles() {
    try {
      const picked = await window.otter.pickAttachments();
      if (picked.length === 0) return; // 用户取消
      const ok = picked.filter((a): a is Extract<StagedAttachment, { kind: "image" | "text" }> => a.kind !== "rejected");
      const rejected = picked.filter((a) => a.kind === "rejected");
      let staged = [...get().staged, ...ok];
      // 限额:图片 ≤4 张/条。超出的裁掉并告知——静默丢弃会让用户以为传上了
      const errors = rejected.map((r) => `「${r.name}」被拒:${r.reason}`);
      const images = staged.filter((a) => a.kind === "image");
      if (images.length > 4) {
        let kept = 0;
        staged = staged.filter((a) => a.kind !== "image" || ++kept <= 4);
        errors.push(`图片最多 4 张/条,多出的 ${images.length - 4} 张已忽略`);
      }
      set({ staged, attachError: errors.length > 0 ? errors.join("；") : null });
    } catch (e) {
      set({ attachError: e instanceof Error ? e.message : String(e) });
    }
  },

  removeStaged(index) {
    set({ staged: get().staged.filter((_, i) => i !== index) });
  },
```

`send(text, skill)` 改:调用前取 staging、成功后清空(失败保留——用户就地重发):

```ts
  async send(text, skill) {
    const sessionId = get().sessionId; // 发消息瞬间锁定目标会话——之后切走也不串
    const staged = get().staged;
    const attachments = staged.map((a) =>
      a.kind === "image"
        ? { kind: "image" as const, ref: a.ref }
        : { kind: "text" as const, name: a.name, content: a.content }
    );
    set({ error: null, attachError: null });
    try {
      await window.otter.sendMessage(
        sessionId, text, skill,
        attachments.length > 0 ? attachments : undefined
      );
      // 只清成功送出的那批:turn 进行中用户可能又 pick 了新附件,不能一锅端
      set({ staged: get().staged.filter((a) => !staged.includes(a)) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const last = get().events.at(-1);
      if (!(last?.type === "turn_ended" && last.error && msg.includes(last.error))) {
        set({ error: msg });
      }
    }
  },
```

注意:sendMessage 是 turn 级 Promise(整 turn 结束才 resolve),清空放 resolve 后意味着 turn 全程 chips 还挂着——不对。**改成发出即清**:`await` 前先 `set({ staged: [] })`,catch 里 `set({ staged })` 还原(发送失败附件回位,用户不用重选)。实现按这个版本:

```ts
    set({ error: null, attachError: null, staged: [] });
    try {
      await window.otter.sendMessage(
        sessionId, text, skill,
        attachments.length > 0 ? attachments : undefined
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // IPC 层失败(会话不存在/turn 冲突)= 消息没发出去,附件回位
      const last = get().events.at(-1);
      if (!(last?.type === "turn_ended" && last.error && msg.includes(last.error))) {
        set({ error: msg, staged: [...staged, ...get().staged] });
      }
    }
```

(turn 跑起来后暴死走 turn_ended 分支——消息已落盘,附件不回位,正确。)

- [ ] **Step 2: App.tsx 三处 UI**

**① ComposerBar ＋ 按钮**——`mode-select` 的 `</select>` 之后、`<span className="spacer" />` 之前插:

```tsx
      <button
        type="button"
        className="attach-btn"
        title="添加文件(图片/文本)"
        disabled={status === "running"}
        onClick={() => void useChat.getState().pickFiles()}
      >
        ＋
      </button>
```

**② chips 行**——会话 composer 里 `<textarea` 之前(slash/skill 菜单之后)插:

```tsx
              {(staged.length > 0 || attachError) && (
                <div className="attach-chips">
                  {staged.map((a, i) => (
                    <span className="attach-chip" key={i}>
                      {a.kind === "image" ? (
                        <img src={a.previewDataUrl} alt={a.ref.name ?? "图片"} />
                      ) : (
                        <span className="attach-chip-file">
                          {a.name}({(a.bytes / 1024).toFixed(0)}KB)
                        </span>
                      )}
                      <button
                        type="button"
                        className="attach-chip-x"
                        title="移除"
                        onClick={() => removeStaged(i)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {attachError && <span className="attach-error">{attachError}</span>}
                </div>
              )}
```

组件顶部(App 主组件里现有 useChat 选择器旁)加:

```tsx
  const staged = useChat((s) => s.staged);
  const attachError = useChat((s) => s.attachError);
  const removeStaged = useChat((s) => s.removeStaged);
```

**③ 时间线缩略图**——`EventRow` 的 `case "user_message":` 改成:

```tsx
    case "user_message":
      return (
        <div className="row user">
          {event.content}
          {event.attachments && event.attachments.length > 0 && (
            <div className="user-attachments">
              {event.attachments.map((a) => (
                <AttachmentThumb key={a.id} id={a.id} name={a.name} />
              ))}
            </div>
          )}
        </div>
      );
```

`EventRow` 之前加组件与模块级缓存:

```tsx
/** 附件 data URL 内存缓存:同图(内容寻址同 id)只过一次 IPC */
const thumbCache = new Map<string, string>();

/** 时间线里的图片缩略图:懒取 + 缓存。取不到(附件库文件丢失)显示占位文案——
    日志重放依赖附件库是已接受的取舍(docs/adr/0009),缺图不该炸时间线 */
function AttachmentThumb({ id, name }: { id: string; name?: string }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(id) ?? null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (url) return;
    let alive = true;
    window.otter.attachmentDataUrl(id).then(
      (u) => {
        thumbCache.set(id, u);
        if (alive) setUrl(u);
      },
      () => { if (alive) setLost(true); }
    );
    return () => { alive = false; };
  }, [id, url]);
  if (lost) return <span className="attach-lost">[图片缺失:{name ?? id.slice(0, 14)}]</span>;
  if (!url) return <span className="attach-loading">…</span>;
  return <img className="attach-thumb" src={url} alt={name ?? "附件图片"} title={name} />;
}
```

(`useState`/`useEffect` 该文件已 import。)

- [ ] **Step 3: app.css 样式**

文件尾追加(色值/圆角对齐文件里既有 composer 部分的变量或数值风格):

```css
/* ── 附件(file-input-v1)────────────────────────────── */
.attach-btn {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.attach-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
.attach-btn:disabled { opacity: 0.4; cursor: default; }

.attach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 10px 0;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
}
.attach-chip img {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
}
.attach-chip-x {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
}
.attach-chip-x:hover { opacity: 1; }
.attach-error { color: #e5534b; font-size: 12px; }

.user-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.attach-thumb {
  max-width: 200px;
  max-height: 160px;
  border-radius: 6px;
  display: block;
}
.attach-lost, .attach-loading { opacity: 0.6; font-size: 12px; }
```

- [ ] **Step 4: ADR**

`docs/adr/0009-attachment-store.md`:

```markdown
# ADR-0009: 图片附件走内容寻址附件库,日志只存引用

日期:2026-08-17　状态:已接受

## 背景

file-input-v1 要让图片进入模型上下文。事件日志是唯一事实源且只增不减,
图片 base64 直接进日志 = 几 MB 大 row 躺进最热路径(store.load 每 turn
全量读),压缩层也压不动。参考 DeepSeek Harness:附件字节与日志分家。

## 决定

- 图片字节存 `userData/attachments/<sha256>`(0600/0700),内容寻址、
  写后不可变、同图去重;`user_message` 事件只加可选 `attachments` 引用
  数组 `{id, mediaType, bytes, name}`(schema 向后兼容)
- 投影(deriveMessages)保持纯函数:只产出 `image_ref` 分片;
  bytes 在 adapter 请求组装的最后一刻经注入的 `readAttachment` 解出转
  base64——日志与投影里永远没有 base64 大块
- 文本文件不进附件库:发送时全文内联进 content(skill_invoked 同款
  快照语义,日志自包含)
- name 只留 basename:本机路径不进日志

## 代价(接受)

- 日志重放依赖附件库:bytes 与 log 分家,备份/迁移要带上 attachments 目录;
  附件文件丢失时时间线显示占位、模型请求会失败——不隐藏不伪造
- 取消发送的已入库图片成为孤儿文件:无害(内容寻址,重发自动复用),
  GC 留将来
- 非视觉模型收到图片:API 自己报错,走既有 turn 失败管线——不维护
  模型能力表,能力以 API 实际响应为准

## 已否决

- base64 直接进日志:零新组件但性能债进最热路径
- 文件复制进 workspace:污染用户工程文件夹
```

- [ ] **Step 5: 全量 gate**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 手动 e2e(唯一一次真跑)**

先杀旧 Electron 实例再 `npm run dev`(memory 规则)。验:
1. ＋ 选一张 png + 一个 .md → chips 出现(缩略图 + 文件名chip)
2. × 移除再选回
3. 选一个二进制(如 /bin/ls)→ 红字拒收理由
4. 发送带图消息 → 时间线正文下出缩略图;文本文件内容在事件 content 里
   (回放/重开会话可见);DeepSeek 若不吃图 → turn 失败横幅出现 = 预期路径
5. 重开 app resume 会话 → 缩略图仍在(附件库读出)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store.ts src/renderer/src/App.tsx src/renderer/src/app.css docs/adr/0009-attachment-store.md
git commit -m "feat: ＋ 按钮附件 UI(chips/缩略图)+ ADR-0009(file-input-v1 Task 4)"
```

---

## Self-Review 记录

- Spec 覆盖:store/schema(T1)、投影+adapter(T2)、IPC/intake/engine(T3)、UI/限额提示/ADR(T4)✓;「发送仍要求正文非空」沿用现行为(submit 的 `!text` 拦截),spec 未另行要求 ✓
- 占位扫描:无 TBD/TODO;所有代码块完整 ✓
- 类型一致:`UserAttachmentRef`(events.ts)/`UserContentPart`(deriveMessages.ts)/`StagedAttachment`/`OutgoingAttachment`(shellBridge.ts)四处定义点唯一,消费方全 import;`runTurn(full, refs)` 与 T3 签名一致;`readAttachment` 名字 T2/T3 一致 ✓
