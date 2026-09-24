# 手机端「智能体」单栏 A1——名册 + 私聊 + 智能体设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端名册接上真数据（主场的智能体 + 群，混排、按最近一次动静降序，可搜索），点进去是能聊的聊天页（私聊为主，群聊先有基础版），从私聊进智能体设置（名字 / 职责 / 交代 / 换形象 / 删掉）；后端补上名册要的「最后一句 + 最近动静」投影。

**Architecture:** 所有判据写进 `src/shared/`（进 vitest），手机端只画。桌面云会话 store 里的两条状态规则、桌面主进程里改 / 删智能体的编排，先原样抽进 shared、桌面改成调用（行为不变，桌面现有测试兜底），手机端再用同一份。手机端直连 Supabase（用户 JWT + RLS），云会话走 A0 已挪进 shared 的 `createCloudSessionClient`，推送进一个 `useSyncExternalStore` 的外部 store。runtime 在 `notify` 里把「最后一句」按 3 秒节流写进 `workspace_sessions` 新加的三列。

**Tech Stack:** Expo SDK 57 / RN 0.86 / react-native-svg 15.15 / expo-blur / @react-navigation native-stack 7；本片新增 `react-native-reanimated` 4.5.1 + `react-native-gesture-handler` ~2.32.0 + `react-native-worklets` 0.10.1（底部抽屉）；Supabase；vitest；runtime（Node，`services/runtime/`）。

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（本片对应 §4 底部抽屉、§5.2 名册、§5.3 私聊、§5.4 智能体设置、§6 状态与降级、§7.1 后端、§3.2 删智能体编排、§8 A1 一行）。执行者先读 spec 这几节再动手。

## Global Constraints

- 手机端（`mobile/`）在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session` 文件（`tests/architecture.test.ts` 第 8 条会红）。类型 `SessionEvent` 从 `src/session/events.js` 取（在白名单里）。
- **两端共用的纯逻辑写进 / 挪进 `src/shared/`，不抄第二份**（spec §2）。手机端不进 vitest、只跑 tsc，所以凡是「判断」都放 shared 并带测试；RN 组件里只剩接线与样式。
- 依赖：本片**只**新增 `react-native-reanimated@4.5.1`、`react-native-gesture-handler@~2.32.0`、`react-native-worklets@0.10.1`（版本取 `mobile/node_modules/expo/bundledNativeModules.json`，ADR-0293 决定 3：跟第一个底部抽屉一起进）。不加别的依赖。
- 设计令牌逐值取自 `mobile/src/theme.ts`；尺寸逐值取自 spec §4 / demo。界面文案不出现「水獭」。
- 名字必填：校验走 shared 的 `validateAgentName` + `agentNameConflict`（spec §3.3）。职责 ≤200 字、不许换行；「还有什么要交代的」≤4000 字（spec §5.4，常量 `AGENT_DESCRIPTION_MAX` / `AGENT_INSTRUCTIONS_MAX`）。
- 头像写回用 `pickSlotOf`：暂借格 1 / 2 / 10 不许存；挑头像那面墙只放 10 张（cap 没有自己的坑位，spec §5.4；**维护者 2026-09-24 确认**）。没换就不写。管理员没有「删掉」那一行。
- 名册**不画**「在跑没在跑」、不画未读（#722 / #1282）。进门七态照搬 `rosterGate`；还没查到 / 正在建主场画骨架、**不劝订阅**；没订阅 / 档位不带只写一句实话、不画钮（A5 之前手机上办不了订阅）；建失败 = 原因 + 重试钮、不自动重试。
- 状态与降级（spec §6）：还没查到 ≠ 没有 / 读不到 ≠ 空 / 说不清就不画钮。会话房四态：gone 时输入框上方一行「正在重连…」、输入框照常可打但发送钮灰；denied 是终态，说清是哪一种并给「回名册」。聊天身份三态照 ADR-0302（先按清单那一行种，welcome 覆盖；还不知道时不画壳）。
- 回执三态照 ADR-0228：`ok` / 确定失败（原文留在输入框、画原因）/ `unknown`（**清输入框**、另画一行「不确定有没有发出去」+「重新发送」「放弃」）。
- §7.1：migration 先、runtime 后；runtime 在列不存在时只记日志不崩；「最后一句」的判据是 shared 纯函数、runtime 只管 IO；桌面暂不读这三列。**不在生产库上跑 migration、不部署 runtime**——那是维护者合并后的事。
- 本片不新增事件类型、不改 cs 协议（协议号不动）、不改任何 Hard rule。
- TypeScript strict；根与 runtime 另开 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（shared 代码两边都要过）。可选字段不许显式赋 `undefined`，用 `...(x === undefined ? {} : { k: x })`。
- 门禁 `npm test`（根 tsc + edge tsc + runtime tsc + mobile tsc + vitest）。这个 worktree 的 `mobile/node_modules` 已经是本地安装（A0 换掉了软链），不要重新软链。
- 提交：小步提交，中文 message 写清「为什么」，末尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不许 `git stash`（worktree 共享 stash 栈）、不许 `--no-verify`。
- 若 shell 拒绝 heredoc 形式的 `git commit -m "$(cat <<'EOF' … EOF)"`，把 message 用编辑工具写进 `.superpowers/` 下的一个临时文件，再 `git commit -F <文件>`；message 内容照计划原文。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/workspaces.ts` | 改 | `WorkspaceAgentRow.createdTs?`（名册排序的最后一档退路） |
| `src/shared/workspaceView.ts` | 改 | `CloudSessionListRow` 改成 `CloudSessionRow` 的别名（A0 留的去重） |
| `src/shared/supabaseWorkspacesApi.ts` | 改 | agents 多选 `created_at`；新增 `fetchCloudLasts` |
| `src/shared/cloudSessionState.ts` | 新 | `insertCloudEvent` / `applyCloudStatus` / `cloudDeniedText` / `unknownSendNote`（从桌面抽出） |
| `src/shared/agentAdmin.ts` | 新 | `assertAgentNameFree` / `updateAgentChecked` / `deleteAgentEverywhere`（从桌面抽出） |
| `src/shared/sessionLast.ts` | 新 | 「最后一句」的判据：`lastOf` / `excerptOf` / `lastSpeakerOf` |
| `src/shared/mobileRoster.ts` | 新 | 名册一列：`rosterItems` / `filterRosterItems` / `rosterTimeLabel` / `groupFaceOffsets` |
| `src/shared/mobileChat.ts` | 新 | 聊天页：`chatRows` / `liveRows` / `nowRowOf` / `clockLabel` |
| `src/shared/agentSettingsForm.ts` | 新 | 设置页表单：`agentFormOf` / `agentFormErrors` / `agentFormPatch` / `pickableFaces` / `FACE_TOUR` |
| `src/renderer/src/store.ts` | 改 | 两个云会话回调改调 `insertCloudEvent` / `applyCloudStatus` |
| `src/renderer/src/components/CloudSessionPage.tsx` | 改 | 删本地 `cloudDeniedMessage` / `unknownNote`，改 import shared |
| `src/main/workspaceManager.ts` | 改 | `updateAgent` / `deleteAgent` / 名字查重改调 `agentAdmin` |
| `supabase/migrations/0040_workspace_sessions_last.sql` | 新 | `last_ts` / `last_excerpt` / `last_from` 三列（编号合并时认领） |
| `services/runtime/src/cloudSessionMeta.ts` | 改 | `setLast` |
| `services/runtime/src/lastWriter.ts` | 新 | 首尾两沿的 3 秒节流 |
| `services/runtime/src/sessionService.ts` | 改 | `notify` 里推进「最后一句」 |
| `mobile/package.json` / `package-lock.json` | 改 | 三个新依赖 |
| `mobile/App.tsx` | 改 | 根上包 `GestureHandlerRootView` |
| `mobile/src/sheet/BottomSheet.tsx` | 新 | 70% 底部抽屉（下拽可关、带动量） |
| `mobile/src/home/billing.ts` | 新 | `GET /billing/v1/me` |
| `mobile/src/home/homeStore.ts` | 新 | 主场快照 + 聊天清单 + 最后一句 + 建主场（外部 store） |
| `mobile/src/cloud/cloudClient.ts` | 新 | 手机端装配 shared 的云会话客户端 |
| `mobile/src/cloud/chatStore.ts` | 新 | 当前聊天的状态与动作（外部 store） |
| `mobile/src/chrome/Glyphs.tsx` | 新 | 用 View 画的四个小图标（返回 / 关闭 / 设置 / 搜索） |
| `mobile/src/agent/AgentSettingsScreen.tsx` | 新 | 智能体设置 |
| `mobile/src/agent/FacePickerSheet.tsx` | 新 | 「换个形象」抽屉 |
| `mobile/src/chat/ChatScreen.tsx` | 新 | 聊天页（头部药丸 / 时间线 / 此刻 / 输入框 / 草稿） |
| `mobile/src/chat/ChatRows.tsx` | 新 | 时间线各行的画法 |
| `mobile/src/chat/Composer.tsx` | 新 | 输入框 + 回执三态 |
| `mobile/src/roster/RosterScreen.tsx` | 重写 | 进门七态 + 混排一列 + 搜索 |
| `mobile/src/roster/RosterRow.tsx` | 新 | 名册一行（单只 / 群） |
| `mobile/src/nav/types.ts` / `RootNavigator.tsx` | 改 | `Chat` / `AgentSettings` 两条路由 |
| `docs/adr/0318-*.md` / `AGENTS.md` / `mobile/README.md` / spec §10 | 改 | 收尾文档（ADR 编号合并时认领） |

任务顺序：1–3 是桌面侧的小修与抽取（先让 shared 有东西），4–5 是后端（判据 + migration + 读查询 / runtime 写入），6–7 是手机要的纯逻辑，8 装依赖 + 抽屉，9 数据层，10–12 三屏（设置 → 聊天 → 名册：后者要导航到前两者），13 收尾。

**开工前（controller 做，不是某个任务）**：`git fetch origin && git merge --ff-only origin/main`——A0 合并后 main 上多了一个 merge commit，先快进过来再开 A1，免得 PR 里夹一段历史。Task 8 要从 npm 下载三个包——**维护者 2026-09-24 已同意**。

---
### Task 1: A0 留下的三处注释 + 智能体补一格 `createdTs` + 两份列表行类型并成一份

A0 终审挂账的三处都是注释（指针写的还是挪家前的路径、计数写错）；另外两件是本片名册要的前置：名册排序的最后一档退路是「智能体自己的 `created_at`」（spec §5.2），而快照里至今没有这一格；`CloudSessionListRow` 与 `CloudSessionRow` 形状逐字相同，A0 在注释里写明「去重留给 A1」。

**Files:**
- Modify: `src/shared/agentAvatarSlot.ts:1-2,19-20`
- Modify: `src/shared/agentAvatar.ts:3`
- Modify: `tests/architecture.test.ts:4`
- Modify: `src/shared/ottoFace/characters/index.ts:23`
- Modify: `AGENTS.md`（ottoFace 那一条里的「13 个坑位、10 个角色」）
- Modify: `src/shared/workspaces.ts`（`WorkspaceAgentRow`、`assembleSnapshot`）
- Modify: `src/shared/supabaseWorkspacesApi.ts:118-126`（`fetchWorkspace` 的 agents 查询）
- Modify: `src/shared/workspaceView.ts:204-219`（`CloudSessionListRow`）
- Test: `tests/shared/workspaces.test.ts`

**Interfaces:**
- Produces: `WorkspaceAgentRow.createdTs?: number`（epoch ms；缺席 = 旧夹具 / 旧 select，**不是 0**）；`CloudSessionListRow` = `CloudSessionRow`（`src/shared/supabaseWorkspacesApi.ts`，字段 `id, title, publisherUid, archived, updatedTs, participantUids, chatKind, agentIds`）。

- [ ] **Step 1: 改三处注释**

`src/shared/agentAvatarSlot.ts` 第 1–2 行改成：

```ts
// agentAvatarSlot —— 团队 agent 用哪个内置头像坑位（#971）。纯逻辑零 IO，像素形象
// 本身在 src/shared/ottoFace/ 里，这里只算「第几个坑位」。
```

同一文件第 19–20 行改成：

```ts
/** 内置头像的坑位数。与 `src/shared/ottoFace/sprites.ts` 的 `FACE_CHARACTERS` 个数一致
    （一个坑位对一个角色，#1345），由测试钉住 */
```

`src/shared/agentAvatar.ts` 第 3 行改成：

```ts
// 坑位算法在 agentAvatarSlot.ts（纯逻辑），像素脸的纯层在 src/shared/ottoFace/，canvas 那层在渲染层的 lib/ottoFace/paint.ts。
```

`tests/architecture.test.ts` 第 4 行里「其余五条」改成「其余六条」（1 + 1 + 6 = 八条，下面列的正是 3–8）：

```ts
// 八条边界。前两条是 AGENTS.md 的 Hard rules 原文,其余六条是各自 ADR 落下来的分层约束:
```

`src/shared/ottoFace/characters/index.ts` 第 23 行里「这边是 10 个角色」改成「这边是 11 个角色」（`FACE_PACKS` 里正好 11 个）：

```ts
/** 互不相同的角色本身。**坑位表在 sprites.ts** —— 那边是 13 格、这边是 11 个角色，
```

`AGENTS.md` 里 ottoFace 那一条（`grep -n '13 个坑位、10 个角色' AGENTS.md` 找到的那一处）把 `**13 个坑位、10 个角色**` 改成 `**13 个坑位、11 个角色**`。**同一段里「7 种眼形 × 10 个角色里 69 张是同构的」不要动**——那是写下时量出来的数，不是现状描述。

- [ ] **Step 2: 写失败的测试（`createdTs`）**

在 `tests/shared/workspaces.test.ts` 的 `describe("assembleSnapshot", …)` 里、「avatar_slot：…」那条用例之后加：

```ts
  it("agents：created_at → createdTs（ms）；列缺席（旧 select / 旧夹具）就不带这一格，不补 0", () => {
    const row = {
      agent_id: "a1", name: "运营", description: "", instructions: "",
      models: [], tools: [], created_by: "u2", updated_at: "2026-09-02T00:00:00.000Z",
    };
    const withCreated = assembleSnapshot(WS, [], [], [], [{ ...row, created_at: "2026-09-01T08:00:00.000Z" }], () => null);
    expect(withCreated.agents[0]!.createdTs).toBe(Date.parse("2026-09-01T08:00:00.000Z"));
    // 0 会被名册排序读成「1970 年建的」，排到最底下——缺席就是缺席
    const without = assembleSnapshot(WS, [], [], [], [row], () => null);
    expect("createdTs" in without.agents[0]!).toBe(false);
    // 解析不出来的时间同样不带（与 updated_at 的 toEpochMs 回 0 不同：这一格只用来排序，0 会撒谎）
    const bad = assembleSnapshot(WS, [], [], [], [{ ...row, created_at: "garbage" }], () => null);
    expect("createdTs" in bad.agents[0]!).toBe(false);
  });
```

- [ ] **Step 3: 跑一下确认失败**

Run: `npx vitest run tests/shared/workspaces.test.ts`
Expected: FAIL——新用例报 `createdTs` 是 `undefined`（以及对象字面量多了 `created_at` 的类型报错，vitest 不做类型检查，所以只看断言失败）。

- [ ] **Step 4: 实现**

`src/shared/workspaces.ts` 的 `WorkspaceAgentRow` 里、`updatedTs` 之后加一格：

```ts
  /** `workspace_agents.created_at`（ms）。手机名册排序的最后一档退路（没聊过的智能体
      按它排，spec §5.2）。**缺席只为存量测试夹具与解析不出的脏值留的**：0 会被排序读成
      「1970 年建的」、安静地沉到最底下，所以宁可不带这一格，也不补 0 */
  createdTs?: number;
```

`assembleSnapshot` 的 `agents` 参数类型里加 `created_at?: string;`（放在 `updated_at: string;` 后面），映射那一段改成：

```ts
    agents: agents.map((a) => {
      const created = a.created_at === undefined ? Number.NaN : Date.parse(a.created_at);
      return {
        agentId: a.agent_id,
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        models: normalizeStringArray(a.models),
        tools: normalizeAgentTools(a.tools),
        createdBy: a.created_by,
        updatedTs: toEpochMs(a.updated_at),
        avatarSlot: normalizeAvatarSlot(a.avatar_slot),
        ...(Number.isNaN(created) ? {} : { createdTs: created }),
      };
    }),
```

`src/shared/supabaseWorkspacesApi.ts` 的 `fetchWorkspace` 里，agents 那条查询的 select 串加上 `created_at`，行类型同步加一格：

```ts
  const agents = (unwrap(
    await client.from("workspace_agents")
      .select("agent_id,name,description,instructions,models,tools,created_by,created_at,updated_at,avatar_slot")
      .eq("workspace_id", id)
      .order("created_at", { ascending: true }),
  ) ?? []) as {
    agent_id: string; name: string; description: string; instructions: string; models: unknown;
    tools: unknown; created_by: string; created_at?: string; updated_at: string; avatar_slot?: unknown;
  }[];
```

（`created_at` 是 0021 起就有的列，不需要容错查询。）

`src/shared/workspaceView.ts` 里把 `CloudSessionListRow` 整个 interface（连同它上面那段「与 … 形状凑巧相同……去重留给 A1」的注释）替换成：

```ts
/** ShellBridge.workspaceCloudList 一行的形状。**就是** `supabaseWorkspacesApi` 的
    `CloudSessionRow`——原来两边各留一份、形状逐字相同，A0 注明「去重留给 A1」，
    这里并成一个别名（#1356 A1）。改字段只改那一份 */
export type CloudSessionListRow = CloudSessionRow;
```

并在该文件顶部 import 区加：

```ts
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run tests/shared/workspaces.test.ts && npx tsc --noEmit -p . && npx tsc --noEmit -p mobile`
Expected: PASS；两次 tsc 都无输出。

- [ ] **Step 6: Commit**

```bash
git add src/shared/agentAvatarSlot.ts src/shared/agentAvatar.ts tests/architecture.test.ts src/shared/ottoFace/characters/index.ts AGENTS.md src/shared/workspaces.ts src/shared/supabaseWorkspacesApi.ts src/shared/workspaceView.ts tests/shared/workspaces.test.ts
git commit -m "$(cat <<'EOF'
chore(shared): A0 挂账的三处注释 + 智能体补 createdTs + 列表行类型并成一份（#1356 A1）

- 三处注释：挪家之后指针还写着 lib/ottoFace/、架构测试头注「其余五条」实为六条、
  角色数写成 10 实为 11（A0 终审挂账，约好 A1 第一步改）
- WorkspaceAgentRow.createdTs：手机名册「没聊过的智能体按它自己的 created_at 排」
  （spec §5.2）要这一格。缺席不补 0——0 会让它安静地沉到名册最底下
- CloudSessionListRow 与 CloudSessionRow 形状逐字相同，A0 注明去重留给 A1，
  并成别名，之后改字段只改一处

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 2: 云会话在客户端那一格的状态规则抽进 shared（桌面 store 改用）

桌面渲染层 store 的两个回调里各有一条「抄错了不报错」的规则：事件按 seq 去重并插到对的位置（往前翻的那一页落在前面）；状态推送哪几格照抄、哪几格缺席就留着（`chat` 缺席 = welcome 还没到，读成团队会话就是 #1301）。手机端的 chat store 要做同两件事——照 spec「不抄第二份」，先原样抽进 shared，桌面改调。顺手把桌面云会话页里两句文案（denied 的人话、「不确定有没有发出去」）也挪进来，手机端要说同样的话。

**Files:**
- Create: `src/shared/cloudSessionState.ts`
- Modify: `src/renderer/src/store.ts`（`onCloudSessionEvent` 与 `onCloudSessionStatus` 两个回调里的 `set` updater）
- Modify: `src/renderer/src/components/CloudSessionPage.tsx`（删 `cloudDeniedMessage` / `unknownNote` 两个本地函数，改 import）
- Test: `tests/shared/cloudSessionState.test.ts`

**Interfaces:**
- Consumes: `CloudSessionStatus`（`src/shared/shellBridge.ts`：`state` / `deniedCode?` / `deniedServerVersion?` / `initiatorUid` / `ownerUid` / `selfUid` / `modelRoute` / `chat?` / `gapNote?` / `hasOlder?` / `notice?`）；`CS_PROTOCOL_VERSION`、`CsChatInfo`、`CsModelRoute`（`src/shared/remote/cloudSession.ts`）。
- Produces:
  - `insertCloudEvent(events: readonly SessionEvent[], event: SessionEvent): SessionEvent[] | null`（已有同 seq → `null`）
  - `interface CloudSessionCore { workspaceId; sessionId; state; deniedCode?; deniedServerVersion?; initiatorUid; ownerUid; selfUid; modelRoute; gapNote; chat; hasOlder }`
  - `applyCloudStatus(cur: CloudSessionCore, status: CloudSessionStatus): CloudSessionCore`
  - `cloudDeniedText(code: string | undefined, serverVersion?: number): string`
  - `unknownSendNote(text: string): string`

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/cloudSessionState.test.ts`：

```ts
// cloudSessionState —— 云会话客户端那一格的两条状态规则 + 两句文案（#1356 A1）。
// 规则原来长在桌面 store 的回调里（那边的集成测试照旧在 tests/renderer/ 里跑），
// 这份钉的是规则本身：手机端的 chat store 用的是同一份函数。

import { describe, expect, it } from "vitest";
import {
  applyCloudStatus, cloudDeniedText, insertCloudEvent, unknownSendNote, type CloudSessionCore,
} from "../../src/shared/cloudSessionState.js";
import { CS_PROTOCOL_VERSION } from "../../src/shared/remote/cloudSession.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudSessionStatus } from "../../src/shared/shellBridge.js";

const ev = (seq: number): SessionEvent =>
  ({ type: "session_archived", seq, sessionId: "s1", ts: 1000 + seq, by: "user" }) as unknown as SessionEvent;
const seqs = (es: readonly SessionEvent[] | null) => es?.map((e) => e.seq) ?? null;

describe("insertCloudEvent", () => {
  it("空的与比末尾大的走追加", () => {
    expect(seqs(insertCloudEvent([], ev(0)))).toEqual([0]);
    expect(seqs(insertCloudEvent([ev(0), ev(1)], ev(5)))).toEqual([0, 1, 5]);
  });
  it("同一个 seq 再来一次回 null（:gone 之后重连会把 backlog 全量再推一遍）", () => {
    expect(insertCloudEvent([ev(0), ev(1), ev(2)], ev(1))).toBeNull();
    expect(insertCloudEvent([ev(0), ev(1), ev(2)], ev(2))).toBeNull();
    expect(insertCloudEvent([ev(0)], ev(0))).toBeNull();
  });
  it("往前翻的那一页落在前面：按 seq 升序到达的一页逐条插，结果仍然升序", () => {
    let es: SessionEvent[] = [ev(10), ev(11)];
    for (const s of [3, 4, 5]) es = insertCloudEvent(es, ev(s))!;
    expect(seqs(es)).toEqual([3, 4, 5, 10, 11]);
  });
  it("插在中间", () => {
    expect(seqs(insertCloudEvent([ev(1), ev(5)], ev(3)))).toEqual([1, 3, 5]);
  });
  it("不改入参（store 靠引用变化判断要不要重画）", () => {
    const before = [ev(1), ev(5)];
    insertCloudEvent(before, ev(3));
    expect(seqs(before)).toEqual([1, 5]);
  });
});

const core = (o: Partial<CloudSessionCore> = {}): CloudSessionCore => ({
  workspaceId: "w1", sessionId: "s1", state: "connecting",
  initiatorUid: null, ownerUid: "", selfUid: "me",
  modelRoute: null, gapNote: null, chat: undefined, hasOlder: false,
  ...o,
});
const status = (o: Partial<CloudSessionStatus> = {}): CloudSessionStatus => ({
  workspaceId: "w1", sessionId: "s1", state: "ready",
  initiatorUid: "u1", ownerUid: "owner", selfUid: "me", modelRoute: null,
  ...o,
});

describe("applyCloudStatus", () => {
  it("state / initiator / owner / self / modelRoute 照抄", () => {
    const next = applyCloudStatus(core(), status({ modelRoute: { kind: "blocked", reason: "x" } as never }));
    expect(next).toMatchObject({ state: "ready", initiatorUid: "u1", ownerUid: "owner", selfUid: "me" });
    expect(next.modelRoute).toEqual({ kind: "blocked", reason: "x" });
  });
  it("gapNote / hasOlder 照抄推送、**缺席即结论**（补齐了就不带，留旧值等于说一句不成立的话）", () => {
    const withGap = applyCloudStatus(core(), status({ gapNote: "缺了 3 条", hasOlder: true }));
    expect(withGap.gapNote).toBe("缺了 3 条");
    expect(withGap.hasOlder).toBe(true);
    const healed = applyCloudStatus(withGap, status());
    expect(healed.gapNote).toBeNull();
    expect(healed.hasOlder).toBe(false);
  });
  it("chat **缺席就留着种子**（#1301：welcome 每条连接只说一次），null / 值才覆盖", () => {
    const seeded = core({ chat: { kind: "dm", agentIds: ["a_000000000001"] } });
    expect(applyCloudStatus(seeded, status()).chat).toEqual({ kind: "dm", agentIds: ["a_000000000001"] });
    expect(applyCloudStatus(seeded, status({ chat: null })).chat).toBeNull();
    const group = { kind: "group" as const, agentIds: ["admin", "a_000000000001"] };
    expect(applyCloudStatus(core(), status({ chat: group })).chat).toEqual(group);
  });
  it("deniedCode / deniedServerVersion 来了才覆盖、没来就留着", () => {
    const denied = applyCloudStatus(core(), status({ state: "denied", deniedCode: "version_mismatch", deniedServerVersion: 19 }));
    expect(denied.deniedCode).toBe("version_mismatch");
    expect(denied.deniedServerVersion).toBe(19);
    const again = applyCloudStatus(denied, status({ state: "denied" }));
    expect(again.deniedCode).toBe("version_mismatch");
    expect(again.deniedServerVersion).toBe(19);
  });
  it("没来的可选键不会被写成 undefined（exactOptionalPropertyTypes：键不存在与值是 undefined 是两回事）", () => {
    const next = applyCloudStatus(core(), status());
    expect("deniedCode" in next).toBe(false);
    expect("deniedServerVersion" in next).toBe(false);
  });
  it("不改入参", () => {
    const before = core();
    applyCloudStatus(before, status({ gapNote: "x" }));
    expect(before.gapNote).toBeNull();
    expect(before.state).toBe("connecting");
  });
});

describe("cloudDeniedText", () => {
  it("五个码逐一给人话", () => {
    expect(cloudDeniedText("bad_jwt")).toBe("登录状态已过期，请重新登录后再试");
    expect(cloudDeniedText("not_member")).toBe("你不是这个团队的成员");
    expect(cloudDeniedText("no_session")).toBe("云会话不存在或已归档");
    expect(cloudDeniedText("not_authorized")).toBe("没有权限执行此操作");
    expect(cloudDeniedText("version_mismatch")).toBe("客户端版本与云端不匹配，请更新 Mr Otto 后再试");
  });
  it("版本不匹配说得出方向：服务端比本端低 = 云端还没升级", () => {
    expect(cloudDeniedText("version_mismatch", CS_PROTOCOL_VERSION - 1)).toBe(
      `云端协议版本（${CS_PROTOCOL_VERSION - 1}）低于本客户端（${CS_PROTOCOL_VERSION}），云端还没升级，联系维护者`,
    );
    expect(cloudDeniedText("version_mismatch", CS_PROTOCOL_VERSION + 1)).toBe("客户端版本与云端不匹配，请更新 Mr Otto 后再试");
  });
  it("认不出的码原样带出来，缺席给通用那句", () => {
    expect(cloudDeniedText("weird")).toBe("无法加入云会话（weird）");
    expect(cloudDeniedText(undefined)).toBe("无法加入云会话");
  });
});

describe("unknownSendNote", () => {
  it("正文只回显前 40 字", () => {
    expect(unknownSendNote("你好")).toBe("没有收到回执，不确定有没有发出去：你好");
    const long = "字".repeat(41);
    expect(unknownSendNote(long)).toBe(`没有收到回执，不确定有没有发出去：${"字".repeat(40)}…`);
  });
});
```

- [ ] **Step 2: 跑一下确认失败**

Run: `npx vitest run tests/shared/cloudSessionState.test.ts`
Expected: FAIL（`Cannot find module '../../src/shared/cloudSessionState.js'`）

- [ ] **Step 3: 实现 shared 模块**

Create `src/shared/cloudSessionState.ts`：

```ts
// cloudSessionState —— 云会话在客户端那一格的两条状态规则 + 两句文案（#1356 A1）。
//
// 桌面渲染层的 store 与手机端的 chat store 做同两件事：事件推送来了插到哪儿、状态推送
// 来了哪几格照抄哪几格留着。两条都是「抄错了不报错」的——插错位置时间线乱序且一行都不
// 报错；把 chat 的缺席读成团队会话就是 #1301。原来长在桌面 store.ts 的两个回调里，手机
// 端要照做就得抄第二份，所以挪进这里，两端各调一份（spec §2「不抄第二份」）。

import type { SessionEvent } from "../session/events.js";
import { CS_PROTOCOL_VERSION, type CsChatInfo, type CsModelRoute } from "./remote/cloudSession.js";
import type { CloudSessionStatus } from "./shellBridge.js";

/**
 * 一条事件插进按 seq 升序的时间线。**已经有这个 seq 就回 null**：:gone 之后 host 回来
 * 重连会把 backlog 全量再推一遍（`remote/cloudSessionClient.ts` 文件头「:gone」段），
 * 重复送达在这里无害地被滤掉。
 *
 * 快路径是追加。往前翻的那一页落在**前面**，走一次二分——**不能**只判「比头还小」：
 * 同一页是按 seq 升序到达的，第二条就不再比新的头小了，会被甩到末尾。也不每条都全量
 * 排序：一页 200 条，逐条排就是 200 次 O(n log n)。
 *
 * 去重靠二分落点那一格判：时间线由构造保证按 seq 升序（每一条都经过这里），所以
 * 「有没有同 seq」等价于「落点那一格是不是同 seq」，不必全表扫一遍。
 */
export function insertCloudEvent(events: readonly SessionEvent[], event: SessionEvent): SessionEvent[] | null {
  const n = events.length;
  if (n === 0 || event.seq > events[n - 1]!.seq) return [...events, event];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq < event.seq) lo = mid + 1;
    else hi = mid;
  }
  if (lo < n && events[lo]!.seq === event.seq) return null;
  return [...events.slice(0, lo), event, ...events.slice(lo)];
}

/** 状态推送落到的那一格里、两端共有的部分。桌面 `CloudSessionState` 与手机端
    `ChatSession` 各自在这之上多几格（翻页状态、事件数组） */
export interface CloudSessionCore {
  workspaceId: string;
  sessionId: string;
  state: "connecting" | "ready" | "denied" | "gone";
  deniedCode?: string;
  deniedServerVersion?: number;
  initiatorUid: string | null;
  ownerUid: string;
  selfUid: string;
  modelRoute: CsModelRoute | null;
  gapNote: string | null;
  chat: CsChatInfo | null | undefined;
  hasOlder: boolean;
}

/**
 * 一次状态推送落到手上那一格。三类字段、三种规矩：
 *
 * - `state` / `initiatorUid` / `ownerUid` / `selfUid` / `modelRoute`：照抄。
 * - `gapNote` / `hasOlder`：照抄推送，**缺席即结论**（缺席 → null / false）。主进程
 *   每次推送都重算这两格：缺口补齐时正是靠**不带** `gapNote` 来说「补齐了」，翻到头时
 *   正是靠不带 `hasOlder` 来说「到头了」——「没带就留着旧的」等于一直说一句已经不成立
 *   的话（issue #957 C-I7 / #1280）。
 * - `chat`：**缺席就留着手上那份**（打开时按清单行或建会话的 spec 种下的种子）。与上一
 *   类相反而理由对称：welcome 每条连接只说一次，把缺席读成「团队会话」正是 #1301。
 * - `deniedCode` / `deniedServerVersion`：来了才覆盖、没来就留着；没来的键不写成
 *   undefined（exactOptionalPropertyTypes：「键不存在」与「值是 undefined」是两回事）。
 *
 * 回 `CloudSessionCore`：调用方手上那格多出来的字段（翻页状态、事件）照旧由它自己
 * 展开保留——`{ ...cur, ...applyCloudStatus(cur, status) }`。
 */
export function applyCloudStatus(cur: CloudSessionCore, status: CloudSessionStatus): CloudSessionCore {
  return {
    ...cur,
    state: status.state,
    initiatorUid: status.initiatorUid,
    ownerUid: status.ownerUid,
    selfUid: status.selfUid,
    modelRoute: status.modelRoute,
    gapNote: status.gapNote ?? null,
    ...(status.chat === undefined ? {} : { chat: status.chat }),
    hasOlder: status.hasOlder ?? false,
    ...(status.deniedCode === undefined ? {} : { deniedCode: status.deniedCode }),
    ...(status.deniedServerVersion === undefined ? {} : { deniedServerVersion: status.deniedServerVersion }),
  };
}

/**
 * join 之后持续状态里的 deniedCode → 人话（原桌面 CloudSessionPage 的 `cloudDeniedMessage`）。
 * `remote/cloudSessionClient.ts` 的 `deniedMessage()` 只服务 create() 那一次性 RPC 失败；
 * 这一份多一档：认不出的码原样带出来兜底，不装死。
 *
 * version_mismatch 说得出方向才有用（复审 C2-I6）：严格相等判出的不匹配有两个方向，
 * 「更新 Mr Otto」对「云端还没部署」的那半是错的指引——照做也连不上，且再没有别的线索。
 */
export function cloudDeniedText(code: string | undefined, serverVersion?: number): string {
  switch (code) {
    case "bad_jwt":
      return "登录状态已过期，请重新登录后再试";
    case "not_member":
      return "你不是这个团队的成员";
    case "version_mismatch":
      if (serverVersion !== undefined && serverVersion < CS_PROTOCOL_VERSION) {
        return `云端协议版本（${serverVersion}）低于本客户端（${CS_PROTOCOL_VERSION}），云端还没升级，联系维护者`;
      }
      return "客户端版本与云端不匹配，请更新 Mr Otto 后再试";
    case "no_session":
      return "云会话不存在或已归档";
    case "not_authorized":
      return "没有权限执行此操作";
    default:
      return code ? `无法加入云会话（${code}）` : "无法加入云会话";
  }
}

/** 「不确定有没有发出去」那一行的初始措辞（第四批 C2-I4）。正文只回显前 40 字——这一行
    是「哪一句话」的提示，不是那句话本身（重发发的是全文） */
export function unknownSendNote(text: string): string {
  return `没有收到回执，不确定有没有发出去：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`;
}
```

- [ ] **Step 4: 跑 shared 测试确认通过**

Run: `npx vitest run tests/shared/cloudSessionState.test.ts`
Expected: PASS

- [ ] **Step 5: 桌面 store 改调 shared**

`src/renderer/src/store.ts` 顶部 import 区加：

```ts
import { applyCloudStatus, insertCloudEvent } from "../../shared/cloudSessionState.js";
```

`window.otter.onCloudSessionEvent((event) => {` 回调里第一个 `set((s) => { … })` 整段替换成（后面的 `get().voiceOnEvent(event);` 及之后全部不动）：

```ts
      set((s) => {
        if (!s.cloudSession || s.cloudSession.sessionId !== event.sessionId) return s;
        // 按 seq 去重 + 插到对的位置（往前翻的那一页落在前面）——规则在
        // shared/cloudSessionState.ts 的 insertCloudEvent，手机端用同一份
        const events = insertCloudEvent(s.cloudSession.events, event);
        if (events === null) return s;
        // 流式缓冲清槽（#1107）：终态 assistant_message 整份覆盖预览；
        // turn_ended（aborted/error）= 预览作废——「不完整就不是消息」，
        // 与本机 absorbEvent 清 streamingBySession 同一条纪律
        const cloudStreaming = clearCloudStreamingOn(s.cloudStreaming, event);
        return {
          cloudSession: { ...s.cloudSession, events },
          ...(cloudStreaming !== s.cloudStreaming ? { cloudStreaming } : {}),
        };
      });
```

`window.otter.onCloudSessionStatus((status) => {` 回调里：`get().voiceOnCloudState(status.sessionId, status.state);` 那一行**原样留在最前面**（`tests/renderer/utteranceHoldWiring.test.ts` 读源码钉着它在 `set(` 之前），其后的 `set((s) => { … })` 整段替换成：

```ts
      set((s) => {
        if (!s.cloudSession || s.cloudSession.sessionId !== status.sessionId) return s;
        return {
          // runtime 对这条连接说的话（issue #819：限速/审批失效/事件过大）
          // 落进这一页已有的那格"人话"里——CloudSessionPage 的 actionError
          // 就在 footer 上方。不进 cloudSession：它是一次性的，不是状态
          ...(status.notice === undefined ? {} : { workspaceGroupsError: status.notice }),
          // 哪几格照抄、哪几格缺席就留着（gapNote/hasOlder 缺席即结论，chat 缺席留种子，
          // #1301 / #957 C-I7）——规则与理由在 shared/cloudSessionState.ts 的 applyCloudStatus
          cloudSession: { ...s.cloudSession, ...applyCloudStatus(s.cloudSession, status) },
        };
      });
```

- [ ] **Step 6: 桌面云会话页改用 shared 文案**

`src/renderer/src/components/CloudSessionPage.tsx`：

1. 删掉整个 `function cloudDeniedMessage(…) { … }`（连同它上方那段 `/** join() 之后持续状态的 deniedCode → 人话… */` 注释）。
2. 删掉整个 `function unknownNote(text: string): string { … }`（连同上方 `/** 那一行的初始措辞… */` 注释）。
3. `statusBanner` 里 `cloudDeniedMessage(cs.deniedCode, cs.deniedServerVersion)` 改成 `cloudDeniedText(cs.deniedCode, cs.deniedServerVersion)`。
4. 文件里两处 `unknownNote(` 改成 `unknownSendNote(`。
5. import 区加 `import { cloudDeniedText, unknownSendNote } from "../../../shared/cloudSessionState.js";`；`CS_PROTOCOL_VERSION` 那行 import 在这个文件里已经没有别的用处（Step 前 `grep -n CS_PROTOCOL_VERSION` 只命中那个函数），删掉那一行 import。

- [ ] **Step 7: 跑桌面相关测试 + 类型检查**

Run: `npx vitest run tests/shared/cloudSessionState.test.ts tests/renderer/cloudSessionListStore.test.ts tests/renderer/cloudSessionPaging.test.tsx tests/renderer/cloudSessionShell.test.tsx tests/renderer/agentChatPage.test.tsx tests/renderer/utteranceHoldWiring.test.ts tests/renderer/voiceStore.test.ts && npx tsc --noEmit -p .`
Expected: 全 PASS；tsc 无输出。

- [ ] **Step 8: Commit**

```bash
git add src/shared/cloudSessionState.ts tests/shared/cloudSessionState.test.ts src/renderer/src/store.ts src/renderer/src/components/CloudSessionPage.tsx
git commit -m "$(cat <<'EOF'
refactor(shared): 云会话状态的两条规则与两句文案抽进 shared，桌面改调（#1356 A1）

事件按 seq 去重插位、状态推送哪几格照抄哪几格留着（chat 缺席留种子 = #1301），
原来长在桌面 store 的两个回调里；手机端的 chat store 要做同两件事，照 spec
「不抄第二份」先抽出来。denied 的人话、「不确定有没有发出去」两句文案同理。
桌面行为不变：现有 renderer 集成测试照跑，utteranceHoldWiring 那条读源码的
断言（语音收口在 set( 之前）原样满足。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: 改 / 删智能体的编排抽进 shared（桌面 workspaceManager 改用）

桌面上「改一只智能体」要过校验 + 现查名单判重名与前缀冲突 + 把 23505 翻成人话，「删一只」是倒着排的四步（删私聊 → 从各群摘掉 → 删那一行 → 删记忆页）——都在主进程 `workspaceManager.ts` 里。手机端直连 Supabase，中间没有主进程那一层；spec §3.2 明写删智能体的四步「拆出一个注入式的纯编排，两端共用，桌面那份只剩接线，归 A1」。改名那道闸同理（两条写入路给同一件事两种说法，比各自漏掉一半更难查）。

**Files:**
- Create: `src/shared/agentAdmin.ts`
- Modify: `src/main/workspaceManager.ts`（删本地 `DUPLICATE_AGENT_NAME` / `ADMIN_CANNOT_DELETE` / `assertNameFree`；`createAgent` / `updateAgent` / `deleteAgent` 改调 shared）
- Test: `tests/shared/agentAdmin.test.ts`

**Interfaces:**
- Consumes: `validateAgentPatch` / `scanCreateAgentThreat` / `AgentDraftPatch`（`src/shared/createAgentDraft.ts`）；`ADMIN_AGENT_ID` / `agentNameConflict` / `normalizeAgentName`（`src/shared/workspaceAgents.ts`）；`normalizeAvatarSlot`（`src/shared/workspaces.ts`）；`FriendsResult`（`src/shared/friends.ts`）。
- Produces:
  - `DUPLICATE_AGENT_NAME = "已有同名的智能体"`、`ADMIN_CANNOT_DELETE = "管理员不能删除"`
  - `assertAgentNameFree(deps: AgentNameDeps, client, workspaceId, name, selfAgentId: string | null): Promise<void>`
  - `updateAgentChecked(deps: AgentUpdateDeps, client, workspaceId, agentId, patch: AgentPatchInput): Promise<void>`
  - `deleteAgentEverywhere(deps: AgentDeleteDeps, client, workspaceId, agentId): Promise<void>`
  - `type AgentPatchInput = { name?: string; description?: string; instructions?: string; models?: string[]; tools?: AgentToolAllow[]; avatarSlot?: number | null }`
  - 三个 deps 接口的成员签名与 `supabaseWorkspacesApi` 的同名函数一致（桌面 `WorkspaceManagerDeps` 结构上直接满足）。

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/agentAdmin.test.ts`：

```ts
// agentAdmin —— 改 / 删一只智能体的编排（#1356 A1，spec §3.2）。桌面主进程与手机端共用：
// 桌面那份经 workspaceManager 的集成测试（tests/main/workspaceManager.test.ts）照旧覆盖，
// 这份钉编排本身——手机端没有主进程那一层，直接调它。

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ADMIN_CANNOT_DELETE, DUPLICATE_AGENT_NAME, assertAgentNameFree, deleteAgentEverywhere, updateAgentChecked,
  type AgentDeleteDeps, type AgentUpdateDeps,
} from "../../src/shared/agentAdmin.js";

const client = {} as SupabaseClient;

function updateDeps(names: { agentId: string; name: string }[]): AgentUpdateDeps & { updateAgentRow: ReturnType<typeof vi.fn> } {
  return {
    listAgentNames: vi.fn(async () => names),
    updateAgentRow: vi.fn(async () => undefined),
  };
}

describe("assertAgentNameFree", () => {
  it("精确同名报「已有同名的智能体」（不报前缀那句，与 23505 那条路同一句话）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营", null)).rejects.toThrow(DUPLICATE_AGENT_NAME);
  });
  it("前缀冲突两个方向都拒", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营助理", null)).rejects.toThrow(/冲突/);
    const deps2 = updateDeps([{ agentId: "a1", name: "运营助理" }]);
    await expect(assertAgentNameFree(deps2, client, "w", "运营", null)).rejects.toThrow(/冲突/);
  });
  it("名单里是全角旧名字时，半角同名照样拒（已有名字也要归一化）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "Ａｄｓ" }]);
    await expect(assertAgentNameFree(deps, client, "w", "Ads", null)).rejects.toThrow(DUPLICATE_AGENT_NAME);
  });
  it("改成自己现在的名字不算冲突（名单里排掉正在改的那只）", async () => {
    const deps = updateDeps([{ agentId: "a1", name: "运营" }]);
    await expect(assertAgentNameFree(deps, client, "w", "运营", "a1")).resolves.toBeUndefined();
  });
});

describe("updateAgentChecked", () => {
  it("只带在场的字段：没传的字段不补默认值（补了就是把它清空）", async () => {
    const deps = updateDeps([]);
    await updateAgentChecked(deps, client, "w", "a1", { description: "管店铺" });
    expect(deps.updateAgentRow).toHaveBeenCalledWith(client, "w", "a1", { description: "管店铺" });
    expect(deps.listAgentNames).not.toHaveBeenCalled(); // 不改名不查名单
  });
  it("改名先归一化再查重、再落库", async () => {
    const deps = updateDeps([{ agentId: "a2", name: "设计" }]);
    await updateAgentChecked(deps, client, "w", "a1", { name: " Ａｄｓ " });
    expect(deps.updateAgentRow).toHaveBeenCalledWith(client, "w", "a1", { name: "Ads" });
  });
  it("description 带换行 → 拒绝，不打网络", async () => {
    const deps = updateDeps([]);
    await expect(updateAgentChecked(deps, client, "w", "a1", { description: "第一行\n第二行" })).rejects.toThrow(/换行/);
    expect(deps.updateAgentRow).not.toHaveBeenCalled();
  });
  it("avatarSlot：省略 = 不动这一格；null = 清回派生；越界 = null", async () => {
    const deps = updateDeps([]);
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: 3 });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: 3 });
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: null });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: null });
    await updateAgentChecked(deps, client, "w", "a1", { avatarSlot: -2 });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { avatarSlot: null });
  });
  it("23505 翻成「已有同名的智能体」，别的错误原样抛", async () => {
    const deps = updateDeps([]);
    deps.updateAgentRow.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(updateAgentChecked(deps, client, "w", "a1", { name: "运营" })).rejects.toThrow(DUPLICATE_AGENT_NAME);
    deps.updateAgentRow.mockRejectedValueOnce(new Error("行不存在或无权修改"));
    await expect(updateAgentChecked(deps, client, "w", "a1", { description: "x" })).rejects.toThrow("行不存在或无权修改");
  });
});

function deleteDeps(chats: { dmSessionId: string | null; groups: { sessionId: string; agentIds: string[] }[] }) {
  const calls: string[] = [];
  const deps: AgentDeleteDeps = {
    listAgentChats: vi.fn(async () => chats),
    removeCloudSession: vi.fn(async (_w: string, sid: string) => { calls.push(`remove:${sid}`); return { ok: true as const, value: null }; }),
    updateChatRoster: vi.fn(async (_w: string, sid: string, ids: string[]) => { calls.push(`roster:${sid}:${ids.join(",")}`); return { ok: true as const, value: null }; }),
    deleteAgentRow: vi.fn(async () => { calls.push("row"); }),
    removeAgentPage: vi.fn(async () => { calls.push("page"); }),
  };
  return { deps, calls };
}

describe("deleteAgentEverywhere", () => {
  it("管理员在本层就拒，不打网络", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [] });
    await expect(deleteAgentEverywhere(deps, client, "w", "admin")).rejects.toThrow(ADMIN_CANNOT_DELETE);
    expect(calls).toEqual([]);
    expect(deps.listAgentChats).not.toHaveBeenCalled();
  });
  it("倒着排的四步：私聊 → 各群摘掉（发变动之后的完整名单）→ 那一行 → 记忆页", async () => {
    const { deps, calls } = deleteDeps({
      dmSessionId: "dm1",
      groups: [{ sessionId: "g1", agentIds: ["admin", "a1", "a2"] }, { sessionId: "g2", agentIds: ["a1"] }],
    });
    await deleteAgentEverywhere(deps, client, "w", "a1");
    expect(calls).toEqual(["remove:dm1", "roster:g1:admin,a2", "roster:g2:", "row", "page"]);
  });
  it("私聊删不掉 → 整件事停下、智能体留着（断在半路留下的是「智能体还在、聊天没了」的反面就糟了）", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: "dm1", groups: [{ sessionId: "g1", agentIds: ["a1"] }] });
    vi.mocked(deps.removeCloudSession).mockResolvedValueOnce({ ok: false, message: "云端无响应" });
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).rejects.toThrow("它的聊天记录没删掉（云端无响应），所以这只智能体也先留着。稍后再试。");
    expect(calls).toEqual([]);
  });
  it("摘群失败同样停下", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [{ sessionId: "g1", agentIds: ["a1", "a2"] }] });
    vi.mocked(deps.updateChatRoster).mockResolvedValueOnce({ ok: false, message: "限速" });
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).rejects.toThrow("没能把它从群聊里摘掉（限速），所以这只智能体也先留着。稍后再试。");
    expect(calls).toEqual([]);
  });
  it("记忆页删不掉不拦删除", async () => {
    const { deps, calls } = deleteDeps({ dmSessionId: null, groups: [] });
    vi.mocked(deps.removeAgentPage).mockRejectedValueOnce(new Error("容器没起来"));
    await expect(deleteAgentEverywhere(deps, client, "w", "a1")).resolves.toBeUndefined();
    expect(calls).toEqual(["row"]);
  });
});
```

- [ ] **Step 2: 跑一下确认失败**

Run: `npx vitest run tests/shared/agentAdmin.test.ts`
Expected: FAIL（`Cannot find module '../../src/shared/agentAdmin.js'`）

- [ ] **Step 3: 实现 shared 模块**

Create `src/shared/agentAdmin.ts`（逻辑与注释原样搬自 `src/main/workspaceManager.ts` 的 `assertNameFree` / `updateAgent` / `deleteAgent`）：

```ts
// agentAdmin —— 改 / 删一只智能体的编排（#1356 A1，spec §3.2）。
//
// 原来住在桌面主进程的 workspaceManager.ts：手机端直连 Supabase，中间没有主进程那一层，
// 照抄一份就是两条写入路给同一件事两种说法（改名的前缀冲突、删除那四步的顺序），而那种
// 分家从来不报错。依赖逐个注入：Supabase 那几条是同名的薄查询，云端那三条（删会话 /
// 改群名单 / 删记忆页）是控制房 RPC——桌面与手机各自接线。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentToolAllow } from "./agentToolAllow.js";
import { scanCreateAgentThreat, validateAgentPatch } from "./createAgentDraft.js";
import type { FriendsResult } from "./friends.js";
import { ADMIN_AGENT_ID, agentNameConflict, normalizeAgentName } from "./workspaceAgents.js";
import { normalizeAvatarSlot } from "./workspaces.js";

/** 唯一索引撞了（同团队同名智能体）——PostgREST 的 23505，翻成人话 */
export const DUPLICATE_AGENT_NAME = "已有同名的智能体";
/** RLS 也会拦 'admin' 的删除，但那条回来的是一句 PostgREST 的英文——这里先拦一道，不打网络 */
export const ADMIN_CANNOT_DELETE = "管理员不能删除";

/** 改一只智能体时调用方递进来的 patch。`avatarSlot` 不过 `validateAgentPatch`（那份
    schema 是 create_agent **工具**的参数表），在这里单独归一：**省略与 null 不同义**——
    省略 = 这次没碰头像，null = 明确清回按 agentId 派生 */
export interface AgentPatchInput {
  name?: string;
  description?: string;
  instructions?: string;
  models?: string[];
  tools?: AgentToolAllow[];
  avatarSlot?: number | null;
}

export interface AgentNameDeps {
  listAgentNames(client: SupabaseClient, workspaceId: string): Promise<{ agentId: string; name: string }[]>;
}

export interface AgentUpdateDeps extends AgentNameDeps {
  updateAgentRow(
    client: SupabaseClient,
    workspaceId: string,
    agentId: string,
    patch: {
      name?: string; description?: string; instructions?: string; models?: string[];
      tools?: AgentToolAllow[]; avatarSlot?: number | null;
    },
  ): Promise<void>;
}

export interface AgentDeleteDeps {
  listAgentChats(
    client: SupabaseClient,
    workspaceId: string,
    agentId: string,
  ): Promise<{ dmSessionId: string | null; groups: { sessionId: string; agentIds: string[] }[] }>;
  /** 删一条云会话：走 runtime 的 delete 帧（ADR-0245），不是直连 Supabase——0016 那条
      策略把客户端的 delete 钉死在 kind='package' */
  removeCloudSession(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
  /** 改一条聊天的名单：收的是**变动之后的完整名单**，不是「摘掉谁」（`chat_update` 的形状） */
  updateChatRoster(workspaceId: string, sessionId: string, agentIds: string[]): Promise<FriendsResult<null>>;
  deleteAgentRow(client: SupabaseClient, workspaceId: string, agentId: string): Promise<void>;
  /** 删它自己那页记忆。删不掉不拦删除 */
  removeAgentPage(workspaceId: string, agentId: string): Promise<void>;
}

/**
 * 名字冲突（同名 / 一方是另一方的开头）现查一次名单再判（#957 B-I2）。同名 DB 的唯一
 * 索引也拦得住，前缀冲突拦不住——而 @ 的最长匹配正是被前缀骗的那一个。
 * `selfAgentId` 非 null 时把自己那行排掉：改成自己现在的名字不算冲突。两条纪律与
 * runtime 的 `agentRegistry.assertNameFree` 逐字一致：
 * ① **同名先判**——不先判的话精确重名会被说成「一个名字不能是另一个的开头」，而 23505
 *    那条路说的是「已有同名的智能体」，同一件事两种文案；
 * ② **已有名字也要归一化**——新名字过了 NFKC，名单那份没过的话，一行历史数据「Ａｄｓ」
 *    与新建的「Ads」既躲得过唯一索引也躲得过前缀检查。
 * 前提：`name` 已经归一化过（调用方从 `validateAgentPatch` / `parseCreateAgentArgs` 拿来的）。
 */
export async function assertAgentNameFree(
  deps: AgentNameDeps,
  client: SupabaseClient,
  workspaceId: string,
  name: string,
  selfAgentId: string | null,
): Promise<void> {
  const rows = await deps.listAgentNames(client, workspaceId);
  const others = rows.filter((r) => r.agentId !== selfAgentId).map((r) => normalizeAgentName(r.name));
  if (others.includes(name)) throw new Error(DUPLICATE_AGENT_NAME);
  const conflict = agentNameConflict(name, others);
  if (conflict !== null) throw new Error(conflict);
}

/** 改一只智能体。改名与新建走同一道闸（B-I2）：改名是绕开建时校验最省事的一条路 */
export async function updateAgentChecked(
  deps: AgentUpdateDeps,
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
  patch: AgentPatchInput,
): Promise<void> {
  const clean = validateAgentPatch(patch);
  const threat = scanCreateAgentThreat(clean);
  if (threat) throw new Error(`${threat}，拒绝保存`);
  // 名单只在真的改名时查——不改名时那是一次白打的网络往返
  if (clean.name !== undefined) await assertAgentNameFree(deps, client, workspaceId, clean.name, agentId);
  try {
    await deps.updateAgentRow(client, workspaceId, agentId, {
      ...clean,
      ...(patch.avatarSlot === undefined ? {} : { avatarSlot: normalizeAvatarSlot(patch.avatarSlot) }),
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
    throw e;
  }
}

/**
 * 删一只智能体：四步、不原子（#1280，spec §3.2）。**顺序是倒着排的**：先动最贵、最可能
 * 失败的那一步（云端那条日志），最后才删那一行——断在半路时留下的是「智能体还在、聊天
 * 没了」，比「聊天还在、主人没了」好收拾：前者人再点一次删除就收干净了，后者会在名册上
 * 留下一条指向不存在的智能体的私聊。第 2、3 步之间断了由读取侧的「与现存智能体求交集」
 * 兜住。团队里这条路照走：`listAgentChats` 在 0037 没跑的库上回空，于是退化成一步。
 */
export async function deleteAgentEverywhere(
  deps: AgentDeleteDeps,
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  if (agentId === ADMIN_AGENT_ID) throw new Error(ADMIN_CANNOT_DELETE);
  const chats = await deps.listAgentChats(client, workspaceId, agentId);
  if (chats.dmSessionId !== null) {
    const r = await deps.removeCloudSession(workspaceId, chats.dmSessionId);
    if (!r.ok) throw new Error(`它的聊天记录没删掉（${r.message}），所以这只智能体也先留着。稍后再试。`);
  }
  // 逐个群摘：摘成空群是合法终局（群还在，人可以再往里加），不是「这个群该删了」
  // ——删一只智能体不该连坐删掉它待过的群
  for (const g of chats.groups) {
    const r = await deps.updateChatRoster(workspaceId, g.sessionId, g.agentIds.filter((x) => x !== agentId));
    if (!r.ok) throw new Error(`没能把它从群聊里摘掉（${r.message}），所以这只智能体也先留着。稍后再试。`);
  }
  await deps.deleteAgentRow(client, workspaceId, agentId);
  // 记忆页删不掉**不拦删除**：留下的是一页没人读的 markdown，而拦下来的话这只智能体
  // 永远删不掉（它的私聊已经没了，界面上看不出为什么）
  await deps.removeAgentPage(workspaceId, agentId).catch(() => undefined);
}
```

- [ ] **Step 4: 跑 shared 测试确认通过**

Run: `npx vitest run tests/shared/agentAdmin.test.ts`
Expected: PASS

- [ ] **Step 5: 桌面 workspaceManager 改调 shared**

`src/main/workspaceManager.ts`：

1. 删掉本地常量 `DUPLICATE_AGENT_NAME` 与 `ADMIN_CANNOT_DELETE`（连同各自上方的注释），改为 import：
   ```ts
   import { ADMIN_CANNOT_DELETE, DUPLICATE_AGENT_NAME, assertAgentNameFree, deleteAgentEverywhere, updateAgentChecked } from "../shared/agentAdmin.js";
   ```
   （`ADMIN_CANNOT_DELETE` 若删完之后本文件已无引用，就不要 import 它——tsc 的 `noUnusedLocals` 不开，但别留死 import：Step 结束前 `grep -n ADMIN_CANNOT_DELETE src/main/workspaceManager.ts` 确认。）
2. 删掉 `createWorkspaceManager` 里的整个 `async function assertNameFree(…) { … }`（连同上方那段注释）。
3. `createAgent` 里 `await assertNameFree(client, id, clean.name, null);` 改成 `await assertAgentNameFree(deps, client, id, clean.name, null);`（`createAgent` 其余不动——A2 的手机建一只再抽它）。
4. `updateAgent` 整个方法体改成：
   ```ts
    async updateAgent(id, agentId, patch) {
      return withSession(async (client) => {
        // 校验 / 查重名 / 23505 翻译的编排在 shared/agentAdmin.ts（手机端直连 Supabase，用同一份）
        await updateAgentChecked(deps, client, id, agentId, patch);
        return null;
      });
    },
   ```
5. `deleteAgent` 整个方法体改成：
   ```ts
    async deleteAgent(id, agentId) {
      return withSession(async (client) => {
        // 倒着排的四步在 shared/agentAdmin.ts（spec §3.2：两端共用，桌面这里只剩接线）。
        // 放在 withSession 的业务体里，未登录时依旧先报"还没登录"
        await deleteAgentEverywhere(deps, client, id, agentId);
        return null;
      });
    },
   ```
6. 删完之后若 `agentNameConflict` / `normalizeAgentName` / `validateAgentPatch` / `normalizeAvatarSlot` 在本文件已无引用，从 import 里摘掉（逐个 `grep -n` 确认；`parseCreateAgentArgs` / `scanCreateAgentThreat` / `normalizeAvatarSlot` 仍被 `createAgent` 用着，留）。

`updateAgent` 的 `patch` 参数类型在 `WorkspaceManager` 接口里原样不动——它结构上就是 `AgentPatchInput` 的子集；若 tsc 报两者不兼容，把接口里那一格改成 `AgentPatchInput`（从 shared import），不要在调用处 `as`。

- [ ] **Step 6: 跑桌面测试 + 类型检查**

Run: `npx vitest run tests/shared/agentAdmin.test.ts tests/main/workspaceManager.test.ts && npx tsc --noEmit -p .`
Expected: 全 PASS（`workspaceManager.test.ts` 里建 / 改 / 删 agent 那三组用例一条都不用改）；tsc 无输出。

- [ ] **Step 7: Commit**

```bash
git add src/shared/agentAdmin.ts tests/shared/agentAdmin.test.ts src/main/workspaceManager.ts
git commit -m "$(cat <<'EOF'
refactor(shared): 改 / 删智能体的编排抽进 shared，桌面 workspaceManager 只剩接线（#1356 A1）

手机端直连 Supabase，没有主进程那一层。spec §3.2 定了删智能体那倒着排的四步
「拆出一个注入式的纯编排，两端共用」；改名那道闸（校验 + 现查名单判前缀冲突 +
23505 翻人话）同理——两条写入路各写一份，分家时不报错，只会让同一件事在两台
设备上说两种话。桌面行为不变，workspaceManager 那三组集成用例一条没改。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 4: 「最后一句」的判据 + 读它的查询 + migration（spec §7.1 前半）

名册要按「最近一次动静」排、每行底下写最后一句（spec §5.2），而 `workspace_sessions` 没有这一格——`updated_at` 只在插入时写，按它排就是按创建时间排。权威日志在 VPS 上，手机够不着，所以 runtime 把它投影进库（Task 5 写）。这个任务落三样：判据（shared 纯函数，runtime 按它决定写什么）、手机读回来的容错查询、加三列的 migration。

**Files:**
- Create: `src/shared/sessionLast.ts`
- Modify: `src/shared/supabaseWorkspacesApi.ts`（新增 `fetchCloudLasts`）
- Create: `supabase/migrations/0040_workspace_sessions_last.sql`
- Test: `tests/shared/sessionLast.test.ts`、`tests/shared/supabaseWorkspacesApi.lasts.test.ts`

**Interfaces:**
- Consumes: `splitBubbles`（`src/shared/chatBubbles.ts`）、`isAgentStep` / `parseUserMessageLabel`（`src/shared/cloudTimeline.ts`）、`humanSpeakerOf`（`src/shared/sessionParticipants.ts`）、`isSystemNote`（`src/shared/systemNote.ts`）。
- Produces:
  - `LAST_EXCERPT_MAX = 120`、`LAST_THROTTLE_MS = 3000`
  - `interface SessionLast { ts: number; excerpt: string; from: string }`（`from` = `agent:<agentId>` / `human:<uid>`）
  - `excerptOf(text: string): string`
  - `lastOf(e: SessionEvent): SessionLast | null`
  - `type LastSpeaker = { kind: "agent"; agentId: string } | { kind: "human"; uid: string }`；`lastSpeakerOf(from: string): LastSpeaker | null`
  - `fetchCloudLasts(client: SupabaseClient, workspaceId: string): Promise<Map<string, SessionLast>>`（sessionId → last；读不到回空 Map）

- [ ] **Step 1: 写失败的测试（判据）**

Create `tests/shared/sessionLast.test.ts`：

```ts
// sessionLast —— 名册「最后一句」的判据（#1356 A1，spec §7.1）。runtime 按它决定往库里
// 写什么，手机按它的 from 格式读回来——两边共用这一份。

import { describe, expect, it } from "vitest";
import { LAST_EXCERPT_MAX, excerptOf, lastOf, lastSpeakerOf } from "../../src/shared/sessionLast.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { seq: 1, sessionId: "s1", ts: 5000 };
const user = (o: Record<string, unknown>): SessionEvent => ({ ...base, type: "user_message", ...o }) as unknown as SessionEvent;
const reply = (o: Record<string, unknown>): SessionEvent =>
  ({ ...base, type: "assistant_message", model: "m", ...o }) as unknown as SessionEvent;
const chat = (o: Record<string, unknown>): SessionEvent =>
  ({ ...base, type: "chat_message", label: "Stan", mention: false, ...o }) as unknown as SessionEvent;

describe("excerptOf", () => {
  it("第一段非空文字、折叠空白", () => {
    expect(excerptOf("  门禁绿了，\n推到   分支了。\n\n第二段不要")).toBe("门禁绿了， 推到 分支了。");
  });
  it("只有空白 → 空串", () => {
    expect(excerptOf(" \n\n  ")).toBe("");
  });
  it(`超过 ${LAST_EXCERPT_MAX} 字截断，连省略号正好 ${LAST_EXCERPT_MAX} 字；按字符数不按码元`, () => {
    const long = "一".repeat(200);
    const out = excerptOf(long);
    expect(Array.from(out)).toHaveLength(LAST_EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
    const emoji = "😀".repeat(130);
    expect(Array.from(excerptOf(emoji))).toHaveLength(LAST_EXCERPT_MAX); // 不把 emoji 劈成两半
  });
  it("正好 120 字不截", () => {
    const exact = "二".repeat(LAST_EXCERPT_MAX);
    expect(excerptOf(exact)).toBe(exact);
  });
});

describe("lastOf", () => {
  it("人打的 user_message：剥掉 [名字]: 前缀，from = human:<uid>", () => {
    expect(lastOf(user({ content: "[Stan]: 帮我看下排班\n\n还有进货", fromUid: "u1" }))).toEqual({
      ts: 5000, excerpt: "帮我看下排班", from: "human:u1",
    });
  });
  it("接力 / 招呼开场白不算（fromUid 是点火的人，不是他此刻说的话）", () => {
    expect(lastOf(user({ content: "[系统]: …", fromUid: "u1", relay: { depth: 1 } }))).toBeNull();
    expect(lastOf(user({ content: "打个招呼", fromUid: "u1", greeting: "voice_call" }))).toBeNull();
  });
  it("engine 注的旁白（后台任务 / 护栏）不算", () => {
    expect(lastOf(user({ content: "后台任务 bg-1 完成", origin: "background", agentId: "a_000000000001" }))).toBeNull();
    expect(lastOf(user({ content: "你在打转", origin: "loop_guard", fromUid: "u1" }))).toBeNull();
  });
  it("没有 fromUid 的 user_message（本机旧日志）不算", () => {
    expect(lastOf(user({ content: "hi" }))).toBeNull();
  });
  it("agent 的答案算，from = agent:<id>；要了工具的中间步骤 / 空正文 / 没 agentId 的不算", () => {
    expect(lastOf(reply({ content: "国庆三个人两班倒。", agentId: "a_000000000001" }))).toEqual({
      ts: 5000, excerpt: "国庆三个人两班倒。", from: "agent:a_000000000001",
    });
    expect(lastOf(reply({ content: "我先查一下", agentId: "a1", toolCalls: [{ id: "c1", name: "bash", args: {} }] }))).toBeNull();
    expect(lastOf(reply({ content: "   ", agentId: "a1" }))).toBeNull();
    expect(lastOf(reply({ content: "旧日志", }))).toBeNull();
  });
  it("人的 chat_message 算；系统旁白（fromUid=system）不算", () => {
    expect(lastOf(chat({ content: "大家看一下", fromUid: "u2" }))).toEqual({ ts: 5000, excerpt: "大家看一下", from: "human:u2" });
    expect(lastOf(chat({ content: "没派出去", fromUid: "system", label: "系统" }))).toBeNull();
  });
  it("别的事件一律不算", () => {
    expect(lastOf({ ...base, type: "turn_ended", outcome: "completed" } as unknown as SessionEvent)).toBeNull();
  });
});

describe("lastSpeakerOf", () => {
  it("两种前缀", () => {
    expect(lastSpeakerOf("agent:a_000000000001")).toEqual({ kind: "agent", agentId: "a_000000000001" });
    expect(lastSpeakerOf("human:u1")).toEqual({ kind: "human", uid: "u1" });
  });
  it("空串 / 认不出 / 前缀后面是空的 → null", () => {
    expect(lastSpeakerOf("")).toBeNull();
    expect(lastSpeakerOf("bot:x")).toBeNull();
    expect(lastSpeakerOf("agent:")).toBeNull();
  });
});
```

- [ ] **Step 2: 写失败的测试（读查询）**

Create `tests/shared/supabaseWorkspacesApi.lasts.test.ts`：

```ts
// fetchCloudLasts —— 名册「最后一句」那三列的容错读（#1356 A1，spec §7.1）。
// 这一层薄到本来不单测，例外同 supabaseWorkspacesApi.cloudSessions.test.ts 文件头：
// migration 还没跑时列不存在，这条查询出错不能连累任何别的东西（回空 Map、不抛）。

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCloudLasts } from "../../src/shared/supabaseWorkspacesApi.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(canned: Canned, calls: string[]): SupabaseClient {
  const builder = {
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return {
    from: (t: string) => { calls.push(`from:${t}`); return { select: (cols: string) => { calls.push(`select:${cols}`); return builder; } }; },
  } as unknown as SupabaseClient;
}

describe("fetchCloudLasts", () => {
  it("一条查询按 workspace_id + kind='cloud' 过滤，三列解析成 Map", async () => {
    const calls: string[] = [];
    const map = await fetchCloudLasts(fakeClient({
      data: [
        { id: "s1", last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: "门禁绿了", last_from: "agent:a_000000000001" },
        { id: "s2", last_ts: "2026-09-22T09:00:00.000+00:00", last_excerpt: "你好", last_from: "human:u1" },
      ],
    }, calls), "w1");
    expect(calls).toEqual([
      "from:workspace_sessions", "select:id,last_ts,last_excerpt,last_from", "eq:workspace_id=w1", "eq:kind=cloud",
    ]);
    expect(map.get("s1")).toEqual({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "门禁绿了", from: "agent:a_000000000001" });
    expect(map.get("s2")?.from).toBe("human:u1");
  });
  it("查询出错（migration 没跑，42703）→ 空 Map，不抛", async () => {
    const map = await fetchCloudLasts(fakeClient({ error: { message: "column does not exist", code: "42703" } }, []), "w1");
    expect(map.size).toBe(0);
  });
  it("last_ts 为 null（从没写过）或解析不出的行不进 Map；另两列形状不对退回空串", async () => {
    const map = await fetchCloudLasts(fakeClient({
      data: [
        { id: "a", last_ts: null, last_excerpt: "", last_from: "" },
        { id: "b", last_ts: "garbage", last_excerpt: "x", last_from: "human:u1" },
        { id: "c", last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: 7, last_from: null },
      ],
    }, []), "w1");
    expect([...map.keys()]).toEqual(["c"]);
    expect(map.get("c")).toEqual({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "", from: "" });
  });
});
```

- [ ] **Step 3: 跑一下确认失败**

Run: `npx vitest run tests/shared/sessionLast.test.ts tests/shared/supabaseWorkspacesApi.lasts.test.ts`
Expected: FAIL（`sessionLast.js` 不存在；`fetchCloudLasts` 不是导出）

- [ ] **Step 4: 实现判据**

Create `src/shared/sessionLast.ts`：

```ts
// sessionLast —— 名册那一行的「最后一句 + 最近动静」（#1356 A1，spec §7.1）。
//
// 手机名册把智能体与群混排、按最近一次动静降序（spec §5.2），而 `workspace_sessions`
// 没有这一格：`updated_at` 只在插入时写（没有触发器，runtime 的补丁也不带它），按它排
// 就是按创建时间排。权威日志在 VPS 上，手机够不着（要先开一条会话房才读得到 backlog），
// 而名册必须在一条会话都没开时就排得出来——所以 runtime 把这一格投影进库（同 #1213 的
// participants）。判据在这里、两边共用：runtime 按它决定写什么，手机按它的 from 格式读回来。
//
// **库是投影不是事实**：写失败只记一行日志，下一句话会盖掉（cloudSessionMeta 的纪律）。

import type { SessionEvent } from "../session/events.js";
import { splitBubbles } from "./chatBubbles.js";
import { isAgentStep, parseUserMessageLabel } from "./cloudTimeline.js";
import { humanSpeakerOf } from "./sessionParticipants.js";
import { isSystemNote } from "./systemNote.js";

/** 一条摘录最多多少字——按 Unicode 字符数，不按 UTF-16 码元（emoji 不该被劈成两半） */
export const LAST_EXCERPT_MAX = 120;
/** runtime 写库的节流间隔：3 秒内最多写一次、最后一条一定写到（spec §7.1） */
export const LAST_THROTTLE_MS = 3000;

export interface SessionLast {
  /** 那句话落盘的时刻（ms） */
  ts: number;
  /** 第一段非空文字，折叠空白，≤ LAST_EXCERPT_MAX 字 */
  excerpt: string;
  /** 谁说的：`agent:<agentId>` / `human:<uid>` */
  from: string;
}

/** 第一段非空文字（段 = 空行分隔，与气泡拆段同一条判据 `splitBubbles`）→ 折叠空白 →
    超长截断（省略号算在上限里）。只有空白 → 空串 */
export function excerptOf(text: string): string {
  const first = splitBubbles(text)[0] ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= LAST_EXCERPT_MAX) return flat;
  return `${chars.slice(0, LAST_EXCERPT_MAX - 1).join("")}…`;
}

/**
 * 这条事件算不算名册上的「最后一句」；算就回那一格。三种算：
 * - 人打的 `user_message`（`humanSpeakerOf` 认得出发言人：不含接力 / 招呼开场白——
 *   那两种的 fromUid 是点火的人，不是他此刻说的话）；engine 注的旁白（后台任务 / 护栏，
 *   `isSystemNote`）不算。正文剥掉 `[名字]: ` 前缀；
 * - agent 的**答案**（`assistant_message` 带 agentId、不是中间步骤——要了工具或空正文的
 *   那一条在时间线上也不画，#1055）；
 * - 人的 `chat_message`（系统旁白 fromUid=system 不算）。
 * 摘录为空（整条只有空白）也不算：写一格空串进去等于把上一句好好的话擦掉。
 */
export function lastOf(e: SessionEvent): SessionLast | null {
  if (e.type === "assistant_message") {
    if (!e.agentId || isAgentStep(e)) return null;
    const excerpt = excerptOf(e.content);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `agent:${e.agentId}` };
  }
  if (e.type === "user_message") {
    if (isSystemNote(e)) return null;
    const uid = humanSpeakerOf(e);
    if (uid === null) return null;
    const excerpt = excerptOf(parseUserMessageLabel(e.content).text);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `human:${uid}` };
  }
  if (e.type === "chat_message") {
    const uid = humanSpeakerOf(e);
    if (uid === null) return null;
    const excerpt = excerptOf(e.content);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `human:${uid}` };
  }
  return null;
}

export type LastSpeaker = { kind: "agent"; agentId: string } | { kind: "human"; uid: string };

/** `from` 那一格读回来。认不出（空串 = 那一行从没写过、或脏数据）→ null，调用方不画前缀 */
export function lastSpeakerOf(from: string): LastSpeaker | null {
  if (from.startsWith("agent:") && from.length > "agent:".length) return { kind: "agent", agentId: from.slice("agent:".length) };
  if (from.startsWith("human:") && from.length > "human:".length) return { kind: "human", uid: from.slice("human:".length) };
  return null;
}
```

- [ ] **Step 5: 实现读查询**

`src/shared/supabaseWorkspacesApi.ts` 顶部 import 区加：

```ts
import type { SessionLast } from "./sessionLast.js";
```

在 `fetchCloudChats` 函数之后加：

```ts
/** `workspace_sessions.last_ts / last_excerpt / last_from` 那三列（#1356 A1，spec §7.1），
    **单独一条、容错**——理由与 `fetchCloudChats` / `fetchCloudParticipants` 逐字相同：
    0040 落地前合进主 select 的话，PostgREST 对不存在的列回 42703，这个团队一条云会话
    都读不出来。**不要把这三列「顺手」合回主 select**。读不到回空 Map：名册按
    `updated_at` 排（spec §5.2 的退路）、那一行不写最后一句。
    `last_ts` 为 null（这条会话还没人说过一句算数的话）或解析不出的行不进 Map——
    「没有」与「读不到」在名册上是同一个画法，不必分 */
export async function fetchCloudLasts(
  client: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, SessionLast>> {
  const res = await client
    .from("workspace_sessions")
    .select("id,last_ts,last_excerpt,last_from")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud");
  const map = new Map<string, SessionLast>();
  if (res.error) return map;
  const rows = (res.data ?? []) as { id: string; last_ts: unknown; last_excerpt: unknown; last_from: unknown }[];
  for (const r of rows) {
    if (typeof r.last_ts !== "string") continue;
    const ts = Date.parse(r.last_ts);
    if (Number.isNaN(ts)) continue;
    map.set(r.id, {
      ts,
      excerpt: typeof r.last_excerpt === "string" ? r.last_excerpt : "",
      from: typeof r.last_from === "string" ? r.last_from : "",
    });
  }
  return map;
}
```

- [ ] **Step 6: 写 migration**

Create `supabase/migrations/0040_workspace_sessions_last.sql`（编号合并时认领：合并前 re-fetch，若 0040 已被占就改成 `max + 1` 并在文件头加一行「原为 0040」）：

```sql
-- 0040_workspace_sessions_last.sql —— 名册的「最后一句 + 最近动静」（#1356 A1，spec §7.1）。幂等，重跑不炸。
--
-- 与 0016 / 0021 / 0026 / 0030 / 0035 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime**——
-- runtime 在列不存在时只记一行日志不崩（cloudSessionMeta 的 write() 接住 42703），
-- 反过来也不出事，只是名册那一格一直空着。
--
-- 为什么是加三列而不是一张新表：这份东西**只有一个当前值**（最后一句），没有历史维度
-- （同 0035 participants 的理由）。RLS 已经有（wss_select_member，在籍即可读）。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不新增任何 update 策略**：现有的
-- wss_update_publisher 钉在 kind='package' 上，云会话行客户端本来就改不动——给了就是
-- 让任何在籍成员伪造「某某刚说了一句」。
--
-- 不回填：缺席时各端按 spec §5.2 的退路排（updated_at → 智能体自己的 created_at）。
--
-- last_ts      : 那句话落盘的时刻；null = 还没人说过一句算数的话
-- last_excerpt : 第一段非空文字、折叠空白、≤120 字（判据 src/shared/sessionLast.ts）
-- last_from    : agent:<agentId> / human:<uid>

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_ts'
  ) then
    alter table public.workspace_sessions add column last_ts timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_excerpt'
  ) then
    alter table public.workspace_sessions add column last_excerpt text not null default '';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_from'
  ) then
    alter table public.workspace_sessions add column last_from text not null default '';
  end if;
end $$;
```

- [ ] **Step 7: 跑测试 + 类型检查**

Run: `npx vitest run tests/shared/sessionLast.test.ts tests/shared/supabaseWorkspacesApi.lasts.test.ts tests/docs/migrationNumbers.test.ts && npx tsc --noEmit -p .`
Expected: 全 PASS；tsc 无输出。

- [ ] **Step 8: Commit**

```bash
git add src/shared/sessionLast.ts src/shared/supabaseWorkspacesApi.ts supabase/migrations/0040_workspace_sessions_last.sql tests/shared/sessionLast.test.ts tests/shared/supabaseWorkspacesApi.lasts.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): 名册「最后一句」的判据、容错读查询与 migration（#1356 A1，spec §7.1）

workspace_sessions.updated_at 只在插入时写，按它排就是按创建时间排；权威日志在 VPS，
手机够不着，所以 runtime 把最后一句投影进库。判据放 shared 两边共用：人打的话、
agent 的答案、人的群聊发言算，接力 / 招呼开场白、engine 旁白、中间步骤不算。
读查询单独一条、容错（0040 没跑时回空 Map，名册退回 updated_at 排），同
fetchCloudChats 那条教训。migration 不回填、不加 update 策略。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 5: runtime 把「最后一句」节流写进库（spec §7.1 后半）

判据在 Task 4；这里只管 IO：`CloudSessionMeta` 多一个 `setLast`，`sessionService` 在 `notify` 里逐条推进（同 title / participants 的形状，ADR-0283），每条会话**首尾两沿节流**——3 秒内最多写一次、最后一条一定写到（spec §7.1）。首沿当场写，是为了人刚说完的那句在名册上立刻顶上去；尾沿兜住「3 秒内说了好几句」时最后那句。

**Files:**
- Create: `services/runtime/src/lastWriter.ts`
- Modify: `services/runtime/src/cloudSessionMeta.ts`（接口 + 两个实现各加 `setLast`）
- Modify: `services/runtime/src/sessionService.ts`（`CloudSessionOpts` 加 `lastThrottleMs?`；装配处建 writer；`notify` 里推进）
- Test: `tests/runtime/lastWriter.test.ts`、`tests/runtime/cloudSessionMeta.test.ts`（加用例）、`tests/runtime/sessionService.test.ts`（加一个 describe）

**Interfaces:**
- Consumes: `SessionLast` / `lastOf` / `LAST_THROTTLE_MS`（Task 4，`src/shared/sessionLast.ts`）。
- Produces:
  - `CloudSessionMeta.setLast(l: SessionLast): Promise<void>`（**不抛**，同另两个方法）；内存假件多一格 `last: SessionLast | null`
  - `createLastWriter(o: { write: (l: SessionLast) => Promise<void>; throttleMs: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown }): { push(l: SessionLast): void }`
  - `CloudSessionOpts.lastThrottleMs?: number`（缺席 = `LAST_THROTTLE_MS`；只有测试传 0）

- [ ] **Step 1: 写失败的测试（节流器）**

Create `tests/runtime/lastWriter.test.ts`：

```ts
// lastWriter —— 名册「最后一句」写库的首尾两沿节流（#1356 A1，spec §7.1）。
// 时钟与定时器都注入：不用 vi 的假定时器，断言读得出「此刻写了几次」。

import { describe, expect, it } from "vitest";
import { createLastWriter } from "../../services/runtime/src/lastWriter.js";
import type { SessionLast } from "../../src/shared/sessionLast.js";

function harness(throttleMs = 3000) {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const written: string[] = [];
  const w = createLastWriter({
    write: async (l) => { written.push(l.excerpt); },
    throttleMs,
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(due), 1); due.fn(); }
  };
  const push = (excerpt: string) => w.push({ ts: t, excerpt, from: "human:u1" } satisfies SessionLast);
  return { push, advance, written, timers };
}

describe("createLastWriter", () => {
  it("首沿当场写：人刚说完的那句立刻顶上名册", () => {
    const h = harness();
    h.push("一");
    expect(h.written).toEqual(["一"]);
  });
  it("3 秒内的后几句只写最后一句，而且一定写到（尾沿）", () => {
    const h = harness();
    h.push("一");
    h.advance(500);
    h.push("二");
    h.push("三");
    expect(h.written).toEqual(["一"]);
    expect(h.timers).toHaveLength(1); // 只排一个定时器，不是每句一个
    h.advance(2500);
    expect(h.written).toEqual(["一", "三"]);
  });
  it("隔了够久的下一句又走首沿", () => {
    const h = harness();
    h.push("一");
    h.advance(4000);
    h.push("二");
    expect(h.written).toEqual(["一", "二"]);
  });
  it("尾沿写完之后的 3 秒里又来一句 → 再排一次尾沿（从上一次**写**算起，不从上一次 push 算起）", () => {
    const h = harness();
    h.push("一");          // t=0 写
    h.advance(1000);
    h.push("二");          // 排到 t=3000
    h.advance(2000);       // t=3000 写「二」
    h.advance(500);
    h.push("三");          // t=3500，距上次写 500ms → 排到 t=6000
    expect(h.written).toEqual(["一", "二"]);
    h.advance(2500);
    expect(h.written).toEqual(["一", "二", "三"]);
  });
  it("throttleMs = 0：每句都当场写（测试装配用）", () => {
    const h = harness(0);
    h.push("一");
    h.push("二");
    expect(h.written).toEqual(["一", "二"]);
  });
  it("write 抛了也不影响下一次（投影写失败只丢这一格，下一句盖掉）", () => {
    let calls = 0;
    const w = createLastWriter({
      write: async () => { calls += 1; throw new Error("fetch failed"); },
      throttleMs: 0,
    });
    w.push({ ts: 1, excerpt: "一", from: "human:u1" });
    w.push({ ts: 2, excerpt: "二", from: "human:u1" });
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: 写失败的测试（meta 与会话服务）**

在 `tests/runtime/cloudSessionMeta.test.ts` 里：

`describe("createInMemoryCloudSessionMeta", …)` 内加：

```ts
  it("记下最后一次写进去的「最后一句」（#1356 A1）", async () => {
    const meta = createInMemoryCloudSessionMeta();
    expect(meta.last).toBeNull();
    await meta.setLast({ ts: 42, excerpt: "门禁绿了", from: "agent:a_000000000001" });
    expect(meta.last).toEqual({ ts: 42, excerpt: "门禁绿了", from: "agent:a_000000000001" });
  });
```

`describe("createSupabaseCloudSessionMeta", …)` 内加：

```ts
  it("最后一句三列一起写，时间写成 ISO（#1356 A1）", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}).setLast({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "你好", from: "human:u1" });
    expect(f.update).toHaveBeenCalledWith({ last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: "你好", last_from: "human:u1" });
    expect(f.eq).toHaveBeenCalledWith("id", "sess-1");
  });

  it("最后一句写失败（0040 没跑，列不存在）只记一行日志不抛", async () => {
    const log = vi.fn();
    const f = fakeClient({ error: { message: "column last_ts does not exist" } });
    await expect(createSupabaseCloudSessionMeta(f.client, "s", log).setLast({ ts: 1, excerpt: "x", from: "human:u1" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
```

在 `tests/runtime/sessionService.test.ts` 末尾加一个 describe（`baseOpts` / `newStore` / `echoAdapter` 是该文件已有的装配）：

```ts
// ── 名册「最后一句」（#1356 A1，spec §7.1）─────────────────────────────
describe("最后一句写进 workspace_sessions（#1356 A1）", () => {
  it("人说一句 → 写人那句；agent 答完 → 写 agent 的答案（throttle 0，当场写）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const meta = createInMemoryCloudSessionMeta();
    const setLast = vi.spyOn(meta, "setLast");
    const session = createCloudSession({ ...baseOpts(store, events), sessionMeta: meta, lastThrottleMs: 0 });
    await session.say("u1", "张三", "@default 帮我看下排班", true, ["default"], undefined, undefined);
    await session.settled();
    const froms = setLast.mock.calls.map((c) => c[0].from);
    expect(froms[0]).toBe("human:u1");
    expect(meta.last).toMatchObject({ excerpt: "好", from: "agent:default" });
  });

  it("系统旁白（没派出去那种 chat_message）不写", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const meta = createInMemoryCloudSessionMeta();
    const session = createCloudSession({ ...baseOpts(store, events), sessionMeta: meta, lastThrottleMs: 0 });
    await session.say("u1", "张三", "@不存在的人 你好", false, ["查无此人"], undefined, undefined);
    await session.settled();
    // 人那句算，系统那句「没找到」不算——最后一句仍是人说的
    expect(meta.last).toMatchObject({ from: "human:u1" });
  });
});
```

（若 `say` 的参数签名与上面不同，以该文件里现有 `session.say(...)` 调用的写法为准——参考同文件「每条人类发言都推进参与者」那几条用例，第二条用例与那边「系统旁白不算参与」逐字同形。第一条用例里 `DEFAULT_AGENT` 的 agentId 是 `default`，`echoAdapter` 回 `"好"`。）

- [ ] **Step 3: 跑一下确认失败**

Run: `npx vitest run tests/runtime/lastWriter.test.ts tests/runtime/cloudSessionMeta.test.ts tests/runtime/sessionService.test.ts -t "最后一句|createLastWriter"`
Expected: FAIL（`lastWriter.js` 不存在；`setLast` 不是函数；`lastThrottleMs` 被忽略导致 `meta.last` 为 null）

- [ ] **Step 4: 实现节流器**

Create `services/runtime/src/lastWriter.ts`：

```ts
// lastWriter —— 名册「最后一句」写库的节流（#1356 A1，spec §7.1）。
//
// 首尾两沿：距上一次**写**已经够久就当场写（人刚说完的那句立刻顶上名册）；否则记下
// 这一句、排一个定时器到窗口末尾再写（3 秒内说了好几句时，最后那句一定写到）。窗口
// 从上一次写算起，不从上一次 push 算起——否则一句接一句地说，尾沿会被无限往后推。
// 只排一个定时器：窗口里再来几句只换掉待写的那一格。
//
// 写的是日志的投影：失败只丢这一格（CloudSessionMeta 的实现自己记日志），下一句盖掉。
// 时钟与定时器可注入，测试不必动 vi 的假定时器。

import type { SessionLast } from "../../../src/shared/sessionLast.js";

export interface LastWriter {
  push(l: SessionLast): void;
}

export function createLastWriter(o: {
  write: (l: SessionLast) => Promise<void>;
  throttleMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): LastWriter {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number): unknown => {
    const t = setTimeout(fn, ms);
    // 一个待写的名册投影不该拖着进程不退（daemon 收摊、测试结束时）
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pending: SessionLast | null = null;
  let armed = false;

  const fire = (): void => {
    armed = false;
    if (pending === null) return;
    const l = pending;
    pending = null;
    lastWriteAt = now();
    void o.write(l).catch(() => undefined);
  };

  return {
    push(l) {
      pending = l;
      if (armed) return;
      const wait = lastWriteAt + o.throttleMs - now();
      if (wait <= 0) {
        fire();
        return;
      }
      armed = true;
      setTimer(fire, wait);
    },
  };
}
```

- [ ] **Step 5: `CloudSessionMeta` 加 `setLast`**

`services/runtime/src/cloudSessionMeta.ts`：

1. import 区加 `import type { SessionLast } from "../../../src/shared/sessionLast.js";`
2. 接口 `CloudSessionMeta` 加一个方法（文件头注释第一行里的「那三格」改成「那几格」，并把 `last_*` 三列补进括号里）：
   ```ts
  /** 名册那一行的「最后一句 + 最近动静」（#1356 A1，spec §7.1）。节流在调用方（lastWriter） */
  setLast(l: SessionLast): Promise<void>;
   ```
3. `createInMemoryCloudSessionMeta` 的返回类型加 `last: SessionLast | null;`，`state` 加 `last: null`，返回对象加：
   ```ts
    get last() { return state.last; },
    async setLast(l) { state.last = { ...l }; },
   ```
4. `createSupabaseCloudSessionMeta` 的返回对象加：
   ```ts
    async setLast(l) {
      await write({ last_ts: new Date(l.ts).toISOString(), last_excerpt: l.excerpt, last_from: l.from }, "最后一句");
    },
   ```
5. 全仓还有别的 `CloudSessionMeta` 实现要补这个方法：`grep -rn "setParticipants" services tests --include='*.ts'`，每一处手写的假件都加一个 `async setLast() {}`（或 `setLast: async () => {}`）——tsc 会点名漏掉的。

- [ ] **Step 6: 会话服务接线**

`services/runtime/src/sessionService.ts`：

1. import 区加：
   ```ts
   import { LAST_THROTTLE_MS, lastOf } from "../../../src/shared/sessionLast.js";
   import { createLastWriter } from "./lastWriter.js";
   ```
2. `CloudSessionOpts` 里 `sessionMeta: CloudSessionMeta;` 之后加：
   ```ts
  /** 名册「最后一句」写库的节流间隔（#1356 A1，spec §7.1）。**可选**：缺席 = LAST_THROTTLE_MS
      （3 秒）。只有测试传 0（每条都当场写，断言不用等定时器） */
  lastThrottleMs?: number;
   ```
3. 装配处，紧跟 `let participants: ParticipantWindow | null = lastActiveWindowParticipants(seed);` 那一行之后加：
   ```ts
  /** 名册那一行的「最后一句」（#1356 A1）。**不播种、不回填**（spec §7.1）：重启后下一句
      算数的话来了才写——库里那一格在重启前后都是对的，没必要为它读一遍日志 */
  const lastWriter = createLastWriter({
    write: (l) => opts.sessionMeta.setLast(l),
    throttleMs: opts.lastThrottleMs ?? LAST_THROTTLE_MS,
  });
   ```
4. `notify` 里，紧跟 `if (humanSpeakerOf(e) !== null) humanSaid += 1;` 那一行之后加：
   ```ts
    // 名册「最后一句」（#1356 A1）：判据在 shared/sessionLast.ts，节流在 lastWriter。
    // 同 advanceParticipants 的推理：daemon.ts 绕过 notify 直接 append 的那几类里只有
    // fromUid=system 的 chat_message 与这一格相关，而 lastOf 本来就不认它
    const last = lastOf(e);
    if (last !== null) lastWriter.push(last);
   ```

- [ ] **Step 7: 跑测试 + 类型检查**

Run: `npx vitest run tests/runtime/lastWriter.test.ts tests/runtime/cloudSessionMeta.test.ts tests/runtime/sessionService.test.ts && npx tsc --noEmit -p services/runtime && npx tsc --noEmit -p .`
Expected: 全 PASS；两次 tsc 无输出。

- [ ] **Step 8: Commit**

```bash
git add services/runtime/src/lastWriter.ts services/runtime/src/cloudSessionMeta.ts services/runtime/src/sessionService.ts tests/runtime/lastWriter.test.ts tests/runtime/cloudSessionMeta.test.ts tests/runtime/sessionService.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): 把名册「最后一句」节流写进 workspace_sessions（#1356 A1，spec §7.1）

notify 里逐条推进（同 title / participants 的形状），判据在 shared/sessionLast.ts，
这里只管 IO。首尾两沿节流：首沿当场写（人刚说完的那句立刻顶上名册），3 秒窗口里
后来的几句只写最后那句且一定写到；窗口从上一次写算起，否则连着说会把尾沿无限
往后推。不播种不回填；0040 没跑时 write() 接住 42703 只记日志。要跑 migration
再部署 runtime 才生效（#791）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 6: 手机名册那一列的纯逻辑（shared）

名册画什么、按什么顺序、每行写什么、时间怎么说、群那几张脸怎么叠——全是判断，放 shared 进 vitest；RosterScreen（Task 12）只画。与桌面 `agentRoster.ts` 的一处**故意不同**：桌面单只按名册顺序、群按活动；手机把两种混在一起、一律按最近一次动静降序（spec §5.2，demo 定的）。

**Files:**
- Create: `src/shared/mobileRoster.ts`
- Test: `tests/shared/mobileRoster.test.ts`

**Interfaces:**
- Consumes: `rosterRows` / `groupRows`（`src/shared/agentRoster.ts`）；`agentFaceSlot`（`src/shared/agentAvatar.ts`）；`dayLabelOf`（`src/shared/dayLabel.ts`）；`SessionLast` / `lastSpeakerOf`（Task 4）；`CloudSessionRow`（`src/shared/supabaseWorkspacesApi.ts`）；`agentNameOf` / `labelOf`（`src/shared/workspaceView.ts`）；`faceBox`（`src/shared/ottoFace/art.ts`）；`WorkspaceAgentRow.createdTs?`（Task 1）。
- Produces:
  - `FIRST_WORD_HINT = "点进去跟它说第一句"`
  - `interface AgentRosterItem { kind: "agent"; key: string; agentId: string; name: string; description: string; slot: number; isAdmin: boolean; sessionId: string | null; sub: string; line2: string | null; lastText: string | null; activityTs: number; timeTs: number | null }`
  - `interface GroupRosterItem { kind: "group"; key: string; sessionId: string; name: string; memberNames: string; agentIds: string[]; slots: number[]; sub: string; line2: string | null; lastText: string | null; activityTs: number; timeTs: number | null }`
  - 三格文字各管一件事：`sub` = 第一行名字后面那段小字；`line2` = 第二行（null = 不画）；`lastText` = 真正的最后一句（只给搜索用，null = 没有）
  - `type RosterItem = AgentRosterItem | GroupRosterItem`
  - `rosterItems(o: { home: WorkspaceSnapshot; chats: readonly CloudSessionRow[]; lasts: ReadonlyMap<string, SessionLast>; selfUid: string }): RosterItem[]`
  - `filterRosterItems(items: readonly RosterItem[], query: string): RosterItem[]`
  - `rosterTimeLabel(ts: number, now: number): string`
  - `GROUP_FACES_WIDTH`（= m 档单只的宽 59）、`groupFaceOffsets(n: number): number[]`

- [ ] **Step 1: 写失败的测试**

Create `tests/shared/mobileRoster.test.ts`：

```ts
// mobileRoster —— 手机名册那一列（#1356 A1，spec §5.2）。

import { describe, expect, it } from "vitest";
import {
  FIRST_WORD_HINT, GROUP_FACES_WIDTH, filterRosterItems, groupFaceOffsets, rosterItems, rosterTimeLabel,
} from "../../src/shared/mobileRoster.js";
import type { CloudSessionRow } from "../../src/shared/supabaseWorkspacesApi.js";
import type { SessionLast } from "../../src/shared/sessionLast.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string, o: Partial<WorkspaceAgentRow> = {}): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null, ...o,
});
const HOME: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [
    agent("admin", "管理员", { description: "帮你建智能体", createdTs: 500 }),
    agent("a_000000000001", "开发", { description: "写代码", createdTs: 1000, avatarSlot: 5 }),
    agent("a_000000000002", "运维", { description: "部署与监控", createdTs: 2000 }),
  ],
};
const row = (id: string, o: Partial<CloudSessionRow>): CloudSessionRow => ({
  id, title: "", publisherUid: "me", archived: false, updatedTs: 0, participantUids: [], chatKind: null, agentIds: [], ...o,
});
const last = (ts: number, excerpt: string, from: string): SessionLast => ({ ts, excerpt, from });

describe("rosterItems", () => {
  const chats = [
    row("dm-dev", { chatKind: "dm", agentIds: ["a_000000000001"], updatedTs: 3000 }),
    row("g1", { chatKind: "group", agentIds: ["a_000000000002", "a_000000000001"], title: "发版组", updatedTs: 100 }),
  ];
  it("单只与群混在一起，按最近一次动静降序：last_ts → 那一行的 updated_at → 智能体自己的 created_at", () => {
    const lasts = new Map([["dm-dev", last(5000, "门禁绿了", "agent:a_000000000001")], ["g1", last(7000, "edge 部完了", "agent:a_000000000002")]]);
    const items = rosterItems({ home: HOME, chats, lasts, selfUid: "me" });
    expect(items.map((i) => i.key)).toEqual(["group:g1", "agent:a_000000000001", "agent:a_000000000002", "agent:admin"]);
  });
  it("没有 last 时退回那一行的 updated_at（0040 没跑 / 还没人说过话）", () => {
    const items = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" });
    // dm-dev 3000 > 运维 created 2000 > 管理员 created 500 > g1 updated 100
    expect(items.map((i) => i.key)).toEqual(["agent:a_000000000001", "agent:a_000000000002", "agent:admin", "group:g1"]);
  });
  it("同分按名册顺序（单只在前、按名册；群在后）", () => {
    const flat = { ...HOME, agents: HOME.agents.map((a) => ({ ...a, createdTs: 0 })) };
    const items = rosterItems({ home: flat, chats: [row("g1", { chatKind: "group", agentIds: ["admin", "a_000000000001"], updatedTs: 0 })], lasts: new Map(), selfUid: "me" });
    expect(items.map((i) => i.key)).toEqual(["agent:admin", "agent:a_000000000001", "agent:a_000000000002", "group:g1"]);
  });
  it("缺 createdTs 的智能体按 0 排（旧快照），不报错", () => {
    const old = { ...HOME, agents: [agent("admin", "管理员")] };
    expect(rosterItems({ home: old, chats: [], lasts: new Map(), selfUid: "me" })[0]).toMatchObject({ activityTs: 0, timeTs: null });
  });
  it("单只那一行：聊过 = 名字后面小字写职责、第二行写最后一句（不带前缀）、时间是那句话的时刻", () => {
    const lasts = new Map([["dm-dev", last(5000, "门禁绿了", "agent:a_000000000001")]]);
    const dev = rosterItems({ home: HOME, chats, lasts, selfUid: "me" }).find((i) => i.key === "agent:a_000000000001")!;
    expect(dev).toMatchObject({
      kind: "agent", name: "开发", description: "写代码", sessionId: "dm-dev",
      sub: "写代码", line2: "门禁绿了", lastText: "门禁绿了", timeTs: 5000, slot: 5,
    });
  });
  it("没聊过 = 第二行写提示、不画时间", () => {
    const items = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" });
    expect(items.find((i) => i.key === "agent:a_000000000002")).toMatchObject({
      sessionId: null, sub: "部署与监控", line2: FIRST_WORD_HINT, lastText: null, timeTs: null,
    });
    expect(items.find((i) => i.key === "agent:admin")).toMatchObject({ isAdmin: true });
  });
  it("聊过但读不到最后一句（0040 没跑 / 没部署）：职责挪到第二行、第一行不重复写（spec §10 第 9 条），时间退回 updated_at", () => {
    const dev = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "agent:a_000000000001")!;
    expect(dev).toMatchObject({ sub: "", line2: "写代码", lastText: null, timeTs: 3000 });
    const bare = { ...HOME, agents: HOME.agents.map((a) => ({ ...a, description: "" })) };
    expect(rosterItems({ home: bare, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "agent:a_000000000001"))
      .toMatchObject({ sub: "", line2: null });
  });
  it("群那一行：成员名按名册顺序拼、最后一句带「名字：」前缀；人说的写「我」", () => {
    const byAgent = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "edge 部完了", "agent:a_000000000002")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(byAgent).toMatchObject({ kind: "group", name: "发版组", memberNames: "开发、运维", sub: "开发、运维", line2: "运维：edge 部完了", lastText: "运维：edge 部完了", timeTs: 9 });
    const byMe = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "大家看下", "human:me")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(byMe).toMatchObject({ line2: "我：大家看下" });
    const unknown = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "…", "")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(unknown).toMatchObject({ line2: "…" });
  });
  it("群的脸与名字同一个顺序（跟名册走，不跟那一列的写入顺序走）", () => {
    const g = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "group:g1")!;
    expect(g.kind === "group" && g.agentIds).toEqual(["a_000000000001", "a_000000000002"]);
    expect(g.kind === "group" && g.slots[0]).toBe(5); // 开发挑过坑位 5
  });
});

describe("filterRosterItems", () => {
  const lasts = new Map([["dm-dev", last(5000, "推到 claude/pricing 了", "agent:a_000000000001")]]);
  const items = rosterItems({
    home: HOME,
    chats: [
      row("dm-dev", { chatKind: "dm", agentIds: ["a_000000000001"], updatedTs: 3000 }),
      row("g1", { chatKind: "group", agentIds: ["a_000000000002", "admin"], title: "奶茶店", updatedTs: 1 }),
    ],
    lasts,
    selfUid: "me",
  });
  it("空查询原样返回", () => {
    expect(filterRosterItems(items, "  ")).toHaveLength(items.length);
  });
  it("按名字 / 职责 / 最后一句过滤，拉丁字母不分大小写", () => {
    expect(filterRosterItems(items, "开发").map((i) => i.key)).toEqual(["agent:a_000000000001"]);
    expect(filterRosterItems(items, "部署").map((i) => i.key)).toEqual(["agent:a_000000000002"]);
    expect(filterRosterItems(items, "PRICING").map((i) => i.key)).toEqual(["agent:a_000000000001"]);
  });
  it("群按群名与成员名命中", () => {
    expect(filterRosterItems(items, "奶茶").map((i) => i.key)).toEqual(["group:g1"]);
    expect(filterRosterItems(items, "管理员").map((i) => i.key)).toEqual(expect.arrayContaining(["agent:admin", "group:g1"]));
  });
  it("「点进去跟它说第一句」那句提示不是内容，搜不到", () => {
    expect(filterRosterItems(items, "第一句")).toEqual([]);
  });
});

describe("rosterTimeLabel", () => {
  const now = new Date(2026, 8, 23, 15, 30).getTime(); // 2026-09-23 周三 15:30（本地时间）
  it("一分钟之内写「刚刚」；未来的时间戳（时钟快）也写「刚刚」", () => {
    expect(rosterTimeLabel(now - 30_000, now)).toBe("刚刚");
    expect(rosterTimeLabel(now + 120_000, now)).toBe("刚刚");
  });
  it("同一个自然日写时刻（24 小时制、补零）", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 23, 9, 5).getTime(), now)).toBe("09:05");
  });
  it("往前按自然日：昨天 / 周几 / 几月几日", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 22, 23, 50).getTime(), now)).toBe("昨天");
    expect(rosterTimeLabel(new Date(2026, 8, 20, 10, 0).getTime(), now)).toBe("周日");
    expect(rosterTimeLabel(new Date(2026, 8, 3, 10, 0).getTime(), now)).toBe("9 月 3 日");
  });
});

describe("groupFaceOffsets", () => {
  it("总宽钉死 = m 档单只的宽，左边缘是一条直线；后一张压前一张", () => {
    expect(GROUP_FACES_WIDTH).toBe(59);
    expect(groupFaceOffsets(0)).toEqual([]);
    expect(groupFaceOffsets(1)).toEqual([14.75]);
    expect(groupFaceOffsets(2)).toEqual([0, 29.5]);
    expect(groupFaceOffsets(3)).toEqual([0, 14.75, 29.5]);
    const six = groupFaceOffsets(6);
    expect(six[0]).toBe(0);
    expect(six[5]).toBeCloseTo(29.5);
  });
});
```

- [ ] **Step 2: 跑一下确认失败**

Run: `npx vitest run tests/shared/mobileRoster.test.ts`
Expected: FAIL（`Cannot find module '../../src/shared/mobileRoster.js'`）

- [ ] **Step 3: 实现**

Create `src/shared/mobileRoster.ts`：

```ts
// mobileRoster —— 手机名册那一列（#1356 A1，spec §5.2）。判据全在这里（进 vitest），
// mobile/src/roster/ 只画。
//
// 与桌面 agentRoster.ts 的一处**故意不同**：桌面单只按名册顺序（通讯录）、群按活动；
// 手机把单只与群混在一起、一律按最近一次动静降序（demo 定的，spec §5.2）。
// 行的底层数据仍然来自桌面那两个函数（`rosterRows` / `groupRows`）：「哪条私聊算
// 这只的」「群名单与现存名册求交集、顺序跟名册走」这两条判据只能有一份。

import { agentFaceSlot } from "./agentAvatar.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { dayLabelOf } from "./dayLabel.js";
import { faceBox } from "./ottoFace/art.js";
import { lastSpeakerOf, type SessionLast } from "./sessionLast.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import { agentNameOf, labelOf } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

/** 没聊过的那一只底下那一行（spec §5.2）。它不是内容，搜索不命中它（搜索读的是 lastText） */
export const FIRST_WORD_HINT = "点进去跟它说第一句";

export interface AgentRosterItem {
  kind: "agent";
  key: string;
  agentId: string;
  name: string;
  description: string;
  /** 这只的头像坑位（挑过的优先，没挑过按 agentId 派生） */
  slot: number;
  isAdmin: boolean;
  /** 和它的那条私聊；null = 还没聊过（点进去是草稿，第一句发出去才建） */
  sessionId: string | null;
  /** 第一行名字后面那段小字（职责）。职责挪到第二行时这里是空串——同一句话不画两遍 */
  sub: string;
  /** 第二行：最后一句 / 没聊过的提示 / 读不到最后一句时的职责（spec §10 第 9 条）；null = 不画 */
  line2: string | null;
  /** 真正的最后一句（只给搜索用）；null = 没有 / 读不到 */
  lastText: string | null;
  /** 排序用的「最近一次动静」 */
  activityTs: number;
  /** 右边那格时间；null = 不画（没聊过） */
  timeTs: number | null;
}

export interface GroupRosterItem {
  kind: "group";
  key: string;
  sessionId: string;
  name: string;
  /** 成员名按名册顺序拼（`、` 分隔） */
  memberNames: string;
  agentIds: string[];
  slots: number[];
  /** 第一行名字后面那段小字（成员名） */
  sub: string;
  /** 第二行：「名字：摘录」；null = 读不到 / 还没人说过话 */
  line2: string | null;
  lastText: string | null;
  activityTs: number;
  timeTs: number | null;
}

export type RosterItem = AgentRosterItem | GroupRosterItem;

/** 群那一行的最后一句：「名字：摘录」。人说的写「我」（主场只有我一个人；万一不是，
    退回他在这个团队里的名字）。说话人认不出（空串 / 脏数据）就只写摘录，不编一个名字 */
function groupLastLine(home: WorkspaceSnapshot, last: SessionLast, selfUid: string): string {
  const who = lastSpeakerOf(last.from);
  if (who === null) return last.excerpt;
  const name = who.kind === "agent" ? agentNameOf(home, who.agentId) : who.uid === selfUid ? "我" : labelOf(home, who.uid);
  return `${name}：${last.excerpt}`;
}

/**
 * 名册那一列。顺序 = 最近一次动静降序；动静 = 那条聊天的 `last_ts` → 缺席退回那一行的
 * `updated_at`（这张表没有 created_at，而 updated_at 从没被补丁碰过，今天就等于创建时间）
 * → 没聊过的智能体退回它自己的 `created_at`（缺席按 0）；同分按名册顺序（单只按名册、
 * 群在后按 `groupRows` 的顺序）。
 */
export function rosterItems(o: {
  home: WorkspaceSnapshot;
  chats: readonly CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
  selfUid: string;
}): RosterItem[] {
  const createdOf = new Map(o.home.agents.map((a) => [a.agentId, a.createdTs ?? 0]));
  const agents = rosterRows(o.home, o.chats);
  const ranked: { item: RosterItem; order: number }[] = [];
  agents.forEach((r, i) => {
    const last = r.sessionId === null ? undefined : o.lasts.get(r.sessionId);
    const lastText = last !== undefined && last.excerpt !== "" ? last.excerpt : null;
    const activityTs = r.sessionId === null ? (createdOf.get(r.agentId) ?? 0) : (last?.ts ?? r.updatedTs);
    // 第二行三种：没聊过写提示；聊过写最后一句；聊过却读不到最后一句（0040 没跑 / runtime
    // 没部署）时把职责挪下来、第一行就不再重复写它（spec §10 第 9 条）
    const movedDown = r.sessionId !== null && lastText === null;
    ranked.push({
      order: i,
      item: {
        kind: "agent",
        key: `agent:${r.agentId}`,
        agentId: r.agentId,
        name: r.name,
        description: r.description,
        slot: agentFaceSlot(o.home, r.agentId),
        isAdmin: r.isAdmin,
        sessionId: r.sessionId,
        sub: movedDown ? "" : r.description,
        line2: r.sessionId === null ? FIRST_WORD_HINT : lastText ?? (r.description !== "" ? r.description : null),
        lastText,
        activityTs,
        timeTs: r.sessionId === null ? null : activityTs,
      },
    });
  });
  groupRows(o.home, o.chats).forEach((g, i) => {
    const last = o.lasts.get(g.sessionId);
    const activityTs = last?.ts ?? g.updatedTs;
    const memberNames = g.agentIds.map((id) => agentNameOf(o.home, id)).join("、");
    const lastText = last !== undefined && last.excerpt !== "" ? groupLastLine(o.home, last, o.selfUid) : null;
    ranked.push({
      order: agents.length + i,
      item: {
        kind: "group",
        key: `group:${g.sessionId}`,
        sessionId: g.sessionId,
        name: g.name,
        memberNames,
        agentIds: g.agentIds,
        slots: g.agentIds.map((id) => agentFaceSlot(o.home, id)),
        sub: memberNames,
        line2: lastText,
        lastText,
        activityTs,
        timeTs: activityTs,
      },
    });
  });
  return ranked
    .sort((a, b) => b.item.activityTs - a.item.activityTs || a.order - b.order)
    .map((x) => x.item);
}

/** 名册的本机搜索（spec §5.2，记忆那一半归 A5）：按名字 / 职责 / 最后一句过滤；群按群名 /
    成员名 / 最后一句。拉丁字母不分大小写。没聊过那句提示不是内容，不参与匹配 */
export function filterRosterItems(items: readonly RosterItem[], query: string): RosterItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((it) => {
    const hay = it.kind === "agent"
      ? [it.name, it.description, it.lastText ?? ""]
      : [it.name, it.memberNames, it.lastText ?? ""];
    return hay.some((s) => s.toLowerCase().includes(q));
  });
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 右边那格时间：一分钟之内「刚刚」→ 同一个自然日写时刻 → 往前「昨天 / 周几 / 几月几日」
    （判自然日不判 24 小时，同 dayLabel.ts）。未来的时间戳（本机时钟被调过）按「刚刚」 */
export function rosterTimeLabel(ts: number, now: number): string {
  if (now - ts < 60_000) return "刚刚";
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return dayLabelOf(ts, now);
}

/** 群那几张 s 档脸叠在一起的总宽 = m 档单只的宽：这一列的左边缘是一条直线（spec §5.2） */
export const GROUP_FACES_WIDTH = faceBox("m").w;

/** 每张 s 档脸的 left（pt）。步长 `(59 − 29.5) / (n − 1)`，后一张压前一张（后画的在上面）；
    只有一张时居中 */
export function groupFaceOffsets(n: number): number[] {
  const w = faceBox("s").w;
  if (n <= 0) return [];
  if (n === 1) return [(GROUP_FACES_WIDTH - w) / 2];
  const step = (GROUP_FACES_WIDTH - w) / (n - 1);
  return Array.from({ length: n }, (_, i) => i * step);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/mobileRoster.test.ts && npx tsc --noEmit -p .`
Expected: PASS；tsc 无输出。

- [ ] **Step 5: Commit**

```bash
git add src/shared/mobileRoster.ts tests/shared/mobileRoster.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): 手机名册那一列的纯逻辑——混排排序、每行写什么、时间、群脸横叠（#1356 A1）

spec §5.2：单只与群混在一起按最近一次动静降序（last_ts → updated_at → 智能体
created_at，同分按名册顺序），与桌面「单只按名册、群按活动」故意不同。行的底层
仍取桌面 rosterRows / groupRows——哪条私聊算这只、群名单与名册求交集，这两条
判据只能有一份。没聊过的那句提示不是内容，搜索不命中它。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: 聊天页与设置页的纯逻辑（shared）

聊天页：时间线每一条事件画成哪一种行（我说的 / 它说的按空行拆段 / 旁白 / 出错）、流式碎片画成正在写的那一段、最底下「此刻」那一行挑哪一只、点进来的目标解析成哪一条线。设置页：表单的校验、只带改动的 patch、挑头像墙的那几张脸、大脸那一遍「干活的样子」。藏哪些事件**不另立判据**：一律走桌面同一份 `hiddenFromCloudTimeline`（spec §5.3）。

**Files:**
- Create: `src/shared/mobileChat.ts`
- Create: `src/shared/agentSettingsForm.ts`
- Test: `tests/shared/mobileChat.test.ts`、`tests/shared/agentSettingsForm.test.ts`

**Interfaces:**
- Consumes: `splitBubbles`；`assistantLabel` / `hiddenFromCloudTimeline` / `relayLineText` / `stopButtonRows` / `systemNoteText` / `turnEndedLineText` / `userRowIdentity`（`src/shared/cloudTimeline.ts`）；`withDaySeparators`；`dmFaceState` / `FACE_PACKS` / `pickSlotOf` / `FaceState`（`src/shared/ottoFace/index.ts`）；`systemNoteDetail`；`openTurns` / `OpenTurn`（`src/shared/turnLedger.ts`）；`rosterRows` / `groupRows`；`agentNameOf`；`AGENT_DESCRIPTION_MAX` / `AGENT_INSTRUCTIONS_MAX`；`validateAgentName`；`CsChatInfo`；`CloudSessionRow`；`WorkspaceAgentRow`。
- Produces（`mobileChat.ts`）：
  - `type ChatTarget = { kind: "agent"; agentId: string } | { kind: "group"; sessionId: string }`
  - `interface ResolvedChat { kind: "dm" | "group"; sessionId: string | null; agentIds: string[]; title: string; seed: CsChatInfo }`；`resolveChatTarget(home, chats, target): ResolvedChat | null`
  - `type ChatRow = { kind: "day"; key; label } | { kind: "mine"; key; ts; text } | { kind: "human"; key; ts; name; text } | { kind: "agent"; key; ts; agentId; name; paragraphs: string[] } | { kind: "note"; key; ts; text; tone: "muted" | "error"; detail: string | null }`
  - `chatRows(o: { events; ws; selfUid; now }): ChatRow[]`；`liveRows(o: { streaming; ws; now }): ChatRow[]`
  - `type NowPhase = "queued" | "working" | "solving"`；`NOW_PHASE_TEXT`；`interface NowRow { key; seq; agentId; name; ts; phase; face: FaceState; canStop: boolean }`；`nowRowOf(o: { events; streaming; ws }): NowRow | null`
  - `clockLabel(ts: number): string`（`HH:MM`）
- Produces（`agentSettingsForm.ts`）：
  - `interface AgentForm { name: string; description: string; instructions: string; avatarSlot: number | null }`；`agentFormOf(a: WorkspaceAgentRow): AgentForm`
  - `interface AgentFormErrors { name: string | null; description: string | null; instructions: string | null }`；`agentFormErrors(f: AgentForm): AgentFormErrors`；`agentFormValid(e: AgentFormErrors): boolean`
  - `type AgentFormPatch = { name?: string; description?: string; instructions?: string; avatarSlot?: number | null }`；`agentFormPatch(a: WorkspaceAgentRow, f: AgentForm): AgentFormPatch | null`（null = 什么都没改）
  - `interface PickableFace { id: string; name: string; slot: number }`；`pickableFaces(): PickableFace[]`
  - `FACE_TOUR: readonly { state: FaceState; ms: number }[]`

- [ ] **Step 1: 写失败的测试（聊天页）**

Create `tests/shared/mobileChat.test.ts`：

```ts
// mobileChat —— 手机聊天页的纯逻辑（#1356 A1，spec §5.3）。藏哪些事件走桌面同一份
// hiddenFromCloudTimeline，这里只钉「留下来的那些画成哪一种行」。

import { describe, expect, it } from "vitest";
import { chatRows, clockLabel, liveRows, nowRowOf, resolveChatTarget } from "../../src/shared/mobileChat.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudSessionRow } from "../../src/shared/supabaseWorkspacesApi.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const WS: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "开发"), agent("a_000000000002", "运维")],
};
const DAY = new Date(2026, 8, 23, 10, 0).getTime();
let seq = 0;
const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "s1", ts: DAY, ...o }) as unknown as SessionEvent;

describe("chatRows", () => {
  it("我说的 / 它说的（按空行拆段）/ 日期分隔条", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "session_created" }),
        e({ type: "user_message", content: "[Stan]: 帮我看下排班", fromUid: "me", mentions: [] }),
        e({ type: "assistant_message", content: "国庆三个人两班倒。\n\n草表在 文件/排班.md", model: "m", agentId: "a_000000000001" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "mine", "agent"]);
    expect(rows[0]).toMatchObject({ kind: "day", label: "今天" });
    expect(rows[1]).toMatchObject({ kind: "mine", text: "帮我看下排班", ts: DAY });
    expect(rows[2]).toMatchObject({ kind: "agent", agentId: "a_000000000001", name: "开发", paragraphs: ["国庆三个人两班倒。", "草表在 文件/排班.md"] });
  });
  it("藏起来的一律不画：中间步骤、接力 / 招呼开场白、内务事件、压缩", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "assistant_message", content: "我先查一下", model: "m", agentId: "a_000000000001", toolCalls: [{ id: "c", name: "bash", args: {} }] }),
        e({ type: "user_message", content: "[系统]: …", fromUid: "me", relay: { depth: 1 } }),
        e({ type: "agent_briefed", agentId: "a_000000000001" }),
        e({ type: "context_compacted", agentId: "a_000000000001" }),
        e({ type: "turn_ended", outcome: "completed", agentId: "a_000000000001" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows).toEqual([]);
  });
  it("engine 旁白与系统发言画成旁白行；出错画成错误行（带原文）", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "chat_message", fromUid: "system", label: "系统", content: "没派出去（名单为空）", mention: false }),
        e({ type: "turn_ended", outcome: "error", error: "HTTP 500", agentId: "a_000000000002" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.slice(1)).toEqual([
      { kind: "note", key: "e0", ts: DAY, text: "没派出去（名单为空）", tone: "muted", detail: null },
      { kind: "note", key: "e1", ts: DAY, text: "「运维」这一轮出错", tone: "error", detail: "HTTP 500" },
    ]);
  });
  it("别人说的话（不是我）画成带名字的一行", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "chat_message", fromUid: "u2", label: "小红", content: "我也看看", mention: false })],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows[1]).toMatchObject({ kind: "human", name: "小红", text: "我也看看" });
  });
  it("跨天插分隔条，顺序跟日志走", () => {
    seq = 0;
    const yesterday = DAY - 24 * 3600 * 1000;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 昨天那句", fromUid: "me", ts: yesterday }),
        e({ type: "user_message", content: "[Stan]: 今天这句", fromUid: "me" }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => (r.kind === "day" ? r.label : r.kind))).toEqual(["昨天", "mine", "今天", "mine"]);
  });
});

describe("liveRows", () => {
  it("正在写的那一段按空行拆、名字现查；空的不画", () => {
    const rows = liveRows({ streaming: { a_000000000001: "第一段\n\n第二段", a_000000000002: "  " }, ws: WS, now: DAY });
    expect(rows).toEqual([{ kind: "agent", key: "live-a_000000000001", ts: DAY, agentId: "a_000000000001", name: "开发", paragraphs: ["第一段", "第二段"] }]);
  });
});

describe("nowRowOf", () => {
  const opening = (agentId: string, s: number) =>
    ({ seq: s, sessionId: "s1", ts: DAY + s, type: "user_message", content: "[Stan]: 在吗", fromUid: "me", mentions: [agentId] }) as unknown as SessionEvent;
  const step = (agentId: string, s: number) =>
    ({ seq: s, sessionId: "s1", ts: DAY + s, type: "assistant_message", content: "", model: "m", agentId, toolCalls: [{ id: "c", name: "bash", args: {} }] }) as unknown as SessionEvent;

  it("没有欠着的回答 → null", () => {
    expect(nowRowOf({ events: [], streaming: {}, ws: WS })).toBeNull();
  });
  it("排队中：不能停；时间取开场白那条", () => {
    const now = nowRowOf({ events: [opening("a_000000000001", 3)], streaming: {}, ws: WS })!;
    expect(now).toMatchObject({ agentId: "a_000000000001", name: "开发", phase: "queued", face: "queued", canStop: false, ts: DAY + 3, seq: 3 });
  });
  it("在跑、一个字都还没有 = 执行中（能停）；正文在往下掉 = 作答中", () => {
    const events = [opening("a_000000000001", 3), step("a_000000000001", 4)];
    expect(nowRowOf({ events, streaming: {}, ws: WS })).toMatchObject({ phase: "working", face: "working", canStop: true });
    expect(nowRowOf({ events, streaming: { a_000000000001: "国庆" }, ws: WS })).toMatchObject({ phase: "solving", face: "solving", canStop: true });
  });
  it("好几只同时欠着：作答 > 执行 > 排队，同档取 seq 最小", () => {
    const events = [opening("a_000000000001", 3), opening("a_000000000002", 5), step("a_000000000002", 6)];
    // 运维在跑（执行中）压过开发的排队
    expect(nowRowOf({ events, streaming: {}, ws: WS })).toMatchObject({ agentId: "a_000000000002", phase: "working" });
    const both = [opening("a_000000000001", 3), step("a_000000000001", 4), opening("a_000000000002", 5), step("a_000000000002", 6)];
    expect(nowRowOf({ events: both, streaming: {}, ws: WS })).toMatchObject({ agentId: "a_000000000001", phase: "working" });
  });
});

describe("resolveChatTarget", () => {
  const chats: CloudSessionRow[] = [
    { id: "dm-dev", title: "", publisherUid: "me", archived: false, updatedTs: 1, participantUids: [], chatKind: "dm", agentIds: ["a_000000000001"] },
    { id: "g1", title: "", publisherUid: "me", archived: false, updatedTs: 1, participantUids: [], chatKind: "group", agentIds: ["a_000000000002", "a_000000000001", "a_gone00000000"] },
  ];
  it("单只：有私聊给 sessionId，没有给 null（草稿）", () => {
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_000000000001" })).toEqual({
      kind: "dm", sessionId: "dm-dev", agentIds: ["a_000000000001"], title: "开发", seed: { kind: "dm", agentIds: ["a_000000000001"] },
    });
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_000000000002" })).toMatchObject({ kind: "dm", sessionId: null, title: "运维" });
  });
  it("群：名单与现存名册求交集、顺序跟名册；没起名用成员名拼", () => {
    expect(resolveChatTarget(WS, chats, { kind: "group", sessionId: "g1" })).toEqual({
      kind: "group", sessionId: "g1", agentIds: ["a_000000000001", "a_000000000002"], title: "开发、运维",
      seed: { kind: "group", agentIds: ["a_000000000001", "a_000000000002"] },
    });
  });
  it("找不到（被删了）→ null", () => {
    expect(resolveChatTarget(WS, chats, { kind: "agent", agentId: "a_nope00000000" })).toBeNull();
    expect(resolveChatTarget(WS, chats, { kind: "group", sessionId: "nope" })).toBeNull();
  });
});

describe("clockLabel", () => {
  it("24 小时制、补零", () => {
    expect(clockLabel(new Date(2026, 8, 23, 9, 5).getTime())).toBe("09:05");
    expect(clockLabel(new Date(2026, 8, 23, 21, 40).getTime())).toBe("21:40");
  });
});
```

- [ ] **Step 2: 写失败的测试（设置页）**

Create `tests/shared/agentSettingsForm.test.ts`：

```ts
// agentSettingsForm —— 手机智能体设置页的表单（#1356 A1，spec §5.4）。

import { describe, expect, it } from "vitest";
import {
  FACE_TOUR, agentFormErrors, agentFormOf, agentFormPatch, agentFormValid, pickableFaces,
} from "../../src/shared/agentSettingsForm.js";
import { faceCharacterAt, isFaceState } from "../../src/shared/ottoFace/index.js";
import type { WorkspaceAgentRow } from "../../src/shared/workspaces.js";

const A: WorkspaceAgentRow = {
  agentId: "a_000000000001", name: "开发", description: "写代码", instructions: "只推分支",
  models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
};

describe("agentFormErrors", () => {
  it("名字必填，校验与桌面同一份（空 / 空白 / @ / 太长）", () => {
    const ok = agentFormOf(A);
    expect(agentFormErrors(ok)).toEqual({ name: null, description: null, instructions: null });
    expect(agentFormValid(agentFormErrors(ok))).toBe(true);
    expect(agentFormErrors({ ...ok, name: "  " }).name).toBe("名字不能为空");
    expect(agentFormErrors({ ...ok, name: "开 发" }).name).toBe("名字里不能有空白");
    expect(agentFormErrors({ ...ok, name: "@开发" }).name).toMatch(/@/);
    expect(agentFormErrors({ ...ok, name: "长".repeat(33) }).name).toMatch(/32/);
  });
  it("职责不许换行、≤200 字；还有什么要交代的 ≤4000 字", () => {
    const ok = agentFormOf(A);
    expect(agentFormErrors({ ...ok, description: "一\n二" }).description).toBe("职责不能换行");
    expect(agentFormErrors({ ...ok, description: "字".repeat(201) }).description).toBe("职责最多 200 字");
    expect(agentFormErrors({ ...ok, description: "字".repeat(200) }).description).toBeNull();
    expect(agentFormErrors({ ...ok, instructions: "字".repeat(4001) }).instructions).toBe("最多 4000 字");
    expect(agentFormValid(agentFormErrors({ ...ok, instructions: "字".repeat(4001) }))).toBe(false);
  });
});

describe("agentFormPatch", () => {
  it("什么都没改 → null（「存」按不动）；只改了空白也算没改", () => {
    expect(agentFormPatch(A, agentFormOf(A))).toBeNull();
    expect(agentFormPatch(A, { ...agentFormOf(A), name: " 开发 ", description: "写代码  " })).toBeNull();
  });
  it("只带改了的那几格", () => {
    expect(agentFormPatch(A, { ...agentFormOf(A), description: "写代码、跑门禁" })).toEqual({ description: "写代码、跑门禁" });
    expect(agentFormPatch(A, { ...agentFormOf(A), name: "工程", instructions: "" })).toEqual({ name: "工程", instructions: "" });
  });
  it("换了形象才写 avatarSlot（没换就不写，spec §5.4）", () => {
    expect(agentFormPatch(A, { ...agentFormOf(A), avatarSlot: 3 })).toEqual({ avatarSlot: 3 });
    expect(agentFormPatch({ ...A, avatarSlot: 3 }, { ...agentFormOf({ ...A, avatarSlot: 3 }) })).toBeNull();
  });
});

describe("pickableFaces", () => {
  it("十张：cap 没有自己的坑位不进这面墙；暂借格 1 / 2 / 10 一个都不出现", () => {
    const faces = pickableFaces();
    expect(faces).toHaveLength(10);
    expect(faces.map((f) => f.id)).not.toContain("cap");
    for (const f of faces) {
      expect([1, 2, 10]).not.toContain(f.slot);
      expect(faceCharacterAt(f.slot).id).toBe(f.id); // 存进去的坑位画出来就是这张脸
    }
  });
});

describe("FACE_TOUR", () => {
  it("走一遍干活的样子：排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着", () => {
    expect(FACE_TOUR.map((s) => s.state)).toEqual(["queued", "composing", "searching", "working", "solving", "done", "alive"]);
    for (const s of FACE_TOUR) {
      expect(isFaceState(s.state)).toBe(true);
      expect(s.ms).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: 跑一下确认失败**

Run: `npx vitest run tests/shared/mobileChat.test.ts tests/shared/agentSettingsForm.test.ts`
Expected: FAIL（两个模块都不存在）

- [ ] **Step 4: 实现聊天页的纯逻辑**

Create `src/shared/mobileChat.ts`：

```ts
// mobileChat —— 手机聊天页的纯逻辑（#1356 A1，spec §5.3）。mobile/src/chat/ 只画。
//
// 藏哪些事件**不另立判据**：一律走 hiddenFromCloudTimeline（桌面同一份，内务事件、工具
// 步骤、开场白都不画，ADR-0235 / 0250）。这里只回答「留下来的那些画成哪一种行」，以及
// 最底下「此刻」那一行挑哪一只。

import type { SessionEvent } from "../session/events.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { splitBubbles } from "./chatBubbles.js";
import {
  assistantLabel, hiddenFromCloudTimeline, relayLineText, stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity,
} from "./cloudTimeline.js";
import { withDaySeparators } from "./dayLabel.js";
import { dmFaceState, type FaceState } from "./ottoFace/index.js";
import type { CsChatInfo } from "./remote/cloudSession.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import { systemNoteDetail } from "./systemNote.js";
import { openTurns, type OpenTurn } from "./turnLedger.js";
import { agentNameOf } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

/** 从名册点进来的是谁：单只（按 agentId 找它那条私聊）或一个群（按 sessionId） */
export type ChatTarget = { kind: "agent"; agentId: string } | { kind: "group"; sessionId: string };

export interface ResolvedChat {
  kind: "dm" | "group";
  /** null = 还没有这条私聊（草稿：第一句发出去那一刻才建，spec §5.2） */
  sessionId: string | null;
  /** 已与现存名册求交集、顺序跟名册 */
  agentIds: string[];
  /** 私聊 = 那只的名字；群 = 群名（没起名时成员名拼起来） */
  title: string;
  /** 打开这条线时给 `chat` 种的那一格（ADR-0302：welcome 之前也得知道是哪一种聊天） */
  seed: CsChatInfo;
}

/** 点进来的目标解析成哪一条线。判据与名册同源（`rosterRows` / `groupRows`），名册上
    点得到的这里一定解析得出；查不到（刚被删了）回 null，调用方说实话、不画一张空壳 */
export function resolveChatTarget(
  home: WorkspaceSnapshot,
  chats: readonly CloudSessionRow[],
  target: ChatTarget,
): ResolvedChat | null {
  if (target.kind === "agent") {
    const r = rosterRows(home, chats).find((x) => x.agentId === target.agentId);
    if (r === undefined) return null;
    return { kind: "dm", sessionId: r.sessionId, agentIds: [r.agentId], title: r.name, seed: { kind: "dm", agentIds: [r.agentId] } };
  }
  const g = groupRows(home, chats).find((x) => x.sessionId === target.sessionId);
  if (g === undefined) return null;
  return { kind: "group", sessionId: g.sessionId, agentIds: g.agentIds, title: g.name, seed: { kind: "group", agentIds: [...g.agentIds] } };
}

export type ChatRow =
  | { kind: "day"; key: string; label: string }
  /** 我说的：右侧实色气泡 */
  | { kind: "mine"; key: string; ts: number; text: string }
  /** 别的人说的（主场里不会有，群聊将来会有）：左侧带名字 */
  | { kind: "human"; key: string; ts: number; name: string; text: string }
  /** 它说的：不套气泡的正文，按空行拆成几段（splitBubbles，ADR-0266） */
  | { kind: "agent"; key: string; ts: number; agentId: string; name: string; paragraphs: string[] }
  /** 旁白（系统说的一句、engine 注的后台任务 / 护栏、接力线）与出错 */
  | { kind: "note"; key: string; ts: number; text: string; tone: "muted" | "error"; detail: string | null };

type ItemRow = Exclude<ChatRow, { kind: "day" }>;

function rowOf(e: SessionEvent, ws: WorkspaceSnapshot, selfUid: string): ItemRow | null {
  if (hiddenFromCloudTimeline(e)) return null;
  const key = `e${e.seq}`;
  switch (e.type) {
    case "user_message": {
      const note = systemNoteText(e, ws);
      if (note !== null) return { kind: "note", key, ts: e.ts, text: note, tone: "muted", detail: systemNoteDetail(e) };
      const id = userRowIdentity(e, ws, selfUid);
      return id.mine
        ? { kind: "mine", key, ts: e.ts, text: id.text }
        : { kind: "human", key, ts: e.ts, name: id.label ?? "成员", text: id.text };
    }
    case "chat_message":
      if (e.fromUid === "system") return { kind: "note", key, ts: e.ts, text: e.content, tone: "muted", detail: null };
      return e.fromUid === selfUid
        ? { kind: "mine", key, ts: e.ts, text: e.content }
        : { kind: "human", key, ts: e.ts, name: e.label, text: e.content };
    case "assistant_message": {
      const paragraphs = splitBubbles(e.content);
      if (paragraphs.length === 0) return null;
      return { kind: "agent", key, ts: e.ts, agentId: e.agentId ?? "", name: assistantLabel(e, ws), paragraphs };
    }
    case "turn_ended":
      // 停了（aborted）是人自己按的，「此刻」那一行随事件消失就是回答；出错才画
      if (e.outcome !== "error") return null;
      return { kind: "note", key, ts: e.ts, text: turnEndedLineText(e, ws) ?? "这一轮出错", tone: "error", detail: e.error ?? null };
    case "agent_relay":
      return { kind: "note", key, ts: e.ts, text: relayLineText(e, ws), tone: "muted", detail: null };
    case "session_archived":
      return { kind: "note", key, ts: e.ts, text: "这条聊天已归档", tone: "muted", detail: null };
    default:
      // 名单变更那一行（chat_roster_changed，要看前一条）、通话卡（A4）、压缩与其余内务：
      // 手机端这一片不画——压缩是上下文系统自己的事（聊天里那条线不断），群的名单行在 A3
      return null;
  }
}

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

/** 正在写的那一段（流式碎片，协议 16）：累计快照按空行拆，画成它的一行。终态落盘时
    store 清槽，这一行随之换成真的那条 */
export function liveRows(o: { streaming: Readonly<Record<string, string>>; ws: WorkspaceSnapshot; now: number }): ChatRow[] {
  const out: ChatRow[] = [];
  for (const [agentId, text] of Object.entries(o.streaming)) {
    const paragraphs = splitBubbles(text);
    if (paragraphs.length === 0) continue;
    out.push({ kind: "agent", key: `live-${agentId}`, ts: o.now, agentId, name: agentNameOf(o.ws, agentId), paragraphs });
  }
  return out;
}

export type NowPhase = "queued" | "working" | "solving";
export const NOW_PHASE_TEXT: Record<NowPhase, string> = { queued: "排队中", working: "执行中", solving: "作答中" };
const PHASE_RANK: Record<NowPhase, number> = { solving: 0, working: 1, queued: 2 };

export interface NowRow {
  key: string;
  /** 开场白那条的 seq（「停一下」发的就是它，服务端再核一次 not_current） */
  seq: number;
  agentId: string;
  name: string;
  /** 开场白那条的时刻 */
  ts: number;
  phase: NowPhase;
  /** 那张脸的表情（与桌面私聊头部同一份判据 dmFaceState） */
  face: FaceState;
  /** 「停一下」画不画：只在它真在跑时（排队的那一轮一个 token 都还没跑，没东西可停），
      且只认每只 seq 最小那行（stopButtonRows，否则会停错一轮） */
  canStop: boolean;
}

/**
 * 最底下那一行 =「此刻」（spec §5.3）：只在有没收口的一轮时出现，一次只画一只——
 * 作答 > 执行 > 排队，同档取 seq 最小（spec §5.6 定的顺序，私聊里只有一只，自然成立）。
 * 每只先取它自己 seq 最小的那条（turnLedger 认不出「动静属于哪一轮」，同 dmFaceState）。
 */
export function nowRowOf(o: {
  events: readonly SessionEvent[];
  streaming: Readonly<Record<string, string>>;
  ws: WorkspaceSnapshot;
}): NowRow | null {
  const turns = openTurns(o.events);
  if (turns.length === 0) return null;
  const earliest = new Map<string, OpenTurn>();
  for (const t of turns) {
    const cur = earliest.get(t.agentId);
    if (cur === undefined || t.seq < cur.seq) earliest.set(t.agentId, t);
  }
  let best: { t: OpenTurn; phase: NowPhase } | null = null;
  for (const t of earliest.values()) {
    const phase: NowPhase = t.state === "queued" ? "queued" : (o.streaming[t.agentId] ?? "") === "" ? "working" : "solving";
    if (
      best === null ||
      PHASE_RANK[phase] < PHASE_RANK[best.phase] ||
      (PHASE_RANK[phase] === PHASE_RANK[best.phase] && t.seq < best.t.seq)
    ) {
      best = { t, phase };
    }
  }
  if (best === null) return null;
  const { t, phase } = best;
  return {
    key: `now-${t.seq}-${t.agentId}`,
    seq: t.seq,
    agentId: t.agentId,
    name: agentNameOf(o.ws, t.agentId),
    ts: o.events.find((e) => e.seq === t.seq)?.ts ?? 0,
    phase,
    face: dmFaceState(turns, o.streaming, t.agentId),
    canStop: phase !== "queued" && stopButtonRows(turns).has(`${t.seq}:${t.agentId}`),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 行上那格时刻（段前一行「脸 + 名字 · 时间」、「此刻」那一行）。日期由分隔条说 */
export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
```

- [ ] **Step 5: 实现设置页的纯逻辑**

Create `src/shared/agentSettingsForm.ts`：

```ts
// agentSettingsForm —— 手机智能体设置页的表单（#1356 A1，spec §5.4）。判据全在这里，
// mobile/src/agent/ 只画。真正落库前还会过 agentAdmin.updateAgentChecked（校验 + 查重名），
// 这里的校验只负责「当场说出口、按不动」，与服务端那道同口径（长度按 UTF-16 长度算，
// 同 validateAgentPatch 的 optionalText——否则表单放行的东西落库时被拒）。

import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "./createAgentDraft.js";
import { FACE_PACKS, pickSlotOf, type FaceState } from "./ottoFace/index.js";
import { validateAgentName } from "./workspaceAgents.js";
import type { WorkspaceAgentRow } from "./workspaces.js";

export interface AgentForm {
  name: string;
  description: string;
  /** 「还有什么要交代的」——它自己看得见这一段 */
  instructions: string;
  /** 表单此刻的头像选择；null = 没挑过（按 agentId 派生） */
  avatarSlot: number | null;
}

export function agentFormOf(a: WorkspaceAgentRow): AgentForm {
  return { name: a.name, description: a.description, instructions: a.instructions, avatarSlot: a.avatarSlot };
}

export interface AgentFormErrors {
  name: string | null;
  description: string | null;
  instructions: string | null;
}

export function agentFormErrors(f: AgentForm): AgentFormErrors {
  const description = f.description.trim();
  const instructions = f.instructions.trim();
  return {
    name: validateAgentName(f.name),
    description: /[\r\n]/.test(f.description)
      ? "职责不能换行"
      : description.length > AGENT_DESCRIPTION_MAX
        ? `职责最多 ${AGENT_DESCRIPTION_MAX} 字`
        : null,
    instructions: instructions.length > AGENT_INSTRUCTIONS_MAX ? `最多 ${AGENT_INSTRUCTIONS_MAX} 字` : null,
  };
}

export function agentFormValid(e: AgentFormErrors): boolean {
  return e.name === null && e.description === null && e.instructions === null;
}

export type AgentFormPatch = { name?: string; description?: string; instructions?: string; avatarSlot?: number | null };

/** 只带改了的那几格；什么都没改 → null（「存」按不动）。文字按 trim 之后比；头像**换了才写**
    （spec §5.4「没换就不写」：写一格等于替用户确认「我挑的就是它」） */
export function agentFormPatch(a: WorkspaceAgentRow, f: AgentForm): AgentFormPatch | null {
  const p: AgentFormPatch = {};
  const name = f.name.trim();
  if (name !== a.name) p.name = name;
  const description = f.description.trim();
  if (description !== a.description) p.description = description;
  const instructions = f.instructions.trim();
  if (instructions !== a.instructions) p.instructions = instructions;
  if (f.avatarSlot !== a.avatarSlot) p.avatarSlot = f.avatarSlot;
  return Object.keys(p).length === 0 ? null : p;
}

export interface PickableFace {
  id: string;
  name: string;
  /** 挑它时存进 avatar_slot 的那一格（`pickSlotOf`：自己的坑位，不是暂借格） */
  slot: number;
}

/** 挑头像那面墙。按 FACE_PACKS 的顺序；**cap 没有自己的坑位，不进这面墙**——它只借住在
    坑 2，存进暂借格的人会在补齐旧 03 那天被悄悄换脸（ADR-0316 法理③），所以这面墙是
    10 张不是 demo 的 11 张（spec §5.4，维护者 2026-09-24 确认） */
export function pickableFaces(): PickableFace[] {
  const out: PickableFace[] = [];
  for (const p of FACE_PACKS) {
    const slot = pickSlotOf(p.id);
    if (slot !== null) out.push({ id: p.id, name: p.name, slot });
  }
  return out;
}

/** 大脸上那一遍「它干活时长什么样」：排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着，
    走完从头来（demo 的 FACE_TOUR；最后一格是 alive 不是 idle——idle 带一枚「空闲」角标，
    那是在声称一件我们不知道的事）。queued 只给 900ms：它是唯一完全不动的那一格，停久了
    看着像坏了 */
export const FACE_TOUR: readonly { state: FaceState; ms: number }[] = [
  { state: "queued", ms: 900 },
  { state: "composing", ms: 1500 },
  { state: "searching", ms: 1400 },
  { state: "working", ms: 1600 },
  { state: "solving", ms: 1800 },
  { state: "done", ms: 1200 },
  { state: "alive", ms: 1500 },
];
```

- [ ] **Step 6: 跑测试 + 类型检查**

Run: `npx vitest run tests/shared/mobileChat.test.ts tests/shared/agentSettingsForm.test.ts && npx tsc --noEmit -p .`
Expected: PASS；tsc 无输出。

若 `nowRowOf` 的「排队中」用例拿到的是 `null`：说明 `openTurns` 要的开场白形状与夹具不符——对照 `src/shared/turnLedger.ts` 与 `tests/shared/turnLedger.test.ts` 里的夹具改**测试夹具**（开场白是带 `mentions` 的人话 `user_message`），不要改 `openTurns`。

- [ ] **Step 7: Commit**

```bash
git add src/shared/mobileChat.ts src/shared/agentSettingsForm.ts tests/shared/mobileChat.test.ts tests/shared/agentSettingsForm.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): 手机聊天页与设置页的纯逻辑（#1356 A1，spec §5.3 / §5.4）

聊天页：哪些事件藏起来不另立判据（走桌面同一份 hiddenFromCloudTimeline），这里只管
留下来的画成哪种行；「此刻」那一行作答 > 执行 > 排队、同档取 seq 最小，「停一下」只认
每只 seq 最小那行（stopButtonRows）。设置页：校验与服务端同口径，patch 只带改了的，
头像换了才写；挑头像墙十张（cap 没有自己的坑位，存进暂借格会被悄悄换脸）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 8: 装依赖 + 底部抽屉 + 几个小图标 + 群脸横叠

底部抽屉的第一个消费方是智能体设置里的「换个形象」（Task 10），A2 的「新建智能体」复用同一副骨架。按 ADR-0293 决定 3，`react-native-reanimated` 与 `react-native-gesture-handler` 跟第一个抽屉一起进（两者都在 Expo Go 57 里，reanimated 4 还要 `react-native-worklets`）。图标沿用手机端既有做法——用 View 画，不为几个形状引图标库。

> **执行前提**：这一步要从 npm 下载三个包（registry.npmjs.org：`react-native-reanimated-4.5.1.tgz` 解包约 4.4 MB、`react-native-gesture-handler-2.32.0.tgz` 约 3.3 MB、`react-native-worklets-0.10.1.tgz` 约 1.0 MB，外加少量传递依赖）。**维护者 2026-09-24 已同意下载**。

**Files:**
- Modify: `mobile/package.json`、`mobile/package-lock.json`
- Modify: `mobile/App.tsx`
- Create: `mobile/src/chrome/Glyphs.tsx`
- Create: `mobile/src/face/GroupFaces.tsx`
- Create: `mobile/src/sheet/BottomSheet.tsx`

**Interfaces:**
- Consumes: `groupFaceOffsets` / `GROUP_FACES_WIDTH`（Task 6）；`faceBox` / `facePhase`（`src/shared/ottoFace/art.ts`）；`Face`（`mobile/src/face/Face.tsx`）；`spring` / `usePalette` / `withAlpha` / `type`（`mobile/src/theme.ts`）；`useReduceMotion`（`mobile/src/ui.tsx`）。
- Produces:
  - `BackGlyph({ color, size? })`、`CloseGlyph({ color, size? })`、`MoreGlyph({ color })`、`SearchGlyph({ color, size? })`、`SendGlyph({ color })`
  - `GroupFaces({ agentIds: string[]; slots: number[]; state?: FaceState; height?: number })`
  - `BottomSheet({ visible: boolean; title: string; onClose: () => void; onExited?: () => void; children: ReactNode })`

- [ ] **Step 1: 装三个依赖（版本取 Expo SDK 57 的 bundledNativeModules）**

```bash
npm --prefix mobile install --save-exact react-native-reanimated@4.5.1 react-native-worklets@0.10.1
npm --prefix mobile install --save-prefix='~' react-native-gesture-handler@2.32.0
```

然后确认 `mobile/package.json` 的 `dependencies` 里正好多了这三行（值逐字）：

```json
    "react-native-gesture-handler": "~2.32.0",
    "react-native-reanimated": "4.5.1",
    "react-native-worklets": "0.10.1",
```

并确认版本与 Expo Go 自带的原生那一半一致（不一致 = 真机上一打开就红屏「worklets version mismatch」）：

Run: `grep -E '"react-native-(reanimated|gesture-handler|worklets)"' mobile/node_modules/expo/bundledNativeModules.json`
Expected: `~2.32.0` / `0.10.1` / `4.5.1` 三行，与上面 package.json 逐字对得上。

babel 不用配：`mobile/` 没有 `babel.config.js`，走 babel-preset-expo 的默认值，它在装了 reanimated / worklets 时自动挂 worklets 插件。**不要**新建 babel.config.js。

- [ ] **Step 2: 根上包 `GestureHandlerRootView`**

`mobile/App.tsx`：import 区加 `import { GestureHandlerRootView } from "react-native-gesture-handler";`，把 `view === "app"` 那一支改成：

```tsx
  if (view === "app") {
    return (
      // 手势库要求根上有它（抽屉的手势在它自己的 Modal 里另包一层，那是 Modal 另起一棵原生视图树的缘故）
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <RootNavigator />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }
```

- [ ] **Step 3: 小图标**

Create `mobile/src/chrome/Glyphs.tsx`：

```tsx
// 用 View 画的几个小图标（#1356 A1）：返回 / 关闭 / 设置 / 搜索 / 发送。沿用 ui.tsx 里
// Chevron 的做法——不为几个形状引一个图标依赖。颜色一律由调用方给（前景色 / 弱色 / 反白）。
import { View } from "react-native";

/** ‹ 返回：两道边转 45°（ui.tsx 的 Chevron 反过来） */
export function BackGlyph({ color, size = 11 }: { color: string; size?: number }) {
  return (
    <View style={{
      width: size, height: size, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderColor: color,
      transform: [{ rotate: "45deg" }], marginLeft: size * 0.4,
    }} />
  );
}

/** × 关闭：两根交叉的细条 */
export function CloseGlyph({ color, size = 14 }: { color: string; size?: number }) {
  const bar = { position: "absolute" as const, width: size * 1.25, height: 2, borderRadius: 1, backgroundColor: color };
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

/** ⋯ 设置：三个点 */
export function MoreGlyph({ color }: { color: string }) {
  const dot = { width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: color };
  return (
    <View style={{ flexDirection: "row", gap: 3.5 }}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

/** 放大镜：一个圈 + 右下一根柄 */
export function SearchGlyph({ color, size = 16 }: { color: string; size?: number }) {
  const ring = size * 0.72;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{
        position: "absolute", left: 0, top: 0, width: ring, height: ring,
        borderRadius: ring / 2, borderWidth: 2, borderColor: color,
      }} />
      <View style={{
        position: "absolute", left: ring * 0.72, top: ring * 0.92, width: size * 0.42, height: 2,
        borderRadius: 1, backgroundColor: color, transform: [{ rotate: "45deg" }],
      }} />
    </View>
  );
}

/** ↑ 发送：一道竖杆 + 顶上一个尖 */
export function SendGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 16, height: 16, alignItems: "center" }}>
      <View style={{
        width: 9, height: 9, borderLeftWidth: 2.2, borderTopWidth: 2.2, borderColor: color,
        transform: [{ rotate: "45deg" }], marginTop: 2,
      }} />
      <View style={{ position: "absolute", top: 2.5, width: 2.2, height: 13, borderRadius: 1.1, backgroundColor: color }} />
    </View>
  );
}
```

- [ ] **Step 4: 群脸横叠**

Create `mobile/src/face/GroupFaces.tsx`：

```tsx
// 群那几张脸横着叠（#1356 A1，spec §5.2）：s 档，总宽钉死 = m 档单只的宽（名册这一列的
// 左边缘因此是一条直线），后一张压前一张（后画的在上面）。几何在 shared/mobileRoster.ts。
import { View } from "react-native";
import { GROUP_FACES_WIDTH, groupFaceOffsets } from "../../../src/shared/mobileRoster.js";
import { faceBox, facePhase } from "../../../src/shared/ottoFace/art.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { Face } from "./Face.js";

export function GroupFaces({ agentIds, slots, state = "alive", height }: {
  agentIds: string[];
  slots: number[];
  state?: FaceState;
  /** 外框高度：名册那一行给 m 档单只的高（52），药丸里不给（= 一张 s 档的高） */
  height?: number;
}) {
  const { w, h } = faceBox("s");
  const offsets = groupFaceOffsets(slots.length);
  return (
    <View style={{ width: GROUP_FACES_WIDTH, height: height ?? h, justifyContent: "center" }}>
      <View style={{ width: GROUP_FACES_WIDTH, height: h }}>
        {slots.map((slot, i) => (
          <View key={agentIds[i] ?? String(i)} style={{ position: "absolute", left: offsets[i] ?? 0, top: 0, width: w, height: h }}>
            <Face slot={slot} tier="s" state={state} phase={facePhase(agentIds[i] ?? String(i))} />
          </View>
        ))}
      </View>
    </View>
  );
}
```

- [ ] **Step 5: 底部抽屉**

Create `mobile/src/sheet/BottomSheet.tsx`：

```tsx
// 底部抽屉（#1356 A1，spec §4）：从下往上、定高 70%、下拽可关（带动量：拖过自身高度的
// 四分之一、或者松手时往下一甩，都关）；X 在左、标题绝对居中。第一个消费方是智能体设置
// 里的「换个形象」，A2 的「新建智能体」复用同一副骨架。
//
// · 用 reanimated 驱动位移、gesture-handler 接下拽（ADR-0293 决定 3：两者跟第一个抽屉
//   一起进）。手势回调跑在 JS 线程（`runOnJS(true)`）——少一层 worklet 与 JS 之间的来回，
//   这一屏没有重到需要把手势挪上 UI 线程的东西。
// · 下拽只挂在把手 + 标题那一条上：内容区常常是一块能滚的列表，两个手势抢同一个方向就是
//   「想往下滚却把抽屉拽下来了」。
// · 往上拉给阻尼、封顶 24pt：越拉越拉不动，不是撞墙（Apple 的越界手感）。
// · 进场是临界阻尼的弹簧（可打断：半路又拽回去时速度接得上），退场 220ms 缓出；
//   关了动效就直接到位（瞬切，不是「快一点」）。
// · 「有值才画」的调用方同 dialog.tsx：先让 visible 变 false，在 onExited 里再卸。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloseGlyph } from "../chrome/Glyphs.js";
import { spring, type as t, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

/** 占屏高的比例（spec §4：定高 70%） */
const HEIGHT_RATIO = 0.7;
/** 下拽超过自身高度的这一比例就关 */
const DISMISS_DISTANCE = 0.25;
/** 或者松手时往下的速度（pt/s）超过这个——一甩就该关，不必拖过阈值 */
const DISMISS_VELOCITY = 900;
const EXIT_MS = 220;
const OPEN_SPRING = spring(0.35);
const RADIUS = 22;

export function BottomSheet({ visible, title, onClose, onExited, children }: {
  visible: boolean;
  title: string;
  /** 人要关：点 X / 点暗幕 / 下拽过阈值或一甩。调用方把 visible 置 false */
  onClose: () => void;
  /** 退场放完之后调一次 */
  onExited?: () => void;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const sheetH = Math.round(height * HEIGHT_RATIO);
  const [mounted, setMounted] = useState(visible);
  /** 0 = 完全展开；sheetH = 完全收起 */
  const y = useSharedValue(sheetH);
  const exited = useRef(onExited);
  useEffect(() => {
    exited.current = onExited;
  }, [onExited]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.value = reduce ? 0 : withSpring(0, OPEN_SPRING);
      return;
    }
    if (!mounted) return;
    y.value = reduce ? sheetH : withTiming(sheetH, { duration: EXIT_MS, easing: Easing.out(Easing.quad) });
    // 退场的收尾挂一个 JS 定时器，不从动画回调里回 JS：少一次 worklet → JS 的来回，
    // 时长本来就是我们自己定的
    const timer = setTimeout(() => {
      setMounted(false);
      exited.current?.();
    }, reduce ? 0 : EXIT_MS + 20);
    return () => clearTimeout(timer);
    // 只跟 visible 走：mounted / sheetH / reduce 读的是这一刻的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .onUpdate((e) => {
      y.value = e.translationY >= 0 ? e.translationY : Math.max(-24, e.translationY * 0.2);
    })
    .onEnd((e) => {
      if (e.translationY > sheetH * DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        onClose();
        return;
      }
      y.value = reduce ? 0 : withSpring(0, { ...OPEN_SPRING, velocity: e.velocityY });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, sheetH], [1, 0], Extrapolation.CLAMP),
  }));

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            {
              position: "absolute", left: 0, right: 0, bottom: 0, height: sheetH,
              backgroundColor: c.card, borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS,
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingBottom: insets.bottom, overflow: "hidden",
            },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View>
              <View style={{ alignItems: "center", paddingTop: 8 }}>
                <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.foreground, opacity: 0.18 }} />
              </View>
              <View style={{ height: 52, justifyContent: "center", paddingHorizontal: 60 }}>
                <Text style={{ ...t.headline, color: c.foreground, textAlign: "center" }} numberOfLines={1}>{title}</Text>
              </View>
              <Pressable
                accessibilityRole="button" accessibilityLabel="关闭" hitSlop={10} onPress={onClose}
                style={({ pressed }) => [
                  {
                    position: "absolute", left: 12, top: 21, width: 36, height: 36, borderRadius: 18,
                    alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.07),
                  },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <CloseGlyph color={c.foreground} size={13} />
              </Pressable>
            </View>
          </GestureDetector>
          <View style={{ flex: 1 }}>{children}</View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
```

- [ ] **Step 6: 类型检查 + 门禁里的手机那一段**

Run: `npx tsc --noEmit -p mobile && npx tsc --noEmit -p . && npx vitest run tests/architecture.test.ts`
Expected: 两次 tsc 无输出；架构测试 PASS（新文件只 import `src/shared/**`）。

若 `tsc -p mobile` 报 `withSpring` 的第二参不收 `velocity`：以已装版本的类型为准（`mobile/node_modules/react-native-reanimated/lib/typescript/.../springUtils.d.ts` 里的 `SpringConfig`），**不要**用 `as any` 糊过去；最小修法是去掉 `velocity` 那一格。

- [ ] **Step 7: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/App.tsx mobile/src/chrome/Glyphs.tsx mobile/src/face/GroupFaces.tsx mobile/src/sheet/BottomSheet.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): 底部抽屉（reanimated + gesture-handler）+ 手绘小图标 + 群脸横叠（#1356 A1）

ADR-0293 决定 3：两个库跟第一个抽屉一起进，版本取 Expo SDK 57 的 bundledNativeModules
（与 Expo Go 自带的原生那一半逐字一致，不一致真机上一打开就红屏）。抽屉定高 70%、
下拽过四分之一或一甩就关、往上拉给阻尼；下拽只挂在把手那一条上，免得和内容区的
滚动抢方向。图标沿用 ui.tsx 的做法用 View 画，不引图标库。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 9: 手机端数据层——订阅快照、主场名册、云会话客户端、当前聊天

三块数据两种来源：名册（主场快照 + 聊天清单 + 最后一句）直连 Supabase；订阅快照打 edge 的 `/billing/v1/me`（只在「还没有主场」时才需要：有主场就进得去、不再看档位，spec §5.2）；聊天走 A0 挪进 shared 的 `createCloudSessionClient`，推送进一个外部 store（`useSyncExternalStore`，spec §3.2：不引 zustand）。所有「规则」都调 shared（Task 2 的 `insertCloudEvent` / `applyCloudStatus`、`cloudStreaming` 的两个函数），这里只接线。

**Files:**
- Create: `mobile/src/externalStore.ts`
- Create: `mobile/src/home/billing.ts`
- Create: `mobile/src/home/homeStore.ts`
- Create: `mobile/src/cloud/cloudClient.ts`
- Create: `mobile/src/cloud/chatStore.ts`

**Interfaces:**
- Consumes: `createCloudSessionClient` / `CloudSessionClient`（`src/shared/remote/cloudSessionClient.ts`：`create` / `join` / `leave` / `say` / `stop` / `backlogPage` / `remove` / `chatUpdate` / `workspaceWikiWrite`）；`createWsTransport`（`src/shared/remote/wsTransport.ts`，`{ baseUrl, role: "guest", channel, authToken, log }`）；`csCtlChannel`；`RELAY_BASE`（`mobile/src/relay.ts`）；`edgeBaseUrl`（`src/shared/edgeConfig.ts`）；`parseBillingMe`；`findHomeWorkspace` / `createWorkspace` / `fetchWorkspace` / `listCloudSessions` / `fetchCloudLasts`（Task 4）；`ensureHomeWorkspace`；`humanizeWorkspaceError`；Task 2 的 `insertCloudEvent` / `applyCloudStatus` / `unknownSendNote` / `CloudSessionCore`；`applyCloudDelta` / `clearCloudStreamingOn` / `CloudStreaming`。
- Produces:
  - `createStore<S>(initial): { get(); set(patch | (s) => patch); subscribe(fn) }`
  - `fetchBilling(): Promise<BillingSnapshotView | null>`
  - homeStore：`interface HomeState { selfUid; home; chats; lasts; billing; ensure; ensureError; loadError; loaded; refreshing }`、`useHome()`、`refreshHome(): Promise<void>`、`ensureHome(): Promise<void>`
  - cloudClient：`cloudClient: CloudSessionClient`、`setCloudSinks(s)`、`ensureUid(): Promise<string | null>`
  - chatStore：`interface ChatSession extends CloudSessionCore { older; events }`、`interface ChatStoreState { session; streaming; pendingFirst; unsent; draftSeed; sendError; notice; error }`、`useChatStore()`、`openChat(workspaceId, sessionId, seed, title?)`、`startDm(workspaceId, agentId, text, mentions)`、`sendText(text, mentions): Promise<CloudAck>`、`resendUnsent()`、`dropUnsent()`、`stopTurn(seq): Promise<CloudAck>`、`loadOlder()`、`takeDraftSeed(sessionId): string | null`、`closeChat()`

这一片的代码都在 `mobile/`（不进 vitest），规则都在前面几个任务的 shared 里测过；这个任务的验收是 tsc + 架构断言，真跑在 Task 13 的冒烟里。

- [ ] **Step 1: 一个极小的外部 store**

Create `mobile/src/externalStore.ts`：

```ts
// 一个极小的外部 store（#1356 A1）：给 useSyncExternalStore 用。spec §3.2 定了不引 zustand——
// 手机端只有两份状态（名册、当前聊天），一个 set + 一组订阅者就够。
// `get` 在状态没变时必须回同一个引用（useSyncExternalStore 靠它判断要不要重画）。

export interface ExternalStore<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<S extends object>(initial: S): ExternalStore<S> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      for (const f of subs) f();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
```

- [ ] **Step 2: 订阅快照**

Create `mobile/src/home/billing.ts`：

```ts
// GET /billing/v1/me（#1356 A1）：名册进门七态要知道「能不能建主场」（spec §5.2）。
// 只在还没有主场时才问——有主场就进得去、不再看档位（降了档的人的聊天记录还在）。
//
// 失败回 null =「还没查到」，**不是**「没订阅」：并进后者就是对一个付过钱的人说他没订阅
// （同 workspaceAccess 的 unknown 一态、ADR-0240）。解析走 shared 的 parseBillingMe（桌面同一份）。
import { parseBillingMe } from "../../../src/shared/billing.js";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import { supabase } from "../supabase.js";

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 relay.ts）
const EDGE_BASE = edgeBaseUrl({} as never);

export async function fetchBilling(): Promise<BillingSnapshotView | null> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) return null;
  try {
    const res = await fetch(`${EDGE_BASE}/billing/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const me = parseBillingMe(await res.json());
    return me === null ? null : { me, fetchedAt: Date.now(), exhausted: null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: 主场名册的 store**

Create `mobile/src/home/homeStore.ts`：

```ts
// 名册的数据（#1356 A1，spec §5.2）：个人主场的快照 + 聊天清单 + 每条聊天的最后一句，
// 以及「还没有主场」时的订阅快照与建主场。全部直连 Supabase（用户 JWT + RLS）。
//
// 刷新时机由界面决定（进前台、从聊天页退回来、建 / 删之后），这里不轮询。
// 三条纪律：
// · 读不到 ≠ 空：刷新失败时手上的旧数据照旧画，失败那句挂在 loadError 上；
// · 还没查到 ≠ 没有：`loaded` 为假时名册画骨架，不下任何结论；
// · 建主场失败不自动重试（那一颗钮要人点，rosterGate 的 failed 一态）。
import { useSyncExternalStore } from "react";
import { ensureHomeWorkspace } from "../../../src/shared/homeWorkspace.js";
import type { SessionLast } from "../../../src/shared/sessionLast.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import {
  createWorkspace, fetchCloudLasts, fetchWorkspace, findHomeWorkspace, listCloudSessions, type CloudSessionRow,
} from "../../../src/shared/supabaseWorkspacesApi.js";
import { humanizeWorkspaceError } from "../../../src/shared/workspaceError.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchBilling } from "./billing.js";

export interface HomeState {
  selfUid: string | null;
  /** 个人主场的快照；null = 还没查到，或查过了确实没有（看 loaded） */
  home: WorkspaceSnapshot | null;
  chats: CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
  /** 只在还没有主场时才去问；null = 还没查到（不是「没订阅」） */
  billing: BillingSnapshotView | null;
  ensure: "idle" | "ensuring" | "failed";
  ensureError: string | null;
  /** 最近一次刷新失败的那句话。有旧数据时照画旧数据，这一句挂在顶上 */
  loadError: string | null;
  /** 至少跑完过一次刷新（成功或失败）：区分「还没查过」与「查过了」 */
  loaded: boolean;
  refreshing: boolean;
}

const store = createStore<HomeState>({
  selfUid: null, home: null, chats: [], lasts: new Map(), billing: null,
  ensure: "idle", ensureError: null, loadError: null, loaded: false, refreshing: false,
});

export function useHome(): HomeState {
  return useSyncExternalStore(store.subscribe, store.get);
}

async function currentUid(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.user.id ?? null;
}

let inflight: Promise<void> | null = null;

/** 拉一遍名册。同时来的几次（进前台 + 回到名册 + 刚建完）合成一次 */
export function refreshHome(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = (async () => {
    store.set({ refreshing: true });
    try {
      const uid = await currentUid();
      if (uid === null) {
        store.set({ selfUid: null, home: null, chats: [], lasts: new Map(), loaded: true });
        return;
      }
      const homeId = await findHomeWorkspace(supabase, uid);
      if (homeId !== null) {
        const [home, chats, lasts] = await Promise.all([
          fetchWorkspace(supabase, homeId),
          listCloudSessions(supabase, homeId),
          fetchCloudLasts(supabase, homeId),
        ]);
        store.set({ selfUid: uid, home, chats, lasts, loadError: null, loaded: true });
        return;
      }
      // 还没有主场：要知道「能不能建」，才问订阅（有主场就进得去、不再看档位）
      const billing = await fetchBilling();
      store.set((s) => ({
        selfUid: uid,
        home: null,
        chats: [],
        lasts: new Map(),
        billing: billing ?? s.billing,
        loadError: billing === null && s.billing === null ? "没查到订阅状态" : null,
        loaded: true,
      }));
    } catch (e) {
      store.set({ loadError: humanizeWorkspaceError(e), loaded: true });
    } finally {
      store.set({ refreshing: false });
      inflight = null;
    }
  })();
  return inflight;
}

/** 建个人主场（档位带、主场还没有时名册自己叫，rosterGate 的 ensuring 一态）。
    正在建的时候再叫是空操作：这个动作挂在 effect 上，不挡的话一次冷启动能打出好几条建主场请求 */
export async function ensureHome(): Promise<void> {
  if (store.get().ensure === "ensuring") return;
  store.set({ ensure: "ensuring", ensureError: null });
  try {
    const uid = await currentUid();
    if (uid === null) throw new Error("还没登录");
    await ensureHomeWorkspace({ findHomeWorkspace, createWorkspace }, supabase, uid);
    // 建之前开跑的那次刷新看不见新主场：等它收尾，再拉一次新的——否则名册会以为
    // 「还是没有主场」，effect 又叫一次 ensureHome，来回打转
    if (inflight !== null) await inflight;
    await refreshHome();
    store.set({ ensure: "idle" });
  } catch (e) {
    store.set({ ensure: "failed", ensureError: humanizeWorkspaceError(e) });
  }
}
```

- [ ] **Step 4: 装配云会话客户端**

Create `mobile/src/cloud/cloudClient.ts`：

```ts
// 手机端的云会话客户端（#1356 A1，spec §3.2）：A0 把桌面那份挪进了 shared，这里只接线——
// 传输是中继上的 WebSocket（role 必须是 guest：runtime 在 cs 房里是 host，中继只配对
// host↔guest），令牌现取 supabase 的 session（会过期，缓存一份等于把「过期」变成一次静默失联），
// 推送交给 chatStore。个人主场里一张审批卡都不出（ADR-0298），审批那三个钩子接空。
//
// App 回到前台时对当前会话房 reconnectNow：iOS 把后台 app 的 socket 掐了之后，退避重连
// 可能还要等好几秒，人一回来就该立刻换一条。
import { AppState } from "react-native";
import { csCtlChannel } from "../../../src/shared/remote/cloudSession.js";
import { createCloudSessionClient, type CloudSessionClient } from "../../../src/shared/remote/cloudSessionClient.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import type { CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";

export interface CloudSinks {
  event(e: SessionEvent): void;
  status(s: CloudSessionStatus): void;
  delta(d: CloudSessionDelta): void;
}

/** 客户端要同步读 uid（selfUid 不是 async）。冷启动时 getSession 还没回来，开会话前
    先 `ensureUid()` 等一次 */
let uid: string | null = null;
void supabase.auth.getSession().then(({ data }) => {
  uid = data.session?.user.id ?? null;
});
supabase.auth.onAuthStateChange((_event, session) => {
  uid = session?.user.id ?? null;
});

const accessToken = async (): Promise<string | null> =>
  (await supabase.auth.getSession()).data.session?.access_token ?? null;

/** 当前会话房那条传输（控制房每个请求一条、拿到回执就关，不记） */
let room: RemoteTransport | null = null;
let sinks: CloudSinks | null = null;

export const cloudClient: CloudSessionClient = createCloudSessionClient({
  accessToken,
  selfUid: () => uid,
  createTransport: (channel) => {
    const t = createWsTransport({
      baseUrl: RELAY_BASE,
      role: "guest",
      channel,
      authToken: accessToken,
      log: (m) => console.warn(m),
    });
    if (channel !== csCtlChannel()) room = t;
    return t;
  },
  sendEvent: (e) => sinks?.event(e),
  sendStatus: (s) => sinks?.status(s),
  sendDelta: (d) => sinks?.delta(d),
  onApprovalRequest: () => {},
  onApprovalDecision: () => {},
  onSessionInactive: () => {},
  log: (m) => console.warn(m),
});

export function setCloudSinks(s: CloudSinks): void {
  sinks = s;
}

export async function ensureUid(): Promise<string | null> {
  if (uid !== null) return uid;
  uid = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  return uid;
}

AppState.addEventListener("change", (s) => {
  // 已经关掉的传输（leave 之后）reconnectNow 是空操作
  if (s === "active") room?.reconnectNow("回到前台");
});
```

- [ ] **Step 5: 当前聊天的 store**

Create `mobile/src/cloud/chatStore.ts`：

```ts
// 当前那一条聊天的状态与动作（#1356 A1，spec §5.3 / §6）。同一时刻只开一条（客户端的
// join 先断旧的），ChatScreen 挂载时开、卸载时关。
//
// 规则全在 shared：事件按 seq 去重插位 / 状态推送哪几格照抄哪几格留着（cloudSessionState.ts，
// 与桌面 store 同一份）、流式碎片整槽替换 / 终态清槽（cloudStreaming.ts）。这里只接线，外加
// 三件手机自己的事：
// · **草稿**：私聊还没建时点进来是一页草稿，第一句发出去那一刻才 create（spec §5.2），那句话
//   先存成 pendingFirst，等会话 ready 再发——**先取后发**：状态推送会重复来，晚一步清就发两遍。
// · **回执三态**（ADR-0228）：ok 撤掉「不确定」那行；unknown 摆成那一行（绑 sessionId）；
//   确定失败 = sendError（输入框里的原文由调用方留着；草稿第一句那种则经 draftSeed 摆回输入框）。
// · **代数**：人在异步途中离开了这一页（closeChat），晚到的 open / create 结果不该再把一条
//   会话接回来。
import { useSyncExternalStore } from "react";
import { applyCloudStatus, insertCloudEvent, unknownSendNote, type CloudSessionCore } from "../../../src/shared/cloudSessionState.js";
import { applyCloudDelta, clearCloudStreamingOn, type CloudStreaming } from "../../../src/shared/cloudStreaming.js";
import type { CsChatInfo } from "../../../src/shared/remote/cloudSession.js";
import type { CloudAck, CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { createStore } from "../externalStore.js";
import { cloudClient, ensureUid, setCloudSinks } from "./cloudClient.js";

export interface ChatSession extends CloudSessionCore {
  /** 上一次往前翻的结局。failed 之后不自己重试——那是一颗要人点的钮 */
  older: "idle" | "loading" | "failed";
  events: SessionEvent[];
}

export interface UnsentLine {
  sessionId: string;
  text: string;
  /** 缺席 = 老语义；重发要走与原来那次同一条路 */
  mentions: string[] | undefined;
  note: string;
}

export interface ChatStoreState {
  session: ChatSession | null;
  streaming: CloudStreaming;
  pendingFirst: { sessionId: string; text: string; mentions: string[] | undefined } | null;
  unsent: UnsentLine | null;
  draftSeed: { sessionId: string; text: string } | null;
  sendError: string | null;
  /** runtime 对这条连接说的一句话（限速、事件过大被跳过……）。一次性 */
  notice: string | null;
  /** 开 / 建会话失败的那句 */
  error: string | null;
}

const EMPTY: ChatStoreState = {
  session: null, streaming: {}, pendingFirst: null, unsent: null, draftSeed: null, sendError: null, notice: null, error: null,
};
const store = createStore<ChatStoreState>(EMPTY);
/** 每次 closeChat 加一：异步回来时比一比，变了就说明人已经离开了这一页 */
let gen = 0;

export function useChatStore(): ChatStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

function onEvent(event: SessionEvent): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== event.sessionId) return;
  const events = insertCloudEvent(s.session.events, event);
  if (events === null) return;
  const streaming = clearCloudStreamingOn(s.streaming, event);
  store.set({ session: { ...s.session, events }, ...(streaming !== s.streaming ? { streaming } : {}) });
}

function onDelta(d: CloudSessionDelta): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== d.sessionId) return;
  const streaming = applyCloudDelta(s.streaming, d);
  if (streaming !== s.streaming) store.set({ streaming });
}

function onStatus(status: CloudSessionStatus): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== status.sessionId) return;
  const session: ChatSession = { ...s.session, ...applyCloudStatus(s.session, status) };
  store.set({ session, ...(status.notice === undefined ? {} : { notice: status.notice }) });
  if (session.state === "ready") void flushPendingFirst(session.sessionId);
}

setCloudSinks({ event: onEvent, status: onStatus, delta: onDelta });

function say(text: string, mentions: string[] | undefined): Promise<CloudAck> {
  // 布尔与数组同源（同桌面 store.cloudSay）：mentions 缺席 = 老语义，由 mention 那个布尔说了算
  const mention = mentions === undefined ? true : mentions.length > 0;
  return cloudClient.say(text, mention, mentions, []);
}

async function flushPendingFirst(sessionId: string): Promise<void> {
  const p = store.get().pendingFirst;
  if (p === null || p.sessionId !== sessionId) return;
  store.set({ pendingFirst: null });
  const r = await say(p.text, p.mentions);
  if (store.get().session?.sessionId !== sessionId) return;
  if (r.ok) return;
  if (r.unknown) {
    store.set({ unsent: { sessionId, text: p.text, mentions: p.mentions, note: unknownSendNote(p.text) } });
  } else {
    // 确定没发出去：原文摆回输入框（开局那页早就没了，不摆回去这段字就哪儿都不在了）
    store.set({ draftSeed: { sessionId, text: p.text }, sendError: r.message });
  }
}

/** 进一条已经存在的聊天。`seed` = 打开那一刻种给 `chat` 的那一格（ADR-0302），welcome 覆盖 */
export async function openChat(
  workspaceId: string,
  sessionId: string,
  seed: CsChatInfo | null | undefined,
  title?: string,
): Promise<void> {
  const g = gen;
  const uid = await ensureUid();
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  store.set({
    session: {
      workspaceId, sessionId, state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: uid ?? "",
      modelRoute: null, gapNote: null, chat: seed, hasOlder: false,
      older: "idle", events: [],
    },
    streaming: {}, unsent: null, sendError: null, notice: null, error: null,
  });
  const r = await cloudClient.join(workspaceId, sessionId, title);
  if (g !== gen) {
    // 人已经离开了这一页：刚接上的这条也断掉
    void cloudClient.leave();
    return;
  }
  if (!r.ok) store.set((s) => (s.session?.sessionId === sessionId ? { session: null, error: r.message } : { error: r.message }));
}

/** 草稿里的第一句：先建私聊（runtime 对私聊幂等），这句话等 ready 再发 */
export async function startDm(
  workspaceId: string,
  agentId: string,
  text: string,
  mentions: string[] | undefined,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const g = gen;
  const r = await cloudClient.create(workspaceId, { kind: "dm", agentId });
  if (g !== gen) return { ok: false, message: "已经离开了这条聊天" };
  if (!r.ok) return { ok: false, message: r.message };
  const sessionId = r.value.sessionId;
  // 排在进房之前：join 结束时状态随时可能翻成 ready，晚一步就错过那一次翻转
  store.set({ pendingFirst: { sessionId, text, mentions } });
  await openChat(workspaceId, sessionId, { kind: "dm", agentIds: [agentId] });
  if (store.get().session?.sessionId !== sessionId) {
    store.set({ pendingFirst: null });
    return { ok: false, message: store.get().error ?? "没连上这条聊天" };
  }
  return { ok: true, sessionId };
}

/** 发一句话。回执三态落在 store 里；返回原样的回执，调用方据此决定清不清输入框
    （ok 与 unknown 都清：unknown 时那句话很可能已经落地，原文去了「不确定」那一行） */
export async function sendText(text: string, mentions: string[] | undefined): Promise<CloudAck> {
  const sid = store.get().session?.sessionId ?? null;
  const r = await say(text, mentions);
  if (sid === null || store.get().session?.sessionId !== sid) return r;
  if (r.ok) store.set({ unsent: null, sendError: null });
  else if (r.unknown) store.set({ unsent: { sessionId: sid, text, mentions, note: unknownSendNote(text) }, sendError: null });
  else store.set({ sendError: r.message });
  return r;
}

/** 「重新发送」：人认了可能发两遍 */
export async function resendUnsent(): Promise<void> {
  const u = store.get().unsent;
  if (u === null || store.get().session?.sessionId !== u.sessionId) return;
  const r = await say(u.text, u.mentions);
  if (store.get().session?.sessionId !== u.sessionId) return;
  if (r.ok) store.set({ unsent: null, sendError: null });
  else if (r.unknown) store.set({ unsent: u });
  else store.set({ unsent: { ...u, note: `重新发送失败：${r.message}` } });
}

/** 「放弃」：人认了可能没发出去 */
export function dropUnsent(): void {
  store.set({ unsent: null });
}

export function stopTurn(seq: number): Promise<CloudAck> {
  return cloudClient.stop(seq);
}

/** 往前翻一页（尾巴模式，beforeSeq）。失败只改这一格，hasOlder 仍为真，重试钮点下去还有得拉 */
export async function loadOlder(): Promise<void> {
  const before = store.get().session;
  if (before === null || before.older === "loading" || !before.hasOlder) return;
  const sessionId = before.sessionId;
  const patch = (older: ChatSession["older"]): void => {
    const cur = store.get().session;
    if (cur !== null && cur.sessionId === sessionId) store.set({ session: { ...cur, older } });
  };
  patch("loading");
  const r = await cloudClient.backlogPage();
  patch(r.ok ? "idle" : "failed");
}

/** 输入框取走那句要摆回去的原文（按 sessionId 挂靠：不是这一条就当没有） */
export function takeDraftSeed(sessionId: string): string | null {
  const seed = store.get().draftSeed;
  if (seed === null || seed.sessionId !== sessionId) return null;
  store.set({ draftSeed: null });
  return seed.text;
}

/** 离开这一页：断连接、清状态 */
export function closeChat(): void {
  gen += 1;
  void cloudClient.leave();
  store.set(EMPTY);
}
```

- [ ] **Step 6: 类型检查 + 架构断言**

Run: `npx tsc --noEmit -p mobile && npx vitest run tests/architecture.test.ts`
Expected: tsc 无输出；架构测试 PASS。

若 `tsc -p mobile` 报 `createWsTransport` 缺必填项：以 `src/shared/remote/wsTransport.ts` 的 `WsTransportOpts` 为准补上（桌面装配在 `src/main/index.ts` 的 `createCloudSessionClient({...})` 那一段，照它递）。

- [ ] **Step 7: Commit**

```bash
git add mobile/src/externalStore.ts mobile/src/home/billing.ts mobile/src/home/homeStore.ts mobile/src/cloud/cloudClient.ts mobile/src/cloud/chatStore.ts
git commit -m "$(cat <<'EOF'
feat(mobile): 数据层——主场名册、订阅快照、云会话客户端与当前聊天（#1356 A1）

名册直连 Supabase（读不到照画旧数据、还没查到画骨架、建主场失败不自动重试）；订阅
快照只在还没有主场时才问（有主场就进得去）。聊天装配 A0 挪进 shared 的客户端，
事件插位 / 状态合并 / 碎片清槽全调 shared 那几个函数（与桌面 store 同一份）。
草稿第一句等 ready 先取后发；回执三态照 ADR-0228；人中途离开这一页，晚到的
open / create 不再把会话接回来。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 10: 智能体设置屏 + 「换个形象」抽屉 + 删掉

spec §5.4：头上回退 + 右上「存」；**只有这几样**——形象（一张 l 档大脸 +「换个形象」→ 抽屉：上面大脸走一遍它干活的样子、下面那面墙只有选中那张是活的）/ 名字（必填）/ 职责（≤200 字、不许换行）/ 还有什么要交代的（标签写明「它自己看得见这一段」，≤4000 字）/ 删掉「X」（管理员没有这一行）。撤掉的三样（模型、能用哪几个应用、它记下来的东西）照 demo 不画；说话的声音 A4 才出现。落库走 Task 3 的 `updateAgentChecked` / `deleteAgentEverywhere`（与桌面同一份编排）。

**Files:**
- Create: `mobile/src/agent/FacePickerSheet.tsx`
- Create: `mobile/src/agent/AgentSettingsScreen.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`

**Interfaces:**
- Consumes: Task 7 的 `agentFormOf` / `agentFormErrors` / `agentFormValid` / `agentFormPatch` / `pickableFaces` / `FACE_TOUR`；Task 3 的 `updateAgentChecked` / `deleteAgentEverywhere` / `AgentUpdateDeps` / `AgentDeleteDeps`；Task 8 的 `BottomSheet`；Task 9 的 `useHome` / `refreshHome` / `cloudClient`；`avatarPreviewSlot`（`src/shared/agentAvatar.ts`）；`faceCharacterAt`；`facePhase`；`agentPagePath`（`src/shared/wiki.ts`）；`ADMIN_AGENT_ID` / `AGENT_NAME_MAX`；`AGENT_DESCRIPTION_MAX` / `AGENT_INSTRUCTIONS_MAX`；`listAgentNames` / `updateAgentRow` / `listAgentChats` / `deleteAgentRow`；手机 `Dialog*` / `Button` / `Field` / `Group` / `Row` / `Note`。
- Produces: 路由 `AgentSettings: { agentId: string }`；`FacePickerSheet({ visible, current, onPick, onClose, onExited? })`。

- [ ] **Step 1: 路由表加一格**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里加一行（放在 `Account` 之后）：

```ts
  AgentSettings: { agentId: string };
```

`mobile/src/nav/RootNavigator.tsx`：import `AgentSettingsScreen`，在 `Account` 那一行之后注册：

```tsx
        <Root.Screen
          name="AgentSettings"
          component={AgentSettingsScreen}
          options={{ title: "", headerBackTitle: "返回", headerShadowVisible: false }}
        />
```

- [ ] **Step 2: 「换个形象」抽屉**

Create `mobile/src/agent/FacePickerSheet.tsx`：

```tsx
// 「换个形象」（#1356 A1，spec §5.4）：上面一张 l 档大脸走一遍它干活的样子（排队 → 思考 →
// 检索 → 执行 → 作答 → 完成 → 活着，循环；换一张脸从头走），下面那面墙只有选中那张是活的。
// 墙上是 pickableFaces()：十张，cap 没有自己的坑位不进来（spec §5.4，维护者 2026-09-24 确认）。
// 点一张只改表单里的那一格；真正写库在设置页按「存」的时候（没换就不写）。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { FACE_TOUR, pickableFaces } from "../../../src/shared/agentSettingsForm.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { faceCharacterAt } from "../../../src/shared/ottoFace/index.js";
import { Face } from "../face/Face.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

/** 大脸那一遍。关了动效就停在「活着」那一格（它自己也是静止一帧） */
function FaceTour({ slot, ring }: { slot: number; ring: string }) {
  const reduce = useReduceMotion();
  const [i, setI] = useState(0);
  // 换一张脸从头走
  useEffect(() => {
    setI(0);
  }, [slot]);
  useEffect(() => {
    if (reduce) return;
    const step = FACE_TOUR[i % FACE_TOUR.length]!;
    const t = setTimeout(() => setI((n) => n + 1), step.ms);
    return () => clearTimeout(t);
  }, [i, reduce, slot]);
  const state = reduce ? "alive" : FACE_TOUR[i % FACE_TOUR.length]!.state;
  return <Face slot={slot} state={state} tier="l" ringColor={ring} />;
}

export function FacePickerSheet({ visible, current, onPick, onClose, onExited }: {
  visible: boolean;
  /** 此刻画的那一格（表单里的选择，没挑过就是派生出来的那张） */
  current: number;
  onPick: (slot: number) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const faces = useMemo(pickableFaces, []);
  const currentId = faceCharacterAt(current).id;
  return (
    <BottomSheet visible={visible} title="换个形象" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingTop: 8, paddingBottom: 24 }}>
        <FaceTour slot={current} ring={c.card} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, paddingHorizontal: 16, marginTop: 20 }}>
          {faces.map((f) => {
            const on = f.id === currentId;
            return (
              <Pressable
                key={f.id}
                accessibilityRole="button"
                accessibilityLabel={f.name}
                accessibilityState={{ selected: on }}
                onPress={() => onPick(f.slot)}
                style={({ pressed }) => [
                  {
                    width: 76, height: 70, borderRadius: 16, alignItems: "center", justifyContent: "center",
                    borderWidth: 2, borderColor: on ? c.brand : "transparent",
                    backgroundColor: on ? withAlpha(c.brand, 0.1) : "transparent",
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                {/* 只有选中那张是活的：一墙都在眨眼时，人分不出哪张是「我的」 */}
                <Face slot={f.slot} state={on ? "alive" : "plain"} tier="m" phase={facePhase(f.id)} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
```

- [ ] **Step 3: 设置屏**

Create `mobile/src/agent/AgentSettingsScreen.tsx`：

```tsx
// 智能体设置（#1356 A1，spec §5.4）。从私聊头部右边那颗进来。
// 判据全在 shared：表单校验与 patch（agentSettingsForm.ts）、落库前的校验 + 查重名 + 23505 翻译、
// 删一只的倒序四步（agentAdmin.ts，与桌面同一份编排）。这里只画与接线。
// 「存」挂在原生导航条右边：什么都没改 / 有一格不合法 / 正在存时按不动。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  deleteAgentEverywhere, updateAgentChecked, type AgentDeleteDeps, type AgentUpdateDeps,
} from "../../../src/shared/agentAdmin.js";
import { avatarPreviewSlot } from "../../../src/shared/agentAvatar.js";
import {
  agentFormErrors, agentFormOf, agentFormPatch, agentFormValid, type AgentForm,
} from "../../../src/shared/agentSettingsForm.js";
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "../../../src/shared/createAgentDraft.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { deleteAgentRow, listAgentChats, listAgentNames, updateAgentRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { agentPagePath } from "../../../src/shared/wiki.js";
import { ADMIN_AGENT_ID, AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { Face } from "../face/Face.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { radius, space, type as t, usePalette } from "../theme.js";
import { Button, Field, Group, Note, Row } from "../ui.js";
import { FacePickerSheet } from "./FacePickerSheet.js";

const updateDeps: AgentUpdateDeps = { listAgentNames, updateAgentRow };
const deleteDeps: AgentDeleteDeps = {
  listAgentChats,
  deleteAgentRow,
  removeCloudSession: (w, s) => cloudClient.remove(w, s),
  updateChatRoster: (w, s, agentIds) => cloudClient.chatUpdate(w, s, { agentIds }),
  removeAgentPage: (w, agentId) =>
    cloudClient.workspaceWikiWrite(w, { op: "remove", path: agentPagePath(agentId) }).then(() => undefined),
};

/** 「删掉」的说明——弹窗与那一组的注脚说同一句话（spec §5.4 原文） */
const DELETE_LEAD = "它的私聊一起删掉；群里会被摘出去；它自己那页记忆一起删掉，它改过的共用页面留着。";

function Labeled({ label, hint, error, children }: { label: string; hint?: string; error: string | null; children: ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>
        {label}
        {hint ? ` · ${hint}` : ""}
      </Text>
      {children}
      {error ? <Text style={{ ...t.footnote, color: c.destructive, paddingHorizontal: 4 }}>{error}</Text> : null}
    </View>
  );
}

type Props = NativeStackScreenProps<RootStackParams, "AgentSettings">;

export function AgentSettingsScreen({ route, navigation }: Props) {
  const { agentId } = route.params;
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const agent = ws?.agents.find((a) => a.agentId === agentId) ?? null;
  const [form, setForm] = useState<AgentForm | null>(() => (agent ? agentFormOf(agent) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 快照是异步到的：进来时 agent 还没有就等它来了再种表单（种一次，之后听人的）
  useEffect(() => {
    if (form === null && agent !== null) setForm(agentFormOf(agent));
  }, [agent, form]);

  const errors = form ? agentFormErrors(form) : null;
  const patch = agent && form ? agentFormPatch(agent, form) : null;
  const canSave = !busy && errors !== null && agentFormValid(errors) && patch !== null;

  const save = async (): Promise<void> => {
    if (!ws || !canSave || patch === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateAgentChecked(updateDeps, supabase, ws.id, agentId, patch);
      await refreshHome();
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!ws || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteAgentEverywhere(deleteDeps, supabase, ws.id, agentId);
      setConfirming(false);
      await refreshHome();
      // 回名册：它的私聊已经没了，退回那一页只会看见一条连不上的线
      navigation.popToTop();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 「存」挂在原生导航条右边。按下去调的是 ref 里最新的 save；setOptions 只在「按不按得动 /
  // 正在存」这两格变了时重设——不带依赖地每次渲染都 setOptions，会让导航器跟着重渲、再触发这里，
  // 形成一个死循环
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          hitSlop={10}
          onPress={() => void saveRef.current()}
        >
          <Text style={{ ...t.headline, color: canSave ? c.brand : c.mutedForeground }}>{busy ? "正在存…" : "存"}</Text>
        </Pressable>
      ),
    });
  }, [navigation, canSave, busy, c.brand, c.mutedForeground]);

  if (!ws || !agent || !form || !errors) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {/* 还没查到就什么都不说；查过了还是没有 = 刚被删了 */}
        {home.loaded ? <Note tone="warn">这只智能体已经不在了。</Note> : null}
      </View>
    );
  }

  const previewSlot = avatarPreviewSlot(ws, agentId, form.avatarSlot) ?? 0;
  const isAdmin = agent.agentId === ADMIN_AGENT_ID;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
      >
        <View style={{ alignItems: "center", gap: space.sm }}>
          <Face slot={previewSlot} state="alive" tier="l" phase={facePhase(agentId)} label={`${agent.name}的形象`} />
          <Button size="auto" variant="outline" label="换个形象" onPress={() => setPicking(true)} />
        </View>

        <Labeled label="名字" error={errors.name}>
          <Field
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name })}
            placeholder="群里 @ 它用的名字"
            maxLength={AGENT_NAME_MAX}
            invalid={errors.name !== null}
          />
        </Labeled>

        <Labeled label="职责" error={errors.description}>
          <Field
            value={form.description}
            onChangeText={(description) => setForm({ ...form, description })}
            placeholder="它负责什么，一句话"
            maxLength={AGENT_DESCRIPTION_MAX}
            invalid={errors.description !== null}
          />
        </Labeled>

        <Labeled label="还有什么要交代的" hint="它自己看得见这一段" error={errors.instructions}>
          <TextInput
            multiline
            value={form.instructions}
            onChangeText={(instructions) => setForm({ ...form, instructions })}
            placeholder="比如：只推分支，不动 main"
            placeholderTextColor={c.mutedForeground}
            maxLength={AGENT_INSTRUCTIONS_MAX}
            textAlignVertical="top"
            style={{
              minHeight: 132, borderRadius: radius.control, borderWidth: 1,
              borderColor: errors.instructions !== null ? c.destructive : c.input,
              backgroundColor: c.card, color: c.foreground,
              paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, lineHeight: 22,
            }}
          />
        </Labeled>

        {error ? <Note tone="error">{error}</Note> : null}

        {/* 管理员没有这一行（RLS 也删不掉它，画一颗必然失败的钮是撒谎） */}
        {!isAdmin ? (
          <Group footer={DELETE_LEAD}>
            <Row
              label={`删掉「${agent.name}」`}
              tone="destructive"
              align="center"
              disabled={busy}
              onPress={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
            />
          </Group>
        ) : null}
      </ScrollView>

      <FacePickerSheet
        visible={picking}
        current={previewSlot}
        onPick={(slot) => setForm({ ...form, avatarSlot: slot })}
        onClose={() => setPicking(false)}
      />

      {/* 确认类用居中弹窗，不用抽屉（手机端既有规矩，spec §4） */}
      <Dialog visible={confirming}>
        <DialogTitle>删掉「{agent.name}」？</DialogTitle>
        <DialogLead>{DELETE_LEAD}</DialogLead>
        {deleteError ? (
          <View style={{ paddingHorizontal: 20 }}>
            <Note tone="error">{deleteError}</Note>
          </View>
        ) : null}
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirming(false), disabled: busy }}
          right={{ label: busy ? "正在删…" : "删掉", onPress: () => void remove(), disabled: busy }}
        />
      </Dialog>
    </View>
  );
}
```

- [ ] **Step 4: 类型检查 + 架构断言**

Run: `npx tsc --noEmit -p mobile && npx vitest run tests/architecture.test.ts`
Expected: tsc 无输出；架构测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add mobile/src/agent/FacePickerSheet.tsx mobile/src/agent/AgentSettingsScreen.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): 智能体设置——名字 / 职责 / 交代 / 换形象 / 删掉（#1356 A1，spec §5.4）

只有这几样：模型、应用、记忆三样照 demo 撤掉，声音 A4 才有。落库走 shared 的
updateAgentChecked / deleteAgentEverywhere（与桌面同一份编排）；「存」在什么都没改
或有一格不合法时按不动；头像换了才写。换形象是 70% 抽屉：大脸走一遍干活的样子、
墙上只有选中那张是活的，十张（cap 没有自己的坑位）。删掉用居中确认弹窗、说清连带
删掉什么，管理员没有这一行。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 11: 聊天屏——头部药丸 / 时间线 / 此刻 / 输入框 / 草稿

spec §5.3：头 = 回退 | 药丸（脸 s 档 + 名字）| 右边那颗直接进设置（中间没有菜单）；时间线一条永久线、唯一的分段是一天一条的日期；我说的 = 右侧实色气泡，它说的 = 不套气泡的正文、按空行拆段、段前一行「脸 + 名字 · 时间」；流式碎片画成它正在写的那一段；往上翻到顶取更早一页，失败给一颗要人点的钮；最底下「此刻」那一行（没有打字的三个点，「停一下」在这一行上）；输入框一张卡 + 右边 48 的圆钮，没有型号选择器、没有上下文环；回执三态照 ADR-0228。状态照 spec §6。A1 的聊天页私聊、群聊通用：名册把群一起列出来（spec §5.2），点进去先是基础版——群设置、@ 谁、名单变更那一行在 A3。

**Files:**
- Create: `mobile/src/chat/ChatRows.tsx`
- Create: `mobile/src/chat/Composer.tsx`
- Create: `mobile/src/chat/ChatScreen.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`

**Interfaces:**
- Consumes: Task 7 的 `resolveChatTarget` / `chatRows` / `liveRows` / `nowRowOf` / `clockLabel` / `NOW_PHASE_TEXT` / `ChatTarget` / `ChatRow` / `NowRow`；Task 9 的 `useHome` / `refreshHome` / `useChatStore` / `openChat` / `closeChat` / `startDm` / `sendText` / `resendUnsent` / `dropUnsent` / `stopTurn` / `loadOlder` / `takeDraftSeed`；Task 8 的 `BackGlyph` / `MoreGlyph` / `SendGlyph` / `GroupFaces`；Task 2 的 `cloudDeniedText`；`chatViewOf`（`src/shared/agentRoster.ts`）；`cloudEmptyState`；`resolveSendMentions`（`src/shared/agentMentionInput.ts`）；`parseMentions`（`src/shared/remote/agentMention.ts`）；`dmFaceState`；`openTurns`；`agentFaceSlot` / `agentFaceIfKnown`；`agentNameOf`；`facePhase`。
- Produces: 路由 `Chat: ChatTarget`；`ChatRowView` / `NowRowView` / `Composer`。

- [ ] **Step 1: 路由表加一格**

`mobile/src/nav/types.ts`：顶部加 `import type { ChatTarget } from "../../../src/shared/mobileChat.js";`，`RootStackParams` 里 `Roster` 之后加：

```ts
  /** 私聊按 agentId 进（还没聊过就是草稿），群按 sessionId 进 */
  Chat: ChatTarget;
```

`mobile/src/nav/RootNavigator.tsx`：import `ChatScreen`，在 `Roster` 那一行之后注册（头自己画，浮在内容上）：

```tsx
        <Root.Screen name="Chat" component={ChatScreen} options={{ headerShown: false }} />
```

- [ ] **Step 2: 时间线的各行**

Create `mobile/src/chat/ChatRows.tsx`：

```tsx
// 聊天页时间线的各行（#1356 A1，spec §5.3）。画哪一种由 shared/mobileChat.ts 的 ChatRow 决定，
// 这里只管样子（尺寸逐值取自 demo：.bub.me / .bub.ot / .who / .dayline）。
// 脸只画名册里查得到的那只（agentFaceIfKnown）：派生对陌生 id 也算得出一张脸，画上去等于
// 宣称它还在名册里。
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { agentFaceIfKnown } from "../../../src/shared/agentAvatar.js";
import { NOW_PHASE_TEXT, clockLabel, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Face } from "../face/Face.js";
import { type as t, usePalette } from "../theme.js";
import { Button } from "../ui.js";

export function ChatRowView({ row, ws }: { row: ChatRow; ws: WorkspaceSnapshot }) {
  const { c } = usePalette();
  switch (row.kind) {
    case "day":
      return (
        <Text style={{ alignSelf: "center", fontSize: 11.5, letterSpacing: 0.2, color: c.mutedForeground, opacity: 0.7, paddingTop: 6 }}>
          {row.label}
        </Text>
      );
    case "mine":
      return (
        <View style={{ paddingHorizontal: 16, alignItems: "flex-end" }}>
          <View style={{
            maxWidth: "80%", backgroundColor: c.primary, borderRadius: 20, borderBottomRightRadius: 7,
            paddingVertical: 10, paddingHorizontal: 14,
          }}>
            <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.primaryForeground }}>{row.text}</Text>
          </View>
        </View>
      );
    case "human":
      return (
        <View style={{ paddingHorizontal: 16, alignItems: "flex-start", gap: 4 }}>
          <Text style={{ fontSize: 12, color: c.mutedForeground, marginLeft: 4 }}>{`${row.name} · ${clockLabel(row.ts)}`}</Text>
          <View style={{ maxWidth: "82%", backgroundColor: c.secondary, borderRadius: 19, paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.secondaryForeground }}>{row.text}</Text>
          </View>
        </View>
      );
    case "agent": {
      const face = agentFaceIfKnown(ws, row.agentId);
      return (
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 2 }}>
            {face !== null ? <Face slot={face.slot} tier="s" /> : null}
            <Text style={{ fontSize: 12, color: c.mutedForeground }}>{`${row.name} · ${clockLabel(row.ts)}`}</Text>
          </View>
          {row.paragraphs.map((p, i) => (
            <Text key={i} selectable style={{ fontSize: 16.5, lineHeight: 24, letterSpacing: -0.15, color: c.foreground, paddingHorizontal: 2 }}>
              {p}
            </Text>
          ))}
        </View>
      );
    }
    case "note":
      return <NoteRow text={row.text} tone={row.tone} detail={row.detail} />;
  }
}

/** 旁白 / 出错。带全文（后台任务那一档、出错原文）时点一下展开 */
function NoteRow({ text, tone, detail }: { text: string; tone: "muted" | "error"; detail: string | null }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const color = tone === "error" ? c.destructive : c.mutedForeground;
  const body = (
    <View style={{ alignItems: "center", paddingHorizontal: 28, gap: 4 }}>
      <Text style={{ ...t.footnote, color, textAlign: "center" }}>
        {text}
        {detail !== null && !open ? " ›" : ""}
      </Text>
      {open && detail !== null ? (
        <Text selectable style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{detail}</Text>
      ) : null}
    </View>
  );
  if (detail === null) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={open ? "收起详情" : "展开详情"} onPress={() => setOpen((v) => !v)}>
      {body}
    </Pressable>
  );
}

/** 最底下那一行 =「此刻」：脸 m 档跟着 dmFaceState 走、「名字 · 时间 · 排队中 / 执行中 / 作答中」，
    没有打字的三个点；「停一下」只在它真在跑时出现 */
export function NowRowView({ now, ws, ready, stopping, onStop }: {
  now: NowRow;
  ws: WorkspaceSnapshot;
  ready: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const { c } = usePalette();
  const face = agentFaceIfKnown(ws, now.agentId);
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 10 }}>
      {face !== null ? <Face slot={face.slot} tier="m" state={now.face} phase={facePhase(now.agentId)} ringColor={c.background} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, ...t.footnote, color: c.mutedForeground }}>
        {`${now.name} · ${clockLabel(now.ts)} · ${NOW_PHASE_TEXT[now.phase]}`}
      </Text>
      {now.canStop ? (
        <Button size="auto" variant="outline" label={stopping ? "正在停…" : "停一下"} onPress={onStop} disabled={!ready || stopping} />
      ) : null}
    </View>
  );
}
```

- [ ] **Step 3: 输入框**

Create `mobile/src/chat/Composer.tsx`：

```tsx
// 聊天页的输入框（#1356 A1，spec §5.3）：一张卡 + 右边一颗 48 的圆钮。打了字 = 发出去；空着时
// 是一颗灰的发送钮（A4 起空着变「开电话」，一物两用）。没有型号选择器、没有上下文环。
// 回执三态记在 chatStore（ADR-0228）；这里只决定清不清输入框：ok / unknown 清，确定失败留着。
// 有字才亮：空框旁边一颗常亮的发送钮是在说「点我就发」，而点了什么都不会发生。
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SendGlyph } from "../chrome/Glyphs.js";
import { takeDraftSeed, useChatStore } from "../cloud/chatStore.js";
import { usePalette, withAlpha } from "../theme.js";

export function Composer({ placeholder, canSend, sessionId, onSend }: {
  placeholder: string;
  /** 草稿里总能发（发了才建）；有会话时只有 ready 才能发——gone 时照常能打字，发送钮灰 */
  canSend: boolean;
  sessionId: string | null;
  /** 回 true = 这句话已经交出去（或不确定有没有），清输入框 */
  onSend: (text: string) => Promise<boolean>;
}) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const seed = useChatStore().draftSeed;
  // 确定没发出去的那句（草稿里那第一句）摆回输入框
  useEffect(() => {
    if (sessionId === null) return;
    const text = takeDraftSeed(sessionId);
    if (text !== null) setDraft(text);
  }, [seed, sessionId]);
  const live = draft.trim() !== "" && canSend && !sending;
  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!live) return;
    setSending(true);
    const clear = await onSend(text);
    setSending(false);
    if (clear) setDraft("");
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 12, paddingTop: 9, paddingBottom: Math.max(insets.bottom, 12) }}>
      <View style={{
        flex: 1, minHeight: 48, justifyContent: "center", backgroundColor: c.card,
        borderWidth: 1, borderColor: c.input, borderRadius: 22, paddingLeft: 15, paddingRight: 11, paddingVertical: 12,
      }}>
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={c.mutedForeground}
          style={{ fontSize: 16, lineHeight: 22, maxHeight: 110, color: c.foreground, padding: 0 }}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="发送"
        accessibilityState={{ disabled: !live }}
        disabled={!live}
        onPress={() => void submit()}
        style={({ pressed }) => [
          {
            width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
            backgroundColor: live ? c.primary : withAlpha(c.foreground, 0.07),
          },
          pressed && { transform: [{ scale: 0.93 }] },
        ]}
      >
        <SendGlyph color={live ? c.primaryForeground : c.mutedForeground} />
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 4: 聊天屏**

Create `mobile/src/chat/ChatScreen.tsx`：

```tsx
// 聊天页（#1356 A1，spec §5.3 / §6）。私聊为主；群聊先是基础版（群设置、@ 谁、名单变更那一行在 A3）。
//
// · 头：回退 | 药丸（脸 + 名字）| 私聊右边那颗直接进设置（中间没有菜单）。浮在内容上，页面内容
//   从底下滚过去（spec §4）。药丸里那张脸 = dmFaceState（与桌面私聊头部同一份判据）。名单与
//   名字从日志推导（chatViewOf，ADR-0302 / #1302），还没开房时用清单那一行。
// · 时间线：倒置的 FlatList（最新一条贴底）；往上翻到顶取更早一页（尾巴模式），失败给一颗
//   要人点的钮——哨兵自己重试的话，一条连不上的线会在人往上滚时反复打网络。
// · 草稿：私聊还没建时是同一张页、还没有会话，第一句发出去那一刻才建（spec §5.2）。当场就建
//   会让「点进去看一眼」也把它顶到名册最上面。
// · 状态（spec §6）：gone 一行「正在重连…」、发送钮灰；denied 是终态，说清是哪一种 +「回名册」。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { BlurView } from "expo-blur";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { resolveSendMentions } from "../../../src/shared/agentMentionInput.js";
import { chatViewOf } from "../../../src/shared/agentRoster.js";
import { cloudDeniedText } from "../../../src/shared/cloudSessionState.js";
import { cloudEmptyState } from "../../../src/shared/cloudTimeline.js";
import { chatRows, liveRows, nowRowOf, resolveChatTarget, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { dmFaceState } from "../../../src/shared/ottoFace/index.js";
import { parseMentions } from "../../../src/shared/remote/agentMention.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { BackGlyph, MoreGlyph } from "../chrome/Glyphs.js";
import { ROUND_BUTTON_SIZE, RoundButton } from "../chrome/RoundButton.js";
import {
  closeChat, dropUnsent, loadOlder, openChat, resendUnsent, sendText, startDm, stopTurn, useChatStore,
} from "../cloud/chatStore.js";
import { Face } from "../face/Face.js";
import { GroupFaces } from "../face/GroupFaces.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Spinner } from "../ui.js";
import { ChatRowView, NowRowView } from "./ChatRows.js";
import { Composer } from "./Composer.js";

const EMPTY_EVENTS: SessionEvent[] = [];
type Item = { kind: "row"; row: ChatRow } | { kind: "now"; now: NowRow };
type Props = NativeStackScreenProps<RootStackParams, "Chat">;

function Gap() {
  return <View style={{ height: 12 }} />;
}

function Line({ tone, children }: { tone: "muted" | "warn" | "error"; children: ReactNode }) {
  const { c } = usePalette();
  const color = tone === "error" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
  return <Text style={{ ...t.footnote, color, flexShrink: 1 }}>{children}</Text>;
}

function Centered({ top, children }: { top: number; children: ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: top, paddingHorizontal: space.lg }}>{children}</View>;
}

/** 顶上那一格（倒置列表里 ListFooterComponent 画在最上面）：给浮在上面的头留出位置，外加翻页的三态 */
function OlderRow({ top, hasOlder, older }: { top: number; hasOlder: boolean; older: "idle" | "loading" | "failed" }) {
  const { c } = usePalette();
  return (
    <View style={{ paddingTop: top, paddingBottom: 8, alignItems: "center" }}>
      {!hasOlder ? null : older === "failed" ? (
        // 上一页的内容留在原地不清屏；重试是一颗要人点的钮
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void loadOlder()}>
          <Text style={{ ...t.footnote, color: c.mutedForeground }}>
            没读到更早的消息 · <Text style={{ color: c.brand }}>重试</Text>
          </Text>
        </Pressable>
      ) : older === "loading" ? (
        <Spinner />
      ) : null}
    </View>
  );
}

/** 刚进来、一句都还没说（或只有看不见的内务事件）时的那一屏 */
function Hello({ ws, kind, agentIds, title }: { ws: WorkspaceSnapshot; kind: "dm" | "group"; agentIds: string[]; title: string }) {
  const { c } = usePalette();
  const first = agentIds[0];
  if (kind === "dm" && first !== undefined) {
    const a = ws.agents.find((x) => x.agentId === first);
    return (
      <View style={{ alignItems: "center", gap: 8 }}>
        <Face slot={agentFaceSlot(ws, first)} tier="m" state="alive" phase={facePhase(first)} />
        <Text style={{ ...t.headline, color: c.foreground }}>{title}</Text>
        {a !== undefined && a.description !== "" ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{a.description}</Text>
        ) : null}
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>说第一句话就开始了。</Text>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} />
      <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>
        {`${agentIds.map((id) => agentNameOf(ws, id)).join("、")}都在。说第一句话就开始了。`}
      </Text>
    </View>
  );
}

function ChatHeader({ top, title, faces, onBack, onSettings }: {
  top: number;
  title: string;
  faces: ReactNode;
  onBack: () => void;
  onSettings?: () => void;
}) {
  const { c, isDark } = usePalette();
  const { width } = useWindowDimensions();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: top, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <RoundButton label="返回" onPress={onBack}>
        <BackGlyph color={c.foreground} />
      </RoundButton>
      <View pointerEvents="box-none" style={{ flex: 1, alignItems: "center" }}>
        {/* 药丸：46 高、左 9 右 16、最大宽 62%、毛玻璃（spec §4） */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={title}
          style={{
            height: 46, maxWidth: width * 0.62, borderRadius: 23, overflow: "hidden",
            flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 9, paddingRight: 16,
          }}
        >
          <BlurView intensity={40} tint={isDark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.foreground, 0.1) }]} />
          {faces}
          <Text numberOfLines={1} style={{ ...t.headline, color: c.foreground, flexShrink: 1 }}>{title}</Text>
        </View>
      </View>
      {onSettings !== undefined ? (
        <RoundButton label="设置" onPress={onSettings}>
          <MoreGlyph color={c.foreground} />
        </RoundButton>
      ) : (
        // 群设置在 A3：这一片不画一颗点了没去处的钮（#722），用同宽的空位让药丸居中
        <View style={{ width: ROUND_BUTTON_SIZE }} />
      )}
    </View>
  );
}

export function ChatScreen({ route, navigation }: Props) {
  const target = route.params;
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const home = useHome();
  const chat = useChatStore();
  const ws = home.home;
  const resolved = useMemo(() => (ws !== null ? resolveChatTarget(ws, home.chats, target) : null), [ws, home.chats, target]);
  const sessionId = resolved?.sessionId ?? null;
  /** 这一页自己的一句（点名打错了、建私聊失败、停不下来） */
  const [pageNote, setPageNote] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // 这条线已经存在就进房；草稿什么都不做，第一句发出去才建
  useEffect(() => {
    if (ws === null || resolved === null || sessionId === null) return;
    void openChat(ws.id, sessionId, resolved.seed, resolved.title);
    // 只跟「是哪一条」走：resolved 每次刷新名册都是新对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id, sessionId]);
  useEffect(() => () => closeChat(), []);

  const session = chat.session;
  const events = session?.events ?? EMPTY_EVENTS;
  const selfUid = session?.selfUid || home.selfUid || "";
  const draft = resolved !== null && resolved.sessionId === null && session === null;
  const view = ws !== null && session !== null && session.chat ? chatViewOf(ws, session.chat, events, resolved?.title ?? "") : null;
  const kind = view?.kind ?? resolved?.kind ?? "dm";
  const agentIds = view?.agentIds ?? resolved?.agentIds ?? [];
  const title = view?.title ?? resolved?.title ?? "";
  const dmAgent = kind === "dm" ? (agentIds[0] ?? null) : null;

  const rows = useMemo(() => (ws !== null ? chatRows({ events, ws, selfUid, now: Date.now() }) : []), [ws, events, selfUid]);
  const live = useMemo(() => (ws !== null ? liveRows({ streaming: chat.streaming, ws, now: Date.now() }) : []), [ws, chat.streaming]);
  const nowRow = useMemo(() => (ws !== null ? nowRowOf({ events, streaming: chat.streaming, ws }) : null), [ws, events, chat.streaming]);
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [...rows, ...live].map((row) => ({ kind: "row" as const, row }));
    if (nowRow !== null) list.push({ kind: "now", now: nowRow });
    return list.reverse(); // 倒置列表：data[0] 画在最底下
  }, [rows, live, nowRow]);

  const ready = session?.state === "ready";
  const canSend = draft || ready;

  const onSend = async (text: string): Promise<boolean> => {
    if (ws === null || resolved === null) return false;
    // 点名解析与桌面同一份（resolveSendMentions）：私聊里名单只有那一只
    const candidates = agentIds.map((id) => ({ agentId: id, name: agentNameOf(ws, id) }));
    const plan = resolveSendMentions({ text, parsed: parseMentions(text, candidates), refreshFailed: false, freshCandidates: candidates });
    if (plan.kind === "block") {
      setPageNote(plan.error);
      return false;
    }
    setPageNote(null);
    if (draft && dmAgent !== null) {
      const r = await startDm(ws.id, dmAgent, text, plan.mentions);
      if (!r.ok) {
        setPageNote(r.message);
        return false;
      }
      // 名册那一行要认出这条新私聊（下次点进来直接进房，不再是草稿）
      void refreshHome();
      return true;
    }
    const r = await sendText(text, plan.mentions);
    return r.ok || r.unknown === true;
  };

  const stop = async (seq: number): Promise<void> => {
    setStopping(true);
    const r = await stopTurn(seq);
    setStopping(false);
    if (!r.ok) setPageNote(r.unknown ? "没有收到回执，不确定停下来没有" : r.message);
  };

  const headerTop = insets.top + 8;
  const headerSpace = headerTop + ROUND_BUTTON_SIZE + 12;
  const empty: "loading" | "hello" | null =
    session === null
      ? draft ? "hello" : "loading"
      : cloudEmptyState(session.state, events.length) === "skeleton" ? "loading"
        : items.length === 0 ? "hello" : null;

  const headFaces: ReactNode =
    ws === null ? null
      : dmAgent !== null ? (
        <Face slot={agentFaceSlot(ws, dmAgent)} tier="s" state={dmFaceState(openTurns(events), chat.streaming, dmAgent)} phase={facePhase(dmAgent)} ringColor={c.card} />
      ) : (
        <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} state="plain" />
      );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1 }}>
          {ws !== null && resolved === null ? (
            <Centered top={headerSpace}>
              {home.loaded ? <Text style={{ ...t.callout, color: c.mutedForeground }}>这条聊天已经不在了。</Text> : <Spinner />}
            </Centered>
          ) : ws === null || empty === "loading" ? (
            <Centered top={headerSpace}>
              <Spinner />
            </Centered>
          ) : empty === "hello" ? (
            <Centered top={headerSpace}>
              <Hello ws={ws} kind={kind} agentIds={agentIds} title={title} />
            </Centered>
          ) : (
            <FlatList
              inverted
              data={items}
              keyExtractor={(it) => (it.kind === "row" ? it.row.key : it.now.key)}
              renderItem={({ item }) =>
                item.kind === "row" ? (
                  <ChatRowView row={item.row} ws={ws} />
                ) : (
                  <NowRowView now={item.now} ws={ws} ready={ready} stopping={stopping} onStop={() => void stop(item.now.seq)} />
                )
              }
              ItemSeparatorComponent={Gap}
              onEndReached={() => {
                if (session?.hasOlder && session.older === "idle") void loadOlder();
              }}
              onEndReachedThreshold={0.5}
              ListHeaderComponent={<View style={{ height: 10 }} />}
              ListFooterComponent={<OlderRow top={headerSpace} hasOlder={session?.hasOlder ?? false} older={session?.older ?? "idle"} />}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          )}
        </View>

        <View style={{ gap: 6, paddingHorizontal: 16 }}>
          {session?.state === "gone" ? <Line tone="muted">正在重连…</Line> : null}
          {session?.state === "denied" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Line tone="error">{cloudDeniedText(session.deniedCode, session.deniedServerVersion)}</Line>
              <Button size="auto" variant="plain" label="回名册" onPress={() => navigation.popToTop()} />
            </View>
          ) : null}
          {session?.gapNote ? <Line tone="warn">{session.gapNote}</Line> : null}
          {chat.notice ? <Line tone="muted">{chat.notice}</Line> : null}
          {chat.error ? <Line tone="error">{chat.error}</Line> : null}
          {chat.sendError ? <Line tone="error">{chat.sendError}</Line> : null}
          {pageNote ? <Line tone="error">{pageNote}</Line> : null}
          {chat.unsent !== null && chat.unsent.sessionId === session?.sessionId ? (
            // 中性灰不是红色：它不是一次失败，是这一层消除不了的不确定。两颗钮把决定交回给人
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Line tone="muted">{chat.unsent.note}</Line>
              <Button size="auto" variant="plain" label="重新发送" disabled={!ready} onPress={() => void resendUnsent()} />
              <Button size="auto" variant="plain" label="放弃" onPress={dropUnsent} />
            </View>
          ) : null}
        </View>

        <Composer
          placeholder={kind === "dm" ? `跟「${title}」说…` : "说点什么…"}
          canSend={canSend}
          sessionId={session?.sessionId ?? null}
          onSend={onSend}
        />
      </KeyboardAvoidingView>

      <ChatHeader
        top={headerTop}
        title={title}
        faces={headFaces}
        onBack={() => navigation.goBack()}
        {...(dmAgent !== null ? { onSettings: () => navigation.navigate("AgentSettings", { agentId: dmAgent }) } : {})}
      />
    </View>
  );
}
```

- [ ] **Step 5: 类型检查 + 架构断言**

Run: `npx tsc --noEmit -p mobile && npx vitest run tests/architecture.test.ts`
Expected: tsc 无输出；架构测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add mobile/src/chat/ChatRows.tsx mobile/src/chat/Composer.tsx mobile/src/chat/ChatScreen.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): 聊天页——药丸头 / 时间线 / 此刻 / 输入框 / 草稿（#1356 A1，spec §5.3）

私聊为主、群聊先有基础版（群设置、@ 谁、名单变更那一行在 A3）。行的判据全在
shared/mobileChat.ts，藏哪些事件走桌面同一份 hiddenFromCloudTimeline；名单与名字
从日志推导（chatViewOf）。草稿里第一句发出去才建私聊，免得「点进去看一眼」也把它
顶到名册最上面。回执三态照 ADR-0228（unknown 清输入框、另起一行「重新发送 / 放弃」）；
gone 一行「正在重连…」、发送钮灰；denied 说清是哪一种 +「回名册」。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: 名册屏——进门七态 + 混排一列 + 搜索

spec §5.2：头上三颗圆钮——左 = 账号；右 = 搜索、＋（＋ 在 A2，这一片不画点了没去处的钮），**没有大标题**。进门七态照搬 `rosterGate`。一列 = 主场的智能体 + 主场的群，混在一起按最近一次动静降序（Task 6 算好）。单只那一行：脸（alive、m 档、相位按 agentId 错开）| 名字 + 职责 / 最后一句 | 时间；群那一行：几张 s 档脸横叠 | 群名 + 成员名 /「名字：最后一句」| 时间。**不画「在跑没在跑」、不画未读**。刷新：进前台、从聊天页退回来、建 / 删之后各拉一次；不轮询。搜索（名册那一半）：按名字 / 职责 / 最后一句本机过滤，结果行与名册同款。

**Files:**
- Create: `mobile/src/roster/RosterRow.tsx`
- Rewrite: `mobile/src/roster/RosterScreen.tsx`

**Interfaces:**
- Consumes: Task 6 的 `rosterItems` / `filterRosterItems` / `rosterTimeLabel` / `RosterItem`；Task 9 的 `useHome` / `refreshHome` / `ensureHome`；Task 8 的 `SearchGlyph` / `GroupFaces`；`rosterGate`（`src/shared/agentRoster.ts`）；`workspaceAccess`（`src/shared/workspaceAccess.ts`）；`facePhase`；手机 `AccountButton` / `RoundButton` / `Face` / `Button` / `Field` / `Note`。
- Produces: 名册屏（导航到 `Chat` / `Account` / `FaceGallery`）。

- [ ] **Step 1: 名册一行**

Create `mobile/src/roster/RosterRow.tsx`：

```tsx
// 名册一行（#1356 A1，spec §5.2 / §4）：脸 m 档 | 名字（16.5 / 600）+ 小字 / 第二行（一行截断）| 时间。
// 三格文字由 shared/mobileRoster.ts 算好（sub / line2 / timeTs），这里只画。
// 不画「在跑没在跑」、不画未读（#722 / #1282）：名册查不到谁在跑，画一个恒灰的点就是撒谎的勾。
// 按下整行变色（列表行的语汇），不缩放。
import { Pressable, Text, View } from "react-native";
import { rosterTimeLabel, type RosterItem } from "../../../src/shared/mobileRoster.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { Face } from "../face/Face.js";
import { GroupFaces } from "../face/GroupFaces.js";
import { type as t, usePalette, withAlpha } from "../theme.js";

export function RosterRow({ item, now, onPress }: { item: RosterItem; now: number; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.name}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10 },
        pressed && { backgroundColor: withAlpha(c.foreground, 0.07) },
      ]}
    >
      {item.kind === "agent" ? (
        <Face slot={item.slot} state="alive" tier="m" phase={facePhase(item.agentId)} />
      ) : (
        <GroupFaces agentIds={item.agentIds} slots={item.slots} height={52} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1}>
          <Text style={{ fontSize: 16.5, fontWeight: "600", letterSpacing: -0.2, color: c.foreground }}>{item.name}</Text>
          {item.sub !== "" ? <Text style={{ fontSize: 13, color: c.mutedForeground }}>{`  ${item.sub}`}</Text> : null}
        </Text>
        {item.line2 !== null ? (
          <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 19, color: c.mutedForeground }}>{item.line2}</Text>
        ) : null}
      </View>
      {item.timeTs !== null ? (
        <Text style={{ ...t.footnote, color: c.mutedForeground, alignSelf: "flex-start", marginTop: 6 }}>
          {rosterTimeLabel(item.timeTs, now)}
        </Text>
      ) : null}
    </Pressable>
  );
}
```

- [ ] **Step 2: 名册屏**

Rewrite `mobile/src/roster/RosterScreen.tsx`（整份替换 A0 的占位）：

```tsx
// 名册（根，#1356 A1，spec §5.2）。
//
// · 头：左 = 账号；右 = 搜索（＋ 在 A2——点了什么都不发生的钮是撒谎的勾，#722）。没有大标题，
//   圆钮浮在内容上，列表从底下滚过去（spec §4）。
// · 进门七态照搬 rosterGate：还没查到 / 正在建主场 → 骨架、**不劝订阅**；没订阅 / 档位不带 →
//   一句实话、不画钮（A5 之前手机上办不了订阅）；建失败 → 原因 + 重试钮、不自动重试；
//   **有主场就进得去、不再看档位**（降了档的人的聊天记录还在）。
// · 一列：主场的智能体 + 群混排、按最近一次动静降序（判据在 shared/mobileRoster.ts）。
// · 刷新：进前台、从聊天页退回来（focus）、建 / 删之后（那几处自己调）。不轮询。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
import { filterRosterItems, rosterItems, type RosterItem } from "../../../src/shared/mobileRoster.js";
import { workspaceAccess } from "../../../src/shared/workspaceAccess.js";
import { SearchGlyph } from "../chrome/Glyphs.js";
import { ROUND_BUTTON_SIZE, RoundButton } from "../chrome/RoundButton.js";
import { ensureHome, refreshHome, useHome } from "../home/homeStore.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Field, Note } from "../ui.js";
import { AccountButton } from "./AccountButton.js";
import { RosterRow } from "./RosterRow.js";

/** 还没查到 / 正在建时的骨架：四行灰块，形状与真行一致（脸 59×52 + 两行字） */
function Skeleton() {
  const { c } = usePalette();
  const block = withAlpha(c.foreground, 0.07);
  return (
    <View accessibilityLabel="正在读取名册" style={{ gap: 4 }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10 }}>
          <View style={{ width: 59, height: 52, borderRadius: 14, backgroundColor: block }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "46%", height: 14, borderRadius: 7, backgroundColor: block }} />
            <View style={{ width: "72%", height: 12, borderRadius: 6, backgroundColor: block }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** 名册之外的那几态。只说实话：该给钮的地方给钮，给不出有去处的钮就不画 */
function GateView({ gate, ensureError, loadError }: { gate: RosterGate; ensureError: string | null; loadError: string | null }) {
  const { c } = usePalette();
  const say = (lead: string, hint: string) => (
    <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
      <Text style={{ ...t.headline, color: c.foreground }}>{lead}</Text>
      <Text style={{ ...t.callout, color: c.mutedForeground }}>{hint}</Text>
    </View>
  );
  switch (gate) {
    case "no_subscription":
      return say("订阅 Pro 或 Max 之后才建得了智能体。", "订阅在电脑上的 Mr Otto 里办，办好回来就能用。");
    case "plan_too_low":
      return say("你现在的订阅档位建不了智能体，Pro 或 Max 才行。", "换档在电脑上的 Mr Otto 里办。");
    case "failed":
      return (
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <Note tone="error">{ensureError ?? "没能建好你的智能体空间。"}</Note>
          <Button size="auto" variant="outline" label="重试" onPress={() => void ensureHome()} />
        </View>
      );
    default:
      // unknown / ensuring / signed_out：画骨架，不下任何结论；读不到的那句挂在上面 + 一颗重试
      return (
        <View style={{ gap: space.md }}>
          {loadError !== null ? (
            <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
              <Note tone="warn">{loadError}</Note>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshHome()} />
            </View>
          ) : null}
          <Skeleton />
        </View>
      );
  }
}

export function RosterScreen() {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const home = useHome();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshHome();
    });
    return () => sub.remove();
  }, []);

  const access = workspaceAccess({ signedIn: true, billing: home.billing });
  const gate: RosterGate = home.loaded ? rosterGate({ access, home: home.home, ensure: home.ensure }) : "unknown";
  // 档位带、主场还没有 → 自己去建（建失败不自动重试，那一颗钮要人点）
  useEffect(() => {
    if (gate === "ensuring" && home.ensure === "idle") void ensureHome();
  }, [gate, home.ensure]);

  const items = useMemo(
    () => (home.home !== null && home.selfUid !== null
      ? rosterItems({ home: home.home, chats: home.chats, lasts: home.lasts, selfUid: home.selfUid })
      : []),
    [home.home, home.chats, home.lasts, home.selfUid],
  );
  const shown = useMemo(() => filterRosterItems(items, query), [items, query]);
  const now = Date.now();
  const headerSpace = insets.top + 8 + ROUND_BUTTON_SIZE + 8;

  const open = (item: RosterItem): void => {
    navigation.navigate("Chat", item.kind === "agent" ? { kind: "agent", agentId: item.agentId } : { kind: "group", sessionId: item.sessionId });
  };
  const closeSearch = (): void => {
    setSearching(false);
    setQuery("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {gate === "ready" ? (
        <FlatList
          data={shown}
          keyExtractor={(it) => it.key}
          renderItem={({ item }) => <RosterRow item={item} now={now} onPress={() => open(item)} />}
          contentContainerStyle={{ paddingTop: headerSpace, paddingBottom: insets.bottom + space.xl }}
          ListHeaderComponent={
            home.loadError !== null ? (
              // 读不到 ≠ 空：旧的名册照画，失败那句挂在上面
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
                <Note tone="warn">{home.loadError}</Note>
                <Button size="auto" variant="outline" label="重试" onPress={() => void refreshHome()} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            query.trim() !== "" ? (
              <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", marginTop: space.xl }}>
                {`没有找到「${query.trim()}」`}
              </Text>
            ) : null
          }
          ListFooterComponent={
            __DEV__ ? (
              <View style={{ padding: space.lg }}>
                <Button variant="quiet" label="形象陈列馆（开发用）" onPress={() => navigation.navigate("FaceGallery")} />
              </View>
            ) : null
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      ) : (
        <View style={{ paddingTop: headerSpace }}>
          <GateView gate={gate} ensureError={home.ensureError} loadError={home.loadError} />
        </View>
      )}

      {/* demo 的 .pillnav：状态栏下 8pt、左右 12pt，没有实心导航条 */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        {searching ? (
          <>
            <View style={{ flex: 1 }}>
              <Field value={query} onChangeText={setQuery} placeholder="搜名字、职责、最后一句" autoFocus returnKeyType="search" />
            </View>
            <Button size="auto" variant="plain" label="取消" onPress={closeSearch} />
          </>
        ) : (
          <>
            <AccountButton onPress={() => navigation.navigate("Account")} />
            <View style={{ flex: 1 }} />
            {gate === "ready" ? (
              <RoundButton label="搜索" onPress={() => setSearching(true)}>
                <SearchGlyph color={c.foreground} />
              </RoundButton>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
```

- [ ] **Step 3: 类型检查 + 架构断言 + 手机端没有残留的占位文案**

Run: `npx tsc --noEmit -p mobile && npx vitest run tests/architecture.test.ts && grep -rn "下一步在这里接上真数据" mobile/src || echo "no placeholder left"`
Expected: tsc 无输出；架构测试 PASS；最后一句打印 `no placeholder left`。

- [ ] **Step 4: Commit**

```bash
git add mobile/src/roster/RosterRow.tsx mobile/src/roster/RosterScreen.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): 名册接上真数据——进门七态、混排一列、搜索（#1356 A1，spec §5.2）

一列是主场的智能体与群混排、按最近一次动静降序（判据在 shared/mobileRoster.ts）；
不画在跑没在跑、不画未读（#722 / #1282）。进门七态照搬 rosterGate：还没查到画骨架、
不劝订阅；没订阅 / 档位不带只说一句实话（手机上还办不了订阅，不画没去处的钮）；
建失败给重试钮、不自动重试；有主场就进得去。＋ 在 A2，这一片不画。刷新挂在进前台
与回到名册上，不轮询。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 13: 收尾——ADR、索引、README、spec 偏离、门禁、冒烟、PR

**Files:**
- Create: `docs/adr/0318-手机名册按最近一次动静排-workspace_sessions加三列投影-runtime首尾两沿节流写.md`（编号合并时认领）
- Modify: `AGENTS.md`（Where to find things 加一条）
- Modify: `mobile/README.md`
- Modify: `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§10 追加 A1 的偏离）

**Interfaces:**
- Consumes: 前 12 个任务的全部产物。
- Produces: 一个开着的 PR（Task issue #1356 的 A1 片），合并后 #1356 上一条进度评论。

- [ ] **Step 1: 写 ADR**

先确认编号：`git fetch origin && git -c core.quotePath=false ls-tree --name-only origin/main docs/adr/ | sort | tail -1`（**必须带 `-c core.quotePath=false`**，否则中文文件名被转义、grep 永远匹配不上）。若最大号已经 ≥ 0318，取 `max + 1` 并改下面的文件名与正文里的编号。

Create `docs/adr/0318-手机名册按最近一次动静排-workspace_sessions加三列投影-runtime首尾两沿节流写.md`：

```markdown
# ADR-0318：手机名册按最近一次动静排——workspace_sessions 加三列投影，runtime 首尾两沿节流写

- 日期：2026-09-24
- 状态：已采纳
- 关联：#1356（A1）；spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §5.2 / §7.1；ADR-0283（participants，同形）；ADR-0317（A0）

## 背景

手机名册把个人主场的智能体与群混在一起、按最近一次动静降序，每一行底下写最后一句（demo 定的，维护者 2026-09-23 逐屏点过）。`workspace_sessions` 没有这一格：`updated_at` 只在插入时写（没有触发器，runtime 的补丁也不带它），按它排就是按创建时间排。权威日志在 VPS 上，手机够不着——要先开一条会话房才读得到 backlog，而名册必须在一条会话都没开时就排得出来。

## 决定

1. `workspace_sessions` 加三列：`last_ts timestamptz`（可空）、`last_excerpt text not null default ''`、`last_from text not null default ''`（`agent:<agentId>` / `human:<uid>`）。migration 0040（编号合并时认领），幂等，**不回填、不加任何 update 策略**（写方只有 runtime 的 service key；给了客户端 update 就是让任何在籍成员伪造「某某刚说了一句」）。
2. **判据是 shared 纯函数** `lastOf`（`src/shared/sessionLast.ts`）：人打的话、agent 的答案、人的群聊发言算；接力 / 招呼开场白（fromUid 是点火的人，不是他此刻说的话）、engine 旁白（后台任务 / 护栏）、要了工具的中间步骤、系统发言不算。摘录 = 第一段非空文字（段的判据与气泡拆段同一条 `splitBubbles`）、折叠空白、≤120 字（按字符数）。
3. runtime 在 `notify` 里逐条推进，**首尾两沿节流**（`services/runtime/src/lastWriter.ts`）：距上一次**写**已满 3 秒就当场写（人刚说完的那句立刻顶上名册），否则只记下最后一句、到窗口末尾再写。窗口从上一次写算起，不从上一次 push 算起——否则一句接一句地说会把尾沿无限往后推。写失败只记一行日志（同 `cloudSessionMeta` 的纪律），下一句盖掉。
4. **读是单独一条容错查询** `fetchCloudLasts`：0040 没跑时 PostgREST 回 42703 → 空 Map，名册退回 `updated_at` → 智能体自己的 `created_at` 排，聊过的那一行第二行写职责（spec §10 第 9 条）。**不并进 `listCloudSessions`**：那条桌面也走，而桌面这一片不读这三列，没必要让它多打一条查询。

## 否决

- **手机开会话房读 backlog 自己算**：名册一墙十几条聊天就是十几条长连接，而名册是最常打开的那一页。
- **给 `updated_at` 挂触发器**：它同时被别的补丁写（标题、参与者），「最近动静」会被一次自动改名顶上去；也拿不到摘录。
- **只写尾沿**：人刚发完一句退回名册，那一行要等 3 秒才顶上去——而那正是人发完之后第一眼看的地方。
- **不节流**：群里接力、人连发几句时一秒几写，写的还是一格马上就会被下一句盖掉的投影。

## 已知代价

- 名册上的「最后一句」最多晚 3 秒（尾沿那一格）；runtime 重启时还在窗口里的那一句丢了（不播种），下一句盖掉。
- 这三列与日志可能短暂不一致（写失败不重试）；它们只用来排序与摘录，点进去看的是日志本身。
- **要先跑 0040、再部署 runtime 才生效**（#791）；部署之前手机名册按创建时间排、第二行写职责。

## 同一片里的另外几件（不单开 ADR）

- 桌面云会话 store 的两条状态规则（事件按 seq 插位、状态推送哪几格照抄哪几格留着）与两句文案挪进 `src/shared/cloudSessionState.ts`；改 / 删智能体的编排挪进 `src/shared/agentAdmin.ts`。桌面改成调用、行为不变——spec §2「不抄第二份」、§3.2。
- 底部抽屉引入 `react-native-reanimated@4.5.1` / `react-native-gesture-handler@~2.32.0` / `react-native-worklets@0.10.1`（ADR-0293 决定 3；版本取 Expo SDK 57 的 bundledNativeModules，与 Expo Go 自带的原生那一半一致）。
- A1 的聊天页私聊、群聊通用：名册把群一起列出来，点进去先是基础版；群设置、@ 谁、名单变更那一行在 A3。
- 挑头像那面墙十张：cap 只借住在坑 2、没有自己的坑位，存进暂借格的人会在补齐旧 03 那天被悄悄换脸（ADR-0316 法理③）——维护者 2026-09-24 确认。
```

- [ ] **Step 2: AGENTS.md 索引加一条**

在 `AGENTS.md` 的「Where to find things」里、`src/shared/ottoFace/` 那一条之后加一条（L2：只动索引）：

```markdown
- `mobile/src/roster/` / `mobile/src/chat/` / `mobile/src/agent/` / `mobile/src/home/homeStore.ts` / `mobile/src/cloud/chatStore.ts` / `src/shared/mobileRoster.ts` / `src/shared/mobileChat.ts` / `src/shared/agentSettingsForm.ts` / `src/shared/sessionLast.ts` / `services/runtime/src/lastWriter.ts` — **手机端「智能体」单栏 A1：名册 + 聊天 + 智能体设置**（#1356，ADR-0318）。判据全在 shared（进 vitest），手机端只画与接线：名册把主场的智能体与群混排、按最近一次动静降序（与桌面「单只按名册、群按活动」**故意不同**，spec §5.2），动静来自 runtime 投影进 `workspace_sessions` 的三列（`last_ts` / `last_excerpt` / `last_from`，判据 `lastOf`，首尾两沿 3 秒节流写，**先跑 0040 再部署 runtime**）；读是单独一条容错查询 `fetchCloudLasts`，没跑库时退回 `updated_at` 排、第二行写职责。聊天页藏哪些事件**不另立判据**（走桌面同一份 `hiddenFromCloudTimeline`），「此刻」那一行作答 > 执行 > 排队、同档取 seq 最小，私聊还没建时是草稿、第一句发出去才建。桌面云会话 store 的两条状态规则（`src/shared/cloudSessionState.ts`）与改 / 删智能体的编排（`src/shared/agentAdmin.ts`）为此从桌面抽进 shared，桌面改成调用、行为不变。底部抽屉（`mobile/src/sheet/BottomSheet.tsx`）引入 reanimated / gesture-handler / worklets（ADR-0293 决定 3，版本逐字取 Expo SDK 57 的 bundledNativeModules——不一致真机上一打开就红屏）。挑头像墙十张（cap 没有自己的坑位，维护者 2026-09-24 确认）。真机登录后的流程一次没跑过（agent 不能替人输密码）
```

- [ ] **Step 3: 手机 README**

`mobile/README.md`：

1. 开头第三段「A0 只立了基座（名册是占位，真数据在 A1）；……」改成：
   ```markdown
   A0 立了基座，A1 接上了名册（主场的智能体与群混排、按最近一次动静排、可搜索）、聊天页与智能体设置；进度见 spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §8。
   ```
2. 「## 结构」清单：把 `src/roster/` 那一行改成下面这一行，并在它后面补四行：
   ```markdown
   - `src/roster/`：名册屏（栈底：进门七态 + 混排一列 + 搜索）+ 左上账号入口
   - `src/chat/`：聊天页（头部药丸 / 时间线 / 此刻 / 输入框 / 草稿）
   - `src/agent/`：智能体设置 +「换个形象」抽屉
   - `src/home/`、`src/cloud/`：数据层——主场名册与订阅快照（直连 Supabase / edge）、云会话客户端与当前聊天（外部 store，`useSyncExternalStore`）
   - `src/sheet/`：底部抽屉（reanimated + gesture-handler，ADR-0293 决定 3）
   ```
   `src/nav/` 那一行改成：`- \`src/nav/\`：根栈——名册（无头，自己画浮在内容上的圆钮）/ 聊天（同上）/ 智能体设置 / 账号 / 开发构建里的形象陈列馆；没有底栏、没有第二个根`
3. 「## 跑起来」下面那段「**Expo Go 就能跑，没有 native module。**」开头改成：
   ```markdown
   **Expo Go 就能跑。** 用到的原生模块（react-native-svg / reanimated / gesture-handler / worklets / expo-blur……）Expo Go 57 里都自带，
   版本逐字取 `node_modules/expo/bundledNativeModules.json`——与 Expo Go 自带的那一半不一致时，真机一打开就红屏。
   ```
   （原段落后半「配对那套 `@noble/*` 已经随 #1356 删了……」原样保留。）

- [ ] **Step 4: spec §10 追加 A1 的偏离**

在 `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §10 的第 21 条之后、「（写 plan / 实现期间的偏离追加在这里。）」之前追加：

```markdown
22. **群聊在 A1 先有基础版**：名册按 §5.2 把群一起列出来，点进去是与私聊同一张聊天页（时间线 / 此刻 / 输入框，不 @ 谁由 runtime 派活）；群设置、@ 谁、名单变更那一行仍在 A3。不这样做的话名册上会挂着一排点不进去的行。
23. **智能体设置的头用原生导航条**（回退 + 右上「存」），不是名册 / 聊天页那种浮在内容上的圆钮：这一页是表单，一条实心的导航条让「存」有一个固定、好找的位置。
24. **「最后一句」走单独一条容错查询 `fetchCloudLasts`，不并进 `listCloudSessions`**：后者桌面也走，而桌面这一片不读这三列（§7.1「桌面暂不读」）。
25. **runtime 写库是首尾两沿节流**（§7.1 原文只写了「尾沿」）：首沿当场写，人刚发完一句退回名册，那一行立刻顶上去。理由见 ADR-0318。
26. **名册搜索是头上那一条输入框**，不是另推一页：结果就是名册本身被过滤，行与名册同款（§5.2）。
27. **聊过但读不到最后一句时，职责挪到第二行、第一行不重复写**（落实第 9 条）；没聊过的照旧写「点进去跟它说第一句」。
```

同一次改动里再改两处（维护者 2026-09-24 拍板）：§5.4 那句「这条待 A1 与维护者确认」改成「维护者 2026-09-24 确认」；§11 末尾追加一条：

```markdown
5. 挑头像那面墙 **10 张**、cap 先不进（2026-09-24）：补齐旧 03 的画之前，谁都不该被存进暂借格。
```

- [ ] **Step 5: 全量门禁**

Run: `npm test > .superpowers/a1-gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  " .superpowers/a1-gate.log`（`.superpowers/` 被 git 忽略）
Expected: `GATE_EXIT=0`；Test Files / Tests 两行全 passed（数目比 A0 的 620 / 7726 多出本片新增的那些）。**判据只认 GATE_EXIT**，不认任何包装命令的退出码。

- [ ] **Step 6: 模拟器冒烟（不登录能验的部分）**

在 worktree 里起 Metro（`mobile/node_modules` 是本地安装，metro 才解析得了）：

```bash
npm --prefix mobile start -- --port 8081
```

另开一条：`xcrun simctl list devices booted` 拿到已启动模拟器的 udid，然后 `xcrun simctl openurl <udid> exp://127.0.0.1:8081`。逐项记录结果：

1. 冷启动 → 开屏 → 登录卡，**没有红屏**（reanimated / worklets 的版本与 Expo Go 对不上时这里就红）。
2. 抽屉与挑头像：登录后的屏进不去，所以临时在 `App.tsx` 里挂一个**不提交**的入口（例如把 `view === "splash"` 之外那一支暂时换成一个渲染 `<FacePickerSheet visible current={5} onPick={…} onClose={…} />` 的根视图），验：70% 高、下拽过四分之一关、一甩就关、往上拉有阻尼、X 与点暗幕都关、大脸按「排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着」循环、墙上十张且只有选中那张在动、深色模式下黑头发有浅描边。**验完 `git checkout mobile/App.tsx` 还原**，`git status` 确认干净。
3. **没跑（要登录，agent 不能替人输密码）**：名册七态 / 混排 / 搜索、私聊（草稿 → 建 → 第一句 ready 后发出、流式、此刻那一行、停一下、往前翻）、设置（改名 / 职责 / 交代 / 换形象后存、删掉）、群聊基础版、gone / denied 的横幅。PR 里原样列给维护者点。

若 Expo CLI 提示要装 / 升级 Expo Go：**先问维护者**（那是往模拟器里下载一个 app），不要自动接受。

- [ ] **Step 7: Commit 文档**

```bash
git add docs/adr/0318-*.md AGENTS.md mobile/README.md docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md
git commit -m "$(cat <<'EOF'
docs: A1 的 ADR、索引、手机 README 与 spec §10 偏离（#1356 A1）

ADR-0318 记名册「最后一句」投影的三条判断（三列不回填不给 update、判据在 shared、
首尾两沿节流）与否决的三条路；AGENTS.md 索引加一条；README 的结构清单跟上三个新
目录与三个新依赖；spec §10 追加实现期间的六处偏离（群聊基础版、设置页用原生导航条、
读查询不并进 listCloudSessions、首沿当场写、搜索是一条输入框、读不到最后一句时职责
挪到第二行）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: 推送、开 PR、等 CI、合并**

```bash
git fetch origin
git merge --ff-only origin/main || echo "main 有新提交：先 merge origin/main 进来、解冲突、重跑门禁"
git -c core.quotePath=false ls-tree --name-only origin/main docs/adr/ | sort | tail -3
git -c core.quotePath=false ls-tree --name-only origin/main supabase/migrations/ | sort | tail -3
```

ADR 或 migration 撞号就按项目 ADR-0074 改号（`max + 1`、文件顶部加「原为 …」一行、只改指向它的引用——**不要全局替换**，改完 `git grep -n` 逐条核）。然后：

```bash
git push -u origin claude/elated-bohr-d2f4de
gh pr create --base main --title "feat(mobile): 智能体单栏 A1——名册 + 私聊 + 智能体设置（#1356）" --body-file <正文文件>
```

PR 正文（写进一个临时文件再 `--body-file`）要有：Task issue #1356（A1，**不关 issue**）；spec / plan / ADR-0318；做了什么（按任务分组）；测试变动（新增的测试文件；桌面那两处抽取是行为不变的重构，现有集成测试一条没改）；**部署顺序**（合并后维护者：先在生产库跑 0040，再部署 runtime；手机端 Expo Go 重新载入；桌面下次发版带上两处重构）；验证（门禁两行 + GATE_EXIT、冒烟逐项结果、没跑的那几项）。末尾：

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

CI 由 controller 盯（按 sha 等 `gate` 跑完，CI 绿之前不合并——本仓没有 required check，`mergeStateStatus` 为 CLEAN 不代表 CI 过了）。绿了用 merge commit 合并：`gh pr merge <PR号> --merge --match-head-commit <sha>`。合并后：
- `git fetch origin` 再核一次 ADR 与 migration 编号（带 `-c core.quotePath=false`），撞了就开改号 PR。
- 在 #1356 上评论：A1 已合（PR 号、ADR 号、merge commit）、**维护者要做的两步**（跑 0040 → 部署 runtime）、登录后要点的那几项、下一步是 A2 的 plan。
