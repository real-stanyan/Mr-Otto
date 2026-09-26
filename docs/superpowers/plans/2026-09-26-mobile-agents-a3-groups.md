# 手机端「智能体」单栏 A3——群聊（建群 / 群聊页 / @ 谁 / 群设置）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ＋ 那张岔路弹窗里「一个群聊」接上：推入建群页勾 2–6 只、起名（可空）→ 建成落进那条群聊；群聊页头部右边那颗进群设置（改名 / 移出 / 加一只 / 解散），输入框上方一颗「@ 谁」点一只插进 `@名字 `，时间线多两种行：名单变了那一行（居中带脸）与派活那一句（「没 @ 谁 —— 运维接了」）。

**Architecture:** 判据全在 `src/shared/`（进 vitest）：建群的勾选与群名、加 / 移之后的完整名单（新 `groupEdit.ts`；桌面建群弹窗与「添加智能体」改成调它——群名留空时拼出来的名字截到协议上限以内，顺手堵掉桌面一个会让建群白等 15 秒的洞）；派活那一句（`cloudTimeline.dispatchLineText`）与名单那一行接进手机时间线（`mobileChat.chatRows`）；「@ 谁」插在哪（`agentMentionInput.insertAgentMention`）。服务端一行不改：`create{chat:{kind:"group"}}` / `chat_update` / `delete` 三条控制房帧 #1280 就有（cs 协议 20），手机只接线。手机端只画：两个新栈页 `NewGroup` / `GroupSettings`、两张底部抽屉（加一只 / @ 谁），外加几样零件（确认弹窗的实底红钮 #1362、原生导航条右边的字钮、「一只智能体占一行」）。

**Tech Stack:** Expo SDK 57 / RN 0.86 / react-native-svg 15.15 / reanimated 4.5 + gesture-handler 2.32（A1 已装）/ @react-navigation native-stack；vitest。**本片不新增任何依赖、没有 migration、不动 runtime / edge、不进协议位。**

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（本片对应 §5.6 群聊、§4 居中弹窗与底部抽屉、§6 状态与降级、§8 A3 一行、§10 偏离清单——尤其第 22 条「群聊在 A1 已有基础版」与第 29 条「岔路弹窗『一个群聊』A3 接上」、§11 维护者拍板）。执行者先读 spec 这几节再动手。Demo 在 main 的 `.demo/mobile-agents-redesign.html`（`newGroup` / `groupChat` / `groupSettings` / `mention` / `addMember` / `disband` 那几段），**实现以 spec §10 为准**。

## Global Constraints

- 工作目录：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455`（分支 `claude/mobile-a3-324455`，从 origin/main `7ea283ff` 开）。**你改的每一个路径都必须在这个目录下；绝不碰主 checkout `/Users/stanyan/Github/Mr_Otto`**（那是别的 lane 共用的只读副本）。每条 shell 命令自带 `cd <这个目录> &&`，别依赖上一条留下的 cwd。
- **绝不用 `git stash`（任何形式）**：stash 栈是所有 worktree 共享的。RED 靠「先写测试、跑出失败、再实现」。不许 `--no-verify`。
- 手机端（`mobile/`）在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session` 文件（`tests/architecture.test.ts` 第 8 条会红）。类型 `SessionEvent` 等从 `src/session/events.js` 取（在白名单里）。
- **两端共用的纯逻辑写进 `src/shared/`，不抄第二份**（spec §2）。手机端不进 vitest、只跑 tsc，所以凡是「判断」都放 shared 并带测试；RN 组件里只剩接线与样式。
- **本片不新增任何依赖、没有 migration、不碰 `services/`、不进协议位。**
- 设计令牌逐值取自 `mobile/src/theme.ts`；尺寸逐值取自 spec §4 / demo。界面文案不出现「水獭」，也不出现「主场」「云会话」这类内部名。
- 群聊的上下限用 `src/shared/chatRoster.ts` 的常量：`CHAT_GROUP_CREATE_MIN`（2）、`CHAT_GROUP_MAX`（6）、`CHAT_NAME_MAX`（60），**不写死数字**。
- 状态与降级（spec §6）：还没查到 ≠ 没有 / 读不到 ≠ 空 / 说不清就不画钮（#722）。确认类用居中弹窗（`mobile/src/dialog.tsx`），挑东西用底部抽屉（`mobile/src/sheet/BottomSheet.tsx`）。失败那句话留在出事的那一屏上，不先收起弹窗 / 抽屉（先收就等于把「没做成」说成「做成了」）。
- 每一段动效都要有「减弱动态效果」下的样子（`useReduceMotion()`）：按下的缩放退成变暗；减弱不是取消。
- 桌面行为只改一处：建群弹窗群名留空时拼出来的名字**截到 60 字以内**（Task 2）。其余桌面改动是换成调 shared 同一份判据，`tests/renderer/NewGroupDialog.test.tsx` / `AddAgentPopover.test.tsx` 既有的用例一条都不改就得全绿。
- TypeScript strict；根另开 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（shared 代码根与手机两边都要过）。可选字段不许显式赋 `undefined`，用 `...(x === undefined ? {} : { k: x })`。
- 源码里要 NUL 字符一律 `String.fromCharCode(0)`（本片用不到，别引进来）；测试里要 emoji 一律写 `\u{1F600}` 这种转义，不直接贴字形。
- 门禁 `npm test`（根 tsc + mobile tsc + vitest）。这个 worktree 的根 `node_modules` 是指向主 checkout 的软链、`mobile/node_modules` 是本地安装——**都不要动**。跑门禁：`npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`。**判据只认 `GATE_EXIT`**（`.superpowers/` 被 git 忽略）。单跑一个测试文件：`npx vitest run <路径>`。
- 提交：小步提交，中文 message 写清「为什么」，末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。`git add` 只加这个任务自己的文件（逐路径，不用 `-A` / `.`）。**这个会话的 shell 会拒绝 heredoc**：把 message 用编辑工具写进 `.superpowers/commit-msg.txt`，再 `git commit -F .superpowers/commit-msg.txt`；message 内容照计划原文。
- 代码块照原样写进文件；用编辑工具按「把 A 换成 B」改文件时，先 `grep -n` / 读源文件那几行，照源文件的真实缩进做锚点。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/groupEdit.ts` | 新 | 建群的勾选（名册顺序 / 上下限锁）与群名（留空拼成员名、截到上限以内）；加一只的候选与原因；加 / 移之后的完整名单 |
| `src/renderer/src/components/NewGroupDialog.tsx` | 改 | 改调 `groupEdit`（群名截断是唯一的行为变化） |
| `src/renderer/src/components/AddAgentPopover.tsx` | 改 | 改调 `groupEdit`（行为不变） |
| `src/shared/cloudTimeline.ts` | 改 | 新增 `dispatchLineText`（派活那一句） |
| `src/shared/mobileChat.ts` | 改 | 时间线多两种行：名单变了那一行（`roster`）、派活那一句（`note`，排在那句话底下） |
| `mobile/src/chat/ChatRows.tsx` | 改 | 画名单那一行（居中、名字左边一张脸） |
| `mobile/src/ui.tsx` | 改 | `Button` 加 `danger` 实底红与 `sm` 小胶囊；`Row` 加 `accent`；`Field` 加 `editable` |
| `mobile/src/dialog.tsx` | 改 | `DialogFooter` 右边那颗可以是实底红（`tone: "destructive"`，#1362） |
| `mobile/src/chrome/Glyphs.tsx` | 改 | 新增 `CheckGlyph` |
| `mobile/src/chrome/HeaderTextButton.tsx` | 新 | 原生导航条右边那颗字钮（「存」/「建」） |
| `mobile/src/group/AgentPickRow.tsx` | 新 | 一只智能体占一行：脸 + 名字 + 职责 + 右边一格 |
| `mobile/src/agent/AgentSettingsScreen.tsx` | 改 | 改用 `HeaderTextButton`；「删掉」确认钮实底红 |
| `mobile/src/nav/types.ts` / `RootNavigator.tsx` | 改 | 两个新栈页 `NewGroup` / `GroupSettings` |
| `mobile/src/roster/NewThingDialog.tsx` / `RosterScreen.tsx` | 改 | 「一个群聊」接上（名册不到两只时按不动）→ 推建群页 |
| `mobile/src/group/NewGroupForm.tsx` / `NewGroupScreen.tsx` | 新 | 建群页（受控的正文 + 接线的屏） |
| `mobile/src/group/AddMemberSheet.tsx` | 新 | 「加一只进来」抽屉 |
| `mobile/src/group/GroupSettingsBody.tsx` / `GroupSettingsScreen.tsx` | 新 | 群设置（受控的正文 + 接线的屏） |
| `src/shared/agentMentionInput.ts` | 改 | 新增 `insertAgentMention`（「@ 谁」插在光标处） |
| `mobile/src/chat/Composer.tsx` | 改 | 句柄多一个 `mention(name)` |
| `mobile/src/chat/MentionSheet.tsx` | 新 | 「@ 谁」那颗钮 + 抽屉 |
| `mobile/src/chat/ChatScreen.tsx` | 改 | 群设置入口、「@ 谁」、空群那一行、群聊的占位字 |
| `AGENTS.md` / `mobile/README.md` / spec §10 | 改 | 收尾文档 |

任务顺序：1 是 shared 的建群判据，2 让桌面改用同一份，3 是时间线的两种新行（shared + 画法），4 是手机的几样零件，5 建群，6 群设置，7「@ 谁」，8 收尾（文档、门禁、模拟器冒烟、PR）。

**不在本片**：#1361（名册读不到聊天清单时说成「没聊过」）与 #1360（runtime 名册「最后一句」乱序落库）——两条都不是群聊的事，前者要连桌面侧栏一起判、后者要重新部署 runtime，各自另开。#1362（确认弹窗的删除钮不是破坏性样式）并进本片：解散群是它的第二个消费方（Task 4）。

---

### Task 1: 建群的判据（shared `groupEdit.ts`）

建群页、群设置、桌面的建群弹窗与「添加智能体」要回答同几个问题：勾上的那几只按什么顺序、满了哪几只锁住、群名留空时发出去的是什么、还能加谁、加 / 移之后发出去的完整名单是什么。这些都是纯判断，写进 shared（进 vitest），两端各自 import。

**Files:**
- Create: `src/shared/groupEdit.ts`
- Test: `tests/shared/groupEdit.test.ts`

**Interfaces:**
- Consumes: `CHAT_GROUP_CREATE_MIN` / `CHAT_GROUP_MAX` / `CHAT_NAME_MAX`（`src/shared/chatRoster.ts`）；`WorkspaceAgentRow` / `WorkspaceSnapshot`（`src/shared/workspaces.ts`）。
- Produces（`src/shared/groupEdit.ts`）：
  - `rosterOrder(ws: WorkspaceSnapshot, ids: readonly string[]): string[]`
  - `interface GroupPick { ids: string[]; full: boolean; enough: boolean }`
  - `groupPick(ws: WorkspaceSnapshot, picked: readonly string[]): GroupPick`
  - `pickLocked(pick: GroupPick, agentId: string): boolean`
  - `togglePick(ws: WorkspaceSnapshot, picked: readonly string[], agentId: string): string[]`
  - `clampChatName(name: string): string`
  - `groupNameFor(ws: WorkspaceSnapshot, ids: readonly string[], typed: string): string`
  - `interface AddChoice { candidates: WorkspaceAgentRow[]; room: number; reason: string | null }`
  - `addChoice(ws: WorkspaceSnapshot, current: readonly string[]): AddChoice`
  - `withAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[]`
  - `withoutAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[]`

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/groupEdit.test.ts`：

```ts
// groupEdit —— 建群的勾选与群名、群设置里加 / 移之后的名单（#1356 A3，spec §5.6）。
// 手机建群页 / 群设置与桌面 NewGroupDialog / AddAgentPopover 共用这一份。

import { describe, expect, it } from "vitest";
import { CHAT_NAME_MAX } from "../../src/shared/chatRoster.js";
import {
  addChoice, clampChatName, groupNameFor, groupPick, pickLocked, rosterOrder, togglePick, withAgent, withoutAgent,
} from "../../src/shared/groupEdit.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const ws = (agents: WorkspaceAgentRow[]): WorkspaceSnapshot => ({
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [], connectors: [], sessions: [], agents,
});
const A1 = "a_000000000001";
const A2 = "a_000000000002";
const A3 = "a_000000000003";
const A4 = "a_000000000004";
const A5 = "a_000000000005";
const A6 = "a_000000000006";
const GONE = "a_999999999999";
const WS = ws([
  agent("admin", "管理员"), agent(A1, "开发"), agent(A2, "运维"), agent(A3, "设计"),
  agent(A4, "客服"), agent(A5, "财务"), agent(A6, "法务"),
]);

describe("rosterOrder", () => {
  it("顺序跟名册走、去重、名册里没有的丢掉", () => {
    expect(rosterOrder(WS, [A3, "admin", A3, GONE, A1])).toEqual(["admin", A1, A3]);
  });
});

describe("groupPick / pickLocked / togglePick", () => {
  it("不到两只「建」按不动；两只起按得动，名单按名册顺序", () => {
    expect(groupPick(WS, [A1]).enough).toBe(false);
    expect(groupPick(WS, [A2, A1])).toEqual({ ids: [A1, A2], full: false, enough: true });
  });
  it("满六只：没勾的那几只锁住，勾上的照样点得动（取消勾选永远开着）", () => {
    const six = ["admin", A1, A2, A3, A4, A5];
    const pick = groupPick(WS, six);
    expect(pick.full).toBe(true);
    expect(pickLocked(pick, A6)).toBe(true);
    expect(pickLocked(pick, A5)).toBe(false);
    expect(togglePick(WS, six, A6)).toEqual(six);
    expect(togglePick(WS, six, A5)).toEqual(["admin", A1, A2, A3, A4]);
  });
  it("没满时谁都点得动；勾上的按名册顺序排，不按点的先后", () => {
    expect(pickLocked(groupPick(WS, [A1]), A6)).toBe(false);
    expect(togglePick(WS, [A3], A1)).toEqual([A1, A3]);
    expect(togglePick(WS, [A1, A3], A1)).toEqual([A3]);
  });
});

describe("clampChatName", () => {
  it("上限以内原样", () => {
    const s = "字".repeat(CHAT_NAME_MAX);
    expect(clampChatName(s)).toBe(s);
  });
  it("超了：截到上限以内、末尾一个省略号", () => {
    const out = clampChatName("字".repeat(CHAT_NAME_MAX + 5));
    expect(out.length).toBe(CHAT_NAME_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
  it("按码点截：emoji（两个码元）不会被劈成半个代理对", () => {
    const smile = "\u{1F600}";
    expect(clampChatName("a".repeat(CHAT_NAME_MAX - 2) + smile + smile)).toBe(`${"a".repeat(CHAT_NAME_MAX - 2)}…`);
  });
});

describe("groupNameFor", () => {
  it("填了用填的（去掉首尾空白）", () => {
    expect(groupNameFor(WS, [A1, A2], "  发版组  ")).toBe("发版组");
  });
  it("没填用成员名按名册顺序拼（不按勾选顺序）", () => {
    expect(groupNameFor(WS, [A2, A1], "   ")).toBe("开发、运维");
  });
  it("拼出来超过协议上限：截到上限以内（超长的 create 帧会被整帧拒掉、白等 15 秒）", () => {
    const long = ws([
      agent(A1, "负责对账的财务专员一号"), agent(A2, "负责对账的财务专员二号"), agent(A3, "负责对账的财务专员三号"),
      agent(A4, "负责对账的财务专员四号"), agent(A5, "负责对账的财务专员五号"), agent(A6, "负责对账的财务专员六号"),
    ]);
    const out = groupNameFor(long, [A1, A2, A3, A4, A5, A6], "");
    expect(out.length).toBeLessThanOrEqual(CHAT_NAME_MAX);
    expect(out.startsWith("负责对账的财务专员一号、负责对账的财务专员二号")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("addChoice", () => {
  it("只列不在群里的（名册顺序）；还能加几只", () => {
    const c = addChoice(WS, [A2, "admin"]);
    expect(c.candidates.map((a) => a.agentId)).toEqual([A1, A3, A4, A5, A6]);
    expect(c.room).toBe(4);
    expect(c.reason).toBeNull();
  });
  it("满六只：说「群里已经有六只了」", () => {
    const c = addChoice(WS, ["admin", A1, A2, A3, A4, A5]);
    expect(c.room).toBe(0);
    expect(c.reason).toBe("群里已经有六只了");
  });
  it("名册里的都在群里了：说这一句（不是「满了」）", () => {
    const small = ws([agent("admin", "管理员"), agent(A1, "开发")]);
    expect(addChoice(small, ["admin", A1]).reason).toBe("名册里的智能体都在群里了");
  });
  it("名单里有已经被删的 id：不占名额（发出去的名单里也不会有它）", () => {
    expect(addChoice(WS, ["admin", GONE]).room).toBe(5);
  });
});

describe("withAgent / withoutAgent", () => {
  it("加一只 = 变动之后的完整名单、名册顺序（chat_update 收名单，不收「加了谁」）", () => {
    expect(withAgent(WS, [A3, "admin"], A1)).toEqual(["admin", A1, A3]);
  });
  it("移出一只；可以移到空（空群合法）", () => {
    expect(withoutAgent(WS, [A1, A3], A1)).toEqual([A3]);
    expect(withoutAgent(WS, [A3], A3)).toEqual([]);
  });
  it("顺手把已经被删的 id 清掉", () => {
    expect(withoutAgent(WS, [A1, GONE, A3], A1)).toEqual([A3]);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/groupEdit.test.ts`
Expected: FAIL（`Failed to resolve import "../../src/shared/groupEdit.js"`）。

- [ ] **Step 3: 写实现**

Create `src/shared/groupEdit.ts`：

```ts
// groupEdit —— 建群的勾选与群名、群设置里加 / 移之后的名单（#1356 A3，spec §5.6）。
// 手机的建群页 / 群设置与桌面的 NewGroupDialog / AddAgentPopover 共用这一份——两端各写一遍的话，
// 同一份名单会在两台设备上拼出两个群名。三条判据：
// ① **名单一律按名册顺序**（同 narrowRoster）：勾选的先后不该决定「名单第一只」是谁，也不该改变
//    拼出来的群名；
// ② **上下限当场按不动**（#722）：满 CHAT_GROUP_MAX 时没勾的那几只锁住、勾上的照样点得动（全锁死的
//    话满员之后名单就再也改不了）；不到 CHAT_GROUP_CREATE_MIN「建」按不动；
// ③ **群名留空用成员名拼，并截到协议上限以内**：cs 协议的群名要 1–CHAT_NAME_MAX 字（cloudSession.ts 的
//    normalizeChatName），拼出来超长的话 create 帧整帧被拒、没有回执——客户端白等满 15 秒，然后把
//    「这个名字太长」说成「云端无响应」。六只各起十来个字的名字就到了。

import { CHAT_GROUP_CREATE_MIN, CHAT_GROUP_MAX, CHAT_NAME_MAX } from "./chatRoster.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "./workspaces.js";

/** `ids` 里（去重）且名册里还在的那几只，顺序跟名册走 */
export function rosterOrder(ws: WorkspaceSnapshot, ids: readonly string[]): string[] {
  const want = new Set(ids);
  return ws.agents.map((a) => a.agentId).filter((id) => want.has(id));
}

export interface GroupPick {
  /** 勾上的那几只：名册顺序、只含名册里还在的 */
  ids: string[];
  /** 满 CHAT_GROUP_MAX 了：没勾的那几只锁住 */
  full: boolean;
  /** 够 CHAT_GROUP_CREATE_MIN 了：「建」按得动 */
  enough: boolean;
}

export function groupPick(ws: WorkspaceSnapshot, picked: readonly string[]): GroupPick {
  const ids = rosterOrder(ws, picked);
  return { ids, full: ids.length >= CHAT_GROUP_MAX, enough: ids.length >= CHAT_GROUP_CREATE_MIN };
}

/** 这一只此刻点不动吗：满员时只有已经勾上的点得动——取消勾选永远开着 */
export function pickLocked(pick: GroupPick, agentId: string): boolean {
  return pick.full && !pick.ids.includes(agentId);
}

/** 点一下：勾上 / 取消。锁住的那只点了不变 */
export function togglePick(ws: WorkspaceSnapshot, picked: readonly string[], agentId: string): string[] {
  const pick = groupPick(ws, picked);
  if (pick.ids.includes(agentId)) return pick.ids.filter((id) => id !== agentId);
  if (pickLocked(pick, agentId)) return pick.ids;
  return rosterOrder(ws, [...pick.ids, agentId]);
}

/** 截断时末尾那一个字（占一个码元，所以截完整串仍 ≤ CHAT_NAME_MAX） */
const ELLIPSIS = "…";

/** 群名截到协议上限以内。**按码点截**：一个 emoji 是两个码元，按码元截会把它劈成半个代理对 */
export function clampChatName(name: string): string {
  if (name.length <= CHAT_NAME_MAX) return name;
  let out = "";
  for (const ch of name) {
    if (out.length + ch.length > CHAT_NAME_MAX - ELLIPSIS.length) break;
    out += ch;
  }
  return out + ELLIPSIS;
}

/** 建群时发出去的群名：填了用填的（去掉首尾空白）；没填用成员名按名册顺序拼（`、`，与 `groupRows` 那份
    兜底同一个拼法）。两种都截到 CHAT_NAME_MAX 以内（见头注第 ③ 条）。没有成员时回空串——调用方本来就
    按不动「建」 */
export function groupNameFor(ws: WorkspaceSnapshot, ids: readonly string[], typed: string): string {
  const t = typed.trim();
  if (t !== "") return clampChatName(t);
  const nameOf = new Map(ws.agents.map((a) => [a.agentId, a.name]));
  return clampChatName(rosterOrder(ws, ids).map((id) => nameOf.get(id) ?? id).join("、"));
}

export interface AddChoice {
  /** 名册里还不在群里的那几只（名册顺序） */
  candidates: WorkspaceAgentRow[];
  /** 还能加几只（CHAT_GROUP_MAX − 此刻的人数，不小于 0） */
  room: number;
  /** 这一刻加不了的原因；null = 加得了。满员是「这个群装不下了」，没人可加是「你只有这几只」——两句话不一样 */
  reason: string | null;
}

export function addChoice(ws: WorkspaceSnapshot, current: readonly string[]): AddChoice {
  const inGroup = rosterOrder(ws, current);
  const candidates = ws.agents.filter((a) => !inGroup.includes(a.agentId));
  const room = Math.max(0, CHAT_GROUP_MAX - inGroup.length);
  const reason = room === 0 ? "群里已经有六只了" : candidates.length === 0 ? "名册里的智能体都在群里了" : null;
  return { candidates, room, reason };
}

/** 加一只之后的**完整**名单：chat_update 要的是名单不是「加了谁」（只发新来的那只等于把原来的人全踢了） */
export function withAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[] {
  return rosterOrder(ws, [...current, agentId]);
}

/** 移出一只之后的完整名单。可以移到空（空群合法：0037 给 group 那条 CHECK 写的是 0..6） */
export function withoutAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[] {
  return rosterOrder(ws, current.filter((id) => id !== agentId));
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/groupEdit.test.ts`
Expected: PASS（17 条）。

- [ ] **Step 5: Commit**

message 写进 `.superpowers/commit-msg.txt`：

```
feat(shared): 建群的勾选与群名、加 / 移之后的名单（#1356 A3）

手机建群页 / 群设置与桌面建群弹窗 /「添加智能体」要回答同几个问题——勾上的按什么顺序、
满了哪几只锁住、群名留空时发出去的是什么、还能加谁、加移之后的完整名单——两端各写一遍，
同一份名单就会在两台设备上拼出两个群名。写进 shared 一份：名单一律按名册顺序；满 6 只时
没勾的锁住、勾上的照样点得动；群名留空用成员名拼，并按码点截到 60 字以内（协议的群名
要 1–60 字，拼出来超长的 create 帧会被整帧拒掉、客户端白等 15 秒再说「云端无响应」）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add src/shared/groupEdit.ts tests/shared/groupEdit.test.ts && git commit -F .superpowers/commit-msg.txt
```

---

### Task 2: 桌面建群弹窗与「添加智能体」改调同一份判据

桌面那两个组件各自写着 Task 1 那几条判断。改成调 `groupEdit`：判据只剩一份；**唯一的行为变化**是群名留空时拼出来的名字截到 60 字以内（原来那份没截，六只长名字的群建不出来、还要白等 15 秒）。

**Files:**
- Modify: `src/renderer/src/components/NewGroupDialog.tsx`
- Modify: `src/renderer/src/components/AddAgentPopover.tsx`
- Test: `tests/renderer/NewGroupDialog.test.tsx`（加一条）

**Interfaces:**
- Consumes: Task 1 的 `groupNameFor` / `groupPick` / `pickLocked` / `togglePick` / `addChoice` / `rosterOrder`。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

在 `tests/renderer/NewGroupDialog.test.tsx` 里「起了名字就用那个名字」那条 `it(...)` 之后加一条：

```tsx
  it("群名留空、成员名拼起来超过 60 字：截到 60 字以内（超长的 create 帧会被整帧拒掉、白等 15 秒）", async () => {
    const createGroupChat = vi.fn(async (_name: string, _ids: string[]) => ({ ok: true as const }));
    const long = {
      ...HOME,
      agents: [
        agent("a_000000000001", "负责对账的财务专员一号", ""), agent("a_000000000002", "负责对账的财务专员二号", ""),
        agent("a_000000000003", "负责对账的财务专员三号", ""), agent("a_000000000004", "负责对账的财务专员四号", ""),
        agent("a_000000000005", "负责对账的财务专员五号", ""), agent("a_000000000006", "负责对账的财务专员六号", ""),
      ],
    } as unknown as WorkspaceSnapshot;
    seed({
      workspaceGroups: [long],
      createGroupChat,
      newGroupPreset: ["a_000000000001", "a_000000000002", "a_000000000003", "a_000000000004", "a_000000000005", "a_000000000006"],
    });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "建群" }));
    const name = createGroupChat.mock.calls[0]![0];
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("…")).toBe(true);
  });
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/renderer/NewGroupDialog.test.tsx`
Expected: FAIL（新那条：`expected 71 to be less than or equal to 60`；其余照旧通过）。

- [ ] **Step 3: 改 `NewGroupDialog.tsx`**

1. 头注第 ③ 条：

```
// ③ **群名留空用成员名顶上**：侧栏那一行不能是一格空白（同 sessionTitle.ts 的兜底），
//    而拼名字**按名册顺序不按勾选顺序**——同一份名单在两台设备上不该拼出两个名字。
```

换成：

```
// ③ **群名留空用成员名顶上**：侧栏那一行不能是一格空白（同 sessionTitle.ts 的兜底），
//    而拼名字**按名册顺序不按勾选顺序**——同一份名单在两台设备上不该拼出两个名字；拼出来
//    超过 60 字就截断（协议的群名要 1–60 字，超长的 create 帧整帧被拒、白等 15 秒）。
//    三条判据都在 shared/groupEdit.ts，与手机建群页同一份（#1356 A3）。
```

2. import 那一行：

```ts
import { CHAT_GROUP_CREATE_MIN, CHAT_GROUP_MAX, CHAT_NAME_MAX } from "../../../shared/chatRoster.js";
```

换成：

```ts
import { CHAT_GROUP_CREATE_MIN, CHAT_NAME_MAX } from "../../../shared/chatRoster.js";
import { groupNameFor, groupPick, pickLocked, togglePick } from "../../../shared/groupEdit.js";
```

3. `NewGroupForm` 里这一段：

```ts
  // 名单**按名册顺序**算，不按勾选顺序：同一份名单在两台设备上要拼出同一个名字，
  // 也要让服务端那侧的「名单第一只」是同一只（narrowRoster 的规矩）
  const ids = home.agents.map((a) => a.agentId).filter((id) => picked.includes(id));
  const full = ids.length >= CHAT_GROUP_MAX;
  const enough = ids.length >= CHAT_GROUP_CREATE_MIN;
  const trimmed = name.trim();
```

换成：

```ts
  // 名单**按名册顺序**算，不按勾选顺序：同一份名单在两台设备上要拼出同一个名字，
  // 也要让服务端那侧的「名单第一只」是同一只（narrowRoster 的规矩）
  const pick = groupPick(home, picked);
  const { ids, full, enough } = pick;
```

4. `submit` 里这两行：

```ts
    // 留空用成员名顶上（同 groupRows 的兜底，两处拼法一致）
    const r = await createGroupChat(trimmed !== "" ? trimmed : nameOf(home, ids), ids);
```

换成：

```ts
    // 留空用成员名顶上（同 groupRows 的兜底，两处拼法一致；超长截断，见头注 ③）
    const r = await createGroupChat(groupNameFor(home, ids, name), ids);
```

5. 列表里那一行的锁与勾：

```tsx
          // 满员之后只有「取消勾选」还开着：全锁死的话名单就再也改不了
          const locked = busy || (full && !on);
```

换成：

```tsx
          // 满员之后只有「取消勾选」还开着：全锁死的话名单就再也改不了
          const locked = busy || pickLocked(pick, a.agentId);
```

以及

```tsx
                onChange={() => setPicked((p) => (on ? p.filter((x) => x !== a.agentId) : [...p, a.agentId]))}
```

换成：

```tsx
                onChange={() => setPicked((p) => togglePick(home, p, a.agentId))}
```

6. 删掉文件末尾整段（它的活由 `groupNameFor` 接了）：

```tsx
/** 没起名字时的群名：成员名顿号拼起来（与 `groupRows` 那份兜底同一个拼法）。
    两处各写一遍的话，起过名的群和没起过名的群会在侧栏和头部拼出两个样子 */
function nameOf(home: WorkspaceSnapshot, ids: readonly string[]): string {
  return ids.map((id) => home.agents.find((a) => a.agentId === id)?.name ?? id).join("、");
}
```

（`WorkspaceSnapshot` 仍被 `NewGroupForm` 的 props 用着，import 留着。）

- [ ] **Step 4: 改 `AddAgentPopover.tsx`**

1. import：

```ts
import { CHAT_GROUP_MAX } from "../../../shared/chatRoster.js";
```

换成：

```ts
import { addChoice, rosterOrder } from "../../../shared/groupEdit.js";
```

2. 这一段：

```ts
  const candidates = ws.agents.filter((a) => !current.includes(a.agentId));
  const room = CHAT_GROUP_MAX - current.length;
  // 满员、或者名册里一只都不剩——两种情形下这颗钮都没有事可做，但话不一样：
  // 满员是「这个群装不下了」，没人可加是「你只有这几只」
  const reason = room <= 0 ? "群里已经有六只了" : candidates.length === 0 ? "名册里的智能体都在群里了" : null;
```

换成：

```ts
  // 满员、或者名册里一只都不剩——两种情形下这颗钮都没有事可做，但话不一样：
  // 满员是「这个群装不下了」，没人可加是「你只有这几只」（判据在 shared/groupEdit.ts，与手机群设置同一份）
  const { candidates, room, reason } = addChoice(ws, current);
```

3. `confirm` 里：

```ts
    const next = ws.agents.map((a) => a.agentId).filter((id) => current.includes(id) || picked.includes(id));
```

换成：

```ts
    const next = rosterOrder(ws, [...current, ...picked]);
```

- [ ] **Step 5: 跑两个文件的测试，确认全绿**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/renderer/NewGroupDialog.test.tsx tests/renderer/AddAgentPopover.test.tsx tests/renderer/GroupSettingsDrawer.test.tsx`
Expected: PASS（NewGroupDialog 多一条；另两个文件一条都没改、全绿）。

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 没有输出。

- [ ] **Step 6: Commit**

message：

```
fix(renderer): 建群弹窗群名留空时拼出来的名字截到 60 字以内，两处判据改调 shared（#1356 A3）

桌面建群弹窗在群名留空时把成员名顿号拼起来直接发出去，而协议的群名要 1–60 字：六只各起
十来个字的名字就超了，create 帧被整帧拒掉、没有回执，弹窗白等满 15 秒再说「云端无响应」。
改调 shared/groupEdit.ts 的 groupNameFor（按码点截、末尾一个省略号），这是唯一的行为变化。
「添加智能体」那颗的候选 / 名额 / 原因与完整名单也改调同一份——手机群设置要回答同一件事，
判据只该有一份。既有用例一条没改。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add src/renderer/src/components/NewGroupDialog.tsx src/renderer/src/components/AddAgentPopover.tsx tests/renderer/NewGroupDialog.test.tsx && git commit -F .superpowers/commit-msg.txt
```

---

### Task 3: 时间线的两种新行——名单变了那一行、派活那一句

spec §5.6：群聊时间线上「名单变更那一行居中带脸（`chatRosterLineParts`）、派活那一句（我没 @ 谁、runtime 挑了谁：『没 @ 谁 —— 运维接了』，从 `user_message.dispatch` 投影，手机端先画）」。A1 的 `mobileChat.rowOf` 对 `chat_roster_changed` 回 null（注释写着「群的名单行在 A3」），派活那一句还没有文案函数。

名单那一行画不画要看**前一条**名单事件（建聊天那一条与「名单没变」都不画），所以判据不进逐事件的 `rowOf`，住在 `chatRows` 的循环里（同桌面 CloudSessionPage 的 `rosterLines` 那张表）。**`ChatRow` 联合多一种之后手机的 `ChatRowView` 必须同一个任务里接上**，不然那一行安静地什么都不画（那个 switch 没有 default）。

**Files:**
- Modify: `src/shared/cloudTimeline.ts`（新增 `dispatchLineText`）
- Modify: `src/shared/mobileChat.ts`
- Modify: `mobile/src/chat/ChatRows.tsx`
- Test: `tests/shared/cloudTimeline.test.ts`、`tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes: `chatRosterLineParts` / `RosterLinePart`（`src/shared/cloudTimeline.ts`，已有）；`ChatRosterChangedEvent` / `UserMessageEvent`（`src/session/events.ts`）；`agentNameOf`；`agentFaceIfKnown`（`src/shared/agentAvatar.ts`）。
- Produces:
  - `dispatchLineText(e: UserMessageEvent, ws: WorkspaceSnapshot): string | null`（`src/shared/cloudTimeline.ts`）
  - `ChatRow` 多一种 `{ kind: "roster"; key: string; ts: number; parts: RosterLinePart[] }`（`src/shared/mobileChat.ts`）；派活那一句是一条 `note`，key `dispatch-<seq>`，排在那句话那一行后面

- [ ] **Step 1: 写失败的测试（`dispatchLineText`）**

`tests/shared/cloudTimeline.test.ts` 顶上三行 import 换成：

```ts
import { describe, it, expect } from "vitest";
import { chatRosterLineParts, dispatchLineText, hiddenFromCloudTimeline, type RosterLinePart } from "../../src/shared/cloudTimeline.js";
import type { ChatRosterChangedEvent, SessionEvent, UserMessageEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
```

文件末尾追加：

```ts
// 派活那一句（#1356 A3，spec §5.6）：人没 @ 谁、runtime 按职责挑了谁接（ADR-0270），从 user_message.dispatch 投影
describe("dispatchLineText（#1356 A3）", () => {
  const agent = (agentId: string, name: string) => ({
    agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
  });
  const WS = {
    id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
    members: [], connectors: [], sessions: [],
    agents: [agent("admin", "管理员"), agent("a_000000000002", "运维"), agent("a_000000000003", "设计")],
  } as unknown as WorkspaceSnapshot;
  const um = (o: Record<string, unknown>) =>
    ({ seq: 1, sessionId: "s", ts: 0, type: "user_message", content: "[Stan]: 这版谁先发", fromUid: "me", ...o }) as UserMessageEvent;

  it("派出去了：「没 @ 谁 —— 运维接了」；几只一起接就顿号连起来", () => {
    expect(dispatchLineText(um({ mentions: ["a_000000000002"], dispatch: "auto" }), WS)).toBe("没 @ 谁 —— 运维接了");
    expect(dispatchLineText(um({ mentions: ["a_000000000002", "a_000000000003"], dispatch: "auto" }), WS))
      .toBe("没 @ 谁 —— 运维、设计接了");
  });
  it("人亲手 @ 的 / 没派出去（名单空）/ 旧日志没有这一格：不画", () => {
    expect(dispatchLineText(um({ mentions: ["a_000000000002"] }), WS)).toBeNull();
    expect(dispatchLineText(um({ mentions: [], dispatch: "auto" }), WS)).toBeNull();
    expect(dispatchLineText(um({}), WS)).toBeNull();
  });
  it("那只已经被删了：回 id（旧的一行上还得有个把手，同接力线）", () => {
    expect(dispatchLineText(um({ mentions: ["a_999999999999"], dispatch: "auto" }), WS)).toBe("没 @ 谁 —— a_999999999999接了");
  });
});
```

- [ ] **Step 2: 写失败的测试（`chatRows` 的两种新行）**

`tests/shared/mobileChat.test.ts` 末尾追加：

```ts
describe("群聊的两种行（#1356 A3，spec §5.6）", () => {
  const roster = (ids: [string, string][], byUid?: string): SessionEvent =>
    e({
      type: "chat_roster_changed", ignorable: true,
      agents: ids.map(([agentId, name]) => ({ agentId, name })),
      ...(byUid === undefined ? {} : { byUid }),
    });

  it("名单变了那一行：建群那一条不画，之后谁进谁出画成一行（名字那几格带 agentId，好画脸）", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        roster([["a_000000000001", "开发"], ["a_000000000002", "运维"]]),
        roster([["a_000000000001", "开发"]], "me"),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "roster"]);
    expect(rows[1]).toEqual({
      kind: "roster", key: "e1", ts: DAY,
      parts: [{ text: "你把" }, { text: "「运维」", agentId: "a_000000000002" }, { text: "移出了群聊" }],
    });
  });

  it("名单没变的那一条不画", () => {
    seq = 0;
    const rows = chatRows({
      events: [roster([["a_000000000001", "开发"]]), roster([["a_000000000001", "开发"]], "me")],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows).toEqual([]);
  });

  it("派活那一句排在那句话底下；人亲手 @ 的不画", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 这版谁先发", fromUid: "me", mentions: ["a_000000000002"], dispatch: "auto" }),
        e({ type: "user_message", content: "[Stan]: @开发 看下", fromUid: "me", mentions: ["a_000000000001"] }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.slice(1)).toEqual([
      { kind: "mine", key: "e0", ts: DAY, text: "这版谁先发" },
      { kind: "note", key: "dispatch-0", ts: DAY, text: "没 @ 谁 —— 运维接了", tone: "muted", detail: null },
      { kind: "mine", key: "e1", ts: DAY, text: "@开发 看下" },
    ]);
  });
});
```

- [ ] **Step 3: 跑测试，确认它们失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/cloudTimeline.test.ts tests/shared/mobileChat.test.ts`
Expected: FAIL（`dispatchLineText is not a function` / 名单那一行与派活那一句都没画出来）。

- [ ] **Step 4: 写 `dispatchLineText`**

`src/shared/cloudTimeline.ts` 里 `relayLineText` 那个函数之后（`/** 这条事件在云会话时间线上要不要**藏起来**` 那段注释之前）加：

```ts
/** 派活那一句（#1356 A3，spec §5.6）：人没 @ 谁、runtime 按职责挑了谁接（ADR-0270）——
    「没 @ 谁 —— 运维接了」，排在那句话底下。从 `user_message.dispatch` 投影；只在真的派出去了
    （`mentions` 非空）时说。名字现查（被删的那只回 id，同 relayLineText 的纪律：旧的一行上还得有个
    把手）。手机端先画，桌面那侧还没接 */
export function dispatchLineText(e: UserMessageEvent, ws: WorkspaceSnapshot): string | null {
  if (e.dispatch !== "auto" || e.mentions === undefined || e.mentions.length === 0) return null;
  return `没 @ 谁 —— ${e.mentions.map((id) => agentNameOf(ws, id)).join("、")}接了`;
}
```

（`UserMessageEvent`、`agentNameOf`、`WorkspaceSnapshot` 这个文件已经 import 了。）

- [ ] **Step 5: 改 `mobileChat.ts`**

1. 两处 import：

```ts
import {
  assistantLabel, cloudEmptyState, hiddenFromCloudTimeline, relayLineText, stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity,
} from "./cloudTimeline.js";
```

换成：

```ts
import {
  assistantLabel, chatRosterLineParts, cloudEmptyState, dispatchLineText, hiddenFromCloudTimeline, relayLineText, stopButtonRows,
  systemNoteText, turnEndedLineText, userRowIdentity, type RosterLinePart,
} from "./cloudTimeline.js";
```

以及

```ts
import type { SessionEvent } from "../session/events.js";
```

换成：

```ts
import type { ChatRosterChangedEvent, SessionEvent } from "../session/events.js";
```

2. `ChatRow` 联合的最后一种：

```ts
  /** 旁白（系统说的一句、engine 注的后台任务 / 护栏、接力线）与出错 */
  | { kind: "note"; key: string; ts: number; text: string; tone: "muted" | "error"; detail: string | null };
```

换成：

```ts
  /** 旁白（系统说的一句、engine 注的后台任务 / 护栏、接力线、派活那一句）与出错 */
  | { kind: "note"; key: string; ts: number; text: string; tone: "muted" | "error"; detail: string | null }
  /** 群的名单变了那一行（A3）：居中，名字那几格带 agentId（左边画脸）；几格拼起来就是那句话本身 */
  | { kind: "roster"; key: string; ts: number; parts: RosterLinePart[] };
```

3. `rowOf` 最后的 `default` 分支：

```ts
    default:
      // 名单变更那一行（chat_roster_changed，要看前一条）、通话卡（A4）、压缩与其余内务：
      // 手机端这一片不画——压缩是上下文系统自己的事（聊天里那条线不断），群的名单行在 A3
      return null;
```

换成：

```ts
    default:
      // 名单变更那一行（chat_roster_changed）要看前一条，在 chatRows 的循环里判，不在这里；
      // 通话卡（A4）、压缩与其余内务：手机端不画——压缩是上下文系统自己的事（聊天里那条线不断）
      return null;
```

4. `rowOf` 之后、`chatRows` 之前加：

```ts
/** 一条事件画成几行：通常一行；人说的那句被 runtime 派了活（没 @ 谁、它按职责挑了谁接）时，
    那句话底下再跟一行「没 @ 谁 —— 运维接了」（spec §5.6） */
function rowsOf(e: SessionEvent, ws: WorkspaceSnapshot, selfUid: string): ItemRow[] {
  const row = rowOf(e, ws, selfUid);
  if (row === null) return [];
  const dispatched = e.type === "user_message" && (row.kind === "mine" || row.kind === "human") ? dispatchLineText(e, ws) : null;
  if (dispatched === null) return [row];
  return [row, { kind: "note", key: `dispatch-${e.seq}`, ts: e.ts, text: dispatched, tone: "muted", detail: null }];
}
```

5. `chatRows` 整个函数（连同它上面那行注释）：

```ts
/** 时间线：日志顺序 + 每个自然日前一条分隔条（`now` 由调用方递，纯函数才测得动） */
export function chatRows(o: { events: readonly SessionEvent[]; ws: WorkspaceSnapshot; selfUid: string; now: number }): ChatRow[] {
  const items: ItemRow[] = [];
  for (const e of o.events) {
    const r = rowOf(e, o.ws, o.selfUid);
    if (r !== null) items.push(r);
  }
  return withDaySeparators(items, o.now).map((d): ChatRow =>
    d.kind === "day" ? { kind: "day", key: d.key, label: d.label } : d.item,
  );
}
```

换成：

```ts
/** 时间线：日志顺序 + 每个自然日前一条分隔条（`now` 由调用方递，纯函数才测得动）。
    名单变了那一行（A3）要看**前一条**名单事件——建聊天那一条与「名单没变」都不画——判据跨事件，
    所以在这个循环里判、不进逐事件的 rowOf（同桌面 CloudSessionPage 的 rosterLines）。
    窗口里最早那条名单事件（尾巴模式，往前还有没拉下来的）没有前一条可比，当建聊天那一条不画
    （说不清就不画）；往前翻一页之后它自己会出现 */
export function chatRows(o: { events: readonly SessionEvent[]; ws: WorkspaceSnapshot; selfUid: string; now: number }): ChatRow[] {
  const items: ItemRow[] = [];
  let prevRoster: ChatRosterChangedEvent | null = null;
  for (const e of o.events) {
    if (e.type === "chat_roster_changed") {
      const parts = chatRosterLineParts(prevRoster, e, o.selfUid);
      prevRoster = e;
      if (parts !== null) items.push({ kind: "roster", key: `e${e.seq}`, ts: e.ts, parts });
      continue;
    }
    items.push(...rowsOf(e, o.ws, o.selfUid));
  }
  return withDaySeparators(items, o.now).map((d): ChatRow =>
    d.kind === "day" ? { kind: "day", key: d.key, label: d.label } : d.item,
  );
}
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/cloudTimeline.test.ts tests/shared/mobileChat.test.ts`
Expected: PASS（新增 6 条，既有的全绿）。

- [ ] **Step 7: 手机端画名单那一行**

`mobile/src/chat/ChatRows.tsx`：

1. 头注末尾（`// 宣称它还在名册里。` 那一行之后）加一行：

```
// A3：群的名单变了那一行（`roster`）居中、名字左边一张 s 档的脸；派活那一句是一条普通的旁白。
```

2. import：

```ts
import { NOW_PHASE_TEXT, clockLabel, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
```

之后加一行：

```ts
import type { RosterLinePart } from "../../../src/shared/cloudTimeline.js";
```

3. `ChatRowView` 的 switch 里 `case "note":` 那一行：

```tsx
    case "note":
      return <NoteRow text={row.text} tone={row.tone} detail={row.detail} />;
```

之后加：

```tsx
    case "roster":
      return <RosterLineView parts={row.parts} ws={ws} />;
```

4. `/** 旁白 / 出错。带全文` 那个 `NoteRow` 函数之前加：

```tsx
/** 群的名单变了那一行（A3，spec §5.6）：居中；每个名字左边一张 s 档的脸——**名册里查不到的不给脸**
    （派生对陌生 id 也算得出一张脸，画上去等于宣称它还在名册里，而被移出的那只常常正是刚被删掉的那只）。
    脸与名字包在同一格里不断开，名字多了整行折行；读屏把整句念一遍（几格拼起来就是那句话本身） */
function RosterLineView({ parts, ws }: { parts: readonly RosterLinePart[]; ws: WorkspaceSnapshot }) {
  const { c } = usePalette();
  return (
    <View
      accessible
      accessibilityLabel={parts.map((p) => p.text).join("")}
      style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", paddingHorizontal: 28, rowGap: 4 }}
    >
      {parts.map((p, i) => {
        const face = p.agentId === undefined ? null : agentFaceIfKnown(ws, p.agentId);
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            {face !== null ? <Face slot={face.slot} tier="s" /> : null}
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{p.text}</Text>
          </View>
        );
      })}
    </View>
  );
}
```

- [ ] **Step 8: 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p mobile/tsconfig.json 2>&1 | head -20 && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 两条都没有输出。

- [ ] **Step 9: Commit**

message：

```
feat(mobile): 群聊时间线的名单那一行与派活那一句（#1356 A3）

spec §5.6：名单变了那一行居中带脸（chatRosterLineParts），我没 @ 谁时 runtime 挑了谁接的那一句
（「没 @ 谁 —— 运维接了」，从 user_message.dispatch 投影，新写的 dispatchLineText，手机先画）。
名单那一行画不画要看前一条名单事件，判据跨事件，所以住在 chatRows 的循环里、不进逐事件的
rowOf（同桌面 rosterLines）；窗口里最早那条没有前一条可比，当建群那一条不画。ChatRow 多一种
之后 ChatRowView 同一个提交里接上——那个 switch 没有 default，漏了就是安静地什么都不画。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add src/shared/cloudTimeline.ts src/shared/mobileChat.ts mobile/src/chat/ChatRows.tsx tests/shared/cloudTimeline.test.ts tests/shared/mobileChat.test.ts && git commit -F .superpowers/commit-msg.txt
```

---

### Task 4: 手机的几样零件——实底红确认钮（#1362）、行尾小胶囊、点缀色的行、锁得住的输入框、勾、导航条字钮、「一只智能体占一行」

后面三个任务都要的零件，一次备齐，并让 A1 的智能体设置先用上两样（「存」改用共用的字钮、「删掉」确认钮改成实底红——#1362）。

**Files:**
- Modify: `mobile/src/ui.tsx`
- Modify: `mobile/src/dialog.tsx`
- Modify: `mobile/src/chrome/Glyphs.tsx`
- Create: `mobile/src/chrome/HeaderTextButton.tsx`
- Create: `mobile/src/group/AgentPickRow.tsx`
- Modify: `mobile/src/agent/AgentSettingsScreen.tsx`

**Interfaces:**
- Produces:
  - `Button` 的 `variant` 多一个 `"danger"`（实底红），`size` 多一个 `"sm"`（30 高的小胶囊）
  - `Row` 的 `tone` 多一个 `"accent"`（字是点缀色）
  - `Field` 多一个 `editable?: boolean`
  - `DialogFooter` 的 `right` 可带 `tone?: "destructive"`（画成实底红）
  - `CheckGlyph({ color, size? })`（`mobile/src/chrome/Glyphs.tsx`）
  - `HeaderTextButton({ label, disabled, onPress })`（`mobile/src/chrome/HeaderTextButton.tsx`）
  - `AgentPickRow({ ws, agentId, trailing?, onPress?, disabled?, checked? })`（`mobile/src/group/AgentPickRow.tsx`）

- [ ] **Step 1: `ui.tsx` 的 `Button`**

1. 这两行：

```ts
 *   destructive 透明底 + 红字红边——不实底,因为它不是主动作
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "plain" | "quiet" | "destructive";
```

换成：

```ts
 *   destructive 透明底 + 红字红边——不实底,因为它不是主动作
 *   danger   实底红——只给确认弹窗里那颗真的会删东西的钮（#1362）：在那一刻它就是主动作
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "plain" | "quiet" | "destructive" | "danger";
```

2. `/** 四档尺寸。高度照 demo：通栏 50、弹窗 46、进门闸 42、小胶囊 44。` 开头的那段注释里 `四档尺寸` 改成 `五档尺寸`，`小胶囊 44。` 改成 `小胶囊 44、行尾小胶囊 30。`；`BUTTON_SIZE` 里 `auto:` 那一行之后加：

```ts
  // 行尾的小胶囊（群设置每一行的「移出」，demo 的 .btn.sm）：30 高 = 5 + 18 + 5 + 两道 1pt 边
  sm: { box: { borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: 12, minHeight: 30 }, font: 13 },
```

3. `Button` 的 props 里：

```ts
  size?: "full" | "auto" | "dialog" | "compact";
```

换成：

```ts
  size?: "full" | "auto" | "dialog" | "compact" | "sm";
```

并把它上面那段注释的最后一句 `compact = 进门闸那张卡上（42 高） */` 改成 `compact = 进门闸那张卡上（42 高）；sm = 一行末尾的小胶囊（30 高） */`。

4. `face` 里：

```ts
    : v === "destructive" ? { backgroundColor: "transparent", ...line, borderColor: c.destructive }
    : { backgroundColor: "transparent" };
```

换成：

```ts
    : v === "destructive" ? { backgroundColor: "transparent", ...line, borderColor: c.destructive }
    : v === "danger" ? { backgroundColor: c.destructive }
    : { backgroundColor: "transparent" };
```

5. `fg` 里：

```ts
    : v === "destructive" ? c.destructive
```

换成：

```ts
    : v === "destructive" ? c.destructive
    : v === "danger" ? c.destructiveForeground
```

- [ ] **Step 2: `ui.tsx` 的 `Row` 与 `Field`**

1. `Row` 的 props 末尾与头三行：

```ts
  tone?: "default" | "destructive";
}) {
  const { c } = usePalette();
  const hi = useRef(new Animated.Value(0)).current;
  const center = props.align === "center";
  const fg = props.tone === "destructive" ? c.destructive : c.foreground;
```

换成：

```ts
  /** accent = 读成「一个动作」的那一行（群设置的「加一只」，demo 里那一行的字是点缀色） */
  tone?: "default" | "destructive" | "accent";
}) {
  const { c } = usePalette();
  const hi = useRef(new Animated.Value(0)).current;
  const center = props.align === "center";
  const fg = props.tone === "destructive" ? c.destructive : props.tone === "accent" ? c.brand : c.foreground;
```

2. `Field` 的 props 里：

```ts
  /** 字居中（「新建智能体」那一格：它坐在大脸与脸墙之间，是一个名字不是一段话，demo 的 .nmrow） */
  align?: "left" | "center";
}) {
```

换成：

```ts
  /** 字居中（「新建智能体」那一格：它坐在大脸与脸墙之间，是一个名字不是一段话，demo 的 .nmrow） */
  align?: "left" | "center";
  /** false = 打不进字（正在建 / 正在存的那几秒：表单锁住，同抽屉的 locked）。缺席 = 能打 */
  editable?: boolean;
}) {
```

3. `Field` 里 `<TextInput` 那几行：

```tsx
      ref={props.inputRef}
      value={props.value}
      onChangeText={props.onChangeText}
```

换成：

```tsx
      ref={props.inputRef}
      value={props.value}
      editable={props.editable}
      onChangeText={props.onChangeText}
```

- [ ] **Step 3: `dialog.tsx` 的 `DialogFooter`（#1362）**

1. 这一段：

```ts
interface DialogAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}
```

换成：

```ts
interface DialogAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 右边那颗真的会删东西（删掉一只 / 解散群）：画成实底红（#1362）——触发它的那一行是红字，
      弹窗里真正按下去就删的那颗反而是品牌蓝，是一句反话 */
  tone?: "destructive";
}
```

2. `DialogFooter` 上面那段注释 `左边「不做这件事」、右边「做」，两颗等宽。` 改成 `左边「不做这件事」、右边「做」，两颗等宽；「做」是删东西时右边那颗实底红。`；函数里右边那颗：

```tsx
      <Button grow size="dialog" label={right.label} onPress={right.onPress} disabled={right.disabled} />
```

换成：

```tsx
      <Button
        grow
        size="dialog"
        variant={right.tone === "destructive" ? "danger" : "primary"}
        label={right.label}
        onPress={right.onPress}
        disabled={right.disabled}
      />
```

- [ ] **Step 4: 勾**

`mobile/src/chrome/Glyphs.tsx` 头一行注释 `返回 / 关闭 / 新建 / 设置 / 搜索 / 发送。` 改成 `返回 / 关闭 / 新建 / 设置 / 搜索 / 发送 / 勾。`；文件末尾加：

```tsx
/** ✓ 勾：左、下两道边转 -45°（建群那一列勾上的那几只） */
export function CheckGlyph({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <View style={{
      width: size, height: size * 0.55, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderColor: color,
      transform: [{ rotate: "-45deg" }], marginTop: -size * 0.2,
    }} />
  );
}
```

- [ ] **Step 5: 原生导航条右边那颗字钮**

Create `mobile/src/chrome/HeaderTextButton.tsx`：

```tsx
// 原生导航条右边那颗字钮（#1356 A1 起智能体设置的「存」，A3 加了建群的「建」、群设置的「存」）：
// 按不动时弱色，正在做时由调用方换字。挂法：`navigation.setOptions({ headerRight: () => <HeaderTextButton … /> })`，
// 调用方只在「按不按得动 / 正在做」变了时重设（不带依赖地每次渲染都 setOptions，会让导航器跟着重渲、再触发
// 调用方，形成死循环），按下去调的是 ref 里最新的那个函数。
import { Pressable, Text } from "react-native";
import { type as t, usePalette } from "../theme.js";

export function HeaderTextButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [pressed && { opacity: 0.6 }]}
    >
      <Text style={{ ...t.headline, color: disabled ? c.mutedForeground : c.brand }}>{label}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 6: 一只智能体占一行**

Create `mobile/src/group/AgentPickRow.tsx`：

```tsx
// 一只智能体占一行（#1356 A3，spec §5.6）：脸（s 档）| 名字 + 职责 | 右边一格（勾 / 「移出」/ 空）。
// 建群那一列、群设置的「里面有谁」、「加一只」与「@ 谁」两张抽屉共用这一副（demo 的 .row / .opt 同一个形状）。
// 能点的时候按下整行变色、不缩放（列表行的语汇，同 ui.tsx 的 Row）；`checked` 在场 = 这是一格勾选
// （读屏念「复选框，已选中」）。按不动时整行压到 .45（demo 与桌面建群弹窗同一个透明度）。
// 调用方递进来的都是与名册求过交集的 id，名字与职责现查名册。
import { useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Face } from "../face/Face.js";
import { type as t, usePalette } from "../theme.js";

export function AgentPickRow({ ws, agentId, trailing, onPress, disabled = false, checked }: {
  ws: WorkspaceSnapshot;
  agentId: string;
  trailing?: ReactNode;
  /** 缺席 = 这一行本身不能点（右边那颗钮自己接手指） */
  onPress?: () => void;
  disabled?: boolean;
  /** 在场 = 勾选行 */
  checked?: boolean;
}) {
  const { c } = usePalette();
  const hi = useRef(new Animated.Value(0)).current;
  const name = agentNameOf(ws, agentId);
  const description = ws.agents.find((a) => a.agentId === agentId)?.description ?? "";
  // 按下那一帧就变色（setValue，不是动画）；松手才淡出——同 ui.tsx 的 Row
  const press = (down: boolean): void => {
    if (down) return hi.setValue(1);
    Animated.timing(hi, { toValue: 0, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 9, minHeight: 52 }}>
      <Face slot={agentFaceSlot(ws, agentId)} tier="s" />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ ...t.body, fontWeight: "600", color: c.foreground }}>{name}</Text>
        {description !== "" ? (
          <Text numberOfLines={1} style={{ ...t.footnote, color: c.mutedForeground }}>{description}</Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
  if (onPress === undefined) return <View style={disabled ? { opacity: 0.45 } : undefined}>{body}</View>;
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "button" : "checkbox"}
      accessibilityLabel={description !== "" ? `${name}，${description}` : name}
      accessibilityState={checked === undefined ? { disabled } : { disabled, checked }}
      disabled={disabled}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      onPress={onPress}
      style={disabled ? { opacity: 0.45 } : undefined}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.muted, opacity: hi }]} />
      {body}
    </Pressable>
  );
}
```

- [ ] **Step 7: 智能体设置用上两样**

`mobile/src/agent/AgentSettingsScreen.tsx`：

1. import：

```ts
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
```

换成：

```ts
import { ScrollView, Text, TextInput, View } from "react-native";
```

并在 `import { cloudClient } from "../cloud/cloudClient.js";` 之前加：

```ts
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
```

2. `headerRight` 那一段：

```tsx
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          hitSlop={10}
          onPress={() => void saveRef.current()}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          <Text style={{ ...t.headline, color: canSave ? c.brand : c.mutedForeground }}>{busy ? "正在存…" : "存"}</Text>
        </Pressable>
      ),
    });
  }, [navigation, canSave, busy, c.brand, c.mutedForeground]);
```

换成：

```tsx
      headerRight: () => (
        <HeaderTextButton label={busy ? "正在存…" : "存"} disabled={!canSave} onPress={() => void saveRef.current()} />
      ),
    });
  }, [navigation, canSave, busy]);
```

3. 确认弹窗右边那颗：

```tsx
          right={{ label: busy ? "正在删…" : "删掉", onPress: () => void remove(), disabled: busy }}
```

换成：

```tsx
          right={{ label: busy ? "正在删…" : "删掉", onPress: () => void remove(), disabled: busy, tone: "destructive" }}
```

- [ ] **Step 8: 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p mobile/tsconfig.json 2>&1 | head -20`
Expected: 没有输出。

- [ ] **Step 9: Commit**

message：

```
feat(mobile): 群聊要的几样零件；确认弹窗的删除钮改成实底红（#1356 A3，Closes #1362 的那一半）

确认弹窗右边那颗原来写死品牌蓝：触发它的那一行是红字，弹窗里真正按下去就删的那颗反而不是（#1362）。
DialogFooter 的右边那颗可以带 tone:"destructive"，画成新加的 danger 变体（实底红——只在这一刻它是
主动作；平时的破坏性入口仍是红字红边）；智能体设置的「删掉」先用上，A3 的「解散群」是第二个。
另外备齐后面三个任务要的：行尾小胶囊（sm，30 高）、点缀色的行（Row accent）、锁得住的输入框
（Field editable）、勾、导航条右边那颗字钮（智能体设置的「存」改用它，行为不变）、一只智能体
占一行（建群那一列 / 群设置 / 两张抽屉共用）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add mobile/src/ui.tsx mobile/src/dialog.tsx mobile/src/chrome/Glyphs.tsx mobile/src/chrome/HeaderTextButton.tsx mobile/src/group/AgentPickRow.tsx mobile/src/agent/AgentSettingsScreen.tsx && git commit -F .superpowers/commit-msg.txt
```

---

### Task 5: 建群——岔路弹窗「一个群聊」→ 建群页 → 换成那条群聊

spec §5.6：从 ＋ 弹窗的「一个群聊」推入；群名（可空，空着按名册顺序用成员名拼）+ 名册列表（勾选；上下限当场按不动）+ 组尾「一只的群就是私聊，所以至少两只；最多六只」→ `create{chat:{kind:"group"}}` → 推入群聊。

两条 spec 没写、这里定下的：**名册不到两只时「一个群聊」按不动**，副标题照实说（点进去是一页永远按不动「建」的表，#722；名册里永远有管理员，所以这只在「只有它一只」时发生）；**建成后是换成（replace）那条群聊**，返回回到名册，不回到这张表。

正文拆成受控的 `NewGroupForm`（名字与勾选住在调用方）：屏把「建」挂在原生导航条右边，收尾冒烟的临时根组件直接摆一颗钮就能验。

**Files:**
- Modify: `mobile/src/nav/types.ts`
- Modify: `mobile/src/nav/RootNavigator.tsx`
- Modify: `mobile/src/roster/NewThingDialog.tsx`
- Modify: `mobile/src/roster/RosterScreen.tsx`
- Create: `mobile/src/group/NewGroupForm.tsx`
- Create: `mobile/src/group/NewGroupScreen.tsx`

**Interfaces:**
- Consumes: Task 1 的 `groupPick` / `pickLocked` / `togglePick` / `groupNameFor`；Task 4 的 `AgentPickRow` / `CheckGlyph` / `HeaderTextButton` / `Field` 的 `editable`；`cloudClient.create`（`mobile/src/cloud/cloudClient.ts`）；`refreshHomeAfterWrite` / `homeSnapshot` / `useHome`（`mobile/src/home/homeStore.ts`）；`resolveChatTarget`（`src/shared/mobileChat.ts`）。
- Produces:
  - 路由 `NewGroup: undefined`
  - `NewThingDialog` 多两个 props：`groupReady: boolean`、`onGroup: () => void`
  - `NewGroupForm({ ws, name, picked, busy, error, onName, onPicked })`、`NEW_GROUP_FOOTER`
  - `NewGroupScreen`

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 里：

```ts
  AgentSettings: { agentId: string };
```

之后加：

```ts
  /** 建群（A3）：从 ＋ 那张岔路弹窗的「一个群聊」推进来 */
  NewGroup: undefined;
```

- [ ] **Step 2: 岔路弹窗「一个群聊」接上**

`mobile/src/roster/NewThingDialog.tsx`：

1. 头注最后三行：

```
// 「一个群聊」要到 A3 才接上：这一片画出来但按不动、副标题照实说——不画一颗点了没去处的钮（#722），
// 也不把它藏起来让这张弹窗只剩一条路（spec §10 第 29 条）。
```

换成：

```
// 「一个群聊」（A3）：点了收起弹窗、退场放完推建群页。名册不到两只时按不动、副标题照实说为什么——
// 一只的「群」就是私聊，点进去是一页永远按不动「建」的表（#722）；名册里永远有管理员，所以这只在
// 「只有它一只」时发生。
```

2. props：

```tsx
export function NewThingDialog({ visible, groupFaces, onAgent, onDismiss, onExited }: {
  visible: boolean;
  /** 「一个群聊」那一行左边那几张（名册里的前三只） */
  groupFaces: { id: string; slot: number }[];
  /** 点了「一只智能体」：调用方收起弹窗，退场放完（onExited）再升抽屉 */
  onAgent: () => void;
```

换成：

```tsx
export function NewThingDialog({ visible, groupFaces, groupReady, onAgent, onGroup, onDismiss, onExited }: {
  visible: boolean;
  /** 「一个群聊」那一行左边那几张（名册里的前三只） */
  groupFaces: { id: string; slot: number }[];
  /** 名册里够两只：「一个群聊」按得动 */
  groupReady: boolean;
  /** 点了「一只智能体」：调用方收起弹窗，退场放完（onExited）再升抽屉 */
  onAgent: () => void;
  /** 点了「一个群聊」：调用方收起弹窗，退场放完再推建群页 */
  onGroup: () => void;
```

3. 「一个群聊」那一行最后四行：

```tsx
        title="一个群聊"
        sub="还没做好，下一步就有。"
        disabled
        onPress={() => {}}
      />
```

换成：

```tsx
        title="一个群聊"
        sub={groupReady ? "把几只放进同一条线，它们在里头互相接力。" : "至少要两只智能体才凑得成一个群。"}
        disabled={!groupReady}
        onPress={onGroup}
      />
```

- [ ] **Step 3: 名册接上**

`mobile/src/roster/RosterScreen.tsx`：

1. 头注 `// · 刷新：进前台、从聊天页退回来（focus）、建 / 删之后（那几处自己调）。不轮询。` 之前加一行：

```
// · ＋ →「一个群聊」（A3）→ 弹窗退场放完推建群页（Modal 还在的时候推进来的页会压在它底下）。
```

2. import：

```ts
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
```

之后加：

```ts
import { CHAT_GROUP_CREATE_MIN } from "../../../src/shared/chatRoster.js";
```

3. ref：

```ts
  /** 弹窗退场放完之后要不要升抽屉（点的是「一只智能体」，不是取消 / 点外面） */
  const sheetAfterFork = useRef(false);
```

换成：

```ts
  /** 弹窗退场放完之后做什么：升「新建智能体」抽屉 / 推建群页 / 什么都不做（点的是取消 / 点外面）。
      两个 Modal 不叠着出场；推页也等弹窗收起 */
  const afterFork = useRef<"agent" | "group" | null>(null);
```

4. `<NewThingDialog` 那一整段：

```tsx
      <NewThingDialog
        visible={fork}
        groupFaces={groupFaces}
        onAgent={() => {
          sheetAfterFork.current = true;
          setFork(false);
        }}
        onDismiss={() => setFork(false)}
        onExited={() => {
          if (!sheetAfterFork.current) return;
          sheetAfterFork.current = false;
          setSheet({ key: Date.now(), visible: true });
        }}
      />
```

换成：

```tsx
      <NewThingDialog
        visible={fork}
        groupFaces={groupFaces}
        groupReady={ws !== null && ws.agents.length >= CHAT_GROUP_CREATE_MIN}
        onAgent={() => {
          afterFork.current = "agent";
          setFork(false);
        }}
        onGroup={() => {
          afterFork.current = "group";
          setFork(false);
        }}
        onDismiss={() => setFork(false)}
        onExited={() => {
          const next = afterFork.current;
          afterFork.current = null;
          if (next === "agent") setSheet({ key: Date.now(), visible: true });
          else if (next === "group") navigation.navigate("NewGroup");
        }}
      />
```

- [ ] **Step 4: 建群页的正文**

Create `mobile/src/group/NewGroupForm.tsx`：

```tsx
// 建群那一页的正文（#1356 A3，spec §5.6）：群名（可空）+ 名册一列（勾选）+ 组尾那一句。受控：名字与
// 勾选住在调用方（NewGroupScreen 把「建」挂在原生导航条右边；收尾冒烟的临时根组件直接摆一颗钮）。
// 判据全在 shared/groupEdit.ts：名册顺序、满六只时没勾的锁住（勾上的照样点得动）、群名留空用成员名拼。
// 群名那一格的占位字就是此刻勾选的那几只拼出来的名字——留空时发出去的正是它（一只都没勾时给个例子）。
import { ScrollView, Text, View } from "react-native";
import { CHAT_GROUP_MAX, CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import { groupNameFor, groupPick, pickLocked, togglePick } from "../../../src/shared/groupEdit.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { space, type as t, usePalette } from "../theme.js";
import { Field, Group, Note } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

/** 组尾那一句（demo 的 newGroup） */
export const NEW_GROUP_FOOTER = "一只的「群」就是私聊，所以至少两只；最多六只。";

export function NewGroupForm({ ws, name, picked, busy, error, onName, onPicked }: {
  ws: WorkspaceSnapshot;
  name: string;
  picked: string[];
  /** 正在建：表单锁住 */
  busy: boolean;
  error: string | null;
  onName: (v: string) => void;
  onPicked: (ids: string[]) => void;
}) {
  const { c } = usePalette();
  const pick = groupPick(ws, picked);
  const placeholder = pick.ids.length > 0 ? groupNameFor(ws, pick.ids, "") : "比如「发版组」";
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>群名 · 不填就用它们的名字拼</Text>
        <Field value={name} onChangeText={onName} placeholder={placeholder} maxLength={CHAT_NAME_MAX} editable={!busy} returnKeyType="done" />
      </View>
      <Group header={`把谁放进去 · 已选 ${pick.ids.length} / ${CHAT_GROUP_MAX}`} footer={NEW_GROUP_FOOTER}>
        {ws.agents.map((a) => {
          const on = pick.ids.includes(a.agentId);
          return (
            <AgentPickRow
              key={a.agentId}
              ws={ws}
              agentId={a.agentId}
              checked={on}
              disabled={busy || pickLocked(pick, a.agentId)}
              onPress={() => onPicked(togglePick(ws, picked, a.agentId))}
              trailing={
                <View style={{ width: 22, alignItems: "center", opacity: on ? 1 : 0 }}>
                  <CheckGlyph color={c.brand} />
                </View>
              }
            />
          );
        })}
      </Group>
      {error !== null ? <Note tone="error">{error}</Note> : null}
    </ScrollView>
  );
}
```

- [ ] **Step 5: 建群页**

Create `mobile/src/group/NewGroupScreen.tsx`：

```tsx
// 建群（#1356 A3，spec §5.6）：从 ＋ 那张岔路弹窗的「一个群聊」推进来。原生导航条：返回 | 新的群聊 | 建。
// 「建」= create{chat:{kind:"group"}}（群名留空时发出去的是成员名拼起来的那个，groupNameFor）→ 名册刷新
// （新群那一行与群名都从那份清单来）→ **换成**那条群聊（replace：返回回到名册，不回到这张表）。
// 名册没读回来就退回名册（那里有读不到的那句话 + 重试钮），不推一页「这条聊天已经不在了」——它明明在。
// 建失败那句话留在这一页、表单不清（关掉就等于把「没建成」说成「建成了」，同桌面建群弹窗）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { groupNameFor, groupPick } from "../../../src/shared/groupEdit.js";
import { resolveChatTarget, type ChatTarget } from "../../../src/shared/mobileChat.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { homeSnapshot, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, usePalette } from "../theme.js";
import { Note, Spinner } from "../ui.js";
import { NewGroupForm } from "./NewGroupForm.js";

type Props = NativeStackScreenProps<RootStackParams, "NewGroup">;

export function NewGroupScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = ws === null ? null : groupPick(ws, picked);
  const canCreate = !busy && pick !== null && pick.enough;

  const create = async (): Promise<void> => {
    if (ws === null || pick === null || !canCreate) return;
    setBusy(true);
    setError(null);
    const r = await cloudClient.create(ws.id, { kind: "group", name: groupNameFor(ws, pick.ids, name), agentIds: pick.ids });
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    // 这几秒里人可能已经退出了这一页：不隔着别的屏硬推一条聊天
    if (!navigation.isFocused()) return;
    const h = homeSnapshot();
    const target: ChatTarget = { kind: "group", sessionId: r.value.sessionId };
    if (h.home !== null && resolveChatTarget(h.home, h.chats, target) !== null) navigation.replace("Chat", target);
    else navigation.popToTop();
  };

  // 「建」挂在原生导航条右边（同智能体设置的「存」）：按下去调 ref 里最新的 create；
  // setOptions 只在按不按得动 / 正在建变了时重设
  const createRef = useRef(create);
  useEffect(() => {
    createRef.current = create;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderTextButton label={busy ? "正在建…" : "建"} disabled={!canCreate} onPress={() => void createRef.current()} />
      ),
    });
  }, [navigation, canCreate, busy]);

  if (ws === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {home.loaded ? <Note tone="warn">还没读到你的智能体。</Note> : <Spinner />}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <NewGroupForm ws={ws} name={name} picked={picked} busy={busy} error={error} onName={setName} onPicked={setPicked} />
    </View>
  );
}
```

- [ ] **Step 6: 注册这一页**

`mobile/src/nav/RootNavigator.tsx`：

1. `import { AgentSettingsScreen } from "../agent/AgentSettingsScreen.js";` 之后加：

```ts
import { NewGroupScreen } from "../group/NewGroupScreen.js";
```

2. `AgentSettings` 那个 `<Root.Screen … />` 之后加：

```tsx
        <Root.Screen
          name="NewGroup"
          component={NewGroupScreen}
          options={{ title: "新的群聊", headerBackTitle: "返回", headerShadowVisible: false }}
        />
```

- [ ] **Step 7: 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p mobile/tsconfig.json 2>&1 | head -20`
Expected: 没有输出。

- [ ] **Step 8: Commit**

message：

```
feat(mobile): 建群——岔路弹窗「一个群聊」接上，建群页勾 2–6 只，建成换成那条群聊（#1356 A3）

spec §5.6：从 ＋ 弹窗推入建群页，群名可空（占位字就是留空时会发出去的那个名字），名册一列勾选，
满六只时没勾的锁住、勾上的照样点得动，不到两只「建」按不动；create 成功后先刷名册（新群那一行与
群名都从那份清单来）再 replace 成那条群聊——返回回到名册，不回到这张表；名册没读回来就退回名册，
不推一页「这条聊天已经不在了」。名册不到两只时「一个群聊」按不动并说清为什么（点进去是一页永远
按不动「建」的表）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx mobile/src/roster/NewThingDialog.tsx mobile/src/roster/RosterScreen.tsx mobile/src/group/NewGroupForm.tsx mobile/src/group/NewGroupScreen.tsx && git commit -F .superpowers/commit-msg.txt
```

---

### Task 6: 群设置——改名 / 移出 / 加一只 / 解散

spec §5.6：群名（改了按「存」走 `chat_update{name}`）/ 里面有谁（每行「移出」，可以移到空群，ADR-0297 的 0..6）/ 加一只（抽屉，满 6 只锁住）/ 解散这个群（居中确认：「只删这条线，里面那几只都还在」→ `delete`）。入口：群聊头部右边那颗直接进（中间没有菜单）。

**Files:**
- Modify: `mobile/src/nav/types.ts`
- Modify: `mobile/src/nav/RootNavigator.tsx`
- Create: `mobile/src/group/AddMemberSheet.tsx`
- Create: `mobile/src/group/GroupSettingsBody.tsx`
- Create: `mobile/src/group/GroupSettingsScreen.tsx`
- Modify: `mobile/src/chat/ChatScreen.tsx`（头部右边那颗在群聊里进群设置）

**Interfaces:**
- Consumes: Task 1 的 `addChoice` / `withAgent` / `withoutAgent`；Task 4 的 `AgentPickRow` / `HeaderTextButton` / `Button size="sm"` / `Row tone="accent"` / `Field editable` / `DialogFooter` 的 `tone`；`groupRows`（`src/shared/agentRoster.ts`）；`cloudClient.chatUpdate` / `cloudClient.remove`；`refreshHome` / `refreshHomeAfterWrite` / `useHome`。
- Produces:
  - 路由 `GroupSettings: { sessionId: string }`
  - `AddMemberSheet({ visible, ws, candidates, busyId, error, onPick, onClose, onExited? })`
  - `GroupSettingsBody({ ws, agentIds, name, onName, busy, removingId, addReason, error, onRemove, onAdd, onDissolve })`、`DISSOLVE_FOOTER`
  - `GroupSettingsScreen`

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 里 Task 5 加的 `NewGroup: undefined;` 之后加：

```ts
  /** 群设置（A3）：从群聊头部右边那颗进来 */
  GroupSettings: { sessionId: string };
```

- [ ] **Step 2: 「加一只进来」抽屉**

Create `mobile/src/group/AddMemberSheet.tsx`：

```tsx
// 「加一只进来」（#1356 A3，spec §5.6）：群设置里「加一只」点开的底部抽屉，只列名册里还不在群里的；
// 点一只就加那一只（demo 的 addMember：点完抽屉就收）。加的时候抽屉锁住、每一行按不动，成了才收——
// 失败那句话留在抽屉里（先收掉就等于把「没加上」说成「加上了」）。满六只时这张抽屉根本打不开
// （「加一只」那一行按不动并写着为什么），所以这里不再判上限。
import { ScrollView, Text } from "react-native";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { space, type as t, usePalette } from "../theme.js";
import { Group, Note } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

export function AddMemberSheet({ visible, ws, candidates, busyId, error, onPick, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  /** 名册里还不在群里的（groupEdit.addChoice） */
  candidates: WorkspaceAgentRow[];
  /** 正在加的那一只；null = 没在加 */
  busyId: string | null;
  error: string | null;
  onPick: (agentId: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  return (
    <BottomSheet
      visible={visible}
      title="加一只进来"
      locked={busyId !== null}
      onClose={onClose}
      {...(onExited === undefined ? {} : { onExited })}
    >
      <ScrollView contentContainerStyle={{ padding: space.md, gap: space.md }}>
        <Group footer="最多六只。">
          {candidates.map((a) => (
            <AgentPickRow
              key={a.agentId}
              ws={ws}
              agentId={a.agentId}
              disabled={busyId !== null}
              onPress={() => onPick(a.agentId)}
              trailing={busyId === a.agentId ? <Text style={{ ...t.footnote, color: c.mutedForeground }}>正在加…</Text> : null}
            />
          ))}
        </Group>
        {error !== null ? <Note tone="error">{error}</Note> : null}
      </ScrollView>
    </BottomSheet>
  );
}
```

- [ ] **Step 3: 群设置的正文**

Create `mobile/src/group/GroupSettingsBody.tsx`：

```tsx
// 群设置的正文（#1356 A3，spec §5.6）：群名 / 里面有谁（每行「移出」）/ 加一只 / 解散这个群。受控：
// 名字草稿与各个动作的进行状态住在调用方（GroupSettingsScreen 接线；收尾冒烟的临时根组件摆假数据）。
// · 名单当场生效（移出 / 加一只各发一次 chat_update，发的是变动之后的完整名单）；群名要按「存」
//   （原生导航条右边）——两格分开发：只改名时不把名单一起发过去，那等于替人声明「那一格我也确认是
//   这个值」（同桌面群设置 ②）。
// · 最后一只也移得走：空群合法（ADR-0297 的 0..6）——删一只智能体不该连坐删掉它待过的群。
// · 「加一只」满六只 / 名册里没有别的了就按不动，原因写在那一行右边（#722：不画一颗点了必然被拒的钮）。
// · 一次只做一件事：有一个动作在路上时别的钮都按不动（两条 chat_update 前后脚发出去，后到的那份名单
//   会把先到的覆盖回去）。
import { ScrollView, Text, View } from "react-native";
import { CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { PlusGlyph } from "../chrome/Glyphs.js";
import { space, type as t, usePalette } from "../theme.js";
import { Button, Field, Group, Note, Row } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

/** 解散那一组底下那一句（spec §5.6） */
export const DISSOLVE_FOOTER = "解散只删这条线，里面那几只都还在。";

export function GroupSettingsBody({
  ws, agentIds, name, onName, busy, removingId, addReason, error, onRemove, onAdd, onDissolve,
}: {
  ws: WorkspaceSnapshot;
  /** 此刻的名单（名册顺序、只含名册里还在的） */
  agentIds: string[];
  name: string;
  onName: (v: string) => void;
  /** 有一个动作在路上：别的钮都按不动 */
  busy: boolean;
  /** 正在移出的那一只（那一行的钮换字） */
  removingId: string | null;
  /** 「加一只」按不动的原因；null = 按得动 */
  addReason: string | null;
  error: string | null;
  onRemove: (agentId: string) => void;
  onAdd: () => void;
  onDissolve: () => void;
}) {
  const { c } = usePalette();
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>群名</Text>
        <Field
          value={name}
          onChangeText={onName}
          placeholder="给这个群起个名字"
          maxLength={CHAT_NAME_MAX}
          editable={!busy}
          returnKeyType="done"
        />
      </View>

      <Group header="里面有谁" footer="移出之后它在群里说过的话还在，只是不再接这个群的活。">
        {agentIds.map((id) => (
          <AgentPickRow
            key={id}
            ws={ws}
            agentId={id}
            trailing={
              <Button
                size="sm"
                variant="outline"
                label={removingId === id ? "正在移…" : "移出"}
                disabled={busy}
                onPress={() => onRemove(id)}
              />
            }
          />
        ))}
        {agentIds.length === 0 ? <Row label="这个群里没有智能体了" /> : null}
        <Row
          label="加一只"
          tone="accent"
          leading={<PlusGlyph color={c.brand} size={13} />}
          {...(addReason === null ? {} : { value: addReason })}
          disabled={busy || addReason !== null}
          onPress={onAdd}
        />
      </Group>

      {error !== null ? <Note tone="error">{error}</Note> : null}

      <Group footer={DISSOLVE_FOOTER}>
        <Row label="解散这个群" tone="destructive" align="center" disabled={busy} onPress={onDissolve} />
      </Group>
    </ScrollView>
  );
}
```

- [ ] **Step 4: 群设置页**

Create `mobile/src/group/GroupSettingsScreen.tsx`：

```tsx
// 群设置（#1356 A3，spec §5.6）：从群聊头部右边那颗进来（中间没有菜单）。原生导航条：返回 | 群名 | 存。
// 群名与名单读名册那份清单（groupRows：workspace_sessions 的投影——runtime 回 chat_update 的回执之前已经
// 写完那两列），不读日志：这一页不开房（同桌面 GroupSettingsDrawer）。聊天页头部那排名字仍从日志推导
// （chatViewOf），名单变了房里会广播一条 chat_roster_changed，那边自己跟上。
// 每个动作做完拉一遍名册（refreshHomeAfterWrite）；进这一页也拉一次（别的设备可能刚改过名单）。
// 群名那一格人没动过时显示清单里那一格（名册刷新了跟着变），动过之后听人的。
// 解散 = 删除不是归档：居中确认（spec §4），右边那颗实底红（#1362）→ delete → 回名册（这条线没了，
// 退回聊天页只会看见一条连不上的线）。先回名册再刷新：反过来的话这一页会先闪一下「这个群已经不在了」。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { groupRows } from "../../../src/shared/agentRoster.js";
import { addChoice, withAgent, withoutAgent } from "../../../src/shared/groupEdit.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { refreshHome, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, usePalette } from "../theme.js";
import { Note, Spinner } from "../ui.js";
import { AddMemberSheet } from "./AddMemberSheet.js";
import { GroupSettingsBody } from "./GroupSettingsBody.js";

/** 解散确认里那句话（demo 的 disband） */
const DISSOLVE_LEAD = "这条线会删掉，不可恢复。里面那几只都还在，它们各自的线一个字不少。";

type Props = NativeStackScreenProps<RootStackParams, "GroupSettings">;

export function GroupSettingsScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const row = useMemo(
    () => (ws === null ? null : (groupRows(ws, home.chats).find((g) => g.sessionId === sessionId) ?? null)),
    [ws, home.chats, sessionId],
  );
  /** null = 人还没动过群名那一格（显示清单里那一格） */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addBusyId, setAddBusyId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [dissolveError, setDissolveError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );

  const busy = saving || removingId !== null || addBusyId !== null || dissolving;
  const name = nameDraft ?? row?.name ?? "";
  const trimmed = name.trim();
  const canSave = !busy && row !== null && trimmed !== "" && trimmed !== row.name;

  const save = async (): Promise<void> => {
    if (ws === null || !canSave) return;
    setSaving(true);
    setError(null);
    // 只发名字：名单那一格不带（见 GroupSettingsBody 头注）
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { name: trimmed });
    if (!r.ok) {
      setSaving(false);
      setError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setSaving(false);
    navigation.goBack();
  };

  const remove = async (agentId: string): Promise<void> => {
    if (ws === null || row === null || busy) return;
    setRemovingId(agentId);
    setError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withoutAgent(ws, row.agentIds, agentId) });
    if (r.ok) await refreshHomeAfterWrite();
    else setError(r.message);
    setRemovingId(null);
  };

  const add = async (agentId: string): Promise<void> => {
    if (ws === null || row === null || addBusyId !== null) return;
    setAddBusyId(agentId);
    setAddError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withAgent(ws, row.agentIds, agentId) });
    if (!r.ok) {
      setAddBusyId(null);
      setAddError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setAddBusyId(null);
    setAdding(false);
  };

  const dissolve = async (): Promise<void> => {
    if (ws === null || dissolving) return;
    setDissolving(true);
    setDissolveError(null);
    const r = await cloudClient.remove(ws.id, sessionId);
    if (!r.ok) {
      setDissolving(false);
      setDissolveError(r.message);
      return;
    }
    navigation.popToTop();
    void refreshHomeAfterWrite();
  };

  // 「存」挂在原生导航条右边（同智能体设置）：按下去调 ref 里最新的 save；setOptions 只在
  // 标题 / 按不按得动 / 正在存变了时重设
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      title: row?.name ?? "",
      headerRight: () => (
        <HeaderTextButton label={saving ? "正在存…" : "存"} disabled={!canSave} onPress={() => void saveRef.current()} />
      ),
    });
  }, [navigation, row?.name, canSave, saving]);

  if (ws === null || row === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {/* 还没查到就转圈；查过了还是没有 = 刚被解散了 */}
        {home.loaded ? <Note tone="warn">这个群已经不在了。</Note> : <Spinner />}
      </View>
    );
  }

  const choice = addChoice(ws, row.agentIds);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <GroupSettingsBody
        ws={ws}
        agentIds={row.agentIds}
        name={name}
        onName={setNameDraft}
        busy={busy}
        removingId={removingId}
        addReason={choice.reason}
        error={error}
        onRemove={(id) => void remove(id)}
        onAdd={() => {
          setAddError(null);
          setAdding(true);
        }}
        onDissolve={() => {
          setDissolveError(null);
          setConfirming(true);
        }}
      />

      <AddMemberSheet
        visible={adding}
        ws={ws}
        candidates={choice.candidates}
        busyId={addBusyId}
        error={addError}
        onPick={(id) => void add(id)}
        onClose={() => setAdding(false)}
      />

      {/* 确认类用居中弹窗，不用抽屉（手机端既有规矩，spec §4）；「解散」实底红（#1362） */}
      <Dialog visible={confirming}>
        <DialogTitle>解散「{row.name}」？</DialogTitle>
        <DialogLead>{DISSOLVE_LEAD}</DialogLead>
        {dissolveError !== null ? (
          <View style={{ paddingHorizontal: 20 }}>
            <Note tone="error">{dissolveError}</Note>
          </View>
        ) : null}
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirming(false), disabled: dissolving }}
          right={{
            label: dissolving ? "正在解散…" : "解散",
            onPress: () => void dissolve(),
            disabled: dissolving,
            tone: "destructive",
          }}
        />
      </Dialog>
    </View>
  );
}
```

- [ ] **Step 5: 注册这一页**

`mobile/src/nav/RootNavigator.tsx`：

1. Task 5 加的 `import { NewGroupScreen } from "../group/NewGroupScreen.js";` 之后加：

```ts
import { GroupSettingsScreen } from "../group/GroupSettingsScreen.js";
```

2. Task 5 加的 `NewGroup` 那个 `<Root.Screen … />` 之后加：

```tsx
        {/* 标题由这一页自己按群名 setOptions（改了名回来就跟着变） */}
        <Root.Screen
          name="GroupSettings"
          component={GroupSettingsScreen}
          options={{ title: "", headerBackTitle: "返回", headerShadowVisible: false }}
        />
```

- [ ] **Step 6: 群聊头部右边那颗进群设置**

`mobile/src/chat/ChatScreen.tsx`：

1. 头注第一行 `// 聊天页（#1356 A1，spec §5.3 / §6）。私聊为主；群聊先是基础版（群设置、@ 谁、名单变更那一行在 A3）。` 换成：

```
// 聊天页（#1356 A1 / A3，spec §5.3 / §5.6 / §6）。私聊与群聊同一张页；群聊的设置入口、@ 谁、名单变更那一行是 A3 加的。
```

2. 头注里 `// · 头：回退 | 药丸（脸 + 名字）| 私聊右边那颗直接进设置（中间没有菜单）。浮在内容上，页面内容` 换成：

```
// · 头：回退 | 药丸（脸 + 名字）| 右边那颗直接进设置——私聊进智能体设置、群聊进群设置（中间没有菜单）。浮在内容上，页面内容
```

3. `ChatHeader` 里没有设置入口那一支的注释：

```tsx
        // 群设置在 A3：这一片不画一颗点了没去处的钮（#722），用同宽的空位让药丸居中
```

换成：

```tsx
        // 还不知道是哪一条（群还没解析出来）时不画一颗点了没去处的钮（#722），用同宽的空位让药丸居中
```

4. `const headFaces: ReactNode =` 那一整段（到 `);` 为止）之后加：

```tsx
  // 右边那颗：私聊进智能体设置，群聊进群设置（spec §5.3 / §5.6）
  const onSettings =
    dmAgent !== null ? () => navigation.navigate("AgentSettings", { agentId: dmAgent })
      : kind === "group" && sessionId !== null ? () => navigation.navigate("GroupSettings", { sessionId })
        : undefined;
```

5. 页底那个 `<ChatHeader` 里：

```tsx
        {...(dmAgent !== null ? { onSettings: () => navigation.navigate("AgentSettings", { agentId: dmAgent }) } : {})}
```

换成：

```tsx
        {...(onSettings === undefined ? {} : { onSettings })}
```

- [ ] **Step 7: 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p mobile/tsconfig.json 2>&1 | head -20`
Expected: 没有输出。

- [ ] **Step 8: Commit**

message：

```
feat(mobile): 群设置——改名 / 移出 / 加一只 / 解散，群聊头部右边那颗直接进（#1356 A3）

spec §5.6。群名与名单读名册那份清单（workspace_sessions 的投影，runtime 回执之前已写完那两列），
这一页不开房；名单当场生效、发的是变动之后的完整名单，群名要按「存」、只发名字那一格（两格分开发，
不替人声明名单）；最后一只也移得走（空群合法）；「加一只」满六只 / 名册里没有别的就按不动并写着
为什么，点开是一张抽屉、点一只加一只、失败那句话留在抽屉里；一次只做一件事（两条 chat_update
前后脚出去，后到的会把先到的覆盖回去）。解散 = 删除：居中确认、实底红，成了先回名册再刷新。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx mobile/src/group/AddMemberSheet.tsx mobile/src/group/GroupSettingsBody.tsx mobile/src/group/GroupSettingsScreen.tsx mobile/src/chat/ChatScreen.tsx && git commit -F .superpowers/commit-msg.txt
```

---

### Task 7: 「@ 谁」——输入框上方一颗钮 → 抽屉 → 在光标处插 `@名字 `

spec §5.6：输入框上方一颗「@ 谁」→ 底部抽屉（只列这个群里的智能体）→ 插一个 `@名字 `；发送前解析走 shared 的 `resolveSendMentions`（与桌面同一份，A1 的 `onSend` 已经在用）。

插在哪是一条判断，写进 shared：光标正停在一个没打完的 @ 后面（人自己先打了「@运」）时替换那一截；**光标前面贴着构词字符时先补一个空格**——`parseMentions` 要 @ 前是行首或非构词字符，贴上去的「看下@运维」一个都认不出，而 `resolveSendMentions` 会把它当成打错的名字整句拦下。

顺带把群聊里另外三处补齐：占位字「说给这一组听…」（demo 的 groupChat）；空群（最后一只被移出了）输入框上方一行实话、不画「@ 谁」；空群的开场那一屏不再说「都在」。

**Files:**
- Modify: `src/shared/agentMentionInput.ts`（新增 `insertAgentMention`）
- Test: `tests/shared/agentMentionInput.test.ts`
- Modify: `mobile/src/chat/Composer.tsx`
- Create: `mobile/src/chat/MentionSheet.tsx`
- Modify: `mobile/src/chat/ChatScreen.tsx`

**Interfaces:**
- Consumes: `mentionQueryAt` / `applyAgentMention`（同文件，已有）；Task 4 的 `AgentPickRow`；`BottomSheet`。
- Produces:
  - `insertAgentMention(text: string, caret: number, name: string): { text: string; caret: number }`
  - `ComposerHandle.mention(name: string): void`
  - `MentionChip({ onPress })`、`MentionSheet({ visible, ws, agentIds, onPick, onClose, onExited? })`、`MENTION_FOOTER`

- [ ] **Step 1: 写失败的测试**

`tests/shared/agentMentionInput.test.ts` 顶上两行 import（今天是 `import { describe, it, expect } from "vitest";` 与 `import { applyAgentMention, mentionQueryAt, pickerEmptyState, resolveSendMentions } from "../../src/shared/agentMentionInput.js";`）换成：

```ts
import { describe, it, expect } from "vitest";
import {
  applyAgentMention, insertAgentMention, mentionQueryAt, pickerEmptyState, resolveSendMentions,
} from "../../src/shared/agentMentionInput.js";
import { parseMentions } from "../../src/shared/remote/agentMention.js";
```

文件末尾追加：

```ts
describe("insertAgentMention（#1356 A3：手机「@ 谁」那颗钮）", () => {
  const C = [{ agentId: "a_000000000002", name: "运维" }];
  it("空输入框：插在开头", () => {
    expect(insertAgentMention("", 0, "运维")).toEqual({ text: "@运维 ", caret: 4 });
  });
  it("光标前面贴着字：补一个空格——贴上去的「看下@运维」parseMentions 认不出", () => {
    const r = insertAgentMention("帮我看下", 4, "运维");
    expect(r).toEqual({ text: "帮我看下 @运维 ", caret: 9 });
    expect(parseMentions(r.text, C)).toEqual(["a_000000000002"]);
  });
  it("光标前面是中文标点：不补（标点本来就是边界）", () => {
    expect(insertAgentMention("你好，", 3, "运维")).toEqual({ text: "你好，@运维 ", caret: 7 });
  });
  it("光标停在一个没打完的 @ 后面：替换那一截，不再补一个 @", () => {
    expect(insertAgentMention("@运", 2, "运维")).toEqual({ text: "@运维 ", caret: 4 });
  });
  it("插在句子中间：前后都不多出空格", () => {
    expect(insertAgentMention("看下 明天", 2, "运维")).toEqual({ text: "看下 @运维 明天", caret: 6 });
  });
  it("光标越界（输入框刚被清空、选区还是旧的）：夹回末尾", () => {
    expect(insertAgentMention("", 7, "运维")).toEqual({ text: "@运维 ", caret: 4 });
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/agentMentionInput.test.ts`
Expected: FAIL（`insertAgentMention is not a function`）。

- [ ] **Step 3: 写 `insertAgentMention`**

`src/shared/agentMentionInput.ts` 里 `applyAgentMention` 那个函数之后加：

```ts
// #1356 A3：手机「@ 谁」那颗钮——人先挑一只、再把名字插进光标处（桌面是打 @ 弹选人层，两条路插出来的
// 一样）。光标正停在一个没打完的 @ 后面（人自己先打了「@运」）时替换那一截，不再补一个 @；光标前面贴着
// 构词字符（「看下|」）时先补一个空格——parseMentions 要 @ 前是行首或非构词字符，贴上去的「看下@运维」
// 一个都认不出，而 resolveSendMentions 会把它当成打错的名字整句拦下。`caret` 越界（输入框刚被清空、
// 选区还是旧的）夹回末尾。
export function insertAgentMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const pos = Math.max(0, Math.min(caret, text.length));
  const typing = mentionQueryAt(text, pos);
  if (typing !== null) return applyAgentMention(text, typing.at, pos, name);
  if (pos > 0 && WORD.test(text[pos - 1]!)) {
    return applyAgentMention(`${text.slice(0, pos)} ${text.slice(pos)}`, pos + 1, pos + 1, name);
  }
  return applyAgentMention(text, pos, pos, name);
}
```

（`WORD` 是这个文件顶上已有的 `/[\p{L}\p{N}_]/u`。）

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx vitest run tests/shared/agentMentionInput.test.ts`
Expected: PASS（新增 6 条，既有的全绿）。

- [ ] **Step 5: 输入框的句柄多一个 `mention`**

`mobile/src/chat/Composer.tsx`：

1. 头注最后一行 `// 要这一句，demo 同款），焦点还给输入框、光标落在末尾。` 之后加：

```
// `mention(name)`（A3）：「@ 谁」那张抽屉挑了一只——在光标处插一个 `@名字 `（插在哪由 shared 的
// insertAgentMention 判），焦点还给输入框、光标落在插进去那一段后面。要知道光标在哪，所以记着最近一次的选区。
```

2. import：

```ts
import { SendGlyph } from "../chrome/Glyphs.js";
```

之前加：

```ts
import { insertAgentMention } from "../../../src/shared/agentMentionInput.js";
```

3. 句柄接口：

```ts
export interface ComposerHandle {
  /** 把一句话填进输入框（不发出去），焦点还给它、光标落在末尾 */
  fill(text: string): void;
}
```

换成：

```ts
export interface ComposerHandle {
  /** 把一句话填进输入框（不发出去），焦点还给它、光标落在末尾 */
  fill(text: string): void;
  /** 在光标处插一个 `@名字 `（A3），焦点还给它、光标落在插进去那一段后面 */
  mention(name: string): void;
}
```

4. `const input = useRef<TextInput>(null);` 之后加：

```ts
  /** 最近一次的选区与正文：句柄是一次建好的（useImperativeHandle 的依赖是 []），读 state 会读到旧值 */
  const selection = useRef({ start: 0, end: 0 });
  const draftNow = useRef("");
  useEffect(() => {
    draftNow.current = draft;
  }, [draft]);
```

5. `useImperativeHandle` 那一整段：

```ts
  useImperativeHandle(
    ref,
    () => ({
      fill(text: string) {
        setDraft(text);
        const el = input.current;
        if (el === null) return;
        el.focus();
        // 值要等这一拍渲染落到原生那侧才在；下一帧再把光标挪到末尾（刚聚焦时光标可能落在任何地方）
        requestAnimationFrame(() => el.setSelection(text.length, text.length));
      },
    }),
    [],
  );
```

换成：

```ts
  useImperativeHandle(
    ref,
    () => {
      /** 把一句话摆进输入框、光标落在 `caret`，焦点还给它 */
      const put = (text: string, caret: number): void => {
        setDraft(text);
        draftNow.current = text;
        selection.current = { start: caret, end: caret };
        const el = input.current;
        if (el === null) return;
        el.focus();
        // 值要等这一拍渲染落到原生那侧才在；下一帧再挪光标（刚聚焦时光标可能落在任何地方）
        requestAnimationFrame(() => el.setSelection(caret, caret));
      };
      return {
        fill(text: string) {
          put(text, text.length);
        },
        mention(name: string) {
          const next = insertAgentMention(draftNow.current, selection.current.end, name);
          put(next.text, next.caret);
        },
      };
    },
    [],
  );
```

6. `<TextInput` 里：

```tsx
          onChangeText={setDraft}
```

之后加：

```tsx
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
```

- [ ] **Step 6: 「@ 谁」的钮与抽屉**

Create `mobile/src/chat/MentionSheet.tsx`：

```tsx
// 「@ 谁」（#1356 A3，spec §5.6）：群聊输入框上方那颗钮 + 点开的底部抽屉。抽屉只列这个群里的智能体，
// 点一只就收；`@名字 ` 等抽屉退场放完再插进输入框（调用方在 onExited 里插——抽屉的 Modal 还在的时候
// 输入框拿不到焦点）。插在哪由 shared 的 insertAgentMention 判；发出去时点了谁仍由 resolveSendMentions
// 说了算（与桌面同一份）。私聊里不画这颗钮（名单里只有它一只）；空群也不画（没有谁可点）。
import { useRef } from "react";
import { Animated, Pressable, ScrollView, Text } from "react-native";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { AgentPickRow } from "../group/AgentPickRow.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { PRESS_SPRING, space, usePalette } from "../theme.js";
import { Group, useReduceMotion } from "../ui.js";

/** 抽屉底下那一句：不 @ 谁时谁接（ADR-0270 的派活）。demo 那句后面补了「都不对口就没人接」——
    群里闲聊没人接是那边定的口径，不说的话人会一直等 */
export const MENTION_FOOTER = "不 @ 谁 = 它们自己认领：读一遍名册和最近几句，挑职责对口的那只；都不对口就没人接。";

/** 输入框上方那颗「@ 谁」：按下缩到 .96（同 RoleChips 的 chip），关了动效退成变暗 */
export function MentionChip({ onPress }: { onPress: () => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="@ 谁"
      accessibilityHint="挑一只智能体接这一句，它的名字会插进输入框"
      hitSlop={6}
      onPressIn={() => to(0.96)}
      onPressOut={() => to(1)}
      onPress={onPress}
      style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
    >
      <Animated.View
        style={{
          height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: "center",
          backgroundColor: c.secondary, transform: [{ scale }],
        }}
      >
        <Text style={{ fontSize: 13.5, color: c.foreground }}>@ 谁</Text>
      </Animated.View>
    </Pressable>
  );
}

export function MentionSheet({ visible, ws, agentIds, onPick, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  /** 这个群此刻的名单（已与现存名册求过交集、名册顺序） */
  agentIds: string[];
  onPick: (agentId: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="点谁接这一句" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ padding: space.md }}>
        <Group footer={MENTION_FOOTER}>
          {agentIds.map((id) => (
            <AgentPickRow key={id} ws={ws} agentId={id} onPress={() => onPick(id)} />
          ))}
        </Group>
      </ScrollView>
    </BottomSheet>
  );
}
```

- [ ] **Step 7: 聊天页接上**

`mobile/src/chat/ChatScreen.tsx`：

1. 头注里 `// · 状态（spec §6）：gone 一行「正在重连…」、发送钮灰；denied 是终态，说清是哪一种 +「回名册」。` 之后加：

```
// · 群聊（A3，spec §5.6）：输入框上方一颗「@ 谁」→ 抽屉挑一只 → 抽屉退场放完插进 `@名字 `；空群（最后一只
//   被移出了）输入框上方一行实话、不画「@ 谁」；占位字「说给这一组听…」。
```

2. import：

```ts
import { Composer, type ComposerHandle } from "./Composer.js";
```

之后加：

```ts
import { MentionChip, MentionSheet } from "./MentionSheet.js";
```

3. `const EMPTY_EVENTS: SessionEvent[] = [];` 之后加：

```ts
/** 空群（A3：最后一只也移得走）的那句实话：没有人在，说的话没人接，出路在群设置 */
const EMPTY_GROUP_TEXT = "这个群里没有智能体了，说的话没人接。去群设置里加一只。";
```

4. `Hello` 里群那一支：

```tsx
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} />
```

换成：

```tsx
  if (agentIds.length === 0) {
    // 空群：没有谁「都在」
    return <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{EMPTY_GROUP_TEXT}</Text>;
  }
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} />
```

5. `const [stopping, setStopping] = useState(false);` 之后加：

```ts
  /** 「@ 谁」那张抽屉开着没有；挑中的名字等抽屉退场放完再插（Modal 还在时输入框拿不到焦点） */
  const [mentioning, setMentioning] = useState(false);
  const pendingMention = useRef<string | null>(null);
```

6. Task 6 加的 `const onSettings =` 那一段之后加：

```tsx
  const emptyGroup = kind === "group" && session !== null && agentIds.length === 0;
  const canMention = kind === "group" && session !== null && agentIds.length > 0;
```

7. 输入框上方那几行里，「不确定有没有发出去」那一块结束处：

```tsx
              <Button size="auto" variant="plain" label="放弃" onPress={dropUnsent} />
            </View>
          ) : null}
        </View>

        <Composer
```

换成：

```tsx
              <Button size="auto" variant="plain" label="放弃" onPress={dropUnsent} />
            </View>
          ) : null}
          {emptyGroup && centre !== "hello" ? <Line tone="muted">{EMPTY_GROUP_TEXT}</Line> : null}
        </View>

        {canMention ? (
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 8 }}>
            <MentionChip onPress={() => setMentioning(true)} />
          </View>
        ) : null}

        <Composer
```

8. 占位字：

```tsx
          placeholder={roleAnchor !== null ? "说一句它是干什么的…" : kind === "dm" ? `跟「${title}」说…` : "说点什么…"}
```

换成：

```tsx
          placeholder={roleAnchor !== null ? "说一句它是干什么的…" : kind === "dm" ? `跟「${title}」说…` : "说给这一组听…"}
```

9. 页底 `<ChatHeader … />` 之后（`</View>` 与 `);` 之前）加：

```tsx
      {ws !== null ? (
        <MentionSheet
          visible={mentioning}
          ws={ws}
          agentIds={agentIds}
          onPick={(agentId) => {
            pendingMention.current = agentNameOf(ws, agentId);
            setMentioning(false);
          }}
          onClose={() => setMentioning(false)}
          onExited={() => {
            const name = pendingMention.current;
            pendingMention.current = null;
            if (name !== null) composer.current?.mention(name);
          }}
        />
      ) : null}
```

- [ ] **Step 8: 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npx tsc --noEmit -p mobile/tsconfig.json 2>&1 | head -20 && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 两条都没有输出。

- [ ] **Step 9: Commit**

message：

```
feat(mobile): 群聊的「@ 谁」——输入框上方一颗钮，抽屉挑一只，插在光标处（#1356 A3）

spec §5.6。插在哪是一条判断，写进 shared 的 insertAgentMention：光标停在一个没打完的 @ 后面时
替换那一截；光标前面贴着构词字符时先补一个空格——parseMentions 要 @ 前是行首或非构词字符，贴上去
的「看下@运维」认不出，resolveSendMentions 会把它当成打错的名字整句拦下。挑中的名字等抽屉退场放完
再插（Modal 还在时输入框拿不到焦点）。顺带：群聊占位字「说给这一组听…」；空群（最后一只被移出了）
输入框上方一行实话、不画「@ 谁」，开场那一屏不再说「都在」。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add src/shared/agentMentionInput.ts tests/shared/agentMentionInput.test.ts mobile/src/chat/Composer.tsx mobile/src/chat/MentionSheet.tsx mobile/src/chat/ChatScreen.tsx && git commit -F .superpowers/commit-msg.txt
```

---

### Task 8: 收尾——索引、README、spec 偏离、门禁、模拟器冒烟、PR

**Files:**
- Modify: `AGENTS.md`（Where to find things 加一条）
- Modify: `mobile/README.md`
- Modify: `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§10 追加 A3 的偏离）

**Interfaces:**
- Consumes: 前 7 个任务的全部产物。
- Produces: 一个合并了的 PR（Task issue #1356 的 A3 片，`Closes #1362`，**不关 #1356**），#1356 上一条进度评论，一个 context only 的交接 issue。

本片没有架构级的新决定（服务端一行没改、协议不进位，判据都是 spec §5.6 的落地），**不写 ADR**；实现期间定下的偏离写进 spec §10。

- [ ] **Step 1: AGENTS.md 索引**

`AGENTS.md` 的 Where to find things 里，`src/shared/agentOnboarding.ts` 开头的那一条（A2）之后加一条：

```markdown
- `mobile/src/group/` / `src/shared/groupEdit.ts` / `mobile/src/chat/MentionSheet.tsx` / `src/shared/mobileChat.ts` 的名单行与派活那一句 — **手机端「智能体」单栏 A3：群聊的建、聊、设置**（#1356，spec §5.6）。判据在 shared：建群的勾选与群名（`groupEdit.ts`：名单一律按名册顺序、满 6 只时没勾的锁住而勾上的照样点得动、不到 2 只「建」按不动、群名留空用成员名拼**并按码点截到 60 字以内**——拼出来超长的话 create 帧整帧被拒、没有回执，客户端白等满 15 秒再说「云端无响应」，桌面建群弹窗同一处一起改用它）、加 / 移之后的完整名单（`chat_update` 收名单不收「加了谁」）；时间线上名单变了那一行（`chatRosterLineParts`，要看前一条，判据住在 `chatRows` 的循环里不在逐事件的谓词里，窗口里最早那条当建群那一条不画）与派活那一句（`dispatchLineText`：「没 @ 谁 —— 运维接了」，从 `user_message.dispatch` 投影，手机先画）；「@ 谁」插在光标处（`insertAgentMention`：光标前贴着构词字符时补一个空格——「看下@运维」parseMentions 认不出、会被当成打错的名字拦下）。群设置读名册那份清单不开房（名单当场生效、群名按「存」只发名字；空群合法；一次只做一件事），解散是删除（居中确认、右边那颗实底红——`DialogFooter` 的 `tone:"destructive"`，#1362）。**服务端一行没改、不进协议位、不用部署**；桌面那处群名截断随下一次桌面发版。真机登录后的流程一次没跑过
```

- [ ] **Step 2: 手机 README**

`mobile/README.md`：

1. 开头第三段 `…，A2 加上了名册右上的 ＋：建一只智能体，它先开口问你要它干什么，你答的那句就是它的职责；进度见 spec…` 里 `你答的那句就是它的职责；` 之后插入 `A3 接上了群聊（建群、群设置、输入框上方的「@ 谁」、时间线上名单变了那一行与派活那一句）；`，结果是：

```markdown
A0 立了基座，A1 接上了名册（主场的智能体与群混排、按最近一次动静排、可搜索）、聊天页与智能体设置，A2 加上了名册右上的 ＋：建一只智能体，它先开口问你要它干什么，你答的那句就是它的职责；A3 接上了群聊（建群、群设置、输入框上方的「@ 谁」、时间线上名单变了那一行与派活那一句）；进度见 spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §8。
```

2. 「## 结构」清单：`- src/nav/：…` 那一行里 `名册（无头，自己画浮在内容上的圆钮）/ 聊天（同上）/ 智能体设置 / 账号` 改成 `名册（无头，自己画浮在内容上的圆钮）/ 聊天（同上）/ 智能体设置 / 建群 / 群设置 / 账号`；`- src/chat/：…` 那一行换成：

```markdown
- `src/chat/`：聊天页（头部药丸 / 时间线 / 此刻 / 输入框 / 草稿 / 新建的那只开口之后的六句现成话 / 群聊的「@ 谁」）
```

并在 `- src/agent/：…` 那一行之后加：

```markdown
- `src/group/`：建群页、群设置、「加一只进来」抽屉，与它们共用的「一只智能体占一行」
```

- [ ] **Step 3: spec §10 追加 A3 的偏离**

在 `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §10 的第 42 条之后、「（写 plan / 实现期间的偏离追加在这里。）」之前追加：

```markdown
43. **「一个群聊」在名册不到两只时按不动**，副标题照实说「至少要两只智能体才凑得成一个群。」：点进去是一页永远按不动「建」的表（#722）。名册里永远有管理员，所以这只在「只有它一只」时发生。
44. **群名留空时拼出来的名字按码点截到 60 字以内**（`CHAT_NAME_MAX`，末尾一个「…」，`groupEdit.groupNameFor`）：cs 协议的群名要 1–60 字，拼出来超长的话 create 帧整帧被拒、没有回执，客户端白等满 15 秒再说「云端无响应」；桌面建群弹窗同一处一起改用它（原来那份没截）。
45. **建群页群名那一格的占位字是此刻勾选的那几只拼出来的名字**（一只都没勾时是「比如『发版组』」）：留空时发出去的正是它。
46. **建成之后换成（replace）那条群聊**：返回回到名册，不回到那张表；名册没读回来就退回名册（那里有读不到的那句话 + 重试钮），不推一页「这条聊天已经不在了」。
47. **「加一只」点一只就加那一只、抽屉就收**（demo 的 addMember），不是桌面那种多选再「拉进来」；加的时候抽屉锁住，失败那句话留在抽屉里。
48. **群设置的「存」只存群名**（移出 / 加一只当场生效，各发一次 `chat_update`、发的是变动之后的完整名单），存完退回聊天页（同智能体设置）；一次只做一件事（有一个在路上时别的钮都按不动——两条 `chat_update` 前后脚发出去，后到的那份名单会把先到的覆盖回去）。群设置读名册那份清单、不开房。
49. **解散的确认文案用 demo 的那句**（「这条线会删掉，不可恢复。里面那几只都还在，它们各自的线一个字不少。」），组尾那句用 §5.6 的「解散只删这条线，里面那几只都还在。」；成了先回名册再刷新（反过来这一页会先闪一下「这个群已经不在了」）。
50. **派活那一句不带 demo 括号里那段职责**（demo 写「运维接了（它管部署）」）：职责最长 200 字，挂在一行旁白上要么截断、要么撑成一段；想知道它管什么，点进群设置看。
51. **名单变了那一行的脸是 s 档（26 高）**，不是 demo 的 16：手机端的脸只有 s / m / l 三档（§3.1），再小一档每格不到半个点。窗口里最早那条名单事件（尾巴模式，往前还有没拉下来的）没有前一条可比，当建群那一条不画，往前翻一页之后它自己会出现（说不清就不画）。
52. **「@ 谁」插在光标处**（`insertAgentMention`）：光标停在一个没打完的 @ 后面时替换那一截；光标前面贴着字时先补一个空格——「看下@运维」parseMentions 认不出、发送时会被当成打错的名字拦下。抽屉底下那一句在 demo 那句后面补了「都不对口就没人接」（ADR-0270：群里闲聊没人接，不说的话人会一直等）。「@ 谁」只在群聊里、名单不空时画。
53. **空群**（最后一只被移出了）：聊天页输入框上方一行「这个群里没有智能体了，说的话没人接。去群设置里加一只。」、不画「@ 谁」，开场那一屏也说这一句（不再说「都在」）；群设置「里面有谁」写「这个群里没有智能体了」，「加一只」照常。
54. **确认弹窗右边那颗可以是实底红**（`DialogFooter` 的 `tone: "destructive"`，#1362）：解散群与 A1 的删掉一只都用它；平时的破坏性入口仍是红字红边。
55. **群聊输入框的占位字是「说给这一组听…」**（demo 的 groupChat）。
```

- [ ] **Step 4: 全量门禁**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && npm test > .superpowers/a3-gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/a3-gate.log`
Expected: `GATE_EXIT=0`；Test Files 635 passed（基线 634 + `groupEdit.test.ts`）、Tests 比基线的 7919 多出本片新增的那些，全 passed。**判据只认 GATE_EXIT。**

- [ ] **Step 5: 模拟器冒烟（不登录能验的部分）**

登录后的屏进不去（agent 不替人输密码），所以用一个**不提交**的临时根组件验本片画出来的东西（方法见 memory 的 mobile-sim-smoke-expo-go）。

1. Create `mobile/src/dev/A3Harness.tsx`（**不提交**）：

```tsx
// 临时冒烟用（#1356 A3 Task 8），不提交：验完 git checkout -- mobile/index.ts、删掉这个文件
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { addChoice, withAgent, withoutAgent } from "../../../src/shared/groupEdit.js";
import { chatRows } from "../../../src/shared/mobileChat.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { ChatRowView } from "../chat/ChatRows.js";
import { Composer, type ComposerHandle } from "../chat/Composer.js";
import { MentionChip, MentionSheet } from "../chat/MentionSheet.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { AddMemberSheet } from "../group/AddMemberSheet.js";
import { GroupSettingsBody } from "../group/GroupSettingsBody.js";
import { NewGroupForm } from "../group/NewGroupForm.js";
import { NewThingDialog } from "../roster/NewThingDialog.js";
import { usePalette } from "../theme.js";
import { Button } from "../ui.js";

const agent = (agentId: string, name: string, description = "") => ({
  agentId, name, description, instructions: "", models: [], tools: [], createdBy: "u", updatedTs: 0, avatarSlot: null,
});
const WS = {
  id: "w", name: "我的智能体", ownerUid: "u", kind: "home", sandboxApproval: "ask", members: [], connectors: [], sessions: [],
  agents: [
    agent("admin", "管理员", "帮你建智能体，接没人对口的活"), agent("a_000000000001", "开发", "写代码、改 bug"),
    agent("a_000000000002", "运维", "部署、看日志"), agent("a_000000000003", "设计", "改文案、出图"),
    agent("a_000000000004", "客服", "回消息"), agent("a_000000000005", "财务", "对账"), agent("a_000000000006", "法务", "看合同"),
  ],
} as unknown as WorkspaceSnapshot;
const T = Date.now();
const EVENTS = [
  { seq: 1, sessionId: "s", ts: T, type: "chat_roster_changed", ignorable: true,
    agents: [{ agentId: "a_000000000001", name: "开发" }, { agentId: "a_000000000002", name: "运维" }] },
  { seq: 2, sessionId: "s", ts: T, type: "user_message", content: "[我]: 这版谁先发", fromUid: "u",
    mentions: ["a_000000000002"], dispatch: "auto" },
  { seq: 3, sessionId: "s", ts: T, type: "chat_roster_changed", ignorable: true, byUid: "u",
    agents: [{ agentId: "a_000000000001", name: "开发" }, { agentId: "a_000000000002", name: "运维" }, { agentId: "a_000000000003", name: "设计" }] },
  { seq: 4, sessionId: "s", ts: T, type: "chat_roster_changed", ignorable: true, byUid: "u",
    agents: [{ agentId: "a_000000000001", name: "开发" }, { agentId: "a_000000000003", name: "设计" }] },
] as unknown as SessionEvent[];

function Inner() {
  const { c } = usePalette();
  const [view, setView] = useState<"new" | "settings" | "chat">("new");
  const [fork, setFork] = useState(false);
  const [groupReady, setGroupReady] = useState(true);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>(["a_000000000001", "a_000000000002"]);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [mentioning, setMentioning] = useState(false);
  const pending = useRef<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const choice = addChoice(WS, members);
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: 60 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Button size="sm" variant="outline" label="＋ 新建" onPress={() => setFork(true)} />
        <Button size="sm" variant="outline" label={groupReady ? "名册够两只" : "名册只有一只"} onPress={() => setGroupReady((v) => !v)} />
        <Button size="sm" variant="outline" label="建群页" onPress={() => setView("new")} />
        <Button size="sm" variant="outline" label="群设置" onPress={() => setView("settings")} />
        <Button size="sm" variant="outline" label="聊天" onPress={() => setView("chat")} />
      </View>
      {view === "new" ? (
        <NewGroupForm ws={WS} name={name} picked={picked} busy={false} error={null} onName={setName} onPicked={setPicked} />
      ) : view === "settings" ? (
        <GroupSettingsBody
          ws={WS}
          agentIds={members}
          name="发版组"
          onName={() => {}}
          busy={false}
          removingId={null}
          addReason={choice.reason}
          error={null}
          onRemove={(id) => setMembers((m) => withoutAgent(WS, m, id))}
          onAdd={() => setAdding(true)}
          onDissolve={() => setConfirming(true)}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
            {chatRows({ events: EVENTS, ws: WS, selfUid: "u", now: T }).map((row) => (
              <ChatRowView key={row.key} row={row} ws={WS} />
            ))}
          </ScrollView>
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 8 }}>
            <MentionChip onPress={() => setMentioning(true)} />
          </View>
          <Composer ref={composer} placeholder="说给这一组听…" canSend sessionId={null} onSend={async () => true} />
        </View>
      )}
      <NewThingDialog
        visible={fork}
        groupFaces={WS.agents.slice(0, 3).map((a, i) => ({ id: a.agentId, slot: [6, 4, 7][i]! }))}
        groupReady={groupReady}
        onAgent={() => setFork(false)}
        onGroup={() => { setFork(false); setView("new"); }}
        onDismiss={() => setFork(false)}
        onExited={() => {}}
      />
      <AddMemberSheet
        visible={adding}
        ws={WS}
        candidates={choice.candidates}
        busyId={null}
        error={null}
        onPick={(id) => { setMembers((m) => withAgent(WS, m, id)); setAdding(false); }}
        onClose={() => setAdding(false)}
      />
      <Dialog visible={confirming}>
        <DialogTitle>解散「发版组」？</DialogTitle>
        <DialogLead>这条线会删掉，不可恢复。里面那几只都还在，它们各自的线一个字不少。</DialogLead>
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirming(false) }}
          right={{ label: "解散", onPress: () => setConfirming(false), tone: "destructive" }}
        />
      </Dialog>
      <MentionSheet
        visible={mentioning}
        ws={WS}
        agentIds={["a_000000000001", "a_000000000002"]}
        onPick={(id) => { pending.current = WS.agents.find((a) => a.agentId === id)!.name; setMentioning(false); }}
        onClose={() => setMentioning(false)}
        onExited={() => { const n = pending.current; pending.current = null; if (n !== null) composer.current?.mention(n); }}
      />
    </View>
  );
}

export default function A3Harness() {
  return (
    <SafeAreaProvider>
      <Inner />
    </SafeAreaProvider>
  );
}
```

2. `mobile/index.ts`（**不提交**）：`import App from './App';` 下面加 `import A3Harness from './src/dev/A3Harness';`，最后一行改成 `registerRootComponent(true ? A3Harness : App);`（留着 `App` 的引用，tsc 照样干净）。
3. 起 Metro（CI 模式没有热更新，改了代码要重起）：`cd mobile && CI=1 EXPO_NO_TELEMETRY=1 npx expo start --port 8081`（后台跑）。另开一条：`xcrun simctl list devices booted` 拿 udid → `xcrun simctl terminate <udid> host.exp.Exponent`（不先杀掉的话 openurl 会复用内存里的旧包）→ `xcrun simctl openurl <udid> exp://127.0.0.1:8081`，Metro 日志里出现 `iOS Bundled …`。
4. 逐项记录结果（`xcrun simctl io <udid> screenshot <文件>` 截图看）：
   - ＋ 新建 →「一个群聊」那一行按得动、副标题「把几只放进同一条线…」；切成「名册只有一只」再开：那一行变淡、副标题「至少要两只智能体才凑得成一个群。」、点了没反应。
   - 建群页：群名那一格占位字随勾选变（勾「运维」「开发」→「开发、运维」，名册顺序）；组头「把谁放进去 · 已选 N / 6」跟着变；勾满六只后第七只变淡、点不动，勾上的照样点得掉；右边的勾是点缀色；组尾那句在。
   - 群设置：两行各带「移出」小胶囊（30 高）；点「移出」那一行消失；移到空时出现「这个群里没有智能体了」；「加一只」是点缀色、左边一个 ＋；点开抽屉「加一只进来」只列不在群里的、组尾「最多六只。」、点一只抽屉收、名单多一行；加到六只时「加一只」变淡、右边写「群里已经有六只了」；「解散这个群」红字居中，点开居中弹窗、右边那颗**实底红**。
   - 聊天：时间线上建群那一条不画；「没 @ 谁 —— 运维接了」排在「这版谁先发」底下、居中；「你把「设计」拉进了群聊」「你把「运维」移出了群聊」两行居中、名字左边一张 s 档的脸；点「@ 谁」→ 抽屉「点谁接这一句」、组尾那句在 → 点「运维」→ 抽屉收完之后输入框里是「@运维 」、键盘弹起、光标在末尾；先打「帮我看下」再点「@ 谁」挑「开发」→「帮我看下 @开发 」。
   - 深色模式（`xcrun simctl ui <udid> appearance dark`）下再看一遍群设置与确认弹窗，验完 `appearance light` 还原。
5. **还原**：`git checkout -- mobile/index.ts`、删掉 `mobile/src/dev/A3Harness.tsx`、`git status --porcelain` 确认干净。停掉 Metro。
6. **没跑（要登录，agent 不能替人输密码）**：真的建一个群（create → 名册刷新、新群那一行入场 → 换成那条群聊）、群里说一句不 @ 谁的话看派活那一句、在群设置里改名 / 移出 / 加一只 / 解散、聊天页头部那排脸跟着名单变、桌面上打开手机建的群。PR 里原样列给维护者点。

若 Expo CLI 提示要装 / 升级 Expo Go：**先问维护者**（那是往模拟器里下载一个 app），不要自动接受。

- [ ] **Step 6: Commit 文档**

message：

```
docs: A3 的索引、手机 README 与 spec §10 偏离（#1356 A3）

AGENTS.md 索引加一条（群聊的判据在哪、为什么群名要截、名单那一行为什么不进逐事件的谓词、
「@ 谁」为什么要补空格）；README 跟上建群 / 群设置 / @ 谁；spec §10 追加实现期间的十三处偏离
（第 43–55 条）。本片没有架构级的新决定、服务端一行没改，不写 ADR。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git add AGENTS.md mobile/README.md docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md && git commit -F .superpowers/commit-msg.txt
```

- [ ] **Step 7: 推送、开 PR、等 CI、合并**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git fetch origin && git merge --no-edit origin/main
```

main 有新提交时合进来、解冲突、重跑一遍 Step 4 的门禁。然后：

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a3-324455 && git push -u origin claude/mobile-a3-324455
```

PR 正文写进 `.superpowers/pr-body.md` 再 `gh pr create --base main --title "feat(mobile): 智能体单栏 A3——群聊：建群、群设置、@ 谁、名单那一行与派活那一句（#1356）" --body-file .superpowers/pr-body.md`。正文要有：Task issue #1356（A3，**不关 issue**）+ `Closes #1362`；spec / plan；做了什么（按任务分组）；测试变动（新增 `tests/shared/groupEdit.test.ts`，另三个 shared 测试文件与 `NewGroupDialog.test.tsx` 各加了几条；桌面两个组件既有用例一条没改）；**部署：不用**（服务端一行没改、没有 migration、不进协议位；手机端 Expo Go 重新载入；桌面那处群名截断随下一次桌面发版）；验证（门禁两行 + GATE_EXIT、冒烟逐项结果、没跑的那几项）。末尾：

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

CI 由 controller 盯（按 sha 等 `gate` 跑完，CI 绿之前不合并——本仓没有 required check，`mergeStateStatus` 为 CLEAN 不代表 CI 过了）。绿了用 merge commit 合并：`gh pr merge <PR号> --merge --match-head-commit <sha>`。

- [ ] **Step 8: 合并之后**

- 在 #1356 上评论：A3 已合（PR 号、merge commit）；**不用跑库、不用部署**；登录后要点的那几项（Step 5 第 6 条）；本轮 A0–A3 至此做完，A4（语音）/ A5（账号与那台电脑）各自另开 plan（spec §8）。
- 开一个交接 issue（**context only**，ADR-0048）：标题「交接（context only）：#1356 A3（群聊）已合，本轮 A0–A3 做完」，正文写现状（合了什么、没跑的真机项）、下一步建议（A4 / A5 的 plan；#1361 / #1360 两条挂账），Memory 五段（① 做完了什么 ② 卡在哪（真机登录流程没跑） ③ 下一步 ④ 这条 issue 读完即关 ⑤ 理由 / 取舍：群名截断顺手改了桌面、#1362 并进来、没写 ADR 的理由）。
- 收拾 worktree：`npm run lane:prune`（dry-run 先看），确认本 lane 已合并干净再 `-- --apply`。
