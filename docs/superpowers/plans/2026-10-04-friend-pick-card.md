# 好友选择卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能体用 `call_friend` 认不准是哪位好友时，在手机聊天里弹一张选人卡（头像 + 名字 + 为什么猜他），主人点谁就直接拨给谁。

**Architecture:** 判定是纯函数 `pickFriend`（`src/shared/friendPick.ts`），runtime 的 `outreachHub.dispatch` 用它决定直接拨 / 出卡 / 回文字；出卡 = 在原聊天落 `friend_pick{offered}` 事件（卡里存 brief / opening）。手机点选发 `pick_friend` 帧，`CloudSession.pickFriend` 从日志折出这张卡、校验、落 `picked`，再走 `outreachHub.dialPicked`（与 `dispatch` 共用 `dialResolved` 拨号路径），失败落 `failed`。手机端 `chatRows` 把 `friend_pick` 投影成一行，`FriendPickCard` 画 A 版样式。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes` 开着：可选字段不许塞 `undefined`，用条件展开）、vitest、React Native（mobile/）、云 runtime（services/runtime）。

**Spec:** `docs/superpowers/specs/2026-10-04-friend-pick-card-design.md`（执行者两份都读）

## Global Constraints

- 新事件 `friend_pick`：`ignorable: true`、模型不可见；字段名 `fromAgentId`（不叫 `agentId`）。
- 候选上限 4 位（`FRIEND_PICK_MAX = 4`）；卡 10 分钟过期（`FRIEND_PICK_TTL_MS = 10 * 60_000`）；同一聊天新卡顶掉旧卡。
- `call_friend.candidates`：`minItems: 2`、`maxItems: 4`。
- 协议 `CS_PROTOCOL_VERSION` 24 → 25（合并前 re-fetch：别的 lane 先占了 25 就顺延成 max+1，测试与注释一起改）。
- 文案逐字照抄（见各 Task）：问话三句、`why` 四种（「上次打的就是他」「最近打过」「同名」「同名 · 最近打过」「名字相近」）、卡底三句。
- 只做手机；桌面 `Timeline.tsx` 对 `friend_pick` 返回 `null`。
- 门禁：`npm test`（跑之前 worktree 要有 `node_modules` 与 `mobile/node_modules`，见记忆里「worktree 缺 node_modules」那条：软链主 checkout 的）。
- 每个 commit message 写 why，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，引用 #1520。

---

### Task 1: `friend_pick` 事件类型 + 各张穷举表表态

**Files:**
- Modify: `src/session/events.ts`（`OutreachEvent` 后面加接口；`SessionEvent` union 约 1259 行加一项；`KNOWN_EVENT_TYPES_MAP` 约 1300 行加一项）
- Modify: `src/shared/sessionPackage.ts:159` 附近（`PRIVACY_VERDICTS`）
- Modify: `src/shared/cloudTimeline.ts:124` 附近（`hiddenFromCloudTimeline`）
- Modify: `src/session/deriveMessages.ts:1164` 附近、`src/session/persistencePolicy.ts:76` 附近、`src/shared/contextEstimate.ts:193` 附近、`src/renderer/src/components/Timeline.tsx:705` 附近
- Test: `tests/session/friendPickEvent.test.ts`（新）

**Interfaces:**
- Produces: `FriendPickCandidate`、`FriendPickEvent`（`src/session/events.ts` 导出）

- [ ] **Step 1: 写失败测试** `tests/session/friendPickEvent.test.ts`

```ts
// friend_pick 的登记（#1520）：新事件类型在每一张穷举表里都要表态，这几条钉的是「表的是什么态」
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type SessionEvent } from "../../src/session/events.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";

const ev: SessionEvent = {
  seq: 1, sessionId: "s", ts: 1, type: "friend_pick", pickId: "p1", phase: "offered", fromAgentId: "a",
  question: "你要打给哪位？点一下我就拨。", candidates: [{ uid: "u2", name: "小红", why: "" }],
  brief: "问周五", opening: "小红你好", ignorable: true,
};

describe("friend_pick 事件", () => {
  it("是已知类型", () => expect(KNOWN_EVENT_TYPES.has("friend_pick")).toBe(true));
  it("不进模型视野", () => {
    const msgs = deriveMessages([{ seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" }, ev]);
    expect(JSON.stringify(msgs)).not.toContain("小红");
  });
  it("分享时剥掉（带着好友 uid 与交代）", () => expect(PRIVACY_VERDICTS.friend_pick).toBe("strip"));
  it("桌面云时间线不画", () => expect(hiddenFromCloudTimeline(ev)).toBe(true));
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/session/friendPickEvent.test.ts`
Expected: FAIL（类型 `friend_pick` 不存在 / `KNOWN_EVENT_TYPES.has` 为 false）

- [ ] **Step 3: 加事件类型**，在 `src/session/events.ts` 的 `OutreachEvent` 接口之后：

```ts
/** 选人卡上的一位候选（#1520）。`why` = 卡上第二行（为什么猜他）；空串 = 不画那一行（模型点名的候选不附理由） */
export interface FriendPickCandidate { uid: string; name: string; why: string }

/** 智能体打电话认不准是哪位好友时，在原聊天里弹的一张选人卡（#1520）。`offered` 开头（带候选、问话与
    存好的 brief / opening），之后至多一条 `picked` / `dismissed`，`picked` 之后打不出去再落一条 `failed`；最后一条说了算。
    过期（offered 超过 10 分钟）与作废（之后又出了一张新卡）不落事件，读的时候算（friendPick.ts 的 friendPickStatus）。
    **叫 `fromAgentId` 不叫 `agentId`**：同 outreach / call_ring。模型不可见（`ignorable`）：出卡由 call_friend 的
    tool_result 告诉它，点了之后的结果由外联的汇报开场白告诉它 */
export interface FriendPickEvent extends SessionEventBase {
  type: "friend_pick";
  pickId: string;
  phase: "offered" | "picked" | "dismissed" | "failed";
  fromAgentId: string;
  /** offered 才有 */
  question?: string;
  candidates?: FriendPickCandidate[];
  brief?: string;
  opening?: string;
  /** picked 才有 */
  uid?: string;
  /** failed 才有：卡上那行红字 */
  message?: string;
  ignorable: true;
}
```

`SessionEvent` union 里 `| OutreachEvent` 下一行加 `| FriendPickEvent`；`KNOWN_EVENT_TYPES_MAP` 加 `friend_pick: true,`。

- [ ] **Step 4: 跑 `npx tsc --noEmit`，按报错逐张表表态**（`Record<SessionEvent["type"], …>` 与 `never` 穷举会逐个点名）：
  - `src/shared/sessionPackage.ts` 的 `PRIVACY_VERDICTS`：`friend_pick: "strip", // 选人卡（#1520）：带着好友 uid 与主人的交代，是发送方私事`
  - `src/shared/cloudTimeline.ts` 的 `hiddenFromCloudTimeline`：在 `e.type === "outreach" ||` 下一行加 `e.type === "friend_pick" || // 选人卡（#1520）：手机端自己认，桌面不画`
  - `src/session/deriveMessages.ts`：在 `case "outreach":` 下面加 `// 选人卡（#1520）：出卡由 call_friend 的 tool_result 说，这条只是给手机画卡\n      case "friend_pick":`（与 outreach 同一个不投影的分支）
  - `src/session/persistencePolicy.ts`：`case "friend_pick": // 选人卡（#1520）：卡开着没开着、点没点过都从日志折，必须落`（与 outreach 同一分支）
  - `src/shared/contextEstimate.ts`：`case "friend_pick":` 加在 `case "outreach":` 旁
  - `src/renderer/src/components/Timeline.tsx`：`// 选人卡（#1520）：手机上画，本机会话不会出现它\n    case "friend_pick":\n      return null;`
  - tsc 若还点名别处（比如别的 `Record<…type…>`），同样按「模型不可见、要落盘、桌面不画」表态。

- [ ] **Step 5: 跑测试与 tsc**

Run: `npx tsc --noEmit && npx vitest run tests/session/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/session/events.ts src/shared/sessionPackage.ts src/shared/cloudTimeline.ts src/session/deriveMessages.ts src/session/persistencePolicy.ts src/shared/contextEstimate.ts src/renderer/src/components/Timeline.tsx tests/session/friendPickEvent.test.ts
git commit -m "feat(events): friend_pick 选人卡事件（#1520）"
```

---

### Task 2: 纯逻辑 `src/shared/friendPick.ts`

**Files:**
- Create: `src/shared/friendPick.ts`
- Test: `tests/shared/friendPick.test.ts`

**Interfaces:**
- Consumes: `FriendPickEvent`、`FriendPickCandidate`（Task 1）；`outreachTierProblem(effective: FriendTier, peerName: string): string | null`（`src/shared/friendTier.ts:76`）；`OutreachFold`（`src/shared/outreach.ts`）
- Produces（后面的 Task 按这些名字用）：
  - `FRIEND_PICK_TTL_MS = 600_000`、`FRIEND_PICK_MAX = 4`
  - `type PickFriendInput = { friends: readonly { uid: string; name: string; tier?: FriendTier }[]; wanted: string; candidates?: readonly string[]; recentUids: readonly string[] }`
  - `type PickDecision = { kind: "dial"; uid: string; name: string } | { kind: "card"; question: string; candidates: FriendPickCandidate[] } | { kind: "text"; message: string }`
  - `pickFriend(o: PickFriendInput): PickDecision`
  - `namesSimilar(a: string, b: string): boolean`
  - `recentPeerUids(fold: OutreachFold): string[]`（新的在前，去重）
  - `friendPickToolText(names: readonly string[]): string`
  - `interface FriendPickState { pickId; fromAgentId; offeredTs: number; seq: number; question: string; candidates: FriendPickCandidate[]; brief: string; opening: string; phase: FriendPickEvent["phase"]; uid: string | null; message: string | null; superseded: boolean }`
  - `type FriendPickFold = Map<string, FriendPickState>`
  - `applyFriendPick(fold: FriendPickFold, e: SessionEvent): void`、`friendPickFoldOf(events: readonly SessionEvent[]): FriendPickFold`
  - `type FriendPickStatus = "open" | "picked" | "dismissed" | "failed" | "expired"`
  - `friendPickStatus(st: FriendPickState, now: number): FriendPickStatus`

- [ ] **Step 1: 写失败测试** `tests/shared/friendPick.test.ts`

```ts
// 选人卡的判定与折叠（#1520）：纯函数，runtime 与手机共用
import { describe, expect, it } from "vitest";
import {
  FRIEND_PICK_TTL_MS, friendPickFoldOf, friendPickStatus, friendPickToolText, namesSimilar, pickFriend, recentPeerUids,
} from "../../src/shared/friendPick.js";
import { outreachFoldOf } from "../../src/shared/outreach.js";
import type { SessionEvent } from "../../src/session/events.js";

const F = (uid: string, name: string, tier?: "chat" | "agents" | "full") => ({ uid, name, ...(tier !== undefined ? { tier } : {}) });

describe("namesSimilar", () => {
  it("包含：短的一边至少 2 个字", () => {
    expect(namesSimilar("小明", "王小明")).toBe(true);
    expect(namesSimilar("明", "王小明")).toBe(false);
  });
  it("有一个相同的词（至少 2 个字），大小写与空白不计", () => {
    expect(namesSimilar("Mingxuan Zhang", "mingxuan zhou")).toBe(true);
    expect(namesSimilar("Li Zhang", "Wu Zhang")).toBe(true);
  });
  it("编辑距离 ≤ ⌊较长 / 3⌋，较长至少 3 个字", () => {
    expect(namesSimilar("张明轩", "张铭轩")).toBe(true);
    expect(namesSimilar("小红", "小绿")).toBe(false); // 较长只有 2 个字
    expect(namesSimilar("Mingxuan Zhang", "爸爸")).toBe(false);
  });
});

describe("pickFriend", () => {
  const friends = [F("u_baba", "爸爸"), F("u_mz", "Mingxuan Zhou"), F("u_hong", "小红"), F("u_lee", "小李")];

  it("精确命中一人：直接拨", () => {
    expect(pickFriend({ friends, wanted: "小红", recentUids: [] })).toEqual({ kind: "dial", uid: "u_hong", name: "小红" });
  });

  it("精确命中一人但档位不够：回拒绝那句（同现状）", () => {
    const r = pickFriend({ friends: [F("u_hong", "小红", "chat")], wanted: "小红", recentUids: [] });
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.message).toContain("全部开放");
  });

  it("截图那一例：旧名字对不上，最近打过的（改了名）排第一，名字相近的跟在后面", () => {
    const r = pickFriend({ friends, wanted: "Mingxuan Zhang", recentUids: ["u_baba"] });
    expect(r).toEqual({
      kind: "card",
      question: "好友里没有叫「Mingxuan Zhang」的。你要打给哪位？点一下我就拨。",
      candidates: [
        { uid: "u_baba", name: "爸爸", why: "上次打的就是他" },
        { uid: "u_mz", name: "Mingxuan Zhou", why: "名字相近" },
      ],
    });
  });

  it("重名：同名的都上卡，与最近打过重叠写「同名 · 最近打过」，且排前面", () => {
    const fs = [F("x1", "小明"), F("x2", "小明"), F("u_hong", "小红")];
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: ["u_hong", "x2"] });
    expect(r).toEqual({
      kind: "card",
      question: "好友里有 2 位叫「小明」。你要打给哪位？点一下我就拨。",
      candidates: [
        { uid: "u_hong", name: "小红", why: "上次打的就是他" },
        { uid: "x2", name: "小明", why: "同名 · 最近打过" },
        { uid: "x1", name: "小明", why: "同名" },
      ],
    });
  });

  it("模型给了 candidates：按名字换成好友、不附理由、问话是通用那句", () => {
    const r = pickFriend({ friends, wanted: "她", candidates: ["小红", "小李"], recentUids: ["u_baba"] });
    expect(r).toEqual({
      kind: "card",
      question: "你要打给哪位？点一下我就拨。",
      candidates: [{ uid: "u_hong", name: "小红", why: "" }, { uid: "u_lee", name: "小李", why: "" }],
    });
  });

  it("模型的 candidates 一个都对不上 / 都打不了：当没给，回到按 wanted 判", () => {
    expect(pickFriend({ friends, wanted: "小红", candidates: ["大刘", "老王"], recentUids: [] }))
      .toEqual({ kind: "dial", uid: "u_hong", name: "小红" });
  });

  it("不能打的人不上卡；一个能打的都没有就回现在那句文字", () => {
    const fs = [F("x1", "小明", "chat"), F("x2", "小明", "agents")];
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: [] });
    expect(r).toEqual({ kind: "text", message: "好友里有 2 位叫「小明」，分不出是哪一位，问问他。" });
    const none = pickFriend({ friends, wanted: "大刘", recentUids: [] });
    expect(none).toEqual({ kind: "text", message: "好友里没有叫「大刘」的。他的好友有：爸爸、Mingxuan Zhou、小红、小李。问问他指的是哪一位。" });
    expect(pickFriend({ friends: [], wanted: "大刘", recentUids: [] })).toEqual({ kind: "text", message: "他还没有好友，打不了。" });
  });

  it("最多 4 位", () => {
    const fs = ["a", "b", "c", "d", "e"].map((x) => F(`u_${x}`, `小明${x}`));
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: [] });
    expect(r.kind === "card" ? r.candidates.length : -1).toBe(4);
  });

  it("最近打过但已不是好友：不上卡", () => {
    const r = pickFriend({ friends, wanted: "Mingxuan Zhang", recentUids: ["u_gone", "u_baba"] });
    expect(r.kind === "card" ? r.candidates.map((c) => c.uid) : []).toEqual(["u_baba", "u_mz"]);
  });
});

let seq = 0;
const ev = (o: Record<string, unknown>, ts = 1000): SessionEvent => ({ seq: seq++, sessionId: "s", ts, ...o }) as unknown as SessionEvent;
const offered = (pickId: string, ts = 1000) => ev({
  type: "friend_pick", pickId, phase: "offered", fromAgentId: "ops", question: "q",
  candidates: [{ uid: "u1", name: "小红", why: "" }], brief: "b", opening: "o", ignorable: true,
}, ts);

describe("friendPickFold / friendPickStatus", () => {
  it("offered 之后是 open；10 分钟整还开着，过了就 expired", () => {
    seq = 0;
    const st = friendPickFoldOf([offered("p1")]).get("p1")!;
    expect(st).toMatchObject({ pickId: "p1", fromAgentId: "ops", brief: "b", opening: "o", phase: "offered", superseded: false });
    expect(friendPickStatus(st, 1000 + FRIEND_PICK_TTL_MS)).toBe("open");
    expect(friendPickStatus(st, 1001 + FRIEND_PICK_TTL_MS)).toBe("expired");
  });

  it("最后一条说了算：picked → failed 带 message", () => {
    seq = 0;
    const fold = friendPickFoldOf([
      offered("p1"),
      ev({ type: "friend_pick", pickId: "p1", phase: "picked", fromAgentId: "ops", uid: "u1", ignorable: true }),
      ev({ type: "friend_pick", pickId: "p1", phase: "failed", fromAgentId: "ops", message: "没设备", ignorable: true }),
    ]);
    const st = fold.get("p1")!;
    expect(st.uid).toBe("u1");
    expect(st.message).toBe("没设备");
    expect(friendPickStatus(st, 1000)).toBe("failed");
  });

  it("新卡顶掉还开着的旧卡；已经点过的旧卡不受影响", () => {
    seq = 0;
    const fold = friendPickFoldOf([
      offered("p0"),
      ev({ type: "friend_pick", pickId: "p0", phase: "dismissed", fromAgentId: "ops", ignorable: true }),
      offered("p1"),
      offered("p2"),
    ]);
    expect(friendPickStatus(fold.get("p0")!, 1000)).toBe("dismissed");
    expect(friendPickStatus(fold.get("p1")!, 1000)).toBe("expired");
    expect(friendPickStatus(fold.get("p2")!, 1000)).toBe("open");
  });

  it("没有 offered 开头（窗口裁掉了）：不入账", () => {
    seq = 0;
    expect(friendPickFoldOf([ev({ type: "friend_pick", pickId: "p9", phase: "picked", fromAgentId: "ops", uid: "u1", ignorable: true })]).size).toBe(0);
  });
});

describe("recentPeerUids / friendPickToolText", () => {
  it("按 started 的时间新的在前、去重", () => {
    seq = 0;
    const fold = outreachFoldOf([
      ev({ type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: "a", peerName: "A", ignorable: true }, 1),
      ev({ type: "outreach", phase: "started", outreachId: "o2", fromAgentId: "ops", peerUid: "b", peerName: "B", ignorable: true }, 2),
      ev({ type: "outreach", phase: "started", outreachId: "o3", fromAgentId: "ops", peerUid: "a", peerName: "A", ignorable: true }, 3),
    ]);
    expect(recentPeerUids(fold)).toEqual(["a", "b"]);
  });
  it("工具回模型的那句", () => {
    expect(friendPickToolText(["爸爸", "Mingxuan Zhou"])).toBe(
      "没认准是哪位，已经弹了张卡让他点选（候选：爸爸、Mingxuan Zhou）。卡片自己会问，你这一轮不用再说话；他点了电话会直接拨出去，不用你再调 call_friend。",
    );
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/shared/friendPick.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `src/shared/friendPick.ts`

```ts
// friendPick —— 智能体打电话认不准是哪位好友时的选人卡（#1520，spec 2026-10-04-friend-pick-card-design）：
// 判定（直接拨 / 出卡 / 回文字）、名字相近、卡的折叠与状态。纯逻辑零 IO，runtime 与手机共用——
// 「这张卡此刻还能不能点」的判据只能有一处（同 outreach.ts / callRing.ts 的纪律）。
import type { FriendPickCandidate, FriendPickEvent, SessionEvent } from "../session/events.js";
import { outreachTierProblem, type FriendTier } from "./friendTier.js";
import type { OutreachFold } from "./outreach.js";

export const FRIEND_PICK_TTL_MS = 10 * 60_000;
export const FRIEND_PICK_MAX = 4;

export interface PickFriendInput {
  friends: readonly { uid: string; name: string; tier?: FriendTier }[];
  /** 模型照用户原话写的称呼 */
  wanted: string;
  /** 模型自己拿不准时列的 2–4 个名字 */
  candidates?: readonly string[];
  /** 这条聊天里打过的好友，新的在前（recentPeerUids） */
  recentUids: readonly string[];
}
export type PickDecision =
  | { kind: "dial"; uid: string; name: string }
  | { kind: "card"; question: string; candidates: FriendPickCandidate[] }
  | { kind: "text"; message: string };

const ASK = "你要打给哪位？点一下我就拨。";

/** NFKC、小写、去掉空白与标点 */
function squash(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function words(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[\s\p{P}]+/u).filter((w) => [...w].length >= 2);
}
function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 名字相近（spec §3）：包含（短的至少 2 字）/ 有一个相同的词（至少 2 字）/ 编辑距离 ≤ ⌊较长 / 3⌋（较长至少 3 字） */
export function namesSimilar(a: string, b: string): boolean {
  const sa = squash(a);
  const sb = squash(b);
  if (sa === "" || sb === "") return false;
  const [short, long] = [...sa].length <= [...sb].length ? [sa, sb] : [sb, sa];
  if ([...short].length >= 2 && long.includes(short)) return true;
  const wb = new Set(words(b));
  if (words(a).some((w) => wb.has(w))) return true;
  const longLen = [...long].length;
  return longLen >= 3 && editDistance(sa, sb) <= Math.floor(longLen / 3);
}

const callable = (f: { name: string; tier?: FriendTier }): boolean =>
  f.tier === undefined || outreachTierProblem(f.tier, f.name) === null;

export function pickFriend(o: PickFriendInput): PickDecision {
  const w = o.wanted.trim();
  // ① 模型自己点了名：按名字换成好友（同名的全收），只留能打的
  if (o.candidates !== undefined && o.candidates.length > 0) {
    const seen = new Set<string>();
    const out: FriendPickCandidate[] = [];
    for (const n of o.candidates) {
      for (const f of o.friends) {
        if (f.name.trim() !== n.trim() || seen.has(f.uid) || !callable(f)) continue;
        seen.add(f.uid);
        out.push({ uid: f.uid, name: f.name, why: "" });
      }
    }
    if (out.length > 0) return { kind: "card", question: ASK, candidates: out.slice(0, FRIEND_PICK_MAX) };
  }
  // ② 精确命中一人：照现状
  const hits = o.friends.filter((f) => f.name.trim() === w);
  if (hits.length === 1) {
    const f = hits[0]!;
    const refused = f.tier === undefined ? null : outreachTierProblem(f.tier, f.name);
    return refused !== null ? { kind: "text", message: refused } : { kind: "dial", uid: f.uid, name: f.name };
  }
  // ③ 对不上或重名：最近打过 → 同名 → 名字相近
  const byUid = new Map(o.friends.map((f) => [f.uid, f]));
  const dup = new Set(hits.map((f) => f.uid));
  const ranked: { uid: string; why: string }[] = [];
  const taken = new Set<string>();
  o.recentUids.forEach((uid, i) => {
    if (taken.has(uid) || !byUid.has(uid)) return;
    taken.add(uid);
    ranked.push({ uid, why: dup.has(uid) ? "同名 · 最近打过" : i === 0 ? "上次打的就是他" : "最近打过" });
  });
  for (const f of hits) if (!taken.has(f.uid)) { taken.add(f.uid); ranked.push({ uid: f.uid, why: "同名" }); }
  for (const f of o.friends) if (!taken.has(f.uid) && namesSimilar(w, f.name)) { taken.add(f.uid); ranked.push({ uid: f.uid, why: "名字相近" }); }
  const cands = ranked
    .map((r) => ({ f: byUid.get(r.uid)!, why: r.why }))
    .filter((r) => callable(r.f))
    .slice(0, FRIEND_PICK_MAX)
    .map((r) => ({ uid: r.f.uid, name: r.f.name, why: r.why }));
  if (cands.length > 0) {
    const question = hits.length > 1 ? `好友里有 ${hits.length} 位叫「${w}」。${ASK}` : `好友里没有叫「${w}」的。${ASK}`;
    return { kind: "card", question, candidates: cands };
  }
  if (hits.length > 1) return { kind: "text", message: `好友里有 ${hits.length} 位叫「${w}」，分不出是哪一位，问问他。` };
  const names = [...new Set(o.friends.map((f) => f.name.trim()).filter((n) => n !== ""))];
  return names.length === 0
    ? { kind: "text", message: "他还没有好友，打不了。" }
    : { kind: "text", message: `好友里没有叫「${w}」的。他的好友有：${names.join("、")}。问问他指的是哪一位。` };
}

/** 这条聊天里打过的好友，按那一通开始的时间新的在前、去重（「上次打的就是他」按 uid 认，改名不影响） */
export function recentPeerUids(fold: OutreachFold): string[] {
  const out: string[] = [];
  for (const s of [...fold.values()].sort((a, b) => b.startedTs - a.startedTs)) if (!out.includes(s.peerUid)) out.push(s.peerUid);
  return out;
}

export function friendPickToolText(names: readonly string[]): string {
  return `没认准是哪位，已经弹了张卡让他点选（候选：${names.join("、")}）。卡片自己会问，你这一轮不用再说话；他点了电话会直接拨出去，不用你再调 call_friend。`;
}

export interface FriendPickState {
  pickId: string; fromAgentId: string; offeredTs: number; seq: number; question: string;
  candidates: FriendPickCandidate[]; brief: string; opening: string;
  phase: FriendPickEvent["phase"]; uid: string | null; message: string | null;
  /** 之后同一条聊天又出了一张卡（这张还开着时被顶掉） */
  superseded: boolean;
}
export type FriendPickFold = Map<string, FriendPickState>;

export function applyFriendPick(fold: FriendPickFold, e: SessionEvent): void {
  if (e.type !== "friend_pick") return;
  if (e.phase === "offered") {
    for (const s of fold.values()) if (s.phase === "offered") s.superseded = true;
    fold.set(e.pickId, {
      pickId: e.pickId, fromAgentId: e.fromAgentId, offeredTs: e.ts, seq: e.seq, question: e.question ?? "",
      candidates: e.candidates ?? [], brief: e.brief ?? "", opening: e.opening ?? "",
      phase: "offered", uid: null, message: null, superseded: false,
    });
    return;
  }
  const prev = fold.get(e.pickId);
  if (prev === undefined) return; // 窗口裁掉了开头：不知道卡上是谁
  fold.set(e.pickId, { ...prev, phase: e.phase, uid: e.uid ?? prev.uid, message: e.message ?? prev.message });
}
export function friendPickFoldOf(events: readonly SessionEvent[]): FriendPickFold {
  const fold: FriendPickFold = new Map();
  for (const e of events) applyFriendPick(fold, e);
  return fold;
}

export type FriendPickStatus = "open" | "picked" | "dismissed" | "failed" | "expired";
export function friendPickStatus(st: FriendPickState, now: number): FriendPickStatus {
  if (st.phase !== "offered") return st.phase;
  return st.superseded || now - st.offeredTs > FRIEND_PICK_TTL_MS ? "expired" : "open";
}
```

注：`applyFriendPick` 里对 Map 中对象原地改 `superseded`——fold 是这一份私有的投影，调用方都不共享里面的对象；若 lint 不许，就改成 `fold.set(k, { ...s, superseded: true })`。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/shared/friendPick.test.ts && npx tsc --noEmit`
Expected: PASS。`namesSimilar` 某条若与断言不符，先核断言是不是照 spec §3 的判据写对了，再改实现——别为了绿去改 spec 的判据。

- [ ] **Step 5: Commit**

```bash
git add src/shared/friendPick.ts tests/shared/friendPick.test.ts
git commit -m "feat(shared): friendPick 判定与折叠（#1520）"
```

---

### Task 3: 协议帧 `pick_friend` / `pick_friend_result` + 客户端 `pickFriend`

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`（版本历史注释 + `CS_PROTOCOL_VERSION`；`CsUp` 约 358 行；`CsDown` 约 496 行；`decodeCsUp` 约 801 行；`decodeCsDown` 约 1101 行）
- Modify: `src/shared/remote/cloudSessionClient.ts`（接口约 208 行；`ActiveSession` 约 338 行；`settleApprove` 约 475 行旁；断线收口约 503 行；`case "approve_result"` 约 657 行旁；`approve()` 约 1100 行旁；新建 session 时约 1001 行）
- Test: `tests/shared/cloudSessionFrames.test.ts`、`tests/shared/remote/cloudSessionClient.test.ts`

**Interfaces:**
- Produces:
  - `CsUp`: `{ t: "pick_friend"; pickId: string; uid: string | null }`
  - `CsDown`: `{ t: "pick_friend_result"; pickId: string; ok: boolean; message?: string }`
  - `CloudSessionClient.pickFriend(pickId: string, uid: string | null): Promise<CloudAck>`

- [ ] **Step 1: 写失败测试**，`tests/shared/cloudSessionFrames.test.ts`：把版本断言那条改成 25（标题里补 `；25 = #1520 选人卡 pick_friend`），并加：

```ts
describe("cs 协议 25（#1520：选人卡）", () => {
  it("pick_friend 上行往返：选了人 / 都不是（uid null）", () => {
    expect(decodeCsUp(encodeCs({ t: "pick_friend", pickId: "p1", uid: "u1" }))).toEqual({ t: "pick_friend", pickId: "p1", uid: "u1" });
    expect(decodeCsUp(encodeCs({ t: "pick_friend", pickId: "p1", uid: null }))).toEqual({ t: "pick_friend", pickId: "p1", uid: null });
  });
  it("pick_friend 形状不对整帧拒掉", () => {
    expect(decodeCsUp(b64({ t: "pick_friend", pickId: "p1" }))).toBeNull();
    expect(decodeCsUp(b64({ t: "pick_friend", pickId: 1, uid: "u1" }))).toBeNull();
    expect(decodeCsUp(b64({ t: "pick_friend", pickId: "p1", uid: 3 }))).toBeNull();
  });
  it("pick_friend_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "pick_friend_result", pickId: "p1", ok: true }))).toEqual({ t: "pick_friend_result", pickId: "p1", ok: true });
    expect(decodeCsDown(encodeCs({ t: "pick_friend_result", pickId: "p1", ok: false, message: "这张卡已经用过或过期了。" })))
      .toEqual({ t: "pick_friend_result", pickId: "p1", ok: false, message: "这张卡已经用过或过期了。" });
  });
});
```

`tests/shared/remote/cloudSessionClient.test.ts` 的「say/approve/archive 就绪闸」那个 describe 里加一条（照 534 行那条的写法）：

```ts
  it("没有 join 过：pickFriend 失败（#1520）", async () => {
    const h = harness(); // ← 用那个 describe 里现成的造法，名字照抄
    expect(await h.client.pickFriend("p1", "u1")).toEqual({ ok: false, message: "没有已连接的云会话" });
  });
```

（执行者：先读 519–540 行，把 `harness()` 换成那里真实的造法。）

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/shared/cloudSessionFrames.test.ts tests/shared/remote/cloudSessionClient.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现协议**（`src/shared/remote/cloudSession.ts`）
  - 版本历史注释最前面加一段：`25（#1520）：`CsUp` 加 `pick_friend`（点选人卡上的一位，uid null = 都不是），`CsDown` 加 `pick_friend_result`（带 pickId，同 approve_result 的理由）。`；`CS_PROTOCOL_VERSION = 25`。
  - `CsUp` union 加：`| { t: "pick_friend"; pickId: string; uid: string | null }`，上面一行注释 `/** 点选人卡（#1520）：uid = 卡上的一位，null = 都不是。只有主人本人点得动，判在 runtime */`
  - `CsDown` union 加：`| { t: "pick_friend_result"; pickId: string; ok: boolean; message?: string }`
  - `decodeCsUp`，在 `if (t === "approve")` 块之后：

```ts
    if (t === "pick_friend") {
      if (typeof obj.pickId === "string" && (obj.uid === null || typeof obj.uid === "string")) {
        return { t: "pick_friend", pickId: obj.pickId, uid: obj.uid };
      }
      return null;
    }
```

  - `decodeCsDown`，在 `if (t === "approve_result")` 块之后：

```ts
    if (t === "pick_friend_result") {
      if (
        typeof obj.pickId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "pick_friend_result", pickId: obj.pickId, ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }
```

- [ ] **Step 4: 实现客户端**（`src/shared/remote/cloudSessionClient.ts`），整套照 `approve` 抄一份：
  - 接口 `approve(...)` 下一行：`/** 点选人卡（#1520）：等 pick_friend_result。同一张卡回执没到时再点一次直接回失败（手滑连点） */\n  pickFriend(pickId: string, uid: string | null): Promise<CloudAck>;`
  - `ActiveSession` 里 `pendingApprove` 下面：`/** 还没等到 pick_friend_result 的那几次点选（#1520），按 pickId 分 */\n  pendingPick: Map<string, CsPending>;`；建 session 那处（`pendingApprove: new Map(),` 旁）加 `pendingPick: new Map(),`
  - `settleApprove` 旁加：

```ts
  function settlePick(session: ActiveSession, pickId: string | null, result: CloudAck): void {
    const ids = pickId === null ? [...session.pendingPick.keys()] : [pickId];
    for (const id of ids) {
      const pending = session.pendingPick.get(id);
      if (pending === undefined) continue;
      session.pendingPick.delete(id);
      clearTimeout(pending.timer);
      pending.settle(result);
    }
  }
```

  （执行者：先读 `settleApprove` 的真实函数体，`settlePick` 与它逐行同构。）
  - 断线收口（`settleApprove(session, null, result);` 那一行下面）：`settlePick(session, null, result);`
  - 下行分派 `case "approve_result":` 之后：

```ts
      case "pick_friend_result":
        settlePick(session, msg.pickId, msg.ok ? { ok: true } : { ok: false, message: msg.message ?? "没选上" });
        return;
```

  - `approve()` 之后加：

```ts
  async function pickFriend(pickId: string, uid: string | null): Promise<CloudAck> {
    const r = requireReady();
    if (!r.ok) return r;
    const session = r.session;
    if (session.pendingPick.has(pickId)) return { ok: false, message: "这张卡的回执还没到，稍等" };
    const sent = sendFrame(session, { t: "pick_friend", pickId, uid });
    if (!sent.ok) return sent;
    return new Promise<CloudAck>((resolve) => {
      const timer = setTimeout(() => {
        settlePick(session, pickId, { ok: false, message: ACK_TIMEOUT_MESSAGE, ...ACK_UNKNOWN });
      }, ACK_TIMEOUT_MS);
      session.pendingPick.set(pickId, { settle: resolve, timer });
    });
  }
```

  - 返回的 client 对象里把 `pickFriend` 挂上（找 `approve,` 那一处）。
  - `tsc` 若点名别处实现了 `CloudSessionClient`（测试替身、桌面），各补一个 `pickFriend`（替身回 `{ ok: true }` 即可）。

- [ ] **Step 5: 跑测试**

Run: `npx tsc --noEmit && npx vitest run tests/shared/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/remote/cloudSession.ts src/shared/remote/cloudSessionClient.ts tests/shared/cloudSessionFrames.test.ts tests/shared/remote/cloudSessionClient.test.ts
git commit -m "feat(protocol): pick_friend 帧与回执，协议 25（#1520）"
```

---

### Task 4: `outreachHub`：出卡路径、`dialResolved`、`dialPicked`

**Files:**
- Modify: `services/runtime/src/outreachHub.ts`
- Test: `tests/runtime/outreachHub.test.ts`

**Interfaces:**
- Consumes: `pickFriend`、`friendPickToolText`（Task 2）；`FriendPickCandidate`（Task 1）
- Produces:
  - `OutreachOrigin.logFriendPick(e: { pickId: string; phase: "offered" | "picked" | "dismissed" | "failed"; fromAgentId: string; question?: string; candidates?: FriendPickCandidate[]; brief?: string; opening?: string; uid?: string; message?: string }): void`
  - `OutreachHub.dispatch(o: { workspaceId; ownerUid; originSessionId; agentId; agentName; friend; brief; opening; candidates?: readonly string[]; recentUids: readonly string[] }): Promise<string>`
  - `OutreachHub.dialPicked(o: { workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string; uid: string; brief: string; opening: string }): Promise<string | null>`（null = 已拨出；string = 打不出去的那句人话）

- [ ] **Step 1: 写失败测试**，`tests/runtime/outreachHub.test.ts`：
  - `DISPATCH` 常量加 `recentUids: [] as string[]`。
  - `rig()` 里 `origin` 加 `logFriendPick: (e) => void picks.push(e),`，`const picks: unknown[] = [];` 并在返回值里带上 `picks`。
  - 把「没有这个好友 … 重名」那条用例里重名那一段改成断言出卡（product 行为变了，同 PR 改测试，L2）：

```ts
  it("没有这个好友且没人可猜：回好友名单；一个好友都没有：没有好友", async () => {
    const a = rig();
    const none = await a.hub.dispatch({ ...DISPATCH, friend: "大刘" });
    expect(none).toContain("小红");
    expect(none).toContain("小明");
    expect((await rig({ friendsOf: async () => [] }).hub.dispatch(DISPATCH))).toContain("没有好友");
    expect(a.ensures).toEqual([]);
    expect(a.picks).toEqual([]);
  });

  it("重名：不打，原聊天落一张 offered 卡（带 brief / opening），回模型那句「已经弹了张卡」（#1520）", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }] });
    const msg = await r.hub.dispatch(DISPATCH);
    expect(msg).toContain("已经弹了张卡");
    expect(r.picks).toEqual([{
      pickId: "o-1", phase: "offered", fromAgentId: "ops",
      question: "好友里有 2 位叫「小红」。你要打给哪位？点一下我就拨。",
      candidates: [{ uid: "a", name: "小红", why: "同名" }, { uid: "b", name: "小红", why: "同名" }],
      brief: DISPATCH.brief, opening: DISPATCH.opening,
    }]);
    expect(r.ensures).toEqual([]);
    expect(r.starts).toEqual([]);
  });

  it("对不上但最近打过：卡上第一位是上次打的那位（改了名的爸爸，#1520）", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-baba", name: "爸爸" }, { uid: "u-hong", name: "小红" }] });
    await r.hub.dispatch({ ...DISPATCH, friend: "Mingxuan Zhang", recentUids: ["u-baba"] });
    expect(r.picks).toMatchObject([{ phase: "offered", candidates: [{ uid: "u-baba", name: "爸爸", why: "上次打的就是他" }] }]);
  });

  it("模型给了 candidates：出卡，不附理由", async () => {
    const r = rig();
    await r.hub.dispatch({ ...DISPATCH, friend: "她", candidates: ["小红", "小明"] });
    expect(r.picks).toMatchObject([{ question: "你要打给哪位？点一下我就拨。", candidates: [{ uid: "u-hong", why: "" }, { uid: "u-ming", why: "" }] }]);
  });

  it("出卡时原聊天开不出来：不落卡，回「稍后再试」", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }], origin: async () => null });
    expect(await r.hub.dispatch(DISPATCH)).toContain("稍后再试");
    expect(r.picks).toEqual([]);
  });
```

  - 新 describe：

```ts
const PICKED = {
  workspaceId: "w1", ownerUid: "owner", originSessionId: "origin-1", agentId: "ops", agentName: "运维",
  uid: "u-hong", brief: "问周五来不来", opening: "小红你好，我是运维。",
};

describe("outreachHub.dialPicked（#1520）", () => {
  it("点的人还是好友、档位够：照常拨出，落 outreach started（名字用现在的），回 null", async () => {
    const r = rig();
    expect(await r.hub.dialPicked(PICKED)).toBeNull();
    expect(r.starts).toHaveLength(1);
    expect(r.starts[0]).toMatchObject({ peerUid: "u-hong", peerName: "小红", brief: PICKED.brief, opening: PICKED.opening });
    expect(r.logged).toMatchObject([{ phase: "started", peerUid: "u-hong", peerName: "小红" }]);
  });

  it("出卡之后被删了好友：回那句话，不建会话", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-ming", name: "小明" }] });
    expect(await r.hub.dialPicked(PICKED)).toBe("他已经不在好友名单里了，电话没打出去。");
    expect(r.ensures).toEqual([]);
  });

  it("出卡之后降了档：回档位那句", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-hong", name: "小红", tier: "chat" }] });
    expect(await r.hub.dialPicked(PICKED)).toContain("全部开放");
  });

  it("这只正在打别的 / 好友没设备 / 名单查不出来：各回现成那句", async () => {
    expect(await rig({ activeFor: async () => true }).hub.dialPicked(PICKED)).toBe("这只正在打另一通电话，等它打完再派。");
    expect(await rig({ deviceCount: async () => 0 }).hub.dialPicked(PICKED)).toContain("没有能接电话的 App");
    expect(await rig({ friendsOf: async () => { throw new Error("x"); } }).hub.dialPicked(PICKED)).toContain("稍后再试");
  });
});
```

（`tier: "chat"` 的字面量若与 `FriendTier` 的真实取值不符，先读 `src/shared/friendTier.ts` 换成最低那一档的真名。）

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/runtime/outreachHub.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（`services/runtime/src/outreachHub.ts`）
  - import：`import { friendPickToolText, pickFriend } from "../../../src/shared/friendPick.js";`、`import type { FriendPickCandidate } from "../../../src/session/events.js";`；`resolveFriend` 不再从这里 import（若别处没用到）。
  - `OutreachOrigin` 加 `logFriendPick(...)`（签名见 Interfaces）。
  - `OutreachHub.dispatch` 入参加 `candidates?: readonly string[]; recentUids: readonly string[];`，并加 `dialPicked(...)`（签名见 Interfaces）。
  - 把现在 `dispatch` 里「档位检查之后」那一整段（`activeFor` 检查起，到 `return \`已经打给 ${m.name} 了…\`` 止）原样搬进一个内部函数：

```ts
  type DialArgs = { workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string; brief: string; opening: string };
  /** 认准了人之后的拨号（dispatch 与 dialPicked 共用，#1520）：几道检查、开原聊天房、建外联会话、响铃、落 started */
  async function dialResolved(o: DialArgs, m: { uid: string; name: string }): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    // ← 原来那段，每个 `return "…"` 改成 `return { ok: false, message: "…" }`，
    //   `if (r.kind === "refused") return r.message;` 改成 `return { ok: false, message: r.message }`，
    //   最后一句改成 `return { ok: true, text: \`已经打给 ${m.name} 了。先回他一句「打过去了」；聊完或者没接，通话记录会带回这条聊天，到时你再汇报。\` }`
  }
```

  - `dispatch` 改成：

```ts
    async dispatch(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，电话没打出去，稍后再试。";
      }
      const decision = pickFriend({
        friends, wanted: o.friend, recentUids: o.recentUids,
        ...(o.candidates !== undefined ? { candidates: o.candidates } : {}),
      });
      if (decision.kind === "text") return decision.message;
      if (decision.kind === "card") {
        // 认不准（#1520）：在原聊天落一张卡，主人点谁 dialPicked 就打给谁——这一轮到此为止，不响铃
        let origin: OutreachOrigin | null;
        try {
          origin = await d.origin(o.workspaceId, o.originSessionId);
        } catch (err) {
          d.log(`开原会话房失败（session=${o.originSessionId}）：${String(err)}`);
          origin = null;
        }
        if (origin === null) return "这会儿弹不出选人卡，稍后再试。";
        origin.logFriendPick({
          pickId: d.newId(), phase: "offered", fromAgentId: o.agentId,
          question: decision.question, candidates: decision.candidates, brief: o.brief, opening: o.opening,
        });
        return friendPickToolText(decision.candidates.map((c) => c.name));
      }
      const r = await dialResolved(o, decision);
      return r.ok ? r.text : r.message;
    },
    async dialPicked(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，电话没打出去，稍后再试。";
      }
      // 出卡之后可能删了好友、降了档（#1520 spec §6）：以此刻的名单为准，名字也用此刻的
      const f = friends.find((x) => x.uid === o.uid);
      if (f === undefined) return "他已经不在好友名单里了，电话没打出去。";
      if (f.tier !== undefined) {
        const refused = outreachTierProblem(f.tier, f.name);
        if (refused !== null) return refused;
      }
      const r = await dialResolved(o, { uid: f.uid, name: f.name });
      return r.ok ? null : r.message;
    },
```

  注意：出卡分支「稍后再试」那句——测试断言的是 `toContain("稍后再试")`，文案照上面写。

- [ ] **Step 4: 跑测试**

Run: `npx tsc --noEmit && npx vitest run tests/runtime/outreachHub.test.ts`
Expected: PASS（原有用例逐条仍绿；`tsc` 会在 sessionService / daemon 报 `logFriendPick` 缺失、`recentUids` 缺失——Task 5 补，这一步先只要求 outreachHub 测试绿。若 tsc 报错阻塞 vitest，不阻塞：vitest 只剥类型）

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/outreachHub.ts tests/runtime/outreachHub.test.ts
git commit -m "feat(runtime): outreachHub 认不准时出卡、点选后 dialPicked（#1520）"
```

---

### Task 5: `call_friend.candidates` + sessionService 接线 + daemon 接线

**Files:**
- Modify: `services/runtime/src/callFriendTool.ts`
- Modify: `services/runtime/src/sessionService.ts`（`opts.outreach` 类型约 496 行；`CloudSession` 接口约 579/675 行；`outreachFold` 约 767 行旁；`notify` 约 1203 行旁；`callFriendTool` 装配约 1513 行；`logOutreach` 实现约 3210 行旁；`approve` 实现约 3055 行旁）
- Modify: `services/runtime/src/daemon.ts:1070-1073`
- Test: `tests/runtime/callFriendTool.test.ts`、`tests/runtime/sessionService.outreach.test.ts`、`tests/runtime/frameHandler.test.ts`（只补 `fakeSession` 的两个默认）

**Interfaces:**
- Consumes: Task 2 的 `applyFriendPick`/`friendPickFoldOf`/`friendPickStatus`/`recentPeerUids`；Task 4 的 hub 签名
- Produces:
  - `CallFriendDeps.dispatch(a: { friend: string; brief: string; opening: string; candidates?: string[] }): Promise<string>`
  - `CloudSessionOpts["outreach"]`：`{ dispatch(o: { originSessionId: string; agentId: string; agentName: string; friend: string; brief: string; opening: string; candidates?: string[]; recentUids: string[] }): Promise<string>; dialPicked(o: { originSessionId: string; agentId: string; agentName: string; uid: string; brief: string; opening: string }): Promise<string | null> } | null`
  - `CloudSession.logFriendPick(e)`（同 `OutreachOrigin.logFriendPick`）
  - `CloudSession.pickFriend(pickId: string, byUid: string, uid: string | null): Promise<{ ok: true } | { ok: false; message: string }>`

- [ ] **Step 1: 写失败测试**
  - `tests/runtime/callFriendTool.test.ts`：先读现有用例，把 `dispatch` 替身从位置参数改成对象参数；加：

```ts
  it("candidates：2–4 个字符串原样转给 dispatch；不给就不带这一格；形状不对就抛（#1520）", async () => {
    const seen: unknown[] = [];
    const tool = createCallFriendTool({ mayCall: () => null, dispatch: async (a) => (seen.push(a), "ok") });
    const base = { friend: "她", brief: "问搬家", opening: "你好" };
    await tool.run({ ...base, candidates: ["小红", "小李"] }, world);
    await tool.run(base, world);
    expect(seen).toEqual([{ ...base, candidates: ["小红", "小李"] }, base]);
    await expect(tool.run({ ...base, candidates: ["只有一个"] }, world)).rejects.toThrow("candidates");
    await expect(tool.run({ ...base, candidates: ["a", "b", "c", "d", "e"] }, world)).rejects.toThrow("candidates");
    await expect(tool.run({ ...base, candidates: [1, 2] }, world)).rejects.toThrow("candidates");
    expect((tool.def.parameters as { properties: Record<string, unknown> }).properties.candidates).toBeDefined();
  });
```

  （`world` 用该文件现成的替身名。）

  - `tests/runtime/sessionService.outreach.test.ts`：
    - `portProbe()` 的 port 加 `dialPicked: async () => null`；「主人亲口点起的那一轮」那条用例的期望改成 `[{ originSessionId: SID, agentId: "ops", agentName: "运维", ...CALL_ARGS, recentUids: [] }]`。
    - 新 describe（放文件末尾）：

```ts
describe("选人卡（#1520）", () => {
  const OFFER = { pickId: "p1", phase: "offered" as const, fromAgentId: "ops", question: "q", candidates: [{ uid: "u-hong", name: "小红", why: "" }, { uid: "u-ming", name: "小明", why: "" }], brief: "问周五", opening: "你好" };

  function withPort(dialPicked: Port["dialPicked"]) {
    const calls: Parameters<Port["dialPicked"]>[0][] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), dialPicked(o)) };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, outreach: port, adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }) });
    return { session, store, events, calls };
  }
  const picksOf = (events: SessionEvent[]) => events.filter((e) => e.type === "friend_pick").map((e) => (e as { phase: string }).phase);

  it("主人点了一位：落 picked，dialPicked 拿到卡里的 brief / opening 与现取的名字", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "picked"]);
    expect(t.calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", uid: "u-hong", brief: "问周五", opening: "你好" }]);
    t.store.close();
  });

  it("打不出去：再落 failed 带那句话，回执仍是 ok（失败画在卡上）", async () => {
    const t = withPort(async () => "小红 的手机上还没有能接电话的 App，打不了。");
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "picked", "failed"]);
    const failed = t.events.at(-1) as { message?: string };
    expect(failed.message).toContain("没有能接电话的 App");
    t.store.close();
  });

  it("都不是：落 dismissed，不拨", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, null)).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "dismissed"]);
    expect(t.calls).toEqual([]);
    t.store.close();
  });

  it("拒：不是主人 / 卡不存在 / 点过第二次 / 人不在卡上；一律不拨、不落事件", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", "stranger", "u-hong")).toEqual({ ok: false, message: "只有他本人能选。" });
    expect(await t.session.pickFriend("nope", OWNER, "u-hong")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(await t.session.pickFriend("p1", OWNER, "u-other")).toEqual({ ok: false, message: "这个人不在卡上。" });
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(await t.session.pickFriend("p1", OWNER, "u-ming")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(t.calls).toHaveLength(1);
    t.store.close();
  });

  it("call_friend 把这条聊天打过的人（新的在前）与 candidates 递给 dispatch", async () => {
    const calls: PortCall[] = [];
    const port: Port = { dispatch: async (c) => (calls.push(c), "已经弹了张卡"), dialPicked: async () => null };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, outreach: port,
      beforeOpen: (s) => {
        s.append({ sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: "u-baba", peerName: "Mingxuan Zhang", ignorable: true });
      },
      adapterFor: (id) => {
        let round = 0;
        return { model: "fake-model", async chat(): Promise<ModelReply> {
          round++;
          if (id === "ops" && round === 1) return { content: "", toolCalls: [{ id: "cf1", name: "call_friend", args: { ...CALL_ARGS, candidates: ["小红", "小明"] } }] };
          return { content: "好" };
        } };
      },
    });
    await session.say(OWNER, "Stan", "@运维 给她打个电话", true, ["ops"]);
    await session.settled();
    expect(calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", ...CALL_ARGS, candidates: ["小红", "小明"], recentUids: ["u-baba"] }]);
    store.close();
  });
});
```

  - `tests/runtime/frameHandler.test.ts` 的 `fakeSession` 默认里加 `logFriendPick: () => {},` 与 `pickFriend: async () => ({ ok: true }),`（只为编译，行为测试在 Task 6）。

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/runtime/callFriendTool.test.ts tests/runtime/sessionService.outreach.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `callFriendTool.ts`**
  - `CallFriendDeps.dispatch` 改成 `(a: { friend: string; brief: string; opening: string; candidates?: string[] }) => Promise<string>;`
  - `parameters.properties` 加：

```ts
          candidates: {
            type: "array", items: { type: "string" }, minItems: 2, maxItems: 4,
            description: "拿不准用户指的是哪位好友时（比如「他」「她」指代不清）填 2–4 个可能的名字，会弹卡让用户点选；拿得准就别填",
          },
```

  - `run` 里 `mayCall` 判完之后：

```ts
      const raw = (args as Record<string, unknown> | null)?.candidates;
      let candidates: string[] | undefined;
      if (raw !== undefined) {
        if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4 || raw.some((x) => typeof x !== "string" || x.trim() === "")) {
          throw new Error("call_friend: candidates 要么不填，要么是 2–4 个名字");
        }
        candidates = raw.map((x) => (x as string).trim());
      }
      return deps.dispatch({ friend, brief, opening, ...(candidates !== undefined ? { candidates } : {}) });
```

  注意：参数校验（抛错）要放在 `mayCall` **之前**还是之后——跟 brief / opening 一样放在之前（形状错是模型的错，先报）；把这段挪到 `const no = deps.mayCall();` 前面，`return deps.dispatch(...)` 留在最后。
  - 文件头注释加一句：`candidates（#1520）：模型拿不准时列的候选，认不准就出选人卡（outreachHub）。`

- [ ] **Step 4: 实现 sessionService**
  - import 加 `applyFriendPick, friendPickFoldOf, friendPickStatus, recentPeerUids, type FriendPickFold` from `../../../src/shared/friendPick.js`；`FriendPickCandidate` type from events。
  - `opts.outreach` 类型改成 Interfaces 里那份，注释补一句：`dialPicked（#1520）：主人点了选人卡上的一位，按卡里存的 brief / opening 拨；null = 已拨出，string = 打不出去的那句人话`。
  - `CloudSession` 接口，`logOutreach` 下面：

```ts
  /** 原聊天里记一张选人卡（#1520，outreachHub 出卡、pickFriend 收卡时调）：ignorable、模型不可见；归档之后是空操作 */
  logFriendPick(e: {
    pickId: string; phase: "offered" | "picked" | "dismissed" | "failed"; fromAgentId: string;
    question?: string; candidates?: FriendPickCandidate[]; brief?: string; opening?: string; uid?: string; message?: string;
  }): void;
  /** 主人点了选人卡（#1520，pick_friend 帧）：uid null = 都不是。只认主人本人、只认还开着的卡、只认卡上的人；
      点了就落 picked 再拨，打不出去落 failed（回执仍是 ok，失败画在卡上） */
  pickFriend(pickId: string, byUid: string, uid: string | null): Promise<{ ok: true } | { ok: false; message: string }>;
```

  - `const outreachFold = outreachFoldOf(seed);` 下面：`// 选人卡（#1520）：同 outreachFold，从 seed 播种、notify 里推进；「这张卡还能不能点」只从这一份读\n  const friendPickFold: FriendPickFold = friendPickFoldOf(seed);`
  - `notify` 里 `applyOutreach(outreachFold, e);` 下一行：`applyFriendPick(friendPickFold, e);`
  - `callFriendTool` 装配的 `dispatch` 改成：

```ts
            dispatch: (a) =>
              opts.outreach!.dispatch({
                originSessionId: sessionId, agentId: spec.agentId, agentName: specNames.get(spec.agentId) ?? spec.name, ...a,
                // 「上次打的就是他」按 uid 认（#1520）：改了名也排得出来
                recentUids: recentPeerUids(outreachFold),
              }),
```

  - 返回对象之前（`return {` 那一行上方、与其它本地 helper 放一起）加一个本地函数，对象里的 `logFriendPick` 与 `pickFriend` 都调它（不用 `this`）：

```ts
  // 选人卡（#1520）落盘：outreachHub 出卡、pickFriend 收卡共用。归档之后是空操作
  const logFriendPickEvent: CloudSession["logFriendPick"] = (e) => {
    if (archived) return;
    notify(store.append({ sessionId, ts: Date.now(), type: "friend_pick", ...e, ignorable: true }));
  };
```

  - `logOutreach(e)` 实现旁加：

```ts
    logFriendPick: logFriendPickEvent,

    async pickFriend(pickId, byUid, uid) {
      if (archived) return { ok: false, message: "这条聊天已经归档了。" };
      if (opts.outreach === null || byUid !== opts.ownerUid) return { ok: false, message: "只有他本人能选。" };
      const st = friendPickFold.get(pickId);
      if (st === undefined || friendPickStatus(st, Date.now()) !== "open") return { ok: false, message: "这张卡已经用过或过期了。" };
      if (uid !== null && !st.candidates.some((c) => c.uid === uid)) return { ok: false, message: "这个人不在卡上。" };
      const log = logFriendPickEvent;
      if (uid === null) {
        log({ pickId, phase: "dismissed", fromAgentId: st.fromAgentId });
        return { ok: true };
      }
      // 先落 picked 再 await：notify 同步推进 fold，连点的第二帧在这里就会看到「用过了」
      log({ pickId, phase: "picked", fromAgentId: st.fromAgentId, uid });
      const roster = await rosterNow({ fresh: true });
      const agent = roster.some((a) => a.degraded) ? undefined : roster.find((a) => a.agentId === st.fromAgentId);
      const failed = agent === undefined
        ? "它已经不在这条聊天里了，电话没打出去。"
        : await opts.outreach.dialPicked({ originSessionId: sessionId, agentId: st.fromAgentId, agentName: agent.name, uid, brief: st.brief, opening: st.opening });
      if (failed !== null) log({ pickId, phase: "failed", fromAgentId: st.fromAgentId, message: failed });
      return { ok: true };
    },
```

  （执行者：`archived` / `notify` / `store` 在那个位置都要已声明——放在它们之后；`rosterNow` 回的元素若名字字段不叫 `name`、降级标志不叫 `degraded`，照真实类型改。）

- [ ] **Step 5: 实现 daemon 接线**（`services/runtime/src/daemon.ts:1070-1073`）：

```ts
      outreach:
        outreachHub === null || !approveAll
          ? null
          : {
              dispatch: (o) => outreachHub.dispatch({ ...o, workspaceId, ownerUid }),
              dialPicked: (o) => outreachHub.dialPicked({ ...o, workspaceId, ownerUid }),
            },
```

  `tests/runtime/daemonOutreachWiring.test.ts` 若钉了这一处的形状，按报错同步补 `dialPicked`。

- [ ] **Step 6: 跑测试**

Run: `npx tsc --noEmit && npx vitest run tests/runtime/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/runtime/src/callFriendTool.ts services/runtime/src/sessionService.ts services/runtime/src/daemon.ts tests/runtime/
git commit -m "feat(runtime): call_friend.candidates + CloudSession.pickFriend（#1520）"
```

---

### Task 6: `frameHandler` 处理 `pick_friend`

**Files:**
- Modify: `services/runtime/src/frameHandler.ts`（`case "approve"` 约 862 行之后）
- Test: `tests/runtime/frameHandler.test.ts`

**Interfaces:**
- Consumes: `CloudSession.pickFriend`（Task 5）；帧类型（Task 3）

- [ ] **Step 1: 写失败测试**（照 392 行「approve：CloudSession.approve 回 ok…」那条的造法）：

```ts
  it("pick_friend：转给 CloudSession.pickFriend（带发帧人的 uid），回执带 pickId（#1520）", async () => {
    const calls: unknown[] = [];
    const session = fakeSession({ pickFriend: async (...args) => (calls.push(args), { ok: true }) });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "pick_friend", pickId: "p1", uid: "u-hong" }));
    expect(calls).toEqual([["p1", "u1", "u-hong"]]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "pick_friend_result", pickId: "p1", ok: true } }]);
  });

  it("pick_friend：被拒时回 ok:false + 那句话 + log", async () => {
    const session = fakeSession({ pickFriend: async () => ({ ok: false, message: "只有他本人能选。" }) });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "pick_friend", pickId: "p1", uid: null }));
    expect(sent).toEqual([{ cid: "c1", msg: { t: "pick_friend_result", pickId: "p1", ok: false, message: "只有他本人能选。" } }]);
    expect(logs.join("\n")).toContain("p1");
  });
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/runtime/frameHandler.test.ts`
Expected: FAIL（`pick_friend` 落进 default 分支）

- [ ] **Step 3: 实现**，`case "approve"` 块之后：

```ts
        case "pick_friend": {
          // 选人卡（#1520）：谁能点、卡还开没开着、点的人在不在卡上，全判在 CloudSession.pickFriend（读日志折出来的卡），
          // 这一层只做在籍复查与回执。回执带 pickId：同 approve_result，一张卡一条
          if (!(await requireStillMemberIn(session, workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "pick_friend_result", pickId: msg.pickId, ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          const r = await session.pickFriend(msg.pickId, entry.uid, msg.uid);
          if (!r.ok) {
            deps.log(`选人卡被拒 pickId=${msg.pickId} uid=${entry.uid}：${r.message}`);
            deps.send(cid, { t: "pick_friend_result", pickId: msg.pickId, ok: false, message: r.message });
          } else {
            deps.send(cid, { t: "pick_friend_result", pickId: msg.pickId, ok: true });
          }
          return;
        }
```

  若这个 switch 有 `never` 穷举，tsc 会逼着加；若某个限速桶要求每种帧表态，照 `approve` 不进桶处理（卡一次性，用过即失效，刷不了日志）。

- [ ] **Step 4: 跑测试**

Run: `npx tsc --noEmit && npx vitest run tests/runtime/frameHandler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/frameHandler.ts tests/runtime/frameHandler.test.ts
git commit -m "feat(runtime): frameHandler 收 pick_friend 帧（#1520）"
```

---

### Task 7: 手机端 —— `chatRows` 投影 + `FriendPickCard` + ChatScreen 接线

**Files:**
- Modify: `src/shared/mobileChat.ts`（`ChatRow` union 约 98 行；`chatRows` 约 160–225 行）
- Modify: `mobile/src/chat/Bubbles.tsx`（`ChatRowView` props 与 switch；新组件放 `OutreachRecord` 后）
- Modify: `mobile/src/chat/ChatScreen.tsx`（`decide` 约 525 行旁加 `pick`；`ChatRowView` 用处约 755 行）
- Test: `tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes: `friendPickFoldOf`、`friendPickStatus`、`FriendPickStatus`（Task 2）；`cloudClient.pickFriend`（Task 3）
- Produces: `ChatRow` 新成员 `{ kind: "friend_pick"; key: string; ts: number; pickId: string; agentId: string; name: string; question: string; candidates: FriendPickCandidate[]; status: FriendPickStatus; pickedUid: string | null; message: string | null }`

- [ ] **Step 1: 写失败测试**（`tests/shared/mobileChat.test.ts` 末尾）：

```ts
describe("选人卡一行（#1520）", () => {
  const offer = (pickId: string, ts = DAY) => e({
    type: "friend_pick", pickId, phase: "offered", fromAgentId: "a_000000000002", ts,
    question: "好友里没有叫「Mingxuan Zhang」的。你要打给哪位？点一下我就拨。",
    candidates: [{ uid: "u_baba", name: "爸爸", why: "上次打的就是他" }, { uid: "u_mz", name: "Mingxuan Zhou", why: "名字相近" }],
    brief: "随便聊聊", opening: "你好", ignorable: true,
  });
  const rowsOf = (events: SessionEvent[], now = DAY) =>
    chatRows({ events, ws: WS, selfUid: "me", now }).filter((r) => r.kind === "friend_pick");

  it("offered 的位置出一行，带问话、候选、是谁弹的；还开着 = open", () => {
    seq = 0;
    expect(rowsOf([offer("p1")])).toEqual([{
      kind: "friend_pick", key: "friend_pick-p1", ts: DAY, pickId: "p1", agentId: "a_000000000002", name: "运维",
      question: "好友里没有叫「Mingxuan Zhang」的。你要打给哪位？点一下我就拨。",
      candidates: [{ uid: "u_baba", name: "爸爸", why: "上次打的就是他" }, { uid: "u_mz", name: "Mingxuan Zhou", why: "名字相近" }],
      status: "open", pickedUid: null, message: null,
    }]);
  });

  it("状态取这张卡最后一条：picked / failed（带 message）/ dismissed；后面那几条不单独成行", () => {
    seq = 0;
    const picked = e({ type: "friend_pick", pickId: "p1", phase: "picked", fromAgentId: "a_000000000002", uid: "u_baba", ignorable: true });
    expect(rowsOf([offer("p1"), picked]).map((r) => [r.kind === "friend_pick" && r.status, r.kind === "friend_pick" && r.pickedUid])).toEqual([["picked", "u_baba"]]);
    seq = 0;
    const failed = e({ type: "friend_pick", pickId: "p1", phase: "failed", fromAgentId: "a_000000000002", message: "没设备", ignorable: true });
    const f = rowsOf([offer("p1"), picked, failed]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: "failed", pickedUid: "u_baba", message: "没设备" });
  });

  it("过了 10 分钟 / 被新卡顶掉：expired", () => {
    seq = 0;
    expect(rowsOf([offer("p1")], DAY + 10 * 60_000 + 1)[0]).toMatchObject({ status: "expired" });
    seq = 0;
    const two = rowsOf([offer("p1"), offer("p2")]);
    expect(two.map((r) => r.kind === "friend_pick" && r.status)).toEqual(["expired", "open"]);
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/shared/mobileChat.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/shared/mobileChat.ts`**
  - import：`friendPickFoldOf, friendPickStatus, type FriendPickStatus` from `./friendPick.js`；`FriendPickCandidate` type from events。
  - `ChatRow` union，`outreach` 那一项后面：

```ts
  /** 选人卡（#1520）：它认不准要打给哪位好友时弹的那张。一张卡一行，在 `offered` 的位置；状态取这张卡最后一条，
      过期 / 被新卡顶掉读的时候算（friendPickStatus，`now` 由调用方递）。头像不在这里——手机按 uid 从好友表取 */
  | {
    kind: "friend_pick"; key: string; ts: number; pickId: string; agentId: string; name: string; question: string;
    candidates: FriendPickCandidate[]; status: FriendPickStatus; pickedUid: string | null; message: string | null;
  }
```

  - `chatRows` 里 `const outreaches = outreachFoldOf(o.events);` 下面：`const picks = friendPickFoldOf(o.events);`
  - 循环里，`if (e.type === "outreach") {…}` 块之后（必须在 `rowOf` 之前——`rowOf` 先问 `hiddenFromCloudTimeline`，而 Task 1 把它藏了）：

```ts
    // 选人卡（#1520）：只在 offered 的位置画一行；之后的 picked / dismissed / failed 只改这一行的状态
    if (e.type === "friend_pick") {
      const st = e.phase === "offered" ? picks.get(e.pickId) : undefined;
      if (st !== undefined) {
        items.push({
          kind: "friend_pick", key: `friend_pick-${e.pickId}`, ts: e.ts, pickId: e.pickId, agentId: st.fromAgentId,
          name: agentNameOf(o.ws, st.fromAgentId), question: st.question, candidates: st.candidates,
          status: friendPickStatus(st, o.now), pickedUid: st.uid, message: st.message,
        });
      }
      continue;
    }
```

  - `tsc` 会点名所有对 `ChatRow` 穷举的地方（`Bubbles.tsx` 的 `ChatRowView`、可能还有 `liveRows` / key 计算 / 时刻插入）：时刻插入那类按「有 `ts` 的普通行」处理；`ChatRowView` 在下一步。

- [ ] **Step 4: 实现 `FriendPickCard`**（`mobile/src/chat/Bubbles.tsx`，放在 `OutreachRecord` 之后；样式 = 会话里的 demo A 版）

```tsx
/** 选人卡（#1520；维护者看过 demo 选的 A 版）：长在它的气泡里——上面一句问话，下面一行一人（头像 + 名字 + 为什么猜他），
    最底下「都不是」。点人 = 直接拨（卡里存着交代与开场白，不再过一轮模型）。头像按 uid 从好友表取，取不到画首字。
    `picking` = 这张卡我刚点下、回执还没到（本地态，日志里没有） */
function FriendPickCard({ row, ws, avatarOf, picking, ready, onPick }: {
  row: Extract<ChatRow, { kind: "friend_pick" }>;
  ws: WorkspaceSnapshot;
  avatarOf: (uid: string) => string;
  picking: { pickId: string; uid: string | null } | null;
  ready: boolean;
  onPick: (pickId: string, uid: string | null) => void;
}) {
  const { c } = usePalette();
  const mine = picking !== null && picking.pickId === row.pickId ? picking : null;
  const open = row.status === "open" && mine === null;
  const chosen = mine?.uid ?? row.pickedUid;
  const chosenName = row.candidates.find((x) => x.uid === chosen)?.name ?? "";
  const line = { borderTopWidth: 1, borderTopColor: c.border } as const;
  const foot =
    mine !== null && mine.uid !== null ? (
      <View style={[line, { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12 }]}>
        <ActivityIndicator size="small" color={c.voice} />
        <Text style={{ fontSize: 13, color: c.mutedForeground }}>{`正在拨给 ${chosenName}…`}</Text>
      </View>
    ) : row.status === "failed" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, lineHeight: 18, color: c.destructive }]}>{`没打出去：${row.message ?? ""}`}</Text>
    ) : row.status === "dismissed" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, color: c.mutedForeground }]}>都不是。要打给谁，直接告诉我名字。</Text>
    ) : row.status === "expired" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, color: c.mutedForeground }]}>这张卡过期了，要打再跟我说。</Text>
    ) : open ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="都不是"
        disabled={!ready}
        onPress={() => onPick(row.pickId, null)}
        style={({ pressed }) => [line, { paddingVertical: 9, alignItems: "center" }, pressed && { opacity: 0.6 }]}
      >
        <Text style={{ fontSize: 14, color: c.mutedForeground }}>都不是</Text>
      </Pressable>
    ) : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />
      <View style={{ flexShrink: 1, maxWidth: "76%", minWidth: 240, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent, overflow: "hidden" }}>
        <Text style={{ paddingTop: 9, paddingBottom: 7, paddingHorizontal: 12, fontSize: 16, lineHeight: 24, color: c.foreground }}>{row.question}</Text>
        {row.candidates.map((f) => {
          const picked = chosen === f.uid && row.status !== "dismissed" && row.status !== "expired";
          const dim = !open && !picked;
          return (
            <Pressable
              key={f.uid}
              accessibilityRole="button"
              accessibilityLabel={f.why === "" ? `打给 ${f.name}` : `打给 ${f.name}，${f.why}`}
              disabled={!open || !ready}
              onPress={() => onPick(row.pickId, f.uid)}
              style={({ pressed }) => [
                line,
                { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 12 },
                picked && { backgroundColor: withAlpha(c.voice, 0.2) },
                dim && { opacity: 0.35 },
                pressed && open && { opacity: 0.7 },
              ]}
            >
              <PersonTile name={f.name} url={avatarOf(f.uid)} size={36} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 22, fontWeight: "500", color: c.foreground }}>{f.name}</Text>
                {f.why !== "" ? <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: c.mutedForeground }}>{f.why}</Text> : null}
              </View>
              {open ? <Icon name="phone" size={16} stroke={2} color={c.voice} /> : null}
            </Pressable>
          );
        })}
        {foot}
      </View>
    </View>
  );
}
```

  - `ChatRowView` props 加三个（带注释）：`friendAvatarOf: (uid: string) => string;`（选人卡的头像：按 uid 从好友表取，取不到给空串画首字）、`picking: { pickId: string; uid: string | null } | null;`、`onPickFriend: (pickId: string, uid: string | null) => void;`；switch 里：

```tsx
    case "friend_pick":
      return <FriendPickCard row={row} ws={ws} avatarOf={friendAvatarOf} picking={picking} ready={decideReady} onPick={onPickFriend} />;
```

  - `ActivityIndicator` 已在 import 里；`PersonTile` 已 import。`PersonTile` 的 props 若不叫 `name/url/size`，照 `wx/Avatar.tsx` 的真实签名改。

- [ ] **Step 5: ChatScreen 接线**（`mobile/src/chat/ChatScreen.tsx`）
  - import `useFriends`（`../friends/friendsStore.js`）。
  - state：`const [picking, setPicking] = useState<{ pickId: string; uid: string | null } | null>(null);`
  - `decide` 旁：

```tsx
  // 选人卡（#1520）：点谁就拨谁。没连上之前画的可能是缓存里的卡，同 decide 不许点
  const pickFriendOn = async (pickId: string, uid: string | null): Promise<void> => {
    if (!ready || picking !== null) return;
    setPicking({ pickId, uid });
    const r = await cloudClient.pickFriend(pickId, uid);
    setPicking(null);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定拨出去没有", tone: "muted" } : { text: r.message, tone: "error" });
  };
  const friends = useFriends();
  const friendAvatars = useMemo(
    () => new Map((friends.rows ?? []).map((f) => [f.profile.id, f.profile.avatarUrl])),
    [friends.rows],
  );
```

  （`useMemo` 若没 import 就补；`r.unknown` 的写法照 `decide` 里的真实形状。）
  - `<ChatRowView … />` 加：`friendAvatarOf={(uid) => friendAvatars.get(uid) ?? ""}`、`picking={picking}`、`onPickFriend={(id, uid) => void pickFriendOn(id, uid)}`。项目里若还有别处渲染 `ChatRowView`（`grep -rn "<ChatRowView" mobile/src`），同样补这三个（不在聊天页的地方给 `() => ""` / `null` / 空函数）。

- [ ] **Step 6: 跑门禁的两半**

Run: `npx vitest run tests/shared/mobileChat.test.ts && npx tsc --noEmit && npx tsc --noEmit -p mobile`
Expected: PASS（手机端 tsc 的确切命令照 `package.json` 里 `test` 脚本那一段写）

- [ ] **Step 7: Commit**

```bash
git add src/shared/mobileChat.ts mobile/src/chat/Bubbles.tsx mobile/src/chat/ChatScreen.tsx tests/shared/mobileChat.test.ts
git commit -m "feat(mobile): 选人卡 A 版——气泡里一行一人，点谁拨谁（#1520）"
```

---

### Task 8: ADR、代码地图、门禁、真机冒烟

**Files:**
- Create: `docs/adr/0353-打电话认不准人时弹选人卡-点即拨-不是确认卡.md`（编号合并时再核：`git fetch` 后取 `docs/adr/` 最大号 +1，撞了按 AGENTS.md 改号并加「原为 ADR-0353」）
- Modify: `docs/adr/0337-派智能体给好友打电话-外联会话无工具无记忆-汇报轮受监督.md`（第 4 条后加一句指针）
- Modify: `docs/where-to-find-things.md`（外联那一节旁加 `src/shared/friendPick.ts` 一行）

- [ ] **Step 1: 写 ADR**，内容：

```markdown
# ADR-0353：打电话认不准人时弹选人卡——点即拨，不是确认卡

- 状态：已采纳（2026-10-04）
- Issue：#1520；spec：`docs/superpowers/specs/2026-10-04-friend-pick-card-design.md`；计划：`docs/superpowers/plans/2026-10-04-friend-pick-card.md`

## 背景

`call_friend` 按显示名精确匹配（ADR-0337）。好友改了名（「Mingxuan Zhang」→「爸爸」）或重名时，工具回模型一段文字，模型再问主人，多绕一轮。
维护者原话：「智能体如果不确定是谁，可以弹出一个卡片……让用户自己点击选择。」

## 决定

1. 认不准时（模型给了 `candidates`，或名字对不上 / 重名）在原聊天落 `friend_pick{offered}`，手机画成选人卡；认得准照旧直接拨，**不出卡**。
2. 候选 = 模型点名，或 runtime 按「这条聊天里最近打过（按 uid）→ 同名 → 名字相近」排，只列档位够打的（ADR-0350），最多 4 位。
3. **点即拨**：卡里存着 brief / opening，`pick_friend` 帧 → `CloudSession.pickFriend` 校验（主人本人、卡还开着、人在卡上）→ 与 `dispatch` 同一条拨号路径。不再过一轮模型。
4. 卡 10 分钟过期、新卡顶掉旧卡，都读时算、不落事件。协议 25。

## 与 ADR-0337 第 4 条（「你开口派才算数：不弹确认卡」）的关系

选人卡**不是确认卡**：认得准时照旧不出卡。点卡算「主人亲口派」：卡只在 `mayCall()` 通过的轮里出得来（补跑 / 客人 / 汇报轮都出不了），且只有主人本人点得动。

## 否决的路

- 点选 = 替主人发一句「打给爸爸」再起一轮：多一轮模型、多几秒、多花额度。
- 工具阻塞等点选（像审批卡）：这一轮一直挂着，主人不点就超时。
- runtime 给卡片传头像：手机好友表已经有 `avatarUrl`，按 uid 取即可，日志里不存头像。

## 推翻条件

主人觉得「点了就打」太快、要再确认一次——那就改成点选后在卡上出「拨给 X」按钮，协议不变。
```

- [ ] **Step 2: ADR-0337 第 4 条那一行后加**：`（#1520 补：认不准是哪位时会出选人卡，那不是确认卡——见 ADR-0353。）`

- [ ] **Step 3: `docs/where-to-find-things.md`**：找到 `outreach` / 外联那一段，加一行：`- \`src/shared/friendPick.ts\` — 打电话认不准人时的选人卡：判定（直接拨 / 出卡 / 回文字）、名字相近、卡的折叠与过期（ADR-0353，#1520）`

- [ ] **Step 4: 全量门禁**

Run: `npm test 2>&1 | tee /tmp/gate.log; echo "GATE_EXIT=${PIPESTATUS[0]}"`
Expected: `GATE_EXIT=0`（判据只认这一行，别看后台通知的退出码）。`tests/docs/adrNumbers.test.ts` 会挡撞号。

- [ ] **Step 5: Commit + push**

```bash
git add docs/
git commit -m "docs(adr): 0353 认不准人时弹选人卡、点即拨（#1520）"
git push
```

- [ ] **Step 6: 真机冒烟**（需要部署 runtime，按记忆里「云 UI 真机验收」「手机端模拟器冒烟」两条跑；生产 runtime 部署要维护者点头，**先问**）：三种场景各点一次——改名认不出（最近打过排第一）、重名、「她」+ candidates；再各验一次「都不是」与过期（把 `FRIEND_PICK_TTL_MS` 临时调小只在本地验，别提交）。截图贴进 PR。

- [ ] **Step 7: 开 PR**（`Closes #1520`，正文列三种场景截图与「没做」的那条：同名都没头像时分不出来），CI 绿后 merge commit 合入（不 squash）。合并前 re-fetch 核协议号与 ADR 号。
