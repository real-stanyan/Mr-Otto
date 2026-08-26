# skill 渐进披露 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型自己能发现并取用本机已装的 skill —— 索引常驻在一把 `skill` 工具的 description 里，正文按需 `acquire`（落 `skill_invoked` 事件），并新增 `release` 停用动作。

**Architecture:** 索引挂在工具声明表上（本来就常驻、本来就不落事件、本来就受 `exposure.ts` 预算管着，零新注入面）。正文走 `skill_invoked` 事件而不是 tool_result —— 投影层削 tool_result、不削 user 消息，正文留在 tool_result 里长任务跑一阵就被削掉。新增 `skill_released` 事件后，台账 `activeSkills` 从「只增」变「增删」，连带 `modelContextScan` 与 `microCompact` 两处必须跟改，否则被停用的 skill 会在 compact 之后诈尸。

**Tech Stack:** TypeScript strict / Electron 主进程 / vitest（测试在 `tests/`，镜像 `src/`）/ Playwright-electron（`npm run e2e`，不在门禁里）

**Spec:** `docs/superpowers/specs/2026-08-26-skill-progressive-disclosure-design.md`

## Global Constraints

- 硬规则：append-only 事件日志是唯一事实来源，先落盘再喂模型。模型读到的 skill 正文必须先 `store.append` 再进上下文。
- 硬规则：`SessionEvent` schema 变更必须向后兼容 —— 只加**可选**字段 + 加新事件类型；旧日志投影逐字节不变，要有测试钉住。
- 硬规则：`src/tools/` 下禁止 import `fs` / `child_process`（`tests/architecture.test.ts` 钉着）。`skill` 工具读盘一律经装配期注入的闭包。
- 硬规则：渲染进程只走 `ShellBridge`。
- 门禁：`npm test`（= `tsc --noEmit` + `vitest run`）。内循环用 `npx vitest --watch`。
- 新增事件类型必须在 `KNOWN_EVENT_TYPES_MAP`（`src/session/events.ts`）与 `persistencePolicy` 的穷尽 switch 里表态 —— 漏了 tsc 直接红。
- 提交信息写「为什么」，小步提交。
- ADR 编号合并前 re-fetch 认领 `max + 1`；撞号按 AGENTS.md 留「原为 ADR-00XX」行。

---

### Task 1: 事件 schema + 台账变「增删」

**Files:**
- Modify: `src/session/events.ts:251-259`（`SkillInvokedEvent` 加 `source?`）、`:513-544`（union）、`:557-586`（`KNOWN_EVENT_TYPES_MAP`）
- Modify: `src/session/persistencePolicy.ts:59`（durable 分支加新类型）
- Modify: `src/session/activeSkills.ts`（全文，约 38 行）
- Test: `tests/session/activeSkills.test.ts`（已存在，追加）、`tests/session/persistencePolicy.test.ts`（已存在，追加）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `SkillInvokedEvent.source?: "user" | "model"`（缺省 = user）
  - `interface SkillReleasedEvent extends SessionEventBase { type: "skill_released"; name: string }`
  - `activeSkills(events, barren, before?): Map<string, ActiveSkill>`，其中 `ActiveSkill = { content: string; args?: string; source?: "user" | "model" }`

- [ ] **Step 1: 写失败的测试（台账增删 + 来源）**

追加到 `tests/session/activeSkills.test.ts`（文件顶部已有 `skill()` / `user()` 两个构造器，照抄风格再加一个）：

```typescript
const released = (seq: number, name: string): SessionEvent => ({
  seq, sessionId: "s", ts: seq, type: "skill_released", name,
});

const modelSkill = (seq: number, name: string, content: string): SessionEvent => ({
  seq, sessionId: "s", ts: seq, type: "skill_invoked", name, content, source: "model",
});

describe("停用（skill_released，本次新增）", () => {
  it("停用后不在台账里", () => {
    const events = [skill(0, "tdd", "旧版"), user(1, "活"), released(2, "tdd")];
    expect([...activeSkills(events, new Set()).keys()]).toEqual([]);
  });

  it("停了又启用 = 生效，且排到台账尾部", () => {
    const events = [
      skill(0, "a", "甲"), skill(1, "b", "乙"), released(2, "a"), skill(3, "a", "甲新"),
    ];
    const out = activeSkills(events, new Set());
    expect([...out.keys()]).toEqual(["b", "a"]);
    expect(out.get("a")).toEqual({ content: "甲新" });
  });

  it("停用不存在的 skill 是空操作，不抛", () => {
    const events = [skill(0, "a", "甲"), released(1, "b")];
    expect([...activeSkills(events, new Set()).keys()]).toEqual(["a"]);
  });

  it("barren 里的停用不算数（防御位，与启用同一条规矩）", () => {
    const events = [skill(0, "a", "甲"), released(1, "a")];
    expect([...activeSkills(events, new Set([1])).keys()]).toEqual(["a"]);
  });

  it("source 进台账：模型取的记 model，用户 $ 启用的不带这个键", () => {
    const out = activeSkills([modelSkill(0, "a", "甲"), skill(1, "b", "乙")], new Set());
    expect(out.get("a")).toEqual({ content: "甲", source: "model" });
    expect(out.get("b")).toEqual({ content: "乙" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session/activeSkills.test.ts`
Expected: FAIL —— 类型错（`"skill_released"` 不在 `SessionEvent` union 里）

- [ ] **Step 3: 加事件类型**

`src/session/events.ts`，`SkillInvokedEvent` 里追加字段（**放在 `args` 之后**）：

```typescript
  /** 谁启用的（issue 待开）。缺省 = "user"（$ 指令）——旧日志没有这个字段，
      投影逐字节不变。"model" = 模型自己调 skill 工具取的；停用时按它校验来源：
      模型只能停自己取的，用户 $ 启用的动不了 */
  source?: "user" | "model";
```

同文件里 `SkillInvokedEvent` 之后新增：

```typescript
/** 额外 N：skill 停用。台账（activeSkills）按它剔除——ADR-0066 结尾预留的口子。
    只记名字：正文快照在对应的 skill_invoked 里，重复存一份没有意义。
    模型 release 自己 acquire 的、或用户在 UI 上点掉，都落这一条（来源校验发生在
    落盘之前，被拒的 release 不留痕迹） */
export interface SkillReleasedEvent extends SessionEventBase {
  type: "skill_released";
  name: string;
}
```

union 里 `| SkillInvokedEvent` 之后加 `| SkillReleasedEvent`；`KNOWN_EVENT_TYPES_MAP` 里 `skill_invoked: true,` 之后加 `skill_released: true,`。

`src/session/persistencePolicy.ts` 的 durable 分支，`case "skill_invoked":` 之后加：

```typescript
    case "skill_released": // 停用是台账的事实来源，倒推不出来
```

- [ ] **Step 4: 改台账**

`src/session/activeSkills.ts`，改文件头注释里那句「当前没有『停用』动作」，并改 `ActiveSkill` 与循环体：

```typescript
export interface ActiveSkill {
  content: string;
  args?: string;
  /** 谁启用的。缺省 = user（旧日志/$ 指令）。release 的来源校验读它 */
  source?: "user" | "model";
}
```

```typescript
  for (let i = 0; i < before && i < events.length; i++) {
    const e = events[i]!;
    if (barren.has(i)) continue;
    if (e.type === "skill_released") {
      out.delete(e.name); // 停用即出台账；停一个不在台账里的是空操作
      continue;
    }
    if (e.type !== "skill_invoked") continue;
    // 覆盖时先删再设：后启用的排到台账尾部——重注入次序反映的是最近一次
    // 启用的先后，不是石化的首见序
    out.delete(e.name);
    out.set(e.name, {
      content: e.content,
      ...(e.args !== undefined ? { args: e.args } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    });
  }
```

- [ ] **Step 5: 跑 tsc，把穷尽 switch 的红点逐个补上**

Run: `npx tsc --noEmit`
Expected: 报若干处「switch 未覆盖 skill_released」。逐个补，每处按该文件既有风格写一行注释说明为什么这样处置。已知会红的地方（以 tsc 实际报的为准）：

- `src/session/persistencePolicy.ts` —— Step 3 已加
- `src/main/sectionClassifier.ts:104` 附近 —— 分区分类：停用与启用同档，跟着 `skill_invoked` 走
- `src/shared/contextEstimate.ts:135` 附近 —— 停用事件不占模型上下文（正文不在它身上），记 0
- `src/renderer/src/lib/threadGroups.ts:44` 附近 —— 与 `skill_invoked` 同组
- `src/renderer/src/components/Timeline.tsx:527` 附近 —— Task 6 会正经渲染它，本任务先给一个最小分支（渲成与启用卡片同族的一行）
- `src/renderer/src/replay/trajectory.ts` —— 轨迹视图同上

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/session/activeSkills.test.ts tests/session/persistencePolicy.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/session/events.ts src/session/persistencePolicy.ts src/session/activeSkills.ts tests/session/activeSkills.test.ts tests/session/persistencePolicy.test.ts src/main/sectionClassifier.ts src/shared/contextEstimate.ts src/renderer/src/lib/threadGroups.ts src/renderer/src/components/Timeline.tsx src/renderer/src/replay/trajectory.ts
git commit -m "feat(session): skill 台账支持停用，skill_invoked 记来源

ADR-0066 结尾预留的口子：没有停用动作的话，模型误取一把大 skill 就永久
占着上下文。source 缺省 user = 旧日志投影逐字节不变。"
```

---

### Task 2: 投影层 —— 停用不投影 + 中途 acquire 的插话延后

**Files:**
- Modify: `src/session/deriveMessages.ts:477-487`（`skill_invoked` 分支）+ 新增 `skill_released` 分支
- Test: `tests/session/deriveMessages.test.ts`（已存在，追加）

**Interfaces:**
- Consumes: Task 1 的 `SkillReleasedEvent`、`activeSkills` 的增删语义
- Produces: 无新导出 —— 只改投影行为

**背景（实现者必读）：** `deriveMessages` 里有一套插话延后机制：`pendingToolIds` 非空（一组 tool_call 还没答完）时，落下来的 user 消息先攒进 `deferredUsers`，等组齐了再 `flushDeferred()`（见 `:366-372`、`:389`、`:459-460`）。理由是 API 要求 tool 结果紧跟在发起它的 assistant 消息之后，中间插一条 user 消息就是非法请求。模型调 `skill.acquire` 时，`skill_invoked` 正好落在这个窗口里 —— 必须走同一条延后路，否则每次模型自取都发出一个非法请求。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/session/deriveMessages.test.ts`（照抄该文件已有的事件构造风格）：

```typescript
describe("模型自取 skill 的投影（本次新增）", () => {
  it("中途 acquire：说明书排在 tool 消息之后，不夹在 tool_call 与 tool_result 中间", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "写测试" },
      { seq: 2, sessionId: "s", ts: 2, type: "assistant_message", content: "", model: "m",
        toolCalls: [{ id: "c1", name: "skill", args: { action: "acquire", name: "tdd" } }] },
      { seq: 3, sessionId: "s", ts: 3, type: "skill_invoked", name: "tdd", content: "先写测试", source: "model" },
      { seq: 4, sessionId: "s", ts: 4, type: "tool_result", toolCallId: "c1", status: "ok", output: "skill「tdd」已启用" },
    ];
    const msgs = deriveMessages(events);
    const roles = msgs.map((m) => m.role);
    // assistant(tool_call) 之后必须直接是 tool，说明书排在它后面
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);
    expect(msgs.at(-1)!.content).toContain("先写测试");
  });

  it("skill_released 不投影任何消息（它只改台账）", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "先写测试" },
      { seq: 2, sessionId: "s", ts: 2, type: "skill_released", name: "tdd" },
      { seq: 3, sessionId: "s", ts: 3, type: "user_message", content: "活" },
    ];
    const contents = deriveMessages(events).map((m) => m.content);
    expect(contents.filter((c) => c.includes("skill「tdd」已停用")).length).toBe(0);
    // 已发出的那份说明书照旧留在上下文里：它是历史事实，停用只影响此后
    expect(contents.some((c) => c.includes("先写测试"))).toBe(true);
  });

  it("停用之后 compact 清场：重注入里没有它", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 1, type: "skill_invoked", name: "keep", content: "留着" },
      { seq: 2, sessionId: "s", ts: 2, type: "skill_invoked", name: "drop", content: "扔掉" },
      { seq: 3, sessionId: "s", ts: 3, type: "skill_released", name: "drop" },
      { seq: 4, sessionId: "s", ts: 4, type: "context_compacted", summary: "摘要" },
      { seq: 5, sessionId: "s", ts: 5, type: "user_message", content: "接着干" },
    ];
    const contents = deriveMessages(events).map((m) => m.content).join("\n");
    expect(contents).toContain("留着");
    expect(contents).not.toContain("扔掉");
  });
});
```

> 实现者注意：上面三段里的事件字段（`context_compacted` 的 `summary` 名、`tool_result` 的字段）以 `src/session/events.ts` 为准，照抄该测试文件里已有的同类事件构造，别照抄这里的记忆。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: FAIL —— 第一条在 `["assistant","user","tool"]` 上失败（说明书夹在了中间）

- [ ] **Step 3: 改投影**

`src/session/deriveMessages.ts` 的 `case "skill_invoked":` 分支，把 `messages.push({...})` 换成走延后队列（`:389` 的 `target` 是同款写法）：

```typescript
      case "skill_invoked": {
        // 注入为 user 消息，与 compact 摘要同理：中途插 system 各家方言兼容性参差。
        // 位置就是事件位置——skill 在哪条消息前启用，模型就从哪开始看到它。
        // args 段只在有参数时出现：旧日志（无 args 字段）投影逐字节不变。
        // 组开着时走延后队列（同插话，:389）：模型自取 skill 时这条正好落在
        // tool_call 与 tool_result 之间，直接 push 会插进这一对中间——API 要求
        // tool 结果紧跟发起它的 assistant 消息，夹一条 user 进去就是非法请求
        const target = pendingToolIds.size > 0 ? deferredUsers : messages;
        target.push({
          role: "user",
          content:
            `[本轮启用 skill「${event.name}」${event.args ? `（参数：${event.args}）` : ""}` +
            `，以下是它的指令，请在完成任务时遵循]\n${event.content}`,
        });
        break;
      }

      case "skill_released":
        // 不投影：停用只改台账（activeSkills），已经发出去的那份说明书是历史事实，
        // 不追认、不撤回。效果体现在下一次 compact 清场时不再重注入
        break;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: PASS（含该文件原有全部用例 —— 旧日志投影逐字节不变是这一步的前提）

- [ ] **Step 5: 提交**

```bash
git add src/session/deriveMessages.ts tests/session/deriveMessages.test.ts
git commit -m "fix(session): 模型自取 skill 的说明书走插话延后队列

skill_invoked 落在 tool_call 与 tool_result 之间时直接 push 会夹进这一对
中间，API 要求 tool 结果紧跟发起它的 assistant 消息——每次自取都会发出
一个非法请求。走 :389 那条既有的延后路。"
```

---

### Task 3: compact 两处连锁点（诈尸修复）

**Files:**
- Modify: `src/session/modelContextScan.ts:49` 附近
- Modify: `src/session/microCompact.ts:163` / `:182` / `:216` 附近（规则⑥）
- Test: `tests/session/modelContextScan.test.ts`、`tests/session/microCompact.test.ts`（都已存在，追加）

**Interfaces:**
- Consumes: Task 1 的 `SkillReleasedEvent`
- Produces: 无新导出

**背景（实现者必读）：** 这两处不改，被停用的 skill 会在 compact 之后**诈尸**。`modelContextScan` 从 checkpoint 之后单捞 `skill_invoked` 喂给重注入；只捞启用不捞停用，停用记录就在扫描窗口外面。`microCompact` 规则⑥保证 `skill_invoked` 永不进吸收区（被吸收 = 从模型视野里消失），停用记录同样不能被吸收 —— 吸收掉一条 release，效果就是 skill 悄悄复活。

- [ ] **Step 1: 写失败的测试（两个文件各一条）**

`tests/session/modelContextScan.test.ts` 追加（照抄该文件已有的 store/checkpoint 搭台方式）：

```typescript
it("checkpoint 之后的停用也要捞进来（不捞 = 被停用的 skill 在 compact 后诈尸）", () => {
  // 搭台：checkpoint 之前启用 a、b；checkpoint 之后停用 b
  // 断言：扫描结果里同时有 skill_invoked 和 skill_released，
  //       且喂给 activeSkills 之后台账只剩 a
});
```

`tests/session/microCompact.test.ts` 追加：

```typescript
it("skill_released 不进吸收区（被吸收 = 停用记录消失 = skill 复活）", () => {
  // 搭台：一段可吸收的老 turn，中间夹一条 skill_released
  // 断言：吸收区间不覆盖那条 skill_released 的下标
});
```

> 两条都要写成真断言（把注释换成代码）——照抄同文件里最接近的一条既有用例的搭台方式，别新造 helper。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session/modelContextScan.test.ts tests/session/microCompact.test.ts`
Expected: FAIL

- [ ] **Step 3: 改扫描窗口**

`src/session/modelContextScan.ts:49`：

```typescript
    ...store.ofType(sessionId, "skill_invoked", { beforeSeq: cp.seq }),
    // 停用与启用必须成对地捞：只捞启用的话，checkpoint 之后的停用落在扫描窗口
    // 外面，台账算不出它，被停用的 skill 会在 compact 之后诈尸
    ...store.ofType(sessionId, "skill_released", { beforeSeq: cp.seq }),
```

同文件头部注释里那句列举（`:15`「全部 skill_invoked（台账语义…）」）一并补上 `skill_released`。

- [ ] **Step 4: 改微压缩豁免**

`src/session/microCompact.ts` 里三处提到 `skill_invoked / image_described` 的地方（`:163`、`:182`、`:216` 附近）把 `skill_released` 一并纳入判定 —— 具体写法以现场代码为准（若是 `Set` 就加一项，若是 `||` 链就加一支），并在规则⑥的注释里补一句「停用记录被吸收 = skill 复活」。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/session/`
Expected: PASS（整个 session 目录，含 Task 1/2 的用例）

- [ ] **Step 6: 提交**

```bash
git add src/session/modelContextScan.ts src/session/microCompact.ts tests/session/modelContextScan.test.ts tests/session/microCompact.test.ts
git commit -m "fix(session): 停用记录跟着启用一起过 compact 两道关

modelContextScan 只捞 skill_invoked、microCompact 只豁免 skill_invoked，
两处都会让停用记录消失——效果是被停用的 skill 在压缩之后诈尸。"
```

---

### Task 4: `skill` 工具（纯工具层）

**Files:**
- Create: `src/tools/skill.ts`
- Test: `tests/tools/skill.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ActiveSkill.source`
- Produces:

```typescript
export interface SkillToolDeps {
  /** 现扫磁盘的已装 skill（装配期注入——工具层不碰 fs） */
  listSkills(): { name: string; description: string; content: string; argumentHint?: string }[];
  /** 此刻台账：名字 → 来源。release 的来源校验读它 */
  activeSkills(): Map<string, { source?: "user" | "model" }>;
  /** 落 skill_invoked（source: "model"）。装配根接线：store.append + push.event */
  appendInvoked(name: string, content: string, args?: string): void;
  /** 落 skill_released */
  appendReleased(name: string): void;
}
export function createSkillTool(deps: SkillToolDeps): Tool;
export const SKILL_TOOL_NAME = "skill";
/** 索引拼装（导出供测试直接打）：超预算按最近启用序截断 + 尾注还有几条 */
export function composeSkillIndex(
  skills: { name: string; description: string }[],
  maxBytes: number
): string;
```

- [ ] **Step 1: 写失败的测试**

新建 `tests/tools/skill.test.ts`（照 `tests/tools/todoWrite.test.ts` 的风格：直接调 `run`，`world` 传 `{} as ExecutionWorld` —— 这把工具不碰世界）：

```typescript
import { describe, expect, it } from "vitest";
import { composeSkillIndex, createSkillTool } from "../../src/tools/skill.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const W = {} as ExecutionWorld;

function harness(
  skills = [
    { name: "tdd", description: "先写测试再写实现", content: "TDD 正文" },
    { name: "caveman", description: "极简回话风格", content: "CAVEMAN 正文" },
  ]
) {
  const invoked: { name: string; content: string; args?: string }[] = [];
  const released: string[] = [];
  const active = new Map<string, { source?: "user" | "model" }>();
  const tool = createSkillTool({
    listSkills: () => skills,
    activeSkills: () => active,
    appendInvoked: (name, content, args) => {
      invoked.push({ name, content, ...(args !== undefined ? { args } : {}) });
      active.set(name, { source: "model" });
    },
    appendReleased: (name) => {
      released.push(name);
      active.delete(name);
    },
  });
  return { tool, invoked, released, active };
}

describe("skill 工具", () => {
  it("description 里带索引：每把 skill 一行 name — description", () => {
    const { tool } = harness();
    expect(tool.def.description).toContain("tdd — 先写测试再写实现");
    expect(tool.def.description).toContain("caveman — 极简回话风格");
  });

  it("一把 skill 都没装时不出这把刀", () => {
    const { tool } = harness([]);
    expect(tool.available?.()).toBe(false);
  });

  it("acquire：落事件、回执不含正文（正文走事件，不走 tool_result）", async () => {
    const { tool, invoked } = harness();
    const out = await tool.run({ action: "acquire", name: "tdd" }, W);
    expect(invoked).toEqual([{ name: "tdd", content: "TDD 正文" }]);
    expect(String(out)).toContain("已启用");
    expect(String(out)).not.toContain("TDD 正文");
  });

  it("acquire 带参数：args 跟着进事件", async () => {
    const { tool, invoked } = harness();
    await tool.run({ action: "acquire", name: "caveman", args: "ultra" }, W);
    expect(invoked[0]).toEqual({ name: "caveman", content: "CAVEMAN 正文", args: "ultra" });
  });

  it("acquire 不存在的 skill：抛错且不落事件", async () => {
    const { tool, invoked } = harness();
    await expect(tool.run({ action: "acquire", name: "nope" }, W)).rejects.toThrow(/不存在/);
    expect(invoked).toEqual([]);
  });

  it("重复 acquire 已启用的：不重复落事件（同一份说明书两遍是白烧 token）", async () => {
    const { tool, invoked } = harness();
    await tool.run({ action: "acquire", name: "tdd" }, W);
    const out = await tool.run({ action: "acquire", name: "tdd" }, W);
    expect(invoked.length).toBe(1);
    expect(String(out)).toContain("已经启用");
  });

  it("release 自己取的：落事件", async () => {
    const { tool, released } = harness();
    await tool.run({ action: "acquire", name: "tdd" }, W);
    await tool.run({ action: "release", name: "tdd" }, W);
    expect(released).toEqual(["tdd"]);
  });

  it("release 用户 $ 启用的：报错且不落事件（用户意图优先级高于模型判断）", async () => {
    const { tool, released, active } = harness();
    active.set("tdd", {}); // 缺省来源 = user
    await expect(tool.run({ action: "release", name: "tdd" }, W)).rejects.toThrow(/用户启用/);
    expect(released).toEqual([]);
  });

  it("release 没启用的：报错且不落事件", async () => {
    const { tool, released } = harness();
    await expect(tool.run({ action: "release", name: "tdd" }, W)).rejects.toThrow(/未启用/);
    expect(released).toEqual([]);
  });

  it("list：按关键词打分，命中名字或描述都算", async () => {
    const { tool } = harness();
    const out = String(await tool.run({ action: "list", query: "测试" }, W));
    expect(out).toContain("tdd");
    expect(out).not.toContain("caveman");
  });

  it("list 无命中：说清楚没命中，不返回空串", async () => {
    const { tool } = harness();
    expect(String(await tool.run({ action: "list", query: "zzz" }, W))).toContain("没有匹配");
  });

  it("非法 action / 缺 name：抛错", async () => {
    const { tool } = harness();
    await expect(tool.run({ action: "eat", name: "tdd" }, W)).rejects.toThrow();
    await expect(tool.run({ action: "acquire" }, W)).rejects.toThrow();
  });
});

describe("composeSkillIndex（索引拼装与截断）", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    name: `skill-${i}`,
    description: `第 ${i} 把的描述`,
  }));

  it("装得下就全列", () => {
    const out = composeSkillIndex(many.slice(0, 3), 8 * 1024);
    expect(out).toContain("skill-0");
    expect(out).toContain("skill-2");
    expect(out).not.toContain("未列出");
  });

  it("装不下：截断 + 说清楚还有几条、怎么找", () => {
    const out = composeSkillIndex(many, 1024);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out).toMatch(/另有 \d+ 个未列出/);
    expect(out).toContain("list");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/skill.test.ts`
Expected: FAIL —— `Cannot find module '../../src/tools/skill.js'`

- [ ] **Step 3: 写实现**

新建 `src/tools/skill.ts`：

```typescript
// skill 工具 —— 模型自己发现并取用本机已装的 skill（渐进披露）。
//
// 索引（name — description）拼进 def.description：工具表本来就常驻、本来就不落
// 事件、本来就受 exposure.ts 的单工具预算管着——零新注入面，也不用为「索引凭什么
// 不落盘」另编一套解释（同 tool_search 的先例）。
//
// 正文走 skill_invoked 事件，不进 tool_result：投影层削 tool_result 的输出、
// 不削 user 消息（见 subagentPrompt.ts 文件头）。正文留在 tool_result 里，长任务
// 跑一阵就被削掉——技能无声失效，正是 ADR-0066 刚修好的那个病。
//
// 不碰 fs：读盘与落盘都是装配期注入的闭包（硬规则：src/tools 不 import fs）。

import type { Tool } from "./tool.js";

export const SKILL_TOOL_NAME = "skill";

/** 索引体积上限，与 exposure.ts 的单工具预算同一把尺子。留 1KB 给动作说明 */
const INDEX_BUDGET = 7 * 1024;
const MAX_LIST_RESULTS = 10;

export interface SkillToolDeps {
  listSkills(): {
    name: string;
    description: string;
    content: string;
    argumentHint?: string;
  }[];
  activeSkills(): Map<string, { source?: "user" | "model" }>;
  appendInvoked(name: string, content: string, args?: string): void;
  appendReleased(name: string): void;
}

/** 索引拼装。装得下全列；装不下按传入序（装配层给的是最近启用序）列前 N，
    尾注还有几条、怎么找——静默截半句会让模型以为清单就这些 */
export function composeSkillIndex(
  skills: { name: string; description: string }[],
  maxBytes: number = INDEX_BUDGET
): string {
  const lines: string[] = [];
  let used = 0;
  let listed = 0;
  for (const s of skills) {
    const line = `- ${s.name} — ${s.description || "（无描述）"}`;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    // 尾注本身也要装得下，所以留出余量再收
    if (used + bytes > maxBytes - 120) break;
    lines.push(line);
    used += bytes;
    listed++;
  }
  const rest = skills.length - listed;
  if (rest > 0) {
    lines.push(`（另有 ${rest} 个未列出，用 action:"list" 加关键词检索）`);
  }
  return lines.join("\n");
}

export function createSkillTool(deps: SkillToolDeps): Tool {
  const index = () => composeSkillIndex(deps.listSkills());
  return {
    def: {
      name: SKILL_TOOL_NAME,
      description:
        "本机已装的 skill（说明书式的提示词包）。判断某把 skill 与当前任务相关时，" +
        'acquire 它——它的正文会进入你的上下文并在此后一直生效，直到 release。\n' +
        'action："list" 按关键词检索（清单装不下时用）、"acquire" 启用、"release" 停用。\n' +
        "只能 release 你自己 acquire 的；用户启用的那些你动不了。\n\n" +
        "可用 skill：\n" +
        index(),
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "acquire", "release"], description: "要做什么" },
          name: { type: "string", description: "skill 名（acquire / release 必填）" },
          args: { type: "string", description: "skill 参数（可选，如档位 lite/ultra）" },
          query: { type: "string", description: "检索关键词（list 用）" },
        },
        required: ["action"],
      },
    },
    requiresApproval: false,
    // 并发不安全：acquire 会落事件、改台账，两把同时跑顺序不确定
    parallelSafe: false,
    // 一把 skill 都没装就别出这把刀——报一把只会返回空的工具是白让模型试
    available: () => deps.listSkills().length > 0,
    async run(rawArgs) {
      const a = (rawArgs ?? {}) as { action?: unknown; name?: unknown; args?: unknown; query?: unknown };
      const action = a.action;
      if (action === "list") {
        const query = typeof a.query === "string" ? a.query.trim() : "";
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const all = deps.listSkills();
        const scored = (words.length === 0 ? all.map((s) => ({ s, score: 1 })) : all
          .map((s) => {
            const hay = `${s.name} ${s.description}`.toLowerCase();
            return { s, score: words.filter((w) => hay.includes(w)).length };
          })
          .filter((x) => x.score > 0))
          .sort((x, y) => y.score - x.score)
          .slice(0, MAX_LIST_RESULTS);
        if (scored.length === 0) return `没有匹配「${query}」的 skill。`;
        return `找到 ${scored.length} 个：\n${scored
          .map(({ s }) => `- ${s.name} — ${s.description || "（无描述）"}`)
          .join("\n")}`;
      }

      const name = a.name;
      if (typeof name !== "string" || name === "") {
        throw new Error(`skill: action "${String(action)}" 必须带 name`);
      }

      if (action === "acquire") {
        if (deps.activeSkills().has(name)) return `skill「${name}」已经启用，指令仍在生效。`;
        const found = deps.listSkills().find((s) => s.name === name);
        if (!found) throw new Error(`skill 不存在: ${name}（用 action:"list" 看有哪些）`);
        const args = typeof a.args === "string" && a.args !== "" ? a.args : undefined;
        deps.appendInvoked(found.name, found.content, args);
        return `skill「${name}」已启用，它的指令随后进入你的上下文，此后一直生效。`;
      }

      if (action === "release") {
        const entry = deps.activeSkills().get(name);
        if (!entry) throw new Error(`skill「${name}」未启用，无需停用。`);
        if (entry.source !== "model") {
          throw new Error(`skill「${name}」由用户启用，模型不能停用它。`);
        }
        deps.appendReleased(name);
        return `skill「${name}」已停用，它的指令不再随压缩重注入。`;
      }

      throw new Error(`skill: 未知 action「${String(action)}」（只认 list / acquire / release）`);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/skill.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 干净

- [ ] **Step 5: 提交**

```bash
git add src/tools/skill.ts tests/tools/skill.test.ts
git commit -m "feat(tools): skill 工具——索引进 description，正文按需 acquire

工具层不碰 fs：读盘与落盘都是装配期注入的闭包。回执不含正文，正文走
skill_invoked 事件——留在 tool_result 里会被投影层的输出折叠削掉。"
```

---

### Task 5: 装配接线（agent.ts / index.ts / subagentRunner）

**Files:**
- Modify: `src/main/agent.ts:455-505`（工具数组 + 新增 opts 字段）
- Modify: `src/main/index.ts:1552` 附近（`skillRoots` 已有）+ 造 agent 处
- Modify: `src/main/subagentRunner.ts:181-203`（继承时透传 `source`）
- Modify: `src/main/subagents.ts` 或 `src/shared/subagent.ts`（`skills: "none"` 时不挂这把刀 —— 以现场 `def.skills` 的读取处为准）
- Test: `tests/main/`（照该目录既有的装配测试风格追加一个 `skillToolWiring.test.ts`；若目录里没有可复用的装配 harness，则本任务的验证靠 Task 7 的 e2e，并在提交信息里写明）

**Interfaces:**
- Consumes: Task 4 的 `createSkillTool(deps)`、Task 1 的台账
- Produces: `CreateAgentOptions` 新增可选字段

```typescript
  /** skill 库接线（issue 待开）。缺席 = 不挂 skill 工具（裸装配/测试照旧）。
      listSkills 现扫磁盘由组装根注入——工具层不碰 fs */
  skills?: {
    listSkills(): { name: string; description: string; content: string; argumentHint?: string }[];
  };
```

- [ ] **Step 1: 接线（无新测试逻辑，先写实现）**

`src/main/agent.ts` 的 `tools` 数组里，`createTaskTool` 那一项之后加：

```typescript
    // skill 渐进披露：组装根给了 skill 库才挂（裸装配/测试不挂）。
    // 台账与落盘都在这层闭包里——工具层只认接口，不碰 store 也不碰 fs。
    // acquire 落的事件位置就是"此刻"：模型调用发生在 tool_call 与 tool_result
    // 之间，投影层的插话延后队列负责把它排到 tool 消息之后（deriveMessages）
    ...(opts.skills
      ? [
          createSkillTool({
            listSkills: opts.skills.listSkills,
            activeSkills: () => {
              const log = store.load(sessionId);
              return activeSkills(log, barrenEventIndexes(log));
            },
            appendInvoked: (name, content, args) => {
              opts.push.event(
                store.append({
                  sessionId,
                  ts: Date.now(),
                  type: "skill_invoked",
                  name,
                  content,
                  ...(args !== undefined ? { args } : {}),
                  source: "model",
                })
              );
            },
            appendReleased: (name) => {
              opts.push.event(
                store.append({ sessionId, ts: Date.now(), type: "skill_released", name })
              );
            },
          }),
        ]
      : []),
```

`src/main/index.ts` 造主会话 agent 的地方，传 `skills: { listSkills: () => scanSkills(skillRoots) }`（`skillRoots` 在 `:1552` 已经有了）。

`src/main/subagentRunner.ts`：子会话装配同样传 `skills`，但 `def.skills === "none"` 时**不传** —— 「不被行为 skill 污染」的本意里，自己去取也该关掉。同文件 `:195` 的继承 append 里透传来源：

```typescript
              ...(s.args !== undefined ? { args: s.args } : {}),
              // 来源跟着快照走：父会话里模型自取的，子会话里模型也能 release；
              // 用户 $ 启用的，子会话同样动不了
              ...(s.source !== undefined ? { source: s.source } : {}),
```

- [ ] **Step 2: 跑门禁**

Run: `npm test`
Expected: PASS（tsc + 全部 vitest）

- [ ] **Step 3: 真机点一遍（这一步没有单测替代）**

Run: `npm run dev`，开一个会话，让模型自己判断要不要取 skill（例如问它「本机有哪些 skill？挑一个合适的用上」）。确认三件事：① 模型的工具表里有 `skill`；② `acquire` 之后会话里出现 skill 卡片；③ 下一轮模型的回答确实遵循了那份说明书。

- [ ] **Step 4: 提交**

```bash
git add src/main/agent.ts src/main/index.ts src/main/subagentRunner.ts
git commit -m "feat(main): 接线 skill 工具，子 agent 的 skills:none 连刀一起关

listSkills/落盘都是组装根注入的闭包（工具层不碰 fs、不碰 store）。
继承时透传 source：父会话里模型自取的，子会话里模型也能 release。"
```

---

### Task 6: UI —— 来源标注 + 用户停用入口

**Files:**
- Modify: `src/shared/shellBridge.ts`（加 `releaseSkill`）+ `src/preload/`（通道透传，以现场文件为准）
- Modify: `src/main/index.ts`（`releaseSkill` handler）
- Modify: `src/renderer/src/components/Timeline.tsx:527` 附近（skill 卡片）
- Create: `src/shared/skillCard.ts`（卡片文案的纯函数）
- Test: `tests/shared/skillCard.test.ts`、`tests/main/`（handler 的形状把关测试，照该目录既有 IPC handler 测试风格）

**Interfaces:**
- Consumes: Task 1 的 `source` 字段
- Produces:

```typescript
// src/shared/skillCard.ts
export function skillCardLabel(e: { name: string; args?: string; source?: "user" | "model" }): string;
```

- [ ] **Step 1: 写失败的测试**

新建 `tests/shared/skillCard.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { skillCardLabel } from "../../src/shared/skillCard.js";

describe("skillCardLabel", () => {
  it("用户启用的：不标来源（旧日志同款，缺省即用户）", () => {
    expect(skillCardLabel({ name: "tdd" })).toBe("已启用 skill「tdd」");
    expect(skillCardLabel({ name: "tdd", source: "user" })).toBe("已启用 skill「tdd」");
  });

  it("模型启用的：标出来——用户得知道上下文里这份说明书是谁塞的", () => {
    expect(skillCardLabel({ name: "tdd", source: "model" })).toBe("Otto 启用了 skill「tdd」");
  });

  it("带参数：参数进标签", () => {
    expect(skillCardLabel({ name: "caveman", args: "ultra", source: "model" }))
      .toBe("Otto 启用了 skill「caveman」（参数：ultra）");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/skillCard.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写纯函数**

新建 `src/shared/skillCard.ts`：

```typescript
// skill 卡片的文案 —— 纯函数，主/渲两侧共用（渲染层不该自己拼这套话术）。

export function skillCardLabel(e: {
  name: string;
  args?: string;
  source?: "user" | "model";
}): string {
  const who = e.source === "model" ? "Otto 启用了" : "已启用";
  const args = e.args ? `（参数：${e.args}）` : "";
  return `${who} skill「${e.name}」${args}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/skillCard.test.ts`
Expected: PASS

- [ ] **Step 5: 接 IPC + 卡片**

`src/shared/shellBridge.ts` 加方法（照该文件既有方法的注释风格写一句「为什么」）：

```typescript
  /** 停用一个已启用的 skill（落 skill_released）。用户是老大：不校验来源，
      模型自取的和 $ 启用的都能点掉；模型那侧的 release 才有来源校验 */
  releaseSkill(sessionId: string, name: string): Promise<void>;
```

`src/main/index.ts` 加 handler：形状把关先于 append（同 `handleSendMessage` 的规矩 —— 坏请求零痕迹），`name` 非字符串直接抛；会话不存在直接抛；然后 `store.append({ type: "skill_released", ... })` + `send(CHANNELS.event, ...)`。

`Timeline.tsx` 的 `case "skill_invoked"` 卡片改用 `skillCardLabel(event)`，并在卡片右侧加一个「停用」按钮：只在该 skill 此刻仍在台账里时出现，点击调 `releaseSkill`。`case "skill_released"` 渲成一行灰字「已停用 skill「x」」。

- [ ] **Step 6: 跑门禁 + 真机点一遍**

Run: `npm test`
Expected: PASS

真机：`npm run dev` → 用 `$` 启用一把 skill → 卡片上点「停用」→ 时间线出现停用行 → 触发一次 compact（或用 `/compact`，以现场入口为准）→ 确认那把 skill 没有被重注入。

- [ ] **Step 7: 提交**

```bash
git add src/shared/skillCard.ts src/shared/shellBridge.ts src/preload src/main/index.ts src/renderer/src/components/Timeline.tsx tests/shared/skillCard.test.ts
git commit -m "feat(ui): skill 卡片标出来源，给用户一个停用入口

模型自取的说明书也进上下文，卡片不标来源的话用户看见多出一份指令却不
知道是谁塞的。停用入口不校验来源：用户能点掉任意一把。"
```

---

### Task 7: e2e + ADR + 收尾

**Files:**
- Create: `tests/e2e/skillAcquire.e2e.ts`
- Create: `docs/adr/00NN-skill渐进披露.md`（编号合并前 re-fetch 认领 `max + 1`）
- Modify: `docs/superpowers/specs/2026-08-26-skill-progressive-disclosure-design.md`（头部 Issue 行回填真实编号）

**Interfaces:**
- Consumes: 前六个任务的全部产出
- Produces: 无代码导出

- [ ] **Step 1: 写 e2e**

新建 `tests/e2e/skillAcquire.e2e.ts`，照 `tests/e2e/harness.ts`（换 `HOME` 做隔离）+ `tests/e2e/fakeModel.ts`（本机假模型）的既有用法：

1. 在隔离的 `HOME` 下预置一把 skill：`$HOME/.mr-otto/skills/e2e-demo/SKILL.md`，frontmatter 写 `name: e2e-demo` / `description: e2e 用的假 skill`，正文写一句可断言的标记文本
2. 假模型脚本：第一轮回一个 `skill` 工具调用（`{action:"acquire",name:"e2e-demo"}`），第二轮回一句普通文本
3. 断言：时间线上出现「Otto 启用了 skill「e2e-demo」」卡片；第二轮请求的消息里含那句标记文本

- [ ] **Step 2: 跑 e2e**

Run: `npm run e2e -- skillAcquire`
Expected: PASS（e2e 不在门禁里，但 GUI 改动的 PR 要贴它的结果 —— ADR-0058）

- [ ] **Step 3: 写 ADR**

`docs/adr/00NN-skill渐进披露.md`，按本仓 ADR 的既有结构（背景 / 决定 / 备选与否决 / 代价）。决定部分至少覆盖：索引进工具 description 而不是单独前置词；正文走事件不走 tool_result（连同压缩规则这条理由）；取用同权 + 新增停用；台账变增删连带的两处 compact 连锁点。备选与否决部分至少写：正文进 tool_result（被投影层削掉）、每把 skill 生成一把 deferred 工具（磨损 ADR-0007「不做插件系统」的边界）、一次性取用不进台账（ADR-0066 修好的病从新口子跑回来）。

- [ ] **Step 4: 回填 spec 头部的 Issue 行，跑门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交并开 PR**

```bash
git add tests/e2e/skillAcquire.e2e.ts docs/adr docs/superpowers/specs/2026-08-26-skill-progressive-disclosure-design.md
git commit -m "docs(adr): skill 渐进披露；e2e 钉住模型自取这条路

e2e 用换 HOME 的隔离 + 本机假模型驱一次 acquire：卡片出现、下一轮请求里
确实带着那份说明书。"
git push -u origin HEAD
gh pr create --fill
```

---

## 自检（写完计划后的复核）

- **spec 覆盖**：D1 → Task 4；D2 → Task 4（回执不含正文）+ Task 2（投影位置）；D3 → Task 1（source/台账）+ Task 4（来源校验）；D4 四处连锁点 → Task 1（①②）+ Task 3（③④）；D5 → Task 1；D6 → Task 4（`composeSkillIndex`）；D7 → Task 4（name 是查表键，`listSkills` 闭包注入）；D8 → Task 6；D9 → Task 5。测试与「不做」两节 → 分散在各任务 + Task 7。无遗漏项。
- **类型一致**：`SkillToolDeps` 的四个方法名（`listSkills` / `activeSkills` / `appendInvoked` / `appendReleased`）在 Task 4 定义、Task 5 接线处逐字使用；`ActiveSkill.source` 在 Task 1 定义，Task 4/5/6 一路沿用同一个字面量联合 `"user" | "model"`。
- **已知的现场核对项**（实现者以代码为准，不以本计划的行号为准）：Task 2 测试里的事件字段名、Task 3 `microCompact` 三处判定的具体写法、Task 6 的 preload 通道文件位置、Task 5 中 `def.skills` 的读取处。
