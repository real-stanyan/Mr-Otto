# 手机端「智能体」单栏 A5——账号与那台电脑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 名册左上那颗钮进去的账号页做全：我是谁 + 档位、两扇额度窗（还剩百分之几）、订阅（App 内浏览器里走 Stripe 结账 / Portal，回来重拉）、这周各智能体用了多少、「它们共用的一台电脑」（文件 / 应用 / 记忆 / 用量）、设置（外观 + 连接诊断）、退出；名册搜索多出记忆那一半；名册「没订阅 / 档位不带」那两态有了一颗去订阅的钮。

**Architecture:** 服务端一行不改：`/billing/v1/me`、`checkout` / `portal`、`workspace-usage`（ADR-0203 / 0221 / 0264）、控制房的 `files` / `files_search` / `wiki_write` 帧（ADR-0251 / 0253 / 0282）都已上线，手机只做又一个客户端。判据全在 `src/shared/`（进 vitest）：桌面渲染层三份纯逻辑挪进 shared（`workspaceUsageView` / `workFilesView` / `billingError`，桌面改 import、行为不变），新写 `mobileAccount.ts`（账号页 / 订阅页 / 外观）与 `mobileMachine.ts`（那台电脑 / 文件 / 应用 / 记忆 / 记忆搜索 / 用量页的手机说法）。手机端：两个小 store（订阅快照 + 开支付页；记忆索引 + 用量）、十个屏、一组行首图标、`Row` 多两格（第二行小字、单选的勾）。

**Tech Stack:** Expo SDK 57 / RN 0.86 / react-native-svg 15.15 / expo-web-browser 57（已在依赖里，OAuth 在用）/ expo-sqlite kv-store（已在用）/ `@react-navigation/native-stack`；vitest。**本片不新增任何 npm 依赖、没有 migration、不碰 `services/`、不进协议位、不用部署。**

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（本片对应 §5.8 账号与那台电脑、§5.2 名册的进门七态与搜索、§6 状态与降级、§8 A5 一行、§10 偏离清单、§12 已知代价第 6 条）。执行者先读这几节再动手。Demo 在分支 `claude/auto-mobile-app-redesign-0a1e2f` 的 `.demo/mobile-agents-redesign.html`（`SCREENS.account` / `subscription` / `settings` / `search` / `machine` / `files` / `connectors` / `wiki` / `wikiPage` / `usage` 那几段，CSS 在 `.row` / `.ico` / `.pill` / `.meter` / `.ubar` / `.card`），**实现以本 plan 与 spec §10 为准**。

**开工前验过的数据源（2026-09-27，读源码；spec §5.8 要求「数据源要先查清，查不到就不画」）：**

| 要画的 | 查得到吗 | 出处 |
|---|---|---|
| 档位 / 两扇窗 / 订阅状态 / 价目 | 能：`GET /billing/v1/me` → `BillingMe`（`windows` 只在订阅活跃时下发，否则 null）；手机端 `mobile/src/home/billing.ts` 的 `fetchBilling` 已经在打 | `src/shared/billing.ts:33-70`、`services/edge/src/billingQueries.ts:312` |
| 结账 / 管理订阅 | 能：`POST /billing/v1/checkout {planId}` / `POST /billing/v1/portal` → `{url}`；在跑的订阅（status ≠ canceled）再 checkout 回 **409 `already_subscribed`**；两条都落在 edge 自己那一句话的页面 `/billing/v1/done`，**不回跳 App** | `services/edge/src/edge.ts:396-423`、`worker.ts:758-796` |
| 这周各智能体用了多少 | 能：`GET /billing/v1/workspace-usage?workspace=<主场 id>` → `WorkspaceUsage`（`weekLimitMicro` 可能是 null） | `edge.ts:381-393`、`src/shared/billing.ts:283-321` |
| 文件 | 能：`cloudClient.workspaceFiles(id, path)` 一次一层（`CsWorkNode`：absent / missing / dir / file ≤64 KB / binary）；`workspaceFilesSearch(id, q, content)` 按名 ≤500 / 按内容 ≤200 | `src/shared/remote/cloudSession.ts:126,203-237`、`cloudSessionClient.ts:899-929` |
| 记忆 | 能：读 `wiki/index.md` 与 `wiki/<页>` 走同一个 `files` 帧；改走 `workspaceWikiWrite(id, {op:"write",…})` | `src/renderer/src/components/WorkspaceWikiTab.tsx`、`src/shared/wiki.ts` |
| 应用清单 | 能：主场快照本来就带 `connectors`（`workspace_connectors`，桌面贡献进来的） | `src/shared/workspaces.ts:26-31,77-82` |
| 应用「等你登录」 / 连没连上 | **不能**：needs-auth 只活在桌面主进程 `McpHub` 的内存里；托管箱 `buildEscrowDoc` 把不 live 的整台滤掉；edge 没有状态端点 | `src/main/mcpHub.ts:229`、`src/shared/remote/pxEscrow.ts:134-160` |
| 磁盘用量 | **不能**：`du` 的读数只在 runtime 里当闸（ADR-0287），不进任何帧 / 列 / 端点 | `services/runtime/src/sandbox.ts:665-679` |
| 文件总数 | **不能**：`files` 帧一次只列一层，没有递归计数 | ADR-0253 决定 4 |

所以：名册账号钮上那枚 `--warn` 的点**不画**，应用那一页**不画状态点**，那台电脑那一页**不画磁盘条**、**不报文件数**（spec §10 第 80–81 条，Task 10 写进去）。

**本片没有新的维护者拍板**：几处取舍都是照 spec 既有的规矩裁的（§6 三条降级、§10 的「实现以这里为准」、§12 第 6 条「不开 IAP」），逐条写进 spec §10 第 80–92 条（Task 10）。

## Global Constraints

- 工作目录：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a`（分支 `claude/mobile-a5-account-4e639a`，从 origin/main `37b09f8f` 开）。**你改的每一个路径都必须在这个目录下；绝不碰主 checkout `/Users/stanyan/Github/Mr_Otto`**（那是别的 lane 共用的只读副本）。每条 shell 命令自带 `cd <这个目录> &&`，别依赖上一条留下的 cwd。
- **绝不用 `git stash`（任何形式）**：stash 栈是所有 worktree 共享的。RED 靠「先写测试、跑出失败、再实现」。不许 `--no-verify`。
- 手机端（`mobile/src/`、`mobile/App.tsx`、`mobile/index.ts`）在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session` 文件（`tests/architecture.test.ts` 第 8 条会红）。第三方包（`expo-web-browser`、`react-native-svg`、`@react-navigation/*`、`expo-sqlite/kv-store`）照常 import。
- **两端共用的纯逻辑写进 `src/shared/`，不抄第二份**（spec §2）。手机端不进 vitest、只跑 tsc，所以凡是「判断」都放 shared 并带测试；RN 组件里只剩接线与样式。`src/shared/` 不许 import 任何 node builtin / electron / react-native（`tests/architecture.test.ts` 会红）。
- **本片不新增 npm 依赖、没有 migration、不碰 `services/`、不进协议位。**
- 搬家（Task 1）**只挪不改断言**：桌面行为一个字不变，既有用例原样搬走；桌面改 import，**不留转发壳**（spec §9：两条路径指向同一份代码，下一个人分不清哪条是正路）。
- 设计令牌逐值取自 `mobile/src/theme.ts`；尺寸逐值取自 demo（`.row` 最小 52 高带第二行、`.ico` 29×29 圆角 8、`.pill` 22/24 高、`.meter` 6 高 3 圆角、`.card`）。**界面文案不出现「水獭」，也不出现「主场」「云会话」「团队」「工作区」这类内部名**——桌面那几份文案（`PLAN_CARDS` 的 blurb、`workFilesView` 的几句、`usageScaleNote`）是桌面口吻，手机上另写（在 shared 里、带测试），尺寸 / 时间 / 百分比的算法照旧复用。
- 状态与降级（spec §6）：**还没查到 ≠ 没有**（`billing === null` 不许退成 Free / 没订阅，ADR-0240）/ **读不到 ≠ 空**（刷新失败时上一份照画，错误另起一行）/ **说不清就不画钮**（#722：点了必然失败或没有去处的钮不画）。
- 这一片不加新的动效：按压反馈用现成的（`Row` 整行变色、`Button` 缩放），它们本来就有「减弱动态效果」下的样子。
- TypeScript strict；根另开 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（shared 与手机两边都要过）。**可选字段 / 可选 prop 不许显式传 `undefined`**，一律 `{...(x === null ? {} : { value: x })}` 这种展开写法。
- 新屏的 props 用 `NativeStackScreenProps<RootStackParams, "屏名">`（`import type { NativeStackScreenProps } from "@react-navigation/native-stack";`，同 `AgentSettingsScreen`）——同一个屏压栈要 `navigation.push`，换掉当前这一页要 `navigation.replace`；不带参数的屏可以用 `useNavigation()`（`nav/types.ts` 里那段全局声明让它认得全部路由）。
- 原生导航条右边的字钮挂法照 `AgentSettingsScreen`：`saveRef` 在 `useEffect` 里更新，`setOptions` 只在「按不按得动 / 正在做」变了时重设（不带依赖地每次渲染都 setOptions 会死循环）。
- 门禁 `npm test`（根 tsc + mobile tsc + vitest）。这个 worktree 的根 `node_modules` 是指向主 checkout 的软链、`mobile/node_modules` 是本地安装——**都不要动**。跑门禁：`npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`。**判据只认 `GATE_EXIT`**（`.superpowers/` 被 git 忽略）。单跑测试：`npx vitest run <路径>`；只跑根 tsc：`npx tsc --noEmit`；只跑手机 tsc：`npm --prefix mobile run typecheck`。**本地时间 00:00–01:59 之间 `tests/renderer/agentChatPage.test.tsx` 有一条存量用例必红（#1373）**，那个钟点跑门禁前面加 `TZ=UTC`。
- 提交：小步提交，中文 message 写清「为什么」，末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。`git add` 只加这个任务自己的文件（逐路径，不用 `-A` / `.`；`git mv` 过的文件已经在暂存区）。**这个会话的 shell 会拒绝 heredoc 与 `$(…)` 当参数**：把 message 用编辑工具写进 `.superpowers/commit-msg.txt`（写之前先用读文件的工具读一遍它，它可能已经存在），**等写完再**单独跑 `git commit -F .superpowers/commit-msg.txt`；message 内容照计划原文。
- 代码块照原样写进文件；用编辑工具按「把 A 换成 B」改文件时，先 `grep -n` / 读源文件那几行，照源文件的真实缩进做锚点。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/workspaceUsageView.ts` | 挪（原 `src/renderer/src/lib/workspaceUsageView.ts`） | 用量页：每只一行、页顶那一格、分母是什么 |
| `src/shared/workFilesView.ts` | 挪（原 `src/renderer/src/lib/workFilesView.ts`）+ 加 `parseFileQuery` | 文件那一页：大小 / 时间、行尾那一格、`?` 开头按内容搜 |
| `src/shared/billingError.ts` | 挪（原 `src/renderer/src/lib/billingError.ts`） | 订阅 / Portal 那几条路上的报错说给人听 |
| `src/shared/workspaceView.ts` | 改 | `toolsSummary` 导出（手机的应用清单用同一句） |
| `src/shared/mobileAccount.ts` | 新 | 账号页（名字、档位、两扇窗、订阅那一格）、订阅页（档位卡、钮的去处、几句话、开支付页失败说什么）、外观偏好 |
| `src/shared/mobileMachine.ts` | 新 | 那台电脑的目录四行、文件 / 应用 / 记忆 / 用量页的手机说法、名册搜索里记忆那一半 |
| `src/shared/mobileCall.ts` | 改 | 「接着听」那一格没订阅 / 扣款没成功两句指去「账号 → 订阅」 |
| `src/renderer/src/components/WorkspaceFilesTab.tsx` | 改 | 改用 shared 的 `parseFileQuery`（行为不变） |
| `mobile/src/edge.ts` | 新 | edge 的地址与令牌 |
| `mobile/src/home/billing.ts` | 改 | 改用 `edge.ts` |
| `mobile/src/account/billingStore.ts` | 新 | 订阅快照 + 开支付页 + 回来重拉 |
| `mobile/src/machine/usageApi.ts` / `machineStore.ts` | 新 | 用量请求；记忆索引 + 用量两份共用数据 |
| `mobile/src/themePref.ts` + `mobile/App.tsx` | 新 / 改 | 外观偏好：存 kv-store、`Appearance.setColorScheme`、冷启动读一次 |
| `mobile/src/chrome/RowGlyphs.tsx` / `Meter.tsx` | 新 | 行首小图标（demo 的 `.ico`）/ 计量条（demo 的 `.meter` / `.ubar`） |
| `mobile/src/ui.tsx` | 改 | `Row` 加 `detail` / `checked`；新 `useNow`；`Labeled` 从智能体设置挪过来 |
| `mobile/src/agent/AgentSettingsScreen.tsx` | 改 | `Labeled` 改 import |
| `mobile/src/account/SubscriptionScreen.tsx` | 新 | 订阅页 |
| `mobile/src/roster/RosterScreen.tsx` | 改 | 进门「没订阅 / 档位不带」给钮；搜索多出记忆一组 |
| `mobile/src/machine/FilesScreen.tsx` / `FilePreviewScreen.tsx` | 新 | 文件夹一层 / 一个文件 |
| `mobile/src/machine/WikiScreen.tsx` / `WikiPageScreen.tsx` / `WikiEditScreen.tsx` | 新 | 记忆清单 / 一页 / 改一页 |
| `mobile/src/machine/UsageScreen.tsx` / `MachineScreen.tsx` / `AppsScreen.tsx` | 新 | 这周用了多少 / 它们的电脑 / 应用 |
| `mobile/src/account/AccountScreen.tsx` / `PlanPill.tsx` / `QuotaCard.tsx` / `SettingsScreen.tsx` | 重写 / 新 | 账号页 / 档位药丸 / 两扇窗那张卡 / 设置 |
| `mobile/src/roster/AccountButton.tsx` | 改 | 名字与首字走 shared；那枚点不画（头注说清） |
| `mobile/src/nav/types.ts` / `RootNavigator.tsx` | 改 | 十条新路由（各任务加各自的） |
| spec §5.8 / §8 / §10 / §12、`AGENTS.md`、`mobile/README.md` | 改 | 收尾文档（Task 10） |

任务顺序：1 搬家（桌面行为不变）→ 2、3 两份手机判据（shared，带测试）→ 4 手机端的基础件（store、图标、行、外观）→ 5 订阅 → 6 文件 → 7 记忆 + 名册搜索 → 8 用量 / 电脑 / 应用 → 9 账号 + 设置 → 10 收尾文档。**每个屏只在它自己的任务里加路由**；后面的屏会链到前面的屏，所以顺序不能换（5 → 6 → 7 → 8 → 9）。

**不在本片**：应用状态与「等你登录」的数据源（要桌面把 MCP 连接状态写到手机读得到的地方，另开 issue）；磁盘用量下发（runtime 的 `workspace_state` 帧加一格，另开 issue）；Portal 深链（`flow_data`，「换到 X」直接落在换档那一步，edge 改动 + 部署，另开 issue）；推送（「提醒」那一组，2026-09-11 spec 的 B3）；挑声音（#1372）；记忆的新建 / 删除（留在电脑上）。

---

### Task 1: 桌面渲染层三份纯逻辑挪进 shared

手机要用同一份：用量页的每一行 / 页顶那一格 / 分母（`workspaceUsageView.ts`）、文件大小 / 时间 / 行尾那一格（`workFilesView.ts`）、订阅那几条路上的报错（`billingError.ts`）。**只挪不改断言**，桌面改 import，不留转发壳。三份的 import 本来就全指向 `src/shared/**`（或者没有 import），挪过去只是把 `../../../shared/X.js` 改成 `./X.js`。

**Files:**
- Move: `src/renderer/src/lib/workspaceUsageView.ts` → `src/shared/workspaceUsageView.ts`
- Move: `src/renderer/src/lib/workFilesView.ts` → `src/shared/workFilesView.ts`
- Move: `src/renderer/src/lib/billingError.ts` → `src/shared/billingError.ts`
- Move tests: `tests/renderer/workspaceUsageView.test.ts` → `tests/shared/workspaceUsageView.test.ts`；`tests/renderer/workFilesView.test.ts` → `tests/shared/workFilesView.test.ts`；`tests/renderer/billingError.test.ts` → `tests/shared/billingError.test.ts`
- Modify: `src/renderer/src/store.ts:64`、`src/renderer/src/components/WorkspaceFilesTab.tsx:32`、`src/renderer/src/components/WorkspaceUsageTab.tsx:15`、`src/renderer/src/lib/gitHostsView.ts:5`

**Interfaces:**
- Consumes: 无（搬家）。
- Produces（后面的任务用这些路径，导出一个都不改）：
  - `src/shared/workspaceUsageView.ts`：`interface UsageRowView { agentId; name; avatar: FaceAvatar | null; percent: string; share: number; calls: number; tokens: string }`、`type UsageScale`、`workspaceTotalMicro(usage)`、`usageScale(usage)`、`usageRows(ws, usage)`、`interface UsageHeadlineView { percent: string | null; fill: number | null; calls: number }`、`usageHeadline(usage)`、`usageScaleNote(scale)`、`usageWindowText(usage)`、`usageEmptyText(route)`
  - `src/shared/workFilesView.ts`：`formatWorkSize(bytes)`、`formatWorkTime(mtimeMs, now)`、`workFolderNotice(node)`、`workFileNotice(node)`、`entryMeta(entry, now)`
  - `src/shared/billingError.ts`：`humanizeBillingError(raw: string): string`

- [ ] **Step 1: 搬文件（git mv 保住历史）**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git mv src/renderer/src/lib/workspaceUsageView.ts src/shared/workspaceUsageView.ts && git mv src/renderer/src/lib/workFilesView.ts src/shared/workFilesView.ts && git mv src/renderer/src/lib/billingError.ts src/shared/billingError.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git mv tests/renderer/workspaceUsageView.test.ts tests/shared/workspaceUsageView.test.ts && git mv tests/renderer/workFilesView.test.ts tests/shared/workFilesView.test.ts && git mv tests/renderer/billingError.test.ts tests/shared/billingError.test.ts
```

- [ ] **Step 2: 改三个搬过去的源文件的 import 与头注第一行**

`src/shared/workspaceUsageView.ts`：
- 第 1 行 `// workspaceUsageView —— 设置页「用量」页的纯逻辑（#946，spec §7；#1120 换掉了单位）。` 换成 `// workspaceUsageView —— 设置页「用量」页的纯逻辑（#946，spec §7；#1120 换掉了单位；#1356 A5 从渲染层挪进 shared，手机端的用量页用同一份）。`
- 第 22–27 行六条 import 里的 `"../../../shared/` 一律换成 `"./`（例：`import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";` → `import type { WorkspaceSnapshot } from "./workspaces.js";`；`"../../../shared/remote/cloudSession.js"` → `"./remote/cloudSession.js"`）。

`src/shared/workFilesView.ts`：
- 第 1 行 `// workFilesView —— 团队设置页「文件」tab 的纯逻辑（#1056）。` 换成 `// workFilesView —— 团队设置页「文件」tab 的纯逻辑（#1056；#1356 A5 从渲染层挪进 shared，手机端的文件那一页用同一份尺寸 / 时间的写法）。`
- 第 6 行 `import type { CsWorkEntry, CsWorkNode } from "../../../shared/remote/cloudSession.js";` → `import type { CsWorkEntry, CsWorkNode } from "./remote/cloudSession.js";`

`src/shared/billingError.ts`（没有 import）：
- 第 1 行 `// 订阅/加购/Portal 那几条路上的报错说给人听（issue #910）。` 换成 `// 订阅/加购/Portal 那几条路上的报错说给人听（issue #910；#1356 A5 从渲染层挪进 shared，手机端开支付页失败时用同一份）。`

- [ ] **Step 3: 改桌面四个消费方与三份测试的 import 路径**

- `src/renderer/src/store.ts` 第 64 行 `import { humanizeBillingError } from "./lib/billingError.js";` → `import { humanizeBillingError } from "../../shared/billingError.js";`
- `src/renderer/src/components/WorkspaceFilesTab.tsx` 第 32 行 `import { entryMeta, workFileNotice, workFolderNotice } from "../lib/workFilesView.js";` → `import { entryMeta, workFileNotice, workFolderNotice } from "../../../shared/workFilesView.js";`
- `src/renderer/src/components/WorkspaceUsageTab.tsx` 第 15 行 `} from "../lib/workspaceUsageView.js";` → `} from "../../../shared/workspaceUsageView.js";`
- `src/renderer/src/lib/gitHostsView.ts` 第 5 行 `import { formatWorkTime } from "./workFilesView.js";` → `import { formatWorkTime } from "../../../shared/workFilesView.js";`
- `tests/shared/workspaceUsageView.test.ts` 第 4 行 `} from "../../src/renderer/src/lib/workspaceUsageView.js";` → `} from "../../src/shared/workspaceUsageView.js";`
- `tests/shared/workFilesView.test.ts` 第 8 行 `} from "../../src/renderer/src/lib/workFilesView.js";` → `} from "../../src/shared/workFilesView.js";`
- `tests/shared/billingError.test.ts` 第 8 行 `import { humanizeBillingError } from "../../src/renderer/src/lib/billingError.js";` → `import { humanizeBillingError } from "../../src/shared/billingError.js";`

然后确认没有漏网的旧路径（应当零输出）：

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && grep -rn "lib/workspaceUsageView\|lib/workFilesView\|lib/billingError\|\./workFilesView\.js\|\./billingError\.js" src tests mobile/src
```

三份测试文件里其余的 import 本来就是 `../../src/shared/…` 这种（`tests/renderer` 与 `tests/shared` 同一深度），不用动；若 grep 看到它们还 import 了别的渲染层路径，照实改成新位置并在报告里说明。

- [ ] **Step 4: 跑这三份测试 + 根 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/workspaceUsageView.test.ts tests/shared/workFilesView.test.ts tests/shared/billingError.test.ts && npx tsc --noEmit
```

Expected: 三个文件全 PASS（用例数与搬家前相同），tsc 零输出。

- [ ] **Step 5: 提交**

message（写进 `.superpowers/commit-msg.txt`）：

```
refactor: 用量页、文件页、订阅报错三份纯逻辑挪进 shared（#1356 A5）

手机的账号页要用同一份：这周各智能体用了多少（每一行、页顶那一格、分母是什么）、
文件的大小与时间怎么写、开支付页失败时那句话。三份的 import 本来就全指向 src/shared，
只挪不改断言，桌面四处改 import，不留转发壳（spec §9）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add src/renderer/src/store.ts src/renderer/src/components/WorkspaceFilesTab.tsx src/renderer/src/components/WorkspaceUsageTab.tsx src/renderer/src/lib/gitHostsView.ts src/shared/workspaceUsageView.ts src/shared/workFilesView.ts src/shared/billingError.ts tests/shared/workspaceUsageView.test.ts tests/shared/workFilesView.test.ts tests/shared/billingError.test.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 2: `mobileAccount.ts`——账号页、订阅页、外观的判据

账号页那几格（名字、首字、档位、两扇窗、订阅那一行）、订阅页（几张档位卡、每颗钮去哪儿、几句话、开支付页失败时说什么）、外观偏好（存下来的那一格怎么读、交给 RN 的是什么）。全是纯函数，屏只画。另外把 `mobileCall.joinBlockedText` 里没订阅 / 扣款没成功那两句改成指去「账号 → 订阅」——A4 写它时手机上还没有订阅页（spec §10 第 78 条的原话「不指去哪儿续」），这一片有了。

**Files:**
- Create: `src/shared/mobileAccount.ts`
- Create: `tests/shared/mobileAccount.test.ts`
- Modify: `src/shared/mobileCall.ts:99-113`、`tests/shared/mobileCall.test.ts:148,152`

**Interfaces:**
- Consumes: `src/shared/billing.ts`（`BillingMe`、`PlanId`、`WindowState`、`parseBillingError`）、`src/shared/billingError.ts`（Task 1 的 `humanizeBillingError`）、`src/shared/billingView.ts`（`countdown`、`fmtRemainingPercent`、`liveWindow`、`PLAN_BADGE_LABEL`、`planBadge`、`planCards`、`planName`、`periodLine`、`quotaTone`、`remainingPercent`、`WINDOW_LABELS`、`windowPercent`、`type PlanBadgeId`）、`src/shared/shellBridge.ts`（`BillingSnapshotView`）。
- Produces（Task 3 / 4 / 5 / 9 用）：
  - `accountName(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined): string`
  - `accountInitial(name: string): string`
  - `accountBadge(billing: BillingSnapshotView | null): { id: PlanBadgeId; label: string } | null`
  - `type QuotaToneView = "neutral" | "warn" | "deny"`、`quotaToneView(usedPercent: number): QuotaToneView`
  - `interface QuotaWindowView { key: "h5" | "week"; label: string; remaining: string; fill: number; tone: QuotaToneView; refresh: string }`
  - `type AccountQuota = { kind: "loading" } | { kind: "none"; text: string } | { kind: "windows"; windows: readonly [QuotaWindowView, QuotaWindowView] }`、`accountQuota(billing, now): AccountQuota`
  - `subscriptionValue(billing: BillingSnapshotView | null): string | null`
  - `holdsSubscription(me: BillingMe): boolean`
  - `type PlanOfferAction = { kind: "checkout"; planId: PlanId; label: string } | { kind: "portal"; label: string }`
  - `interface PlanOfferView { key: PlanId | "free"; name: string; price: string; lines: readonly { text: string; ok: boolean }[]; current: boolean; free: boolean; action: PlanOfferAction | null }`、`planOffers(me: BillingMe): PlanOfferView[]`
  - `interface SubscriptionNotes { pastDue: string | null; period: string | null; canManage: boolean }`、`subscriptionNotes(me: BillingMe): SubscriptionNotes`
  - `SUBSCRIPTION_FOOTER: string`、`ACCOUNT_FOOTER: string`
  - `billingChanged(before: BillingMe | null, after: BillingMe | null): boolean`
  - `billingLinkUrl(payload: unknown): string | null`、`billingLinkError(status: number, payload: unknown): string`、`billingLinkThrown(message: string): string`
  - `type ThemePref = "system" | "light" | "dark"`、`THEME_PREFS: readonly { key: ThemePref; label: string }[]`、`parseThemePref(raw: string | null): ThemePref`、`colorSchemeOf(pref: ThemePref): "light" | "dark" | "unspecified"`

- [ ] **Step 1: 写失败的测试**

`tests/shared/mobileAccount.test.ts`：

```ts
// mobileAccount 的用例（#1356 A5）。时间一律从 NOW 往后推，不碰本机时区（倒计时只看差值）
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import { periodLine } from "../../src/shared/billingView.js";
import {
  ACCOUNT_FOOTER, SUBSCRIPTION_FOOTER, THEME_PREFS, accountBadge, accountInitial, accountName, accountQuota,
  billingChanged, billingLinkError, billingLinkThrown, billingLinkUrl, colorSchemeOf, holdsSubscription,
  parseThemePref, planOffers, quotaToneView, subscriptionNotes, subscriptionValue,
} from "../../src/shared/mobileAccount.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";

const NOW = 1_800_000_000_000;

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro",
  status: "active",
  plans: [
    { id: "lite", priceUsdCents: 500, capabilities: { image: false, video: false, workspace: false } },
    { id: "pro", priceUsdCents: 2000, capabilities: { image: true, video: false, workspace: true } },
    { id: "max", priceUsdCents: 20000, capabilities: { image: true, video: false, workspace: true } },
  ],
  windows: {
    h5: { usedMicro: 368_000, limitMicro: 1_000_000, resetAt: NOW + 98 * 60_000 },
    week: { usedMicro: 83_000, limitMicro: 1_000_000, resetAt: NOW + 4 * 86_400_000 },
  },
  addon: { remainingMicro: 0, expiresAt: null },
  periodEnd: null,
  models: [],
  imageModels: [],
  ttsModels: [],
  modelPlatforms: {},
  ...over,
});
const snap = (m: BillingMe | null): BillingSnapshotView => ({ me: m, fetchedAt: NOW, exhausted: null });

describe("accountName / accountInitial", () => {
  it("名字先取 user_metadata 的 name，再 full_name，最后邮箱", () => {
    expect(accountName({ email: "s@x.com", user_metadata: { name: " Stan ", full_name: "Stan Yan" } })).toBe("Stan");
    expect(accountName({ email: "s@x.com", user_metadata: { full_name: "Stan Yan" } })).toBe("Stan Yan");
    expect(accountName({ email: "s@x.com", user_metadata: {} })).toBe("s@x.com");
    expect(accountName({ email: null, user_metadata: { name: 42 } })).toBe("");
    expect(accountName(null)).toBe("");
  });
  it("首字：大写；中文照原样；emoji 不劈开；空的时候一个中点", () => {
    expect(accountInitial("stan")).toBe("S");
    expect(accountInitial("小红")).toBe("小");
    expect(accountInitial("\u{1F600}x")).toBe("\u{1F600}");
    expect(accountInitial("  ")).toBe("·");
  });
});

describe("accountBadge", () => {
  it("还没查到一格都不画（不退成 Free，ADR-0240）", () => {
    expect(accountBadge(null)).toBeNull();
    expect(accountBadge(snap(null))).toBeNull();
  });
  it("活跃 / 扣款没成功报原来的档；退订过、没订阅是 Free", () => {
    expect(accountBadge(snap(me()))).toEqual({ id: "pro", label: "Pro" });
    expect(accountBadge(snap(me({ status: "past_due" })))).toEqual({ id: "pro", label: "Pro" });
    expect(accountBadge(snap(me({ status: "canceled" })))).toEqual({ id: "free", label: "Free" });
    expect(accountBadge(snap(me({ plan: null, status: "none" })))).toEqual({ id: "free", label: "Free" });
  });
});

describe("accountQuota", () => {
  it("还没查到 = loading", () => {
    expect(accountQuota(null, NOW)).toEqual({ kind: "loading" });
    expect(accountQuota(snap(null), NOW)).toEqual({ kind: "loading" });
  });
  it("两扇窗：还剩百分之几、按剩余填、窗名与倒计时用桌面那一份", () => {
    const q = accountQuota(snap(me()), NOW);
    expect(q.kind).toBe("windows");
    if (q.kind !== "windows") return;
    const [h5, week] = q.windows;
    expect(h5).toEqual({ key: "h5", label: "5h", remaining: "63.2%", fill: expect.closeTo(0.632, 5) as unknown as number, tone: "neutral", refresh: "1h 38m 后刷新" });
    expect(week).toMatchObject({ key: "week", label: "本周", remaining: "91.7%", tone: "neutral", refresh: "4d 后刷新" });
  });
  it("色档按已用判：>75 warn、>90 deny，充足是 neutral", () => {
    const warn = accountQuota(snap(me({ windows: { h5: { usedMicro: 800_000, limitMicro: 1_000_000, resetAt: NOW + 60_000 * 90 }, week: { usedMicro: 0, limitMicro: 1_000_000, resetAt: NOW + 86_400_000 } } })), NOW);
    expect(warn.kind === "windows" && warn.windows[0]).toMatchObject({ remaining: "20.0%", tone: "warn" });
    const deny = accountQuota(snap(me({ windows: { h5: { usedMicro: 950_000, limitMicro: 1_000_000, resetAt: NOW + 60_000 * 90 }, week: { usedMicro: 0, limitMicro: 1_000_000, resetAt: NOW + 86_400_000 } } })), NOW);
    expect(deny.kind === "windows" && deny.windows[0]).toMatchObject({ remaining: "5.0%", tone: "deny" });
  });
  it("过了 resetAt 的窗按清零画（快照不会自己到点过期）", () => {
    const q = accountQuota(snap(me({ windows: { h5: { usedMicro: 900_000, limitMicro: 1_000_000, resetAt: NOW - 1 }, week: { usedMicro: 0, limitMicro: 1_000_000, resetAt: NOW + 86_400_000 } } })), NOW);
    expect(q.kind === "windows" && q.windows[0]).toMatchObject({ remaining: "100.0%", fill: 1, tone: "neutral", refresh: "已刷新" });
  });
  it("没有窗时两句话分开说：扣款没成功去更新付款方式，没订阅去挑一档", () => {
    const pastDue = accountQuota(snap(me({ status: "past_due", windows: null })), NOW);
    expect(pastDue).toEqual({ kind: "none", text: "这个账号的订阅扣款没成功，额度先停了。去「订阅」里更新付款方式就恢复。" });
    const none = accountQuota(snap(me({ plan: null, status: "none", windows: null })), NOW);
    expect(none).toEqual({ kind: "none", text: "没有订阅，也就没有云端额度——智能体接不了活。去「订阅」里挑一档。" });
  });
  it("quotaToneView 与 quotaTone 同一组阈值", () => {
    expect(quotaToneView(75)).toBe("neutral");
    expect(quotaToneView(76)).toBe("warn");
    expect(quotaToneView(91)).toBe("deny");
  });
});

describe("subscriptionValue", () => {
  it("还没查到不写字；活跃写档名；扣款没成功带一句；其余写没有订阅", () => {
    expect(subscriptionValue(null)).toBeNull();
    expect(subscriptionValue(snap(me()))).toBe("Pro");
    expect(subscriptionValue(snap(me({ status: "past_due" })))).toBe("Pro · 扣款没成功");
    expect(subscriptionValue(snap(me({ status: "canceled" })))).toBe("没有订阅");
    expect(subscriptionValue(snap(me({ plan: null, status: "none" })))).toBe("没有订阅");
  });
});

describe("planOffers", () => {
  it("订着 Pro：只列带智能体的档（贵的在上）+ Free；换档走 Portal", () => {
    const offers = planOffers(me());
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "free"]);
    const [max, pro, free] = offers;
    expect(max).toMatchObject({ name: "Max", price: "$200 / 月", current: false, free: false, action: { kind: "portal", label: "换到 Max" } });
    expect(pro).toMatchObject({ current: true, action: null });
    expect(pro?.lines.every((l) => l.ok)).toBe(true);
    expect(free).toMatchObject({ key: "free", price: "$0", current: false, free: true, action: null });
  });
  it("退订过 / 没订阅：Free 是这一档，其余走 checkout", () => {
    const offers = planOffers(me({ status: "canceled" }));
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "free"]);
    expect(offers[0]?.action).toEqual({ kind: "checkout", planId: "max", label: "订阅 Max" });
    expect(offers[2]).toMatchObject({ current: true });
  });
  it("订着一档不带智能体的（Lite）：它也列出来、标明用不上，别的档走 Portal", () => {
    const offers = planOffers(me({ plan: "lite" }));
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "lite", "free"]);
    const lite = offers[2];
    expect(lite).toMatchObject({ current: true, action: null });
    expect(lite?.lines).toEqual([{ text: "不带智能体——这个 App 里用不上", ok: false }]);
    expect(offers[1]?.action).toEqual({ kind: "portal", label: "换到 Pro" });
  });
  it("服务端没给价的档整张不画；价格不是整数时写两位小数", () => {
    const offers = planOffers(me({ plans: [{ id: "pro", priceUsdCents: 1999, capabilities: { image: false, video: false, workspace: true } }] }));
    expect(offers.map((o) => o.key)).toEqual(["pro", "free"]);
    expect(offers[0]?.price).toBe("$19.99 / 月");
  });
  it("holdsSubscription：活跃与扣款没成功算在跑，退订过不算", () => {
    expect(holdsSubscription(me())).toBe(true);
    expect(holdsSubscription(me({ status: "past_due" }))).toBe(true);
    expect(holdsSubscription(me({ status: "canceled" }))).toBe(false);
    expect(holdsSubscription(me({ plan: null, status: "none" }))).toBe(false);
  });
});

describe("subscriptionNotes", () => {
  it("扣款没成功那一句只在 past_due 时有", () => {
    expect(subscriptionNotes(me({ status: "past_due" })).pastDue).toBe("这个账号的订阅扣款没成功，额度先停了。更新付款方式之后就恢复。");
    expect(subscriptionNotes(me()).pastDue).toBeNull();
  });
  it("扣款日期那一句用桌面那一份 periodLine", () => {
    const m = me({ periodEnd: NOW + 10 * 86_400_000 });
    expect(subscriptionNotes(m).period).toBe(periodLine(m));
    expect(subscriptionNotes(me()).period).toBeNull();
  });
  it("管理订阅：订过（status ≠ none）才画", () => {
    expect(subscriptionNotes(me({ plan: null, status: "none" })).canManage).toBe(false);
    expect(subscriptionNotes(me({ status: "canceled" })).canManage).toBe(true);
    expect(subscriptionNotes(me()).canManage).toBe(true);
  });
  it("两句固定话", () => {
    expect(SUBSCRIPTION_FOOTER).toBe("降档之后，已经建好的智能体都还在。几档的区别在额度：越往上，5h 与本周那两扇窗越宽。");
    expect(ACCOUNT_FOOTER).toBe("退出只影响这台手机；它们在云端手上的活不会停。");
  });
});

describe("billingChanged", () => {
  it("档位 / 状态 / 扣款日有一样变了就算变了", () => {
    expect(billingChanged(me(), me())).toBe(false);
    expect(billingChanged(me(), me({ plan: "max" }))).toBe(true);
    expect(billingChanged(me({ status: "canceled" }), me())).toBe(true);
    expect(billingChanged(me(), me({ periodEnd: NOW }))).toBe(true);
    expect(billingChanged(null, me())).toBe(true);
    expect(billingChanged(null, null)).toBe(false);
  });
});

describe("billingLinkUrl / billingLinkError / billingLinkThrown", () => {
  it("只认 https 的地址", () => {
    expect(billingLinkUrl({ url: "https://checkout.stripe.com/c/pay/x" })).toBe("https://checkout.stripe.com/c/pay/x");
    expect(billingLinkUrl({ url: "http://evil.example" })).toBeNull();
    expect(billingLinkUrl({})).toBeNull();
    expect(billingLinkUrl(null)).toBeNull();
    expect(billingLinkUrl("https://x")).toBeNull();
  });
  it("已有订阅按错误码认（网关那句中文原文 humanizeBillingError 认不出）", () => {
    const text = billingLinkError(409, { error: { type: "otto_edge", code: "already_subscribed", message: "已有订阅，换档请走「管理」" } });
    expect(text).toBe("你已经有一份订阅了。换档点下面的「管理订阅 · 发票」，别在这里重开一张——重开会变成两条订阅、两笔一起扣。");
  });
  it("别的错交给 humanizeBillingError：认得出的翻，认不出的原样", () => {
    expect(billingLinkError(502, { error: { type: "otto_edge", code: "upstream", message: "这个档位还没配 Stripe price" } })).toBe("这个档位还没配 Stripe price");
    expect(billingLinkError(502, { error: { type: "otto_edge", code: "upstream", message: "Invalid line_items[0]: the product tax code is missing" } })).toMatch(/^支付页开不起来/);
    expect(billingLinkError(500, null)).toBe("HTTP 500");
  });
  it("请求没发出去（RN 断网时的原话）说成连不上", () => {
    expect(billingLinkThrown("Network request failed")).toMatch(/连不上支付服务/);
  });
});

describe("外观偏好", () => {
  it("存下来的那一格：认不出的一律跟随系统", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref("sepia")).toBe("system");
  });
  it("交给 Appearance.setColorScheme 的值：跟随系统 = unspecified", () => {
    expect(colorSchemeOf("system")).toBe("unspecified");
    expect(colorSchemeOf("light")).toBe("light");
    expect(colorSchemeOf("dark")).toBe("dark");
  });
  it("三档与它们的名字", () => {
    expect(THEME_PREFS).toEqual([
      { key: "system", label: "跟随系统" },
      { key: "light", label: "浅色" },
      { key: "dark", label: "深色" },
    ]);
  });
});
```

注意 `expect.closeTo(0.632, 5) as unknown as number` 是为了在 `toEqual` 里给 `fill` 一个近似匹配（`remainingPercent` 是一位小数向下取整，`63.2 / 100` 在浮点上不一定逐位等于 `0.632`）。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/mobileAccount.test.ts
```

Expected: FAIL（`Cannot find module '../../src/shared/mobileAccount.js'` 或同义）。

- [ ] **Step 3: 写实现**

`src/shared/mobileAccount.ts`：

```ts
// mobileAccount —— 手机账号页 / 订阅页 / 外观那几格的判据（#1356 A5，spec §5.8）。纯逻辑，屏只画。
//
// 三条纪律（spec §6）：
// · 还没查到 ≠ 没有：billing 为 null 时徽章、两扇窗、订阅那一格一个结论都不下（ADR-0240）；
// · 说不清就不画钮：订阅页每一颗钮都有真去处——没订阅走 checkout，订着的人换档只走 Portal
//   （ADR-0203 决定 18：已有订阅的人再开一张 checkout = 第二条订阅、两笔一起扣，网关回 409）；
// · 窗名与倒计时用桌面那一份（WINDOW_LABELS「5h / 本周」、countdown「1h 38m 后刷新」）：同一扇窗在几块
//   屏幕上不能有两种叫法（#1229），所以不照 demo 的「5 小时窗 / 1 小时 38 分后刷新」。
// 文案不出现「水獭」：桌面价目卡那句 blurb（PLAN_CARDS）手机上不用，档位卡上的话从服务端下发的能力推。

import { parseBillingError, type BillingMe, type PlanId, type WindowState } from "./billing.js";
import { humanizeBillingError } from "./billingError.js";
import {
  countdown, fmtRemainingPercent, liveWindow, PLAN_BADGE_LABEL, periodLine, planBadge, planCards, planName,
  quotaTone, remainingPercent, WINDOW_LABELS, windowPercent, type PlanBadgeId,
} from "./billingView.js";
import type { BillingSnapshotView } from "./shellBridge.js";

// ── 账号是谁 ──

/** 名字先取 OAuth 带来的 user_metadata（name / full_name），没有就用邮箱（原 AccountButton 的取法） */
export function accountName(
  user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined,
): string {
  const meta = user?.user_metadata ?? {};
  const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return pick(meta["name"]) || pick(meta["full_name"]) || (user?.email ?? "").trim();
}

/** 头像圆里那个字：名字（或邮箱）的第一个字，大写；按码点取，不把 emoji 劈成半个；什么都没有时一个中点 */
export function accountInitial(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "·" : first.toUpperCase();
}

/** 名字右边那枚档位。null = 还没查到，一格都不画（ADR-0240：并进 Free 就是对着付钱的人说他没订阅） */
export function accountBadge(billing: BillingSnapshotView | null): { id: PlanBadgeId; label: string } | null {
  const id = planBadge(billing?.me ?? null);
  return id === null ? null : { id, label: PLAN_BADGE_LABEL[id] };
}

// ── 两扇窗 ──

export type QuotaToneView = "neutral" | "warn" | "deny";

/** 色档按**已用**百分比判（quotaTone，与桌面同一组阈值）；充足 = neutral——颜色只用来说「出事了」（ADR-0239） */
export function quotaToneView(usedPercent: number): QuotaToneView {
  const tone = quotaTone(usedPercent);
  return tone === "brand" ? "neutral" : tone;
}

export interface QuotaWindowView {
  key: "h5" | "week";
  label: string;
  /** 「63.2%」——还剩百分之几（一位小数、向下取整，ADR-0239）；「可用」两个字由界面配 */
  remaining: string;
  /** 条按**剩余**填（闲着时是满的），0..1 */
  fill: number;
  tone: QuotaToneView;
  /** 「1h 38m 后刷新」/「4d 后刷新」/「已刷新」（桌面那一份 countdown） */
  refresh: string;
}

export type AccountQuota =
  | { kind: "loading" }
  | { kind: "none"; text: string }
  | { kind: "windows"; windows: readonly [QuotaWindowView, QuotaWindowView] };

export function accountQuota(billing: BillingSnapshotView | null, now: number): AccountQuota {
  const me = billing?.me ?? null;
  if (me === null) return { kind: "loading" };
  if (me.windows === null) return { kind: "none", text: noQuotaText(me) };
  return { kind: "windows", windows: [windowView("h5", me.windows.h5, now), windowView("week", me.windows.week, now)] };
}

function windowView(key: "h5" | "week", w: WindowState, now: number): QuotaWindowView {
  // 过了 resetAt 的窗按清零画：这份快照不会自己到点过期（同桌面 liveWindow 的纪律）
  const live = liveWindow(w, now);
  return {
    key,
    label: WINDOW_LABELS[key],
    remaining: fmtRemainingPercent(live),
    fill: Math.min(1, Math.max(0, remainingPercent(live) / 100)),
    tone: quotaToneView(windowPercent(live)),
    refresh: countdown(w.resetAt, now),
  };
}

/** 两扇窗画不出来时那一句。窗只在订阅活跃时才下发——扣款没成功与没订阅都没有窗，但两句话该做的事相反：
    前者去更新付款方式，后者去挑一档（ADR-0240：past_due 不是没订阅） */
function noQuotaText(me: BillingMe): string {
  if (me.status === "past_due") return "这个账号的订阅扣款没成功，额度先停了。去「订阅」里更新付款方式就恢复。";
  return "没有订阅，也就没有云端额度——智能体接不了活。去「订阅」里挑一档。";
}

/** 账号页「订阅」那一行右边写什么。null = 还没查到（不写字，更不写「没有订阅」） */
export function subscriptionValue(billing: BillingSnapshotView | null): string | null {
  const me = billing?.me ?? null;
  if (me === null) return null;
  const name = planName(me.plan);
  if (name !== null && me.status === "active") return name;
  if (name !== null && me.status === "past_due") return `${name} · 扣款没成功`;
  return "没有订阅";
}

// ── 订阅页 ──

/** 此刻有没有一份在跑的订阅（活跃或扣款没成功）。**在跑的**不许再开 checkout（ADR-0203 决定 18，网关对
    status ≠ canceled 回 409），换档一律走 Portal；canceled 算没有，网关放行重新订 */
export function holdsSubscription(me: BillingMe): boolean {
  return me.plan !== null && (me.status === "active" || me.status === "past_due");
}

export type PlanOfferAction =
  | { kind: "checkout"; planId: PlanId; label: string }
  | { kind: "portal"; label: string };

export interface PlanOfferView {
  key: PlanId | "free";
  name: string;
  /** 「$20 / 月」；Free 写「$0」 */
  price: string;
  /** 卡上那几行。ok = 这一档带这件事（画勾），否则画一道弱色的横 */
  lines: readonly { text: string; ok: boolean }[];
  current: boolean;
  /** Free 不是价目表里的一行，是「没有订阅」这个状态本身的名字（ADR-0239 决定 3）：虚线、没有主钮 */
  free: boolean;
  action: PlanOfferAction | null;
}

const AGENT_LINES: readonly { text: string; ok: boolean }[] = [
  { text: "建得了智能体，它们在云端的电脑上干活", ok: true },
  { text: "群聊、互相接力、语音通话", ok: true },
];
const NO_AGENT_LINES: readonly { text: string; ok: boolean }[] = [{ text: "不带智能体——这个 App 里用不上", ok: false }];
const FREE_LINES: readonly { text: string; ok: boolean }[] = [{ text: "没有云端额度，智能体接不了活", ok: false }];

/** 订阅页那几张卡：**只列这个 App 用得上的档**（服务端下发的 capabilities.workspace 为真；判据不写死档位名，
    同 ADR-0242），外加此刻订着的那一档（订着 Lite 的人得看得见自己在哪），最后一张 Free。从贵到便宜排（demo 的
    顺序：最能干的在最上面）；价格缺了的档整张不画（planCards 的纪律）。卡上的话从能力推，不照抄 demo 那几行
    （「最多 3 只」「一直开着」都不是事实） */
export function planOffers(me: BillingMe): PlanOfferView[] {
  const holding = holdsSubscription(me);
  const caps = new Map(me.plans.map((p) => [p.id, p.capabilities] as const));
  const shown = planCards(me.plans).filter((c) => caps.get(c.id)?.workspace === true || (holding && c.id === me.plan));
  const offers = [...shown].reverse().map((c): PlanOfferView => {
    const current = holding && c.id === me.plan;
    return {
      key: c.id,
      name: c.name,
      price: priceText(c.priceUsd),
      lines: caps.get(c.id)?.workspace === true ? AGENT_LINES : NO_AGENT_LINES,
      current,
      free: false,
      action: current
        ? null
        : holding
          ? { kind: "portal", label: `换到 ${c.name}` }
          : { kind: "checkout", planId: c.id, label: `订阅 ${c.name}` },
    };
  });
  offers.push({ key: "free", name: "Free", price: "$0", lines: FREE_LINES, current: !holding, free: true, action: null });
  return offers;
}

function priceText(usd: number): string {
  return `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)} / 月`;
}

export interface SubscriptionNotes {
  /** 扣款没成功那一句（配一颗「更新付款方式」，走 Portal）；没出事 = null */
  pastDue: string | null;
  /** 「下次扣款 9月30日」/「9月30日 到期」/「服务到 9月30日 为止」（桌面那一份 periodLine） */
  period: string | null;
  /** 「管理订阅 · 发票」画不画：订过（status ≠ none）才有 Stripe 客户可开 Portal——从没订过的人点下去必然失败 */
  canManage: boolean;
}

export function subscriptionNotes(me: BillingMe): SubscriptionNotes {
  return {
    pastDue: me.status === "past_due" ? "这个账号的订阅扣款没成功，额度先停了。更新付款方式之后就恢复。" : null,
    period: periodLine(me),
    canManage: me.status !== "none",
  };
}

export const SUBSCRIPTION_FOOTER = "降档之后，已经建好的智能体都还在。几档的区别在额度：越往上，5h 与本周那两扇窗越宽。";

/** 从 Stripe 回来之后，订阅变了没有。人点「完成」那一刻 webhook 可能还没落库——没变就再等一会儿再拉（几次封顶） */
export function billingChanged(before: BillingMe | null, after: BillingMe | null): boolean {
  if (before === null || after === null) return before !== after;
  return before.plan !== after.plan || before.status !== after.status || before.periodEnd !== after.periodEnd;
}

/** checkout / portal 回的那个地址：只认 https（它就是 Stripe 的页面；别的形状不往浏览器里送） */
export function billingLinkUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const url = (payload as { url?: unknown }).url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

const ALREADY_SUBSCRIBED = "你已经有一份订阅了。换档点下面的「管理订阅 · 发票」，别在这里重开一张——重开会变成两条订阅、两笔一起扣。";

/** 开支付页那一步失败时说什么。已有订阅（409）按错误码认，不按原文认——网关那句中文原文 humanizeBillingError
    认不出；其余交给 humanizeBillingError（只翻认得出的，认不出的原样留，#910） */
export function billingLinkError(status: number, payload: unknown): string {
  const e = parseBillingError(status, payload);
  if (e?.code === "already_subscribed") return ALREADY_SUBSCRIBED;
  const raw = e?.message ?? "";
  return humanizeBillingError(raw === "" ? `HTTP ${status}` : raw);
}

/** 请求本身没发出去 / 浏览器没开起来（RN 的 fetch 断网时抛 "Network request failed"） */
export function billingLinkThrown(message: string): string {
  return humanizeBillingError(message);
}

// ── 账号页的固定话 ──

/** 退出那一组的组尾。demo 写「会把这台手机上的缓存清掉」——登出只清 supabase 的 session 与名册那一份，说不上
    「缓存」；照实说它影响什么、不影响什么 */
export const ACCOUNT_FOOTER = "退出只影响这台手机；它们在云端手上的活不会停。";

// ── 外观 ──

export type ThemePref = "system" | "light" | "dark";

export const THEME_PREFS: readonly { key: ThemePref; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

/** 存下来的那一格读回来：认不出的一律当跟随系统（旧版本 / 手改过的值不该把界面卡在某一种颜色上） */
export function parseThemePref(raw: string | null): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** 交给 RN `Appearance.setColorScheme` 的那个值（'unspecified' = 回到跟随系统） */
export function colorSchemeOf(pref: ThemePref): "light" | "dark" | "unspecified" {
  return pref === "system" ? "unspecified" : pref;
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/mobileAccount.test.ts
```

Expected: PASS。若 `fill` 那一条的 `expect.closeTo` 写法在这版 vitest 里过不了类型或断言，改成先 `toMatchObject` 其余字段、再单独 `expect(h5.fill).toBeCloseTo(0.632, 5)`，在报告里说明。

- [ ] **Step 5: 「接着听」那一格的两句指去「账号 → 订阅」**

`src/shared/mobileCall.ts`：
- 第 99–103 行那段头注（从 `/** 这台此刻为什么接不了` 到 `额度用完 / 网关不供语音两句照 ttsBlocked 说 */`）里「手机上 A5 之前没有 账号页，所以不指去哪儿续。没订阅那句不照抄桌面（桌面那句指「设置 → 订阅」，手机上没有那一页）；」这一截（跨行，按源文件原样定位）换成「A5 起手机上有了订阅页，两句都指去「账号 → 订阅」（桌面那句指「设置 → 订阅」，手机上的路不一样）；」。
- 第 110 行 `if (o.billing.me?.status === "past_due") return "这个账号的订阅扣款没成功，续上之后才打得了电话。";` → `if (o.billing.me?.status === "past_due") return "这个账号的订阅扣款没成功：去「账号 → 订阅」更新付款方式，续上之后才打得了电话。";`
- 第 112 行 `if (hosted === undefined || !hosted.subscribed) return "订阅 Pro 或 Max 之后才打得了电话。";` → `if (hosted === undefined || !hosted.subscribed) return "订阅 Pro 或 Max 之后才打得了电话（「账号 → 订阅」）。";`

`tests/shared/mobileCall.test.ts`：
- 第 148 行 `expect(text).toBe("这个账号的订阅扣款没成功，续上之后才打得了电话。");` → `expect(text).toBe("这个账号的订阅扣款没成功：去「账号 → 订阅」更新付款方式，续上之后才打得了电话。");`
- 第 152 行 `expect(none).toBe("订阅 Pro 或 Max 之后才打得了电话。");` → `expect(none).toBe("订阅 Pro 或 Max 之后才打得了电话（「账号 → 订阅」）。");`

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/mobileCall.test.ts tests/shared/mobileAccount.test.ts && npx tsc --noEmit
```

Expected: PASS，tsc 零输出。

- [ ] **Step 6: 提交**

```
feat(shared): 手机账号页与订阅页的判据（#1356 A5）

账号页：名字与首字、档位（还没查到一格都不画，ADR-0240）、两扇窗报还剩百分之几（窗名与倒计时用
桌面那一份，#1229）、订阅那一行写什么。订阅页：只列这个 App 用得上的档（capabilities.workspace
为真）+ 此刻订着的那一档 + Free；没订阅走 checkout，订着的人换档只走 Portal（ADR-0203 决定 18）；
开支付页失败时 409 按错误码认、其余交给 humanizeBillingError。外观偏好的读法也放这里。

电话那一格没订阅 / 扣款没成功两句改成指去「账号 → 订阅」：A4 写它时手机上还没有订阅页。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add src/shared/mobileAccount.ts tests/shared/mobileAccount.test.ts src/shared/mobileCall.ts tests/shared/mobileCall.test.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 3: `mobileMachine.ts`——那台电脑、文件、应用、记忆、用量页的判据

「它们的电脑」那几屏要说的每一句话、每一格数字从哪来。另外两处小改：`workFilesView.ts` 加 `parseFileQuery`（`?` 开头按内容搜——桌面那一页原来写在组件的 effect 里，手机要同一个约定，就抬进 shared、桌面改调它，行为不变）；`workspaceView.ts` 的 `toolsSummary` 导出（应用清单的第二行与桌面同一句）。

**Files:**
- Modify: `src/shared/workFilesView.ts`（加 `parseFileQuery`）、`tests/shared/workFilesView.test.ts`（加用例）
- Modify: `src/shared/workspaceView.ts:55-57`（`function toolsSummary` → `export function toolsSummary`）
- Modify: `src/renderer/src/components/WorkspaceFilesTab.tsx`（搜索 effect 改调 `parseFileQuery`）
- Create: `src/shared/mobileMachine.ts`
- Create: `tests/shared/mobileMachine.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `workFilesView`（`entryMeta`、`formatWorkSize`）、`workspaceUsageView`（`usageHeadline`、`usageWindowText`、`workspaceTotalMicro`、`type UsageScale`）；Task 2 的 `quotaToneView`、`type QuotaToneView`；`src/shared/wiki.ts`（`extractWikiLinks`、`parseIndex`、`parseWikiPage`、`validateWikiFields`、`WIKI_AGENTS_DIR`、`type WikiIndexEntry`、`type WikiIndexGroup`、`type WikiPage`）；`src/shared/mobileRoster.ts`（`rosterTimeLabel`）；`src/shared/remote/workPath.ts`（`joinWorkPath`）；`src/shared/billingView.ts`（`fmtRemainingPercent`、`liveWindow`、`usedPercentOf`）。
- Produces（Task 4 / 6 / 7 / 8 / 9 用）：
  - `src/shared/workFilesView.ts`：`parseFileQuery(query: string): { term: string; content: boolean } | null`
  - `src/shared/workspaceView.ts`：`toolsSummary(tools: readonly string[]): string`
  - `src/shared/mobileMachine.ts`：
    - `machineShareText(ws: WorkspaceSnapshot): string`、`MACHINE_FOOTER`
    - `type WikiIndexState = { kind: "loading" } | { kind: "absent" } | { kind: "ok"; groups: WikiIndexGroup[] } | { kind: "error"; message: string; groups: WikiIndexGroup[] | null }`
    - `type UsageLoad = { kind: "loading" } | { kind: "ok"; usage: WorkspaceUsage } | { kind: "error"; message: string; usage: WorkspaceUsage | null }`
    - `interface MachineRowView { key: "files" | "apps" | "wiki" | "usage"; title: string; detail: string; value: string | null }`、`machineRows(o: { apps: number; wiki: WikiIndexState; usage: UsageLoad }): MachineRowView[]`
    - `wikiIndexFrom(node: CsWorkNode): WikiIndexState`、`wikiIndexAfterError(prev: WikiIndexState, message: string): WikiIndexState`、`wikiGroupsOf(s: WikiIndexState): WikiIndexGroup[] | null`、`wikiPageCount(groups): number`、`wikiGroupTitle(name: string): string`
    - `WIKI_FOOTER`、`WIKI_EMPTY`、`WIKI_ABSENT`
    - `type WikiPageLoad = { ok: true; page: WikiPage } | { ok: false; message: string }`、`wikiPageFrom(path: string, node: CsWorkNode): WikiPageLoad`、`wikiMetaLine(page: WikiPage, now: number): string`、`wikiLinkRows(page: WikiPage, groups: readonly WikiIndexGroup[]): WikiIndexEntry[]`、`wikiMatches(groups: readonly WikiIndexGroup[], query: string, limit?: number): WikiIndexEntry[]`、`wikiEditError(f: { title: string; summary: string; pinned: boolean; sources: readonly string[] }): string | null`
    - `type WorkIcon = "folder" | "image" | "file"`、`workIcon(name: string, kind: CsWorkEntry["kind"]): WorkIcon`
    - `interface WorkEntryRowView { key: string; path: string; name: string; icon: WorkIcon; meta: string; opens: "dir" | "file" | null }`、`workEntryRows(dir: string, entries: readonly CsWorkEntry[], now: number): WorkEntryRowView[]`
    - `workFolderText(node: CsWorkNode): string | null`、`workFolderTruncated(node: CsWorkNode): string | null`、`workFileText(node: CsWorkNode): string | null`、`baseName(path: string): string`
    - `interface WorkHitRowView { key: string; path: string; title: string; detail: string; icon: WorkIcon }`、`workHitRows(hits: readonly CsWorkHit[]): WorkHitRowView[]`
    - `FILES_FOOTER`、`FILES_SEARCH_PLACEHOLDER`
    - `interface AppRowView { key: string; title: string; detail: string }`、`appRows(ws: WorkspaceSnapshot): AppRowView[]`、`APPS_EMPTY`、`APPS_FOOTER`
    - `USAGE_EMPTY`、`usageHeroText(usage: WorkspaceUsage, billing: BillingSnapshotView | null, now: number): string`、`usageTone(usage: WorkspaceUsage): QuotaToneView`、`usageNote(scale: UsageScale): string`、`usageAfterError(prev: UsageLoad, message: string): UsageLoad`、`usageErrorText(message: string): string`

- [ ] **Step 1: `parseFileQuery` 的失败用例**

在 `tests/shared/workFilesView.test.ts` 顶部的 import 列表里加上 `parseFileQuery`（它从 `../../src/shared/workFilesView.js` import，和既有那几个同一行 / 同一个 import 块），文件末尾追加：

```ts
describe("parseFileQuery（#1356 A5：桌面文件页与手机文件页同一个约定）", () => {
  it("空的 / 只有问号 / 只有空白 = 还没开始搜", () => {
    expect(parseFileQuery("")).toBeNull();
    expect(parseFileQuery("?")).toBeNull();
    expect(parseFileQuery("?   ")).toBeNull();
    expect(parseFileQuery("   ")).toBeNull();
  });
  it("? 开头按内容搜，其余按名找；词本身原样交出去（桌面原来就不 trim）", () => {
    expect(parseFileQuery("readme")).toEqual({ term: "readme", content: false });
    expect(parseFileQuery("?TODO")).toEqual({ term: "TODO", content: true });
    expect(parseFileQuery(" a")).toEqual({ term: " a", content: false });
  });
});
```

（若这份测试文件没有 import `describe` / `it` / `expect`，它们本来就在——它是既有测试文件，头上已经有 `import { describe, expect, it } from "vitest";`。）

- [ ] **Step 2: 跑它，确认失败**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/workFilesView.test.ts
```

Expected: FAIL（`parseFileQuery` 不存在 / 不是函数）。

- [ ] **Step 3: 实现 `parseFileQuery`，桌面改调它，`toolsSummary` 导出**

`src/shared/workFilesView.ts` 文件末尾追加：

```ts
/** 搜索框里打的字 → 按名找还是按内容找。`?` 开头 = 按内容（#1066 起桌面文件页的约定，#1356 A5 抬进 shared，
    手机那一页同一份）。去掉 `?` 之后只剩空白 = 还没开始搜（null）；词本身原样交出去（桌面原来就不 trim） */
export function parseFileQuery(query: string): { term: string; content: boolean } | null {
  const content = query.startsWith("?");
  const term = content ? query.slice(1) : query;
  return term.trim() === "" ? null : { term, content };
}
```

`src/renderer/src/components/WorkspaceFilesTab.tsx`：
- 第 32 行那条 import 改成 `import { entryMeta, parseFileQuery, workFileNotice, workFolderNotice } from "../../../shared/workFilesView.js";`
- 搜索那个 effect（`// 过滤/搜索去抖 150ms。空查询 = 回到树（同 FilesView）` 底下）里这一段：

```ts
    const content = query.startsWith("?");
    const term = content ? query.slice(1) : query;
    if (term.trim() === "") {
      setHits(null);
      return undefined;
    }
```

换成：

```ts
    // `?` 开头 = 按内容搜（判据在 shared，手机那一页同一份，#1356 A5）
    const parsed = parseFileQuery(query);
    if (parsed === null) {
      setHits(null);
      return undefined;
    }
    const { term, content } = parsed;
```

（前面那段 `if (query === "") { setHits(null); setNotice(""); return undefined; }` 与后面的 `setTimeout` 一字不动——行为逐字相同。）

`src/shared/workspaceView.ts`：`function toolsSummary(tools: readonly string[]): string {` → `export function toolsSummary(tools: readonly string[]): string {`，并在它上面加一行注释 `/** 连接器那一行的第二格：「全部工具」/「3 个工具」。手机的应用清单用同一句（#1356 A5） */`。

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/workFilesView.test.ts tests/renderer/workspaceFilesTree.test.tsx && npx tsc --noEmit
```

Expected: PASS，tsc 零输出。

- [ ] **Step 4: `mobileMachine` 的失败用例**

`tests/shared/mobileMachine.test.ts`：

```ts
// mobileMachine 的用例（#1356 A5）。时间只用「刚刚」那一档与注入的 NOW，不碰本机时区
import { describe, expect, it } from "vitest";
import type { BillingMe, WorkspaceUsage } from "../../src/shared/billing.js";
import {
  APPS_EMPTY, APPS_FOOTER, FILES_FOOTER, FILES_SEARCH_PLACEHOLDER, MACHINE_FOOTER, USAGE_EMPTY, WIKI_ABSENT, WIKI_EMPTY, WIKI_FOOTER,
  appRows, baseName, machineRows, machineShareText, usageAfterError, usageErrorText, usageHeroText, usageNote, usageTone,
  wikiEditError, wikiGroupTitle, wikiGroupsOf, wikiIndexAfterError, wikiIndexFrom, wikiLinkRows, wikiMatches, wikiMetaLine,
  wikiPageCount, wikiPageFrom, workEntryRows, workFileText, workFolderText, workFolderTruncated, workHitRows, workIcon,
  type UsageLoad, type WikiIndexState,
} from "../../src/shared/mobileMachine.js";
import type { CsWorkEntry } from "../../src/shared/remote/cloudSession.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";
import { serializeWikiPage, type WikiIndexGroup, type WikiPage } from "../../src/shared/wiki.js";
import { entryMeta } from "../../src/shared/workFilesView.js";
import { usageScale, usageWindowText } from "../../src/shared/workspaceUsageView.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const NOW = 1_800_000_000_000;

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const HOME: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }],
  connectors: [
    { workspaceId: "home1", hostUid: "me", serverId: "github", label: "GitHub", tools: [] },
    { workspaceId: "home1", hostUid: "me", serverId: "shopify", label: "  ", tools: ["orders", "stock"] },
  ],
  sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "开发"), agent("a_000000000002", "运维")],
};

const GROUPS: WikiIndexGroup[] = [
  { name: "常驻", entries: [{ path: "team.md", title: "团队口径", summary: "每轮都带着", pinned: true }] },
  { name: "agents", entries: [{ path: "agents/a_000000000001.md", title: "开发", summary: "", pinned: false }] },
  { name: "customers", entries: [{ path: "customers/acme.md", title: "Acme 这家客户", summary: "按月结", pinned: false }] },
];

const usage = (over: Partial<WorkspaceUsage> = {}): WorkspaceUsage => ({
  workspaceId: "home1", ownerUid: "me", weekStartAt: NOW - 3 * 86_400_000, weekEndAt: NOW + 4 * 86_400_000,
  weekLimitMicro: 1_000_000,
  rows: [{ agentId: "a_000000000001", costMicro: 380_000, calls: 12, promptTokens: 1000, cachedTokens: 0, completionTokens: 500 }],
  ...over,
});

const billingMe = (): BillingMe => ({
  plan: "pro", status: "active", plans: [],
  windows: {
    h5: { usedMicro: 0, limitMicro: 1_000_000, resetAt: NOW + 60_000 },
    week: { usedMicro: 83_000, limitMicro: 1_000_000, resetAt: NOW + 86_400_000 },
  },
  addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [], imageModels: [], ttsModels: [], modelPlatforms: {},
});
const snap = (me: BillingMe): BillingSnapshotView => ({ me, fetchedAt: NOW, exhausted: null });

const page = (over: Partial<WikiPage["front"]> = {}, body = ""): WikiPage => ({
  path: "team.md",
  front: { title: "团队口径", summary: "每轮都带着", pinned: false, updatedBy: "开发", updatedAt: new Date(NOW - 30_000).toISOString(), sources: [], ...over },
  body,
});

describe("目录", () => {
  it("页顶那一句：几只共用这一台（不写「一直开着」——空闲会停）", () => {
    expect(machineShareText(HOME)).toBe("3 只智能体共用这一台");
    expect(MACHINE_FOOTER).toBe("这台电脑在云端。一阵子没活干它会自己睡着，有活时再醒——文件都还在。");
  });
  it("四行：文件不报数；还在读的格子不写字", () => {
    const rows = machineRows({ apps: 0, wiki: { kind: "loading" }, usage: { kind: "loading" } });
    expect(rows.map((r) => [r.key, r.title, r.value])).toEqual([
      ["files", "文件", null], ["apps", "应用", "还没有"], ["wiki", "记忆", null], ["usage", "这周用了多少", null],
    ]);
    expect(rows.map((r) => r.detail)).toEqual(["它们干活留下的东西", "它们能拿你的身份去用的那几个", "它们自己写、互相看得见", "按智能体分"]);
  });
  it("读到了：应用几个、记忆几页、这周占了百分之几", () => {
    const rows = machineRows({ apps: 2, wiki: { kind: "ok", groups: GROUPS }, usage: { kind: "ok", usage: usage() } });
    expect(rows.map((r) => r.value)).toEqual([null, "2 个", "3 页", "38.0%"]);
  });
  it("电脑还没开过：记忆写「还没有」；读不到但手上有上一份就照上一份报", () => {
    expect(machineRows({ apps: 1, wiki: { kind: "absent" }, usage: { kind: "loading" } })[2]?.value).toBe("还没有");
    expect(machineRows({ apps: 1, wiki: { kind: "error", message: "x", groups: GROUPS }, usage: { kind: "error", message: "x", usage: usage() } }).map((r) => r.value)).toEqual([null, "1 个", "3 页", "38.0%"]);
    expect(machineRows({ apps: 1, wiki: { kind: "error", message: "x", groups: null }, usage: { kind: "error", message: "x", usage: null } }).map((r) => r.value)).toEqual([null, "1 个", null, null]);
  });
  it("分母读不到时这周那一格不报数", () => {
    expect(machineRows({ apps: 0, wiki: { kind: "loading" }, usage: { kind: "ok", usage: usage({ weekLimitMicro: null }) } })[3]?.value).toBeNull();
  });
});

describe("记忆", () => {
  it("索引读回来：电脑没开过 / 没有索引 = 一页没有 / 读到了 / 读不出来", () => {
    expect(wikiIndexFrom({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(wikiIndexFrom({ kind: "missing" })).toEqual({ kind: "ok", groups: [] });
    const ok = wikiIndexFrom({ kind: "file", text: "# 索引\n\n## 常驻\n- [[team]] 团队口径 — 每轮都带着\n", truncated: false, size: 40 });
    expect(ok.kind).toBe("ok");
    expect(wikiIndexFrom({ kind: "binary", size: 3 })).toEqual({ kind: "error", message: "记忆的索引读不出来。", groups: null });
  });
  it("读不到 ≠ 空：上一份清单留在原地", () => {
    const prev: WikiIndexState = { kind: "ok", groups: GROUPS };
    expect(wikiIndexAfterError(prev, "断了")).toEqual({ kind: "error", message: "断了", groups: GROUPS });
    expect(wikiIndexAfterError({ kind: "loading" }, "断了")).toEqual({ kind: "error", message: "断了", groups: null });
    expect(wikiGroupsOf({ kind: "absent" })).toBeNull();
    expect(wikiGroupsOf(prev)).toBe(GROUPS);
  });
  it("页数按路径去重；agents 那一组换个人话的名字", () => {
    expect(wikiPageCount([...GROUPS, { name: "又一组", entries: [GROUPS[0]!.entries[0]!] }])).toBe(3);
    expect(wikiGroupTitle("agents")).toBe("各只自己那一页");
    expect(wikiGroupTitle("customers")).toBe("customers");
  });
  it("一页读回来的几种结局", () => {
    const p = page();
    const ok = wikiPageFrom("team.md", { kind: "file", text: serializeWikiPage(p), truncated: false, size: 100 });
    expect(ok.ok && ok.page.front.title).toBe("团队口径");
    expect(wikiPageFrom("x.md", { kind: "missing" })).toEqual({ ok: false, message: "这一页不在了，可能刚被删掉或改名了。" });
    expect(wikiPageFrom("x.md", { kind: "absent" })).toEqual({ ok: false, message: WIKI_ABSENT });
    expect(wikiPageFrom("x.md", { kind: "binary", size: 1 })).toEqual({ ok: false, message: "这一页读不出来（不是文本）。" });
  });
  it("页头那一行：谁写的 · 什么时候 · 常驻；读不出时间就不写那一段", () => {
    expect(wikiMetaLine(page(), NOW)).toBe("开发 · 刚刚");
    expect(wikiMetaLine(page({ pinned: true }), NOW)).toBe("开发 · 刚刚 · 常驻");
    expect(wikiMetaLine(page({ updatedAt: "", updatedBy: "  " }), NOW)).toBe("—");
  });
  it("它提到的：按索引认出标题，链坏的与自己链自己不列", () => {
    const p = page({}, "见 [[customers/acme]] 与 [[customers/acme|Acme]]，还有 [[nope]]，以及 [[team]]");
    expect(wikiLinkRows(p, GROUPS).map((e) => e.path)).toEqual(["customers/acme.md"]);
  });
  it("名册搜索里记忆那一半：标题 / 摘要 / 路径，不分大小写，同一页只出一次，封顶", () => {
    expect(wikiMatches(GROUPS, "")).toEqual([]);
    expect(wikiMatches(GROUPS, "acme").map((e) => e.path)).toEqual(["customers/acme.md"]);
    expect(wikiMatches(GROUPS, "按月").map((e) => e.path)).toEqual(["customers/acme.md"]);
    expect(wikiMatches([...GROUPS, GROUPS[2]!], "ACME").length).toBe(1);
    expect(wikiMatches(GROUPS, ".md", 2).length).toBe(2);
  });
  it("改一页之前的校验：字段名说中文", () => {
    expect(wikiEditError({ title: "团队口径", summary: "", pinned: false, sources: [] })).toBeNull();
    expect(wikiEditError({ title: " ", summary: "", pinned: false, sources: [] })).toBe("标题必填，且不能是空白");
    expect(wikiEditError({ title: "a [[b]]", summary: "", pinned: false, sources: [] })).toBe("标题不能含 [[ 或 ]]");
  });
  it("几句固定话", () => {
    expect(WIKI_FOOTER).toBe("你也能改——存了之后，它们下一次开口就按新的来。");
    expect(WIKI_EMPTY).toBe("它们还没记下什么。干活时记下的口径、习惯会出现在这里。");
    expect(WIKI_ABSENT).toBe("它们的电脑还没开过——第一次让它们干活时才会建，记忆也在那时候生成。");
  });
});

describe("文件", () => {
  const e = (name: string, kind: CsWorkEntry["kind"], size = 0): CsWorkEntry => ({ name, kind, size, mtimeMs: NOW - 86_400_000 });
  it("一层 → 行：目录在前、再按名字；路径拼好；other 点不开", () => {
    const rows = workEntryRows("docs", [e("b.md", "file", 2048), e("z-dir", "dir"), e("a.png", "file", 10), e("link", "other"), e("a-dir", "dir")], NOW);
    expect(rows.map((r) => r.name)).toEqual(["a-dir", "z-dir", "a.png", "b.md", "link"]);
    expect(rows[0]).toEqual({ key: "docs/a-dir", path: "docs/a-dir", name: "a-dir", icon: "folder", meta: entryMeta(e("a-dir", "dir"), NOW), opens: "dir" });
    expect(rows[2]).toMatchObject({ icon: "image", opens: "file" });
    expect(rows[4]).toMatchObject({ icon: "file", opens: null });
    expect(workEntryRows("", [e("x.txt", "file")], NOW)[0]?.path).toBe("x.txt");
  });
  it("图标按扩展名认图片，目录一律是文件夹", () => {
    expect(workIcon("A.JPEG", "file")).toBe("image");
    expect(workIcon("photos", "dir")).toBe("folder");
    expect(workIcon("notes.md", "file")).toBe("file");
  });
  it("三种「空」分开说", () => {
    expect(workFolderText({ kind: "absent" })).toBe("它们的电脑还没开过——第一次让它们干活时才会建。");
    expect(workFolderText({ kind: "missing" })).toBe("这个位置现在没有东西，可能刚被删掉或改名了。");
    expect(workFolderText({ kind: "dir", entries: [], truncated: false })).toBe("还是空的。它们做出来的东西会出现在这里。");
    expect(workFolderText({ kind: "dir", entries: [e("a", "file")], truncated: false })).toBeNull();
    expect(workFolderTruncated({ kind: "dir", entries: [e("a", "file")], truncated: true })).toBe("这一层东西太多，只列了前一部分。");
    expect(workFolderTruncated({ kind: "dir", entries: [], truncated: false })).toBeNull();
  });
  it("一个文件底下那一句", () => {
    expect(workFileText({ kind: "binary", size: 2048 })).toBe("这是一个二进制文件（2.0 KB），手机上显示不出内容。");
    expect(workFileText({ kind: "file", text: "abc", truncated: true, size: 200_000 })).toBe("文件有 195.3 KB，这里只显示了开头一段。");
    expect(workFileText({ kind: "file", text: "", truncated: false, size: 0 })).toBe("这是一个空文件。");
    expect(workFileText({ kind: "file", text: "abc", truncated: false, size: 3 })).toBeNull();
    expect(workFileText({ kind: "missing" })).toBe("这个文件现在不在了，可能刚被删掉或改名了。");
  });
  it("搜索结果：按名的写它在哪个文件夹，按内容的写第几行", () => {
    expect(workHitRows([{ rel: "notes/todo.md", line: null, text: null }, { rel: "logo.png", line: null, text: null }, { rel: "a/b.ts", line: 12, text: "  // TODO  " }])).toEqual([
      { key: "notes/todo.md::0", path: "notes/todo.md", title: "todo.md", detail: "notes", icon: "file" },
      { key: "logo.png::1", path: "logo.png", title: "logo.png", detail: "最外层", icon: "image" },
      { key: "a/b.ts:12:2", path: "a/b.ts", title: "b.ts", detail: "第 12 行：// TODO", icon: "file" },
    ]);
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("")).toBe("");
  });
  it("两句固定话", () => {
    expect(FILES_FOOTER).toBe("文件在云端那台电脑上，下不到手机上；要看哪一份就点开，或者让它们在聊天里念给你。");
    expect(FILES_SEARCH_PLACEHOLDER).toBe("找文件；打 ? 搜内容");
  });
});

describe("应用", () => {
  it("名字空着退回 serverId；第二行与桌面同一句", () => {
    expect(appRows(HOME)).toEqual([
      { key: "me:github", title: "GitHub", detail: "全部工具" },
      { key: "me:shopify", title: "shopify", detail: "2 个工具" },
    ]);
    expect(APPS_EMPTY).toBe("还没有接应用。");
    expect(APPS_FOOTER).toBe("新的应用要在电脑上的 Mr Otto 里接；要登录的也在那台电脑上登，凭据不经过这个手机。它们此刻连没连上，这里看不出来。");
  });
});

describe("用量页", () => {
  it("大数字底下那一行：分母 + 哪一周；知道本周那扇窗时补一句还剩多少", () => {
    const u = usage();
    expect(usageHeroText(u, null, NOW)).toBe(`占你这一周额度的比例 · ${usageWindowText(u)}`);
    expect(usageHeroText(u, snap(billingMe()), NOW)).toBe(`占你这一周额度的比例 · ${usageWindowText(u)} · 本周还剩 91.7%`);
    expect(usageHeroText(usage({ weekLimitMicro: null }), null, NOW)).toBe(`这一周它们调了几次模型 · ${usageWindowText(u)}`);
  });
  it("大数字那根条的色档：分母在时按已用判，不在时一律 neutral", () => {
    expect(usageTone(usage())).toBe("neutral");
    expect(usageTone(usage({ rows: [{ agentId: "a", costMicro: 800_000, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }] }))).toBe("warn");
    expect(usageTone(usage({ rows: [{ agentId: "a", costMicro: 950_000, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }] }))).toBe("deny");
    expect(usageTone(usage({ weekLimitMicro: null }))).toBe("neutral");
  });
  it("组尾那句：分母是什么（主场里所有者就是你）", () => {
    expect(usageNote(usageScale(usage()))).toBe("百分比 = 占你本周额度的比例，与账号页「本周」那扇窗同一把尺子；条是各自在这几只里的比重。");
    expect(usageNote(usageScale(usage({ weekLimitMicro: null })))).toBe("读不到你的额度上限（没有活跃订阅，或服务端还不报这一格），所以百分比暂时按这一周它们的合计算——不是占额度的比例。");
    expect(USAGE_EMPTY).toBe("这一周它们还没用额度。");
  });
  it("读不到 ≠ 空：上一份用量留着；断网说人话", () => {
    const prev: UsageLoad = { kind: "ok", usage: usage() };
    expect(usageAfterError(prev, "x")).toEqual({ kind: "error", message: "x", usage: usage() });
    expect(usageAfterError({ kind: "loading" }, "x")).toEqual({ kind: "error", message: "x", usage: null });
    expect(usageErrorText("Network request failed")).toBe("连不上服务端——网络不通，或者对面暂时没响应。");
    expect(usageErrorText("not_member")).toBe("not_member");
  });
});
```

- [ ] **Step 5: 跑它，确认失败**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/mobileMachine.test.ts
```

Expected: FAIL（找不到 `../../src/shared/mobileMachine.js`）。

- [ ] **Step 6: 写实现**

`src/shared/mobileMachine.ts`：

```ts
// mobileMachine —— 手机「它们的电脑」那几屏的判据（#1356 A5，spec §5.8）：目录四行、文件、应用、记忆、用量页的
// 手机说法，以及名册搜索里记忆那一半。纯逻辑，屏只画。
//
// **数字全是查得到的**（demo 原话），查不到的一律不画——这一片开工时逐条验过：
// · 磁盘用量不对任何客户端暴露（ADR-0287：`du` 的读数只在 runtime 里当闸，出门的只有超额时那一句旁白）；
// · 文件总数没有（files 帧一次只列一层，ADR-0253）；
// · 「应用等你登录」只活在桌面主进程的内存里（McpHub 的 needs-auth），托管箱还把不 live 的整台滤掉
//   （pxEscrow.buildEscrowDoc）——手机从哪条路都问不出来，所以名册账号钮上那枚点、应用的状态点都不画。
// 界面文案不出现「水獭」「主场」「团队」：桌面 workFilesView / usageScaleNote 那几句是桌面口吻，这里另写；尺寸、
// 时间、百分比的算法照旧复用那几份。

import type { WorkspaceUsage } from "./billing.js";
import { fmtRemainingPercent, liveWindow, usedPercentOf } from "./billingView.js";
import { quotaToneView, type QuotaToneView } from "./mobileAccount.js";
import { rosterTimeLabel } from "./mobileRoster.js";
import type { CsWorkEntry, CsWorkHit, CsWorkNode } from "./remote/cloudSession.js";
import { joinWorkPath } from "./remote/workPath.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import {
  extractWikiLinks, parseIndex, parseWikiPage, validateWikiFields, WIKI_AGENTS_DIR,
  type WikiIndexEntry, type WikiIndexGroup, type WikiPage,
} from "./wiki.js";
import { entryMeta, formatWorkSize } from "./workFilesView.js";
import { usageHeadline, usageWindowText, workspaceTotalMicro, type UsageScale } from "./workspaceUsageView.js";
import { toolsSummary } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

// ── 目录 ──

/** 页顶那一组的组头：几只共用这一台。demo 的「五只共用这一台 · 一直开着」去掉了后半句——容器空闲一阵会停、
    有活再起（ADR-0199），「一直开着」不成立 */
export function machineShareText(ws: WorkspaceSnapshot): string {
  return `${ws.agents.length} 只智能体共用这一台`;
}

export const MACHINE_FOOTER = "这台电脑在云端。一阵子没活干它会自己睡着，有活时再醒——文件都还在。";

export type WikiIndexState =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "ok"; groups: WikiIndexGroup[] }
  | { kind: "error"; message: string; groups: WikiIndexGroup[] | null };

export type UsageLoad =
  | { kind: "loading" }
  | { kind: "ok"; usage: WorkspaceUsage }
  | { kind: "error"; message: string; usage: WorkspaceUsage | null };

export interface MachineRowView {
  key: "files" | "apps" | "wiki" | "usage";
  title: string;
  detail: string;
  /** 右边那一格；null = 这一刻说不出（还在读 / 读不到 / 本来就查不到），不写字 */
  value: string | null;
}

function countText(n: number, unit: string): string {
  return n === 0 ? "还没有" : `${n} ${unit}`;
}

function usageOf(load: UsageLoad): WorkspaceUsage | null {
  return load.kind === "ok" ? load.usage : load.kind === "error" ? load.usage : null;
}

/** 目录那四行。文件那一行**不报数**（没有递归计数）；这周那一格报「占你周额度的百分之几」，分母读不到就不报 */
export function machineRows(o: { apps: number; wiki: WikiIndexState; usage: UsageLoad }): MachineRowView[] {
  const groups = wikiGroupsOf(o.wiki);
  const usage = usageOf(o.usage);
  return [
    { key: "files", title: "文件", detail: "它们干活留下的东西", value: null },
    { key: "apps", title: "应用", detail: "它们能拿你的身份去用的那几个", value: countText(o.apps, "个") },
    {
      key: "wiki", title: "记忆", detail: "它们自己写、互相看得见",
      value: o.wiki.kind === "absent" ? "还没有" : groups === null ? null : countText(wikiPageCount(groups), "页"),
    },
    { key: "usage", title: "这周用了多少", detail: "按智能体分", value: usage === null ? null : usageHeadline(usage).percent },
  ];
}

// ── 记忆 ──

export const WIKI_FOOTER = "你也能改——存了之后，它们下一次开口就按新的来。";
export const WIKI_EMPTY = "它们还没记下什么。干活时记下的口径、习惯会出现在这里。";
export const WIKI_ABSENT = "它们的电脑还没开过——第一次让它们干活时才会建，记忆也在那时候生成。";

/** 读 wiki/index.md 那一格的结局 → 记忆清单的状态。`absent`（电脑还没建起来）与「索引不在」是两回事：后者 =
    建起来了、一页都还没记（桌面 WorkspaceWikiTab 同一个读法）。**只有真读到了才回 ok** */
export function wikiIndexFrom(node: CsWorkNode): WikiIndexState {
  if (node.kind === "absent") return { kind: "absent" };
  if (node.kind === "missing") return { kind: "ok", groups: [] };
  if (node.kind === "file") return { kind: "ok", groups: parseIndex(node.text) };
  return { kind: "error", message: "记忆的索引读不出来。", groups: null };
}

/** 这一次没读到：上一份清单留在原地，错误另起一行（读不到 ≠ 空，同 ADR-0264 决策 8） */
export function wikiIndexAfterError(prev: WikiIndexState, message: string): WikiIndexState {
  return { kind: "error", message, groups: wikiGroupsOf(prev) };
}

export function wikiGroupsOf(s: WikiIndexState): WikiIndexGroup[] | null {
  return s.kind === "ok" ? s.groups : s.kind === "error" ? s.groups : null;
}

export function wikiPageCount(groups: readonly WikiIndexGroup[]): number {
  return new Set(groups.flatMap((g) => g.entries.map((e) => e.path))).size;
}

/** 组头写什么：索引里「各只自己那页」那一组的名字是目录名 `agents`，手机上换成人话；其余照索引（常驻 / 目录名 /
    未分目录）——目录名是它们自己起的，改写就是替它们改了名 */
export function wikiGroupTitle(name: string): string {
  return name === WIKI_AGENTS_DIR ? "各只自己那一页" : name;
}

export type WikiPageLoad = { ok: true; page: WikiPage } | { ok: false; message: string };

export function wikiPageFrom(path: string, node: CsWorkNode): WikiPageLoad {
  if (node.kind === "file") return { ok: true, page: parseWikiPage(path, node.text) };
  if (node.kind === "missing") return { ok: false, message: "这一页不在了，可能刚被删掉或改名了。" };
  if (node.kind === "absent") return { ok: false, message: WIKI_ABSENT };
  return { ok: false, message: "这一页读不出来（不是文本）。" };
}

/** 页头那一行：「开发 · 12:40 · 常驻」。谁写的读页头（updated_by，写的那一刻的名字）；时间用名册那把尺子
    （刚刚 / 12:41 / 昨天 / 周二 / 9 月 3 日）；读不出时间就不写那一段 */
export function wikiMetaLine(page: WikiPage, now: number): string {
  const parts = [page.front.updatedBy.trim() || "—"];
  const ts = Date.parse(page.front.updatedAt);
  if (Number.isFinite(ts)) parts.push(rosterTimeLabel(ts, now));
  if (page.front.pinned) parts.push("常驻");
  return parts.join(" · ");
}

/** 「它提到的」：正文里的 [[链接]]，按索引认出标题；索引里没有的（链坏了 / 还没写）不列，自己链自己不列。
    demo 那一组是「连到这一页的」（反向链接）——那要把每一页都读一遍，files 帧一次只读一个文件，不做 */
export function wikiLinkRows(page: WikiPage, groups: readonly WikiIndexGroup[]): WikiIndexEntry[] {
  const byPath = new Map<string, WikiIndexEntry>();
  for (const g of groups) for (const e of g.entries) if (!byPath.has(e.path)) byPath.set(e.path, e);
  const out: WikiIndexEntry[] = [];
  for (const target of extractWikiLinks(page.body)) {
    if (target === page.path) continue;
    const hit = byPath.get(target);
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/** 名册搜索里记忆那一半：标题 / 摘要 / 路径里含这几个字（不分大小写），按索引里的顺序，同一页只出一次，封顶 limit 条 */
export function wikiMatches(groups: readonly WikiIndexGroup[], query: string, limit = 20): WikiIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const seen = new Set<string>();
  const out: WikiIndexEntry[] = [];
  for (const g of groups) {
    for (const e of g.entries) {
      if (seen.has(e.path)) continue;
      if (![e.title, e.summary, e.path].some((s) => s.toLowerCase().includes(q))) continue;
      seen.add(e.path);
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const FIELD_NAMES: Record<string, string> = { title: "标题", summary: "摘要", sources: "来源" };

/** 改一页之前过一道页头校验（与 wiki 工具、桌面同一份 validateWikiFields）；null = 可以存。
    那份话开头是英文字段名（它也说给模型听），手机上换成中文 */
export function wikiEditError(f: { title: string; summary: string; pinned: boolean; sources: readonly string[] }): string | null {
  const bad = validateWikiFields({ title: f.title, summary: f.summary, pinned: f.pinned, sources: [...f.sources] });
  return bad === null ? null : bad.replace(/^(title|summary|sources) ?/, (_m, k: string) => FIELD_NAMES[k] ?? k);
}

// ── 文件 ──

export const FILES_FOOTER = "文件在云端那台电脑上，下不到手机上；要看哪一份就点开，或者让它们在聊天里念给你。";
export const FILES_SEARCH_PLACEHOLDER = "找文件；打 ? 搜内容";

export type WorkIcon = "folder" | "image" | "file";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i;

export function workIcon(name: string, kind: CsWorkEntry["kind"]): WorkIcon {
  if (kind === "dir") return "folder";
  return IMAGE_EXT.test(name) ? "image" : "file";
}

export interface WorkEntryRowView {
  key: string;
  path: string;
  name: string;
  icon: WorkIcon;
  /** 行的第二格：目录只写时间，文件写大小 · 时间（桌面那一份 entryMeta） */
  meta: string;
  /** 点进去（目录）/ 点开（文件）；other（软链、设备文件）两样都不行 */
  opens: "dir" | "file" | null;
}

/** 一层目录 → 行：目录在前，再按名字（码点序）；路径拼好（joinWorkPath，两端同一个拼法） */
export function workEntryRows(dir: string, entries: readonly CsWorkEntry[], now: number): WorkEntryRowView[] {
  return [...entries]
    .sort((a, b) => {
      if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((e) => {
      const path = joinWorkPath(dir, e.name);
      return {
        key: path, path, name: e.name, icon: workIcon(e.name, e.kind), meta: entryMeta(e, now),
        opens: e.kind === "dir" ? "dir" : e.kind === "file" ? "file" : null,
      };
    });
}

/** 一个文件夹里什么都画不出来时说哪句。**三种「空」不许合成一句**（桌面 workFolderNotice 同一条判据）：电脑还没
    建起来 / 这条路径没了 / 真的是空的 */
export function workFolderText(node: CsWorkNode): string | null {
  if (node.kind === "absent") return "它们的电脑还没开过——第一次让它们干活时才会建。";
  if (node.kind === "missing") return "这个位置现在没有东西，可能刚被删掉或改名了。";
  if (node.kind === "dir" && node.entries.length === 0) return "还是空的。它们做出来的东西会出现在这里。";
  return null;
}

/** 列不全时组尾那一句 */
export function workFolderTruncated(node: CsWorkNode): string | null {
  return node.kind === "dir" && node.truncated && node.entries.length > 0 ? "这一层东西太多，只列了前一部分。" : null;
}

/** 一个文件底下那一句：二进制 / 截断 / 空文件 / 不在了（桌面 workFileNotice 的手机说法）；没什么好说的 = null */
export function workFileText(node: CsWorkNode): string | null {
  if (node.kind === "binary") return `这是一个二进制文件（${formatWorkSize(node.size)}），手机上显示不出内容。`;
  if (node.kind === "file" && node.truncated) return `文件有 ${formatWorkSize(node.size)}，这里只显示了开头一段。`;
  if (node.kind === "file" && node.text === "") return "这是一个空文件。";
  if (node.kind === "missing") return "这个文件现在不在了，可能刚被删掉或改名了。";
  if (node.kind === "absent") return "它们的电脑还没开过——第一次让它们干活时才会建。";
  return null;
}

export function baseName(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? "";
}

export interface WorkHitRowView {
  key: string;
  path: string;
  title: string;
  detail: string;
  icon: WorkIcon;
}

/** 搜索结果 → 行。按内容搜时一个文件可能命中好几行，每行一条（第几行 + 那一行的字）；按名搜时第二行写它在哪个文件夹 */
export function workHitRows(hits: readonly CsWorkHit[]): WorkHitRowView[] {
  return hits.map((h, i) => {
    const slash = h.rel.lastIndexOf("/");
    const dir = slash < 0 ? "" : h.rel.slice(0, slash);
    const title = baseName(h.rel);
    const detail = h.line !== null ? `第 ${h.line} 行：${(h.text ?? "").trim()}` : dir === "" ? "最外层" : dir;
    return { key: `${h.rel}:${h.line ?? ""}:${i}`, path: h.rel, title, detail, icon: workIcon(title, "file") };
  });
}

// ── 应用 ──

export const APPS_EMPTY = "还没有接应用。";
export const APPS_FOOTER = "新的应用要在电脑上的 Mr Otto 里接；要登录的也在那台电脑上登，凭据不经过这个手机。它们此刻连没连上，这里看不出来。";

export interface AppRowView {
  key: string;
  title: string;
  detail: string;
}

/** 接着的那几个应用（workspace_connectors，桌面贡献进来的）。**不画状态**：连没连上、要不要重新登录，手机问不出来
    （见头注）；名字空着退回 serverId；第二行与桌面同一句（toolsSummary） */
export function appRows(ws: WorkspaceSnapshot): AppRowView[] {
  return ws.connectors.map((c) => ({
    key: `${c.hostUid}:${c.serverId}`,
    title: c.label.trim() || c.serverId,
    detail: toolsSummary(c.tools),
  }));
}

// ── 用量页 ──

export const USAGE_EMPTY = "这一周它们还没用额度。";

/** 页顶大数字底下那一行：分母是什么 + 哪一周；知道本周那扇窗时补一句还剩多少——那个数来自账号的额度窗，
    **不是 100 减去上面那个数**（你在电脑上用掉的也算在同一扇窗里） */
export function usageHeroText(usage: WorkspaceUsage, billing: BillingSnapshotView | null, now: number): string {
  const parts = [usage.weekLimitMicro === null ? "这一周它们调了几次模型" : "占你这一周额度的比例", usageWindowText(usage)];
  const week = billing?.me?.windows?.week;
  if (week !== undefined) parts.push(`本周还剩 ${fmtRemainingPercent(liveWindow(week, now))}`);
  return parts.join(" · ");
}

/** 大数字那根条的色档：分母在时按已用判（与账号页两扇窗同一组阈值），不在时不画条也就无所谓色档——一律 neutral */
export function usageTone(usage: WorkspaceUsage): QuotaToneView {
  if (usage.weekLimitMicro === null) return "neutral";
  return quotaToneView(usedPercentOf(workspaceTotalMicro(usage), usage.weekLimitMicro));
}

/** 组尾那句：这些百分比的分母是什么（桌面 usageScaleNote 的手机说法：这几只花的是你的额度，「所有者」就是你） */
export function usageNote(scale: UsageScale): string {
  if (scale.kind === "window") {
    return "百分比 = 占你本周额度的比例，与账号页「本周」那扇窗同一把尺子；条是各自在这几只里的比重。";
  }
  return "读不到你的额度上限（没有活跃订阅，或服务端还不报这一格），所以百分比暂时按这一周它们的合计算——不是占额度的比例。";
}

/** 这一次没读到：上一份用量留着（读不到 ≠ 空） */
export function usageAfterError(prev: UsageLoad, message: string): UsageLoad {
  return { kind: "error", message, usage: usageOf(prev) };
}

/** 请求失败的原话：断网 / 超时说人话，别的原样留（认不出的不猜，#910 的规矩） */
export function usageErrorText(message: string): string {
  return /network request failed|fetch failed|network|timed? ?out/i.test(message)
    ? "连不上服务端——网络不通，或者对面暂时没响应。"
    : message;
}
```

- [ ] **Step 7: 跑测试，确认通过；再跑根 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npx vitest run tests/shared/mobileMachine.test.ts tests/shared/workFilesView.test.ts && npx tsc --noEmit
```

Expected: PASS，tsc 零输出。`workFileText` 截断那条的「195.3 KB」是 `formatWorkSize(200_000)`（`(200000/1024).toFixed(1)`）；若实际输出不同，以 `formatWorkSize(200_000)` 的真实值为准改用例并在报告里说明（不许改 `formatWorkSize`）。

- [ ] **Step 8: 提交**

```
feat(shared): 手机「它们的电脑」那几屏的判据（#1356 A5）

目录四行、文件（一层 → 行、三种「空」分开说、搜索结果）、应用清单、记忆（索引、单页、页头那一行、
它提到的、名册搜索的记忆那一半、改之前的校验）、用量页的手机说法。数字只报查得到的：磁盘、文件总数、
「应用等你登录」这一片开工时逐条验过都问不出来（ADR-0287 / 0253 / pxEscrow），所以不画。

顺带两处：`?` 开头按内容搜抬进 workFilesView（桌面文件页改调它，行为不变）；toolsSummary 导出，
应用清单的第二行与桌面同一句。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add src/shared/mobileMachine.ts tests/shared/mobileMachine.test.ts src/shared/workFilesView.ts tests/shared/workFilesView.test.ts src/shared/workspaceView.ts src/renderer/src/components/WorkspaceFilesTab.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 4: 手机端的基础件——两个 store、外观、图标、计量条、行的两格

后面五个屏共用的零件，一次放好：edge 的地址与令牌、订阅快照（带「开支付页 → 回来重拉」）、那台电脑的两份共用数据（记忆索引、这周用量）、外观偏好、行首小图标（demo 的 `.ico`）、计量条（demo 的 `.meter` / `.ubar`）；`Row` 多两格（第二行小字、单选的勾）、`useNow`、`Labeled` 从智能体设置挪进 `ui.tsx`。这一步没有屏，验收是手机 tsc 过。

**Files:**
- Create: `mobile/src/edge.ts`、`mobile/src/account/billingStore.ts`、`mobile/src/machine/usageApi.ts`、`mobile/src/machine/machineStore.ts`、`mobile/src/themePref.ts`、`mobile/src/chrome/RowGlyphs.tsx`、`mobile/src/chrome/Meter.tsx`
- Modify: `mobile/src/home/billing.ts`、`mobile/App.tsx`、`mobile/src/ui.tsx`、`mobile/src/agent/AgentSettingsScreen.tsx`

**Interfaces:**
- Consumes: Task 2 的 `billingChanged`、`billingLinkError`、`billingLinkThrown`、`billingLinkUrl`、`colorSchemeOf`、`parseThemePref`、`type ThemePref`；Task 3 的 `usageAfterError`、`usageErrorText`、`wikiIndexAfterError`、`wikiIndexFrom`、`type UsageLoad`、`type WikiIndexState`；既有 `cloudClient` / `ensureUid`（`mobile/src/cloud/cloudClient.ts`）、`createStore`（`mobile/src/externalStore.ts`）、`fetchBilling`。
- Produces（Task 5–9 用）：
  - `mobile/src/edge.ts`：`EDGE_BASE: string`、`edgeToken(): Promise<string | null>`
  - `mobile/src/account/billingStore.ts`：`type BillingLinkTarget = { kind: "checkout"; planId: PlanId } | { kind: "portal" }`、`type BillingLinkState = { kind: "idle" } | { kind: "opening"; key: string } | { kind: "syncing" } | { kind: "error"; key: string; message: string }`、`interface BillingState { billing: BillingSnapshotView | null; loaded: boolean; loadError: string | null; link: BillingLinkState }`、`useBilling(): BillingState`、`refreshBilling(): Promise<void>`、`openBillingLink(target: BillingLinkTarget, key: string): Promise<void>`
  - `mobile/src/machine/usageApi.ts`：`fetchWorkspaceUsage(workspaceId: string): Promise<WorkspaceUsage>`
  - `mobile/src/machine/machineStore.ts`：`interface MachineState { homeId: string | null; wiki: WikiIndexState; usage: UsageLoad }`、`useMachine(): MachineState`、`refreshWiki(homeId: string): Promise<void>`、`refreshUsage(homeId: string): Promise<void>`
  - `mobile/src/themePref.ts`：`useThemePref(): ThemePref`、`loadThemePref(): Promise<void>`、`setThemePref(p: ThemePref): Promise<void>`
  - `mobile/src/chrome/RowGlyphs.tsx`：`type RowGlyphName = "spark" | "chart" | "cloud" | "gear" | "folder" | "file" | "image" | "plug" | "book"`、`RowGlyph({ name, color? })`
  - `mobile/src/chrome/Meter.tsx`：`Meter({ fill, color, dim?, style? })`
  - `mobile/src/ui.tsx`：`Row` 新 prop `detail?: string`、`checked?: boolean`；`useNow(periodMs: number): number`；`Labeled({ label, hint?, error, children })`

- [ ] **Step 1: `mobile/src/edge.ts` 与 `home/billing.ts` 改用它**

`mobile/src/edge.ts`：

```ts
// edge 的地址与令牌（#1356 A5）：账号页、订阅页、用量页都要拿用户的 JWT 打 edge。A1 的 home/billing.ts 与 A4 的
// voiceStore 各写过一份 EDGE_BASE；新代码从这里取，home/billing.ts 改用它（voiceStore 不动——A4 的代码这一片不碰）。
import { edgeBaseUrl } from "../../src/shared/edgeConfig.js";
import { supabase } from "./supabase.js";

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 relay.ts）
export const EDGE_BASE = edgeBaseUrl({} as never);

/** 现取 supabase 的 access token（会过期，缓存一份等于把「过期」变成一次静默失败） */
export async function edgeToken(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
```

`mobile/src/home/billing.ts`：
- 删掉 `import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";` 与 `import { supabase } from "../supabase.js";` 两行，加 `import { EDGE_BASE, edgeToken } from "../edge.js";`
- 删掉 `// RN 里没有 process.env，…` 那行注释与 `const EDGE_BASE = edgeBaseUrl({} as never);`
- 函数体第一行 `const token = (await supabase.auth.getSession()).data.session?.access_token;` → `const token = await edgeToken();`
- 头注第 1 行 `// GET /billing/v1/me（#1356 A1）：名册进门七态要知道「能不能建主场」（spec §5.2）。` 换成 `// GET /billing/v1/me（#1356 A1）：名册进门七态要知道「能不能建主场」（spec §5.2）；A5 起账号页 / 订阅页也经 account/billingStore 用它。`

- [ ] **Step 2: `mobile/src/account/billingStore.ts`**

```ts
// 订阅快照（#1356 A5，spec §5.8）：账号页、订阅页、用量页读它；订阅页的钮经 openBillingLink 开支付页。
//
// 支付页开在 App 内浏览器里（expo-web-browser 的 openBrowserAsync = SFSafariViewController，整屏升起、左上「完成」）。
// 结账 / Portal 走完落在 edge 自己那一句话的页面上（/billing/v1/done），**不回跳 App**——所以回来靠人点「完成」，
// 关掉那一刻重拉订阅；结账那一趟 webhook 可能比人点「完成」还慢，没变就隔 2 秒再拉，最多再拉两次。
//
// 纪律同 homeStore：换号就清（本机数据跟着账号走，ADR-0187）；读不到 ≠ 没订阅（上一份照画，失败那句另挂，
// ADR-0240）；同时来的几次刷新合成一次。
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";
import type { BillingMe, PlanId } from "../../../src/shared/billing.js";
import { billingChanged, billingLinkError, billingLinkThrown, billingLinkUrl } from "../../../src/shared/mobileAccount.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import { EDGE_BASE, edgeToken } from "../edge.js";
import { createStore } from "../externalStore.js";
import { fetchBilling } from "../home/billing.js";
import { supabase } from "../supabase.js";

export type BillingLinkTarget = { kind: "checkout"; planId: PlanId } | { kind: "portal" };

export type BillingLinkState =
  | { kind: "idle" }
  | { kind: "opening"; key: string }
  | { kind: "syncing" }
  | { kind: "error"; key: string; message: string };

export interface BillingState {
  /** null = 还没查到（不是「没订阅」） */
  billing: BillingSnapshotView | null;
  /** 至少跑完过一次刷新 */
  loaded: boolean;
  /** 最近一次刷新没拿到。手上有旧快照照画，这一句挂在页顶 */
  loadError: string | null;
  link: BillingLinkState;
}

const INITIAL: BillingState = { billing: null, loaded: false, loadError: null, link: { kind: "idle" } };
const store = createStore<BillingState>(INITIAL);

export function useBilling(): BillingState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let inflight: Promise<void> | null = null;
/** 这份快照属于哪个账号（undefined = 还没听到第一声 auth 事件；第一声只是「知道了是谁」，不算换号，同 homeStore） */
let owner: string | null | undefined;
/** 每换一次号加一；刷新 / 开支付页开跑时记下，写回之前比一比——换过号就扔掉 */
let epoch = 0;

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  epoch += 1;
  inflight = null;
  store.set(INITIAL);
});

/** 拉一遍订阅。同时来的几次（进这一页 + 回前台 + 刚从 Stripe 回来）合成一次 */
export function refreshBilling(): Promise<void> {
  if (inflight !== null) return inflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      const b = await fetchBilling();
      if (mine !== epoch) return;
      // fetchBilling 失败回 null = 这一刻没拿到：旧快照照画，挂一句（不许并进「没订阅」）
      store.set(b === null ? { loaded: true, loadError: "这一刻读不到订阅状态。" } : { billing: b, loaded: true, loadError: null });
    } finally {
      if (inflight === run) inflight = null;
    }
  };
  run = task();
  inflight = run;
  return run;
}

async function postLink(target: BillingLinkTarget): Promise<{ url: string } | { error: string }> {
  const token = await edgeToken();
  if (token === null) return { error: "还没登录。" };
  const path = target.kind === "checkout" ? "/billing/v1/checkout" : "/billing/v1/portal";
  const body = target.kind === "checkout" ? { planId: target.planId } : {};
  const res = await fetch(`${EDGE_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) return { error: billingLinkError(res.status, payload) };
  const url = billingLinkUrl(payload);
  return url === null ? { error: "服务端没给支付页的地址。" } : { url };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 开一张支付页（结账 / Portal）。正在开或正在同步时再点是空操作。`key` 标明是哪颗钮（那颗钮写「正在打开…」、
    出错那句挂在它那一页） */
export async function openBillingLink(target: BillingLinkTarget, key: string): Promise<void> {
  const cur = store.get().link.kind;
  if (cur === "opening" || cur === "syncing") return;
  const mine = epoch;
  const before: BillingMe | null = store.get().billing?.me ?? null;
  store.set({ link: { kind: "opening", key } });
  let url: string;
  try {
    const r = await postLink(target);
    if (mine !== epoch) return;
    if ("error" in r) {
      store.set({ link: { kind: "error", key, message: r.error } });
      return;
    }
    url = r.url;
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      dismissButtonStyle: "done",
      readerMode: false,
    });
  } catch (e) {
    if (mine === epoch) store.set({ link: { kind: "error", key, message: billingLinkThrown(e instanceof Error ? e.message : String(e)) } });
    return;
  }
  if (mine !== epoch) return;
  store.set({ link: { kind: "syncing" } });
  // 刚关浏览器：可能正有一次开页之前起跑的刷新——等它收尾再拉一次新的（同 refreshHomeAfterWrite）
  if (inflight !== null) await inflight;
  await refreshBilling();
  if (target.kind === "checkout") {
    for (let i = 0; i < 2; i += 1) {
      if (mine !== epoch || billingChanged(before, store.get().billing?.me ?? null)) break;
      await sleep(2000);
      if (mine !== epoch) return;
      await refreshBilling();
    }
  }
  if (mine === epoch) store.set({ link: { kind: "idle" } });
}
```

（`url` 声明成 `let` 再赋值是为了让 `try` 里的两步共用它；若 tsc 报「url 已赋值未使用」之类，直接把 `openBrowserAsync(r.url, …)` 写进 try、删掉 `let url` 那行。）

- [ ] **Step 3: `mobile/src/machine/usageApi.ts` 与 `machineStore.ts`**

`mobile/src/machine/usageApi.ts`：

```ts
// 这周各智能体用了多少（#1356 A5）：GET /billing/v1/workspace-usage?workspace=<主场 id>（ADR-0221 / 0264）。
// 与桌面 hostedQuota.workspaceUsage 同一个请求、同一份解析（parseWorkspaceUsage / parseBillingError）。
import { parseBillingError, parseWorkspaceUsage, type WorkspaceUsage } from "../../../src/shared/billing.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

export async function fetchWorkspaceUsage(workspaceId: string): Promise<WorkspaceUsage> {
  const token = await edgeToken();
  if (token === null) throw new Error("还没登录。");
  const res = await fetch(`${EDGE_BASE}/billing/v1/workspace-usage?workspace=${encodeURIComponent(workspaceId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = parseBillingError(res.status, payload);
    throw new Error(e !== null && e.message !== "" ? e.message : `HTTP ${res.status}`);
  }
  const usage = parseWorkspaceUsage(payload);
  if (usage === null) throw new Error("用量的形状不对。");
  return usage;
}
```

`mobile/src/machine/machineStore.ts`：

```ts
// 「它们的电脑」那几屏共用的两份数据（#1356 A5，spec §5.8）：记忆的索引（目录那一行的页数、记忆清单、名册搜索的
// 记忆那一半都读它）与这周的用量（目录那一行的百分比、用量页）。文件与单页各屏自己读，不进这里。
// 纪律同 homeStore：换号就清、读不到 ≠ 空（上一份留着，错误另挂）、同时来的几次合成一次。
import { useSyncExternalStore } from "react";
import {
  usageAfterError, usageErrorText, wikiIndexAfterError, wikiIndexFrom, type UsageLoad, type WikiIndexState,
} from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, WIKI_INDEX_PATH } from "../../../src/shared/wiki.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchWorkspaceUsage } from "./usageApi.js";

export interface MachineState {
  /** 下面两份是哪个主场的（换了号 / 换了主场就清） */
  homeId: string | null;
  wiki: WikiIndexState;
  usage: UsageLoad;
}

const INITIAL: MachineState = { homeId: null, wiki: { kind: "loading" }, usage: { kind: "loading" } };
const store = createStore<MachineState>(INITIAL);

export function useMachine(): MachineState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let wikiInflight: Promise<void> | null = null;
let usageInflight: Promise<void> | null = null;
let owner: string | null | undefined;
let epoch = 0;

function reset(homeId: string | null): void {
  epoch += 1;
  wikiInflight = null;
  usageInflight = null;
  store.set({ ...INITIAL, homeId });
}

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  reset(null);
});

/** 换了主场（一个号只有一个；防的是换号那一拍的交错）：先清再读，不拿上一份顶 */
function adopt(homeId: string): void {
  if (store.get().homeId !== homeId) reset(homeId);
}

/** 读一遍记忆的索引（wiki/index.md，走控制房的 files 帧，不用先进哪条聊天） */
export function refreshWiki(homeId: string): Promise<void> {
  adopt(homeId);
  if (wikiInflight !== null) return wikiInflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      await ensureUid();
      const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${WIKI_INDEX_PATH}`);
      if (mine !== epoch) return;
      store.set((s) => ({ wiki: r.ok ? wikiIndexFrom(r.value) : wikiIndexAfterError(s.wiki, r.message) }));
    } catch (e) {
      if (mine === epoch) store.set((s) => ({ wiki: wikiIndexAfterError(s.wiki, e instanceof Error ? e.message : String(e)) }));
    } finally {
      if (wikiInflight === run) wikiInflight = null;
    }
  };
  run = task();
  wikiInflight = run;
  return run;
}

/** 读一遍这周的用量 */
export function refreshUsage(homeId: string): Promise<void> {
  adopt(homeId);
  if (usageInflight !== null) return usageInflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      const usage = await fetchWorkspaceUsage(homeId);
      if (mine === epoch) store.set({ usage: { kind: "ok", usage } });
    } catch (e) {
      if (mine === epoch) {
        const message = usageErrorText(e instanceof Error ? e.message : String(e));
        store.set((s) => ({ usage: usageAfterError(s.usage, message) }));
      }
    } finally {
      if (usageInflight === run) usageInflight = null;
    }
  };
  run = task();
  usageInflight = run;
  return run;
}
```

- [ ] **Step 4: 外观偏好 `mobile/src/themePref.ts` + 冷启动读一次**

```ts
// 外观偏好（#1356 A5，spec §5.8 的「设置」）：跟随系统 / 浅色 / 深色。存在这台手机的 kv-store 里（同 supabase 的
// session 那一份），生效靠 RN 的 Appearance.setColorScheme——theme.ts 的 usePalette 读的 useColorScheme 跟着它走，
// 原生那几样（键盘、状态栏、SFSafariViewController）也跟着走。偏好属于这台手机，不跟账号走、登出不清。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { colorSchemeOf, parseThemePref, type ThemePref } from "../../src/shared/mobileAccount.js";
import { createStore } from "./externalStore.js";

const KEY = "otto.themePref";
const store = createStore<{ pref: ThemePref }>({ pref: "system" });

export function useThemePref(): ThemePref {
  return useSyncExternalStore(store.subscribe, () => store.get().pref);
}

function apply(pref: ThemePref): void {
  store.set({ pref });
  Appearance.setColorScheme(colorSchemeOf(pref));
}

/** 冷启动时读一次（App.tsx 模块顶层调）：读到之前跟随系统；读不到也跟随系统 */
export async function loadThemePref(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {
    // 读不到 = 跟随系统
  }
  apply(parseThemePref(raw));
}

export async function setThemePref(pref: ThemePref): Promise<void> {
  apply(pref);
  try {
    if (pref === "system") await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, pref);
  } catch {
    // 存不下：这一次照样生效，下次冷启动回到跟随系统
  }
}
```

`mobile/App.tsx`：在最后一条 import 之后、第一个函数 / 常量定义之前加：

```ts
import { loadThemePref } from "./src/themePref.js";

// 外观偏好冷启动时读一次（A5）：读回来之前那几帧跟随系统——冷启动有 Splash 挡着，看不见那一下切换
void loadThemePref();
```

（import 放进 import 区，`void loadThemePref();` 放在 import 区之后。）

- [ ] **Step 5: 行首小图标与计量条**

`mobile/src/chrome/RowGlyphs.tsx`：

```tsx
// 设置类清单行左边那一格（#1356 A5）：demo 的 `.ico`——29×29、圆角 8、次级底，里面一枚 15pt 的描边图标。
// 路径逐字取自 demo 的图标表（24×24 视框、线宽 2、圆头圆角，同 VoiceGlyphs 的画法）。颜色缺省是前景色。
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { usePalette } from "../theme.js";

export type RowGlyphName = "spark" | "chart" | "cloud" | "gear" | "folder" | "file" | "image" | "plug" | "book";

const PATHS: Record<RowGlyphName, string> = {
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  chart: "M3 3v18h18M7 15l4-5 3 3 5-7",
  cloud: "M18 16.5a4 4 0 0 0-.9-7.9 6 6 0 0 0-11.5 1.9A3.5 3.5 0 0 0 6 17.5z",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  image: "M3 5h18v14H3zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5-9 9",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
};

export function RowGlyph({ name, color }: { name: RowGlyphName; color?: string }) {
  const { c } = usePalette();
  return (
    <View style={{ width: 29, height: 29, borderRadius: 8, backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
      <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color ?? c.foreground} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d={PATHS[name]} />
      </Svg>
    </View>
  );
}
```

`mobile/src/chrome/Meter.tsx`：

```tsx
// 一根计量条（#1356 A5）：demo 的 `.meter` / `.ubar`——6pt 高、3pt 圆角，轨道是次级底色，填充色由调用方给
// （充足时弱色、快用完时 warn、用完 destructive——颜色只用来说「出事了」，ADR-0239）。dim = 用量页每一行那种淡一档的条
import { View, type StyleProp, type ViewStyle } from "react-native";
import { usePalette } from "../theme.js";

export function Meter({ fill, color, dim = false, style }: { fill: number; color: string; dim?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = usePalette();
  const pct = Math.round(Math.min(1, Math.max(0, fill)) * 1000) / 10;
  return (
    <View style={[{ height: 6, borderRadius: 3, backgroundColor: c.secondary, overflow: "hidden" }, style]}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 3, backgroundColor: color, opacity: dim ? 0.75 : 1 }} />
    </View>
  );
}
```

- [ ] **Step 6: `ui.tsx`——`Row` 多两格、`useNow`、`Labeled`**

`Row`（`export function Row(props: {` 那一段）：
1. props 类型里在 `label: string;` 之后加：

```ts
  /** 第二行小字（demo 的 `.sub`）：这一行「里面有什么」。给了它，左边那一块改成可收缩的两行、右边收成自然宽 */
  detail?: string;
```

   在 `chevron?: boolean;` 之后加：

```ts
  /** 单选清单里被选中的那一行：右边一枚点缀色的勾（iOS 设置的单选语汇，外观那一组用） */
  checked?: boolean;
```

2. 函数体里 `const center = props.align === "center";` 之后加一行 `const two = props.detail !== undefined;`
3. `const body = (` 那一段整段换成：

```tsx
  const body = (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.sm,
      paddingHorizontal: space.md, paddingVertical: two ? 10 : 12,
      minHeight: two ? 52 : 44, // HIG 的最小可点高度；带第二行时照 demo 的 .row（52）
      justifyContent: center ? "center" : "space-between",
    }}>
      {/* 单行：左边不收缩、右边收缩（要截也该截机器数据那一串，不是"中继"这两个字）。
          两行：反过来——左边那两行是主角、可以截断，右边是「Max」「3 页」这种短值 */}
      <View style={two
        ? { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm }
        : { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
        {props.leading}
        {two ? (
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ ...type.body, color: fg }} numberOfLines={1}>{props.label}</Text>
            <Text style={{ ...type.footnote, color: c.mutedForeground, marginTop: 1 }} numberOfLines={1}>{props.detail}</Text>
          </View>
        ) : (
          <Text style={{ ...type.body, color: fg }} numberOfLines={1}>{props.label}</Text>
        )}
      </View>
      {center ? null : (
        <View style={two
          ? { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: space.xs }
          : { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs }}>
          {props.value === undefined ? null : (
            <Text
              style={props.mono
                ? { ...type.footnote, fontFamily: MONO, color: c.mutedForeground }
                : { ...type.body, color: c.mutedForeground }}
              numberOfLines={1}
              ellipsizeMode={props.mono ? "middle" : "tail"}
              // 长按能拷走。手机上没有别的办法把这串东西送进工单里
              selectable={props.mono && !props.onPress}
            >
              {props.value}
            </Text>
          )}
          {props.checked ? <CheckGlyph color={c.brand} size={14} /> : null}
          {props.chevron ? <Chevron color={c.mutedForeground} /> : null}
        </View>
      )}
    </View>
  );
```

   并在 `ui.tsx` 的 import 区加 `import { CheckGlyph } from "./chrome/Glyphs.js";`（`Glyphs.tsx` 只 import react-native，不会绕回来）。

`useNow`：加在 `useReduceMotion` 之后（`useState` / `useEffect` 若 `ui.tsx` 还没 import，就加进 react 那条 import）：

```ts
/** 此刻（毫秒），每 periodMs 刷新一次：倒计时、「刚刚 / 12:41」这种按分钟变的字用它，不在渲染里裸读 Date.now()
    （裸读的话只在别的东西触发重画时才变，放着不动的一页会一直写「1h 38m 后刷新」） */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}
```

`Labeled`：把 `mobile/src/agent/AgentSettingsScreen.tsx` 第 44–56 行的 `function Labeled` **剪**到 `ui.tsx`（放在 `Field` 之后），改成导出、用 `ui.tsx` 自己的名字：

```tsx
/** 表单里一格：上面一行小字标签（可带一句提示）、下面是输入框、再下面是这一格的错误（#1356 A1 起智能体设置在用，
    A5 改记忆那一页也用，挪进组件层） */
export function Labeled({ label, hint, error, children }: { label: string; hint?: string; error: string | null; children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ ...type.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>
        {label}
        {hint ? ` · ${hint}` : ""}
      </Text>
      {children}
      {error ? <Text style={{ ...type.footnote, color: c.destructive, paddingHorizontal: 4 }}>{error}</Text> : null}
    </View>
  );
}
```

`AgentSettingsScreen.tsx`：删掉那个本地 `function Labeled`，把 `Labeled` 加进它从 `../ui.js` 的那条 import；若删完之后 `ReactNode` 的 import 没人用了就一起删（`tsc` 会指出来）。

- [ ] **Step 7: 手机 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck && npx tsc --noEmit
```

Expected: 两边零错误。常见坑：`exactOptionalPropertyTypes` 下可选 prop 不许传 `undefined`；`WebBrowser.WebBrowserPresentationStyle` 的枚举名以 `mobile/node_modules/expo-web-browser/build/WebBrowser.types.d.ts` 为准（2026-09-27 核过是 `FULL_SCREEN`）。

- [ ] **Step 8: 提交**

```
feat(mobile): A5 的基础件——订阅快照与开支付页、那台电脑的两份数据、外观偏好、行首图标、行的两格（#1356 A5）

订阅快照：支付页开在 App 内浏览器里（SFSafariViewController，整屏升起、左上「完成」），Stripe 走完落在
edge 自己那一句话的页面、不回跳 App，所以关掉那一刻重拉；结账那一趟没变就隔 2 秒再拉，最多两次（webhook
可能比人点「完成」还慢）。那台电脑：记忆索引与这周用量两份共用数据，换号就清、读不到 ≠ 空。外观：存在
这台手机上，靠 Appearance.setColorScheme 生效。Row 多「第二行小字」与「单选的勾」两格；Labeled 从智能体
设置挪进 ui.tsx（改记忆那一页也用）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/edge.ts mobile/src/home/billing.ts mobile/src/account/billingStore.ts mobile/src/machine/usageApi.ts mobile/src/machine/machineStore.ts mobile/src/themePref.ts mobile/App.tsx mobile/src/chrome/RowGlyphs.tsx mobile/src/chrome/Meter.tsx mobile/src/ui.tsx mobile/src/agent/AgentSettingsScreen.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 5: 订阅页 + 名册进门那两态给钮

订阅页：几张档位卡（从贵到便宜、当前那一档一圈点缀色边 +「你在这一档」、Free 虚线）、每张卡的钮（没订阅「订阅 X」走 checkout、订着的人「换到 X」走 Portal）、扣款没成功那一张（「更新付款方式」走 Portal）、扣款日期、组尾一句、「管理订阅 · 发票」（订过才画）。回来那几秒页顶一行「正在从 Stripe 同步…」。名册进门「没订阅 / 档位不带」两态：A5 之前「不画一颗点了没去处的钮」，现在有了去处——各给一颗「去订阅」「去换档」。

**Files:**
- Create: `mobile/src/account/SubscriptionScreen.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/roster/RosterScreen.tsx`

**Interfaces:**
- Consumes: Task 2 的 `planOffers`、`subscriptionNotes`、`SUBSCRIPTION_FOOTER`、`type PlanOfferView`、`type PlanOfferAction`；Task 4 的 `useBilling`、`refreshBilling`、`openBillingLink`、`type BillingLinkTarget`；既有 `CheckGlyph`、`Button` / `Card` / `Hint` / `Note` / `Page` / `Spinner` / `StatusLine`、`withAlpha`。
- Produces: 路由 `Subscription: undefined`（Task 9 的账号页链过来）。

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里 `Account: undefined;` 之后加：

```ts
  /** 订阅（A5）：账号页「订阅」那一行、名册进门「没订阅 / 档位不带」那颗钮进来 */
  Subscription: undefined;
```

`mobile/src/nav/RootNavigator.tsx`：import 区加 `import { SubscriptionScreen } from "../account/SubscriptionScreen.js";`；`Account` 那一行 `Root.Screen` 之后加：

```tsx
        <Root.Screen name="Subscription" component={SubscriptionScreen} options={{ title: "订阅", headerBackTitle: "返回" }} />
```

- [ ] **Step 2: `mobile/src/account/SubscriptionScreen.tsx`**

```tsx
// 订阅（#1356 A5，spec §5.8）：几张档位卡 + 管理订阅。判据在 shared 的 mobileAccount（planOffers / subscriptionNotes）。
// 钮的去处（ADR-0203 决定 18）：没订阅 → checkout 开一张；订着的人换档 → Customer Portal（再开一张 checkout 会变成
// 两条订阅、两笔一起扣，网关回 409）。支付页开在 App 内浏览器里（整屏升起、左上「完成」），关掉那一刻重拉订阅。
// 不走 IAP（spec §12 第 6 条）：手机端不上架，上架那天要重判。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect } from "react";
import { AppState, Text, View } from "react-native";
import {
  planOffers, subscriptionNotes, SUBSCRIPTION_FOOTER, type PlanOfferAction, type PlanOfferView,
} from "../../../src/shared/mobileAccount.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { type as t, space, usePalette, withAlpha } from "../theme.js";
import { Button, Card, Hint, Note, Page, Spinner, StatusLine } from "../ui.js";
import { openBillingLink, refreshBilling, useBilling, type BillingLinkTarget } from "./billingStore.js";

export function SubscriptionScreen() {
  const { c } = usePalette();
  const { billing, loaded, loadError, link } = useBilling();

  useFocusEffect(
    useCallback(() => {
      void refreshBilling();
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshBilling();
    });
    return () => sub.remove();
  }, []);

  const me = billing?.me ?? null;
  if (me === null) {
    // 还没查到 ≠ 没订阅：不画任何一张卡（画出来就是替他下了结论）
    return (
      <Page>
        {loaded && loadError !== null ? (
          <View style={{ gap: space.sm }}>
            <Note tone="warn">{loadError}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshBilling()} />
            </View>
          </View>
        ) : (
          <Spinner />
        )}
      </Page>
    );
  }

  const offers = planOffers(me);
  const notes = subscriptionNotes(me);
  const busy = link.kind === "opening" || link.kind === "syncing";
  const opening = (key: string): boolean => link.kind === "opening" && link.key === key;
  const open = (target: BillingLinkTarget, key: string): void => {
    void openBillingLink(target, key);
  };
  const act = (key: string, a: PlanOfferAction): void =>
    open(a.kind === "checkout" ? { kind: "checkout", planId: a.planId } : { kind: "portal" }, key);

  return (
    <Page>
      <View style={{ gap: space.md }}>
        {link.kind === "syncing" ? <StatusLine tone="busy">正在从 Stripe 同步…</StatusLine> : null}
        {link.kind === "error" ? <Note tone="error">{link.message}</Note> : null}
        {loadError !== null ? <Note tone="warn">{loadError}</Note> : null}
        {notes.pastDue !== null ? (
          <Card>
            <Text style={{ ...t.callout, color: c.warn }}>{notes.pastDue}</Text>
            <Button
              size="compact"
              label={opening("pastDue") ? "正在打开…" : "更新付款方式"}
              disabled={busy}
              onPress={() => open({ kind: "portal" }, "pastDue")}
            />
          </Card>
        ) : null}
        {offers.map((o) => (
          <PlanCard key={o.key} offer={o} opening={opening(o.key)} disabled={busy} onAction={(a) => act(o.key, a)} />
        ))}
        {notes.period !== null ? <Hint>{notes.period}</Hint> : null}
        <Hint>{SUBSCRIPTION_FOOTER}</Hint>
        {notes.canManage ? (
          <Button
            variant="secondary"
            label={opening("manage") ? "正在打开…" : "管理订阅 · 发票"}
            disabled={busy}
            onPress={() => open({ kind: "portal" }, "manage")}
          />
        ) : null}
      </View>
    </Page>
  );
}

/** 一张档位卡（demo 的 subscription 那几张 .card）：名字 + 价格一行、下面几行「带什么」、最底下那颗钮。
    当前这一档一圈点缀色边 +「你在这一档」；Free 是虚线、透明底、没有钮（它不是一件可买的东西） */
function PlanCard({ offer, opening, disabled, onAction }: {
  offer: PlanOfferView;
  opening: boolean;
  disabled: boolean;
  onAction: (a: PlanOfferAction) => void;
}) {
  const { c } = usePalette();
  const frame = offer.current
    ? { borderWidth: 1.5, borderColor: c.brand }
    : offer.free
      ? { borderStyle: "dashed" as const, borderWidth: 1, borderColor: c.border, backgroundColor: "transparent" }
      : null;
  const action = offer.action;
  return (
    <Card style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 18, lineHeight: 23, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }}>{offer.name}</Text>
        {offer.current ? (
          <View style={{ height: 22, paddingHorizontal: 9, borderRadius: 999, justifyContent: "center", backgroundColor: withAlpha(c.brand, 0.18) }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: c.brand }}>你在这一档</Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: "600", color: c.foreground }}>{offer.price}</Text>
      </View>
      <View style={{ gap: 6 }}>
        {offer.lines.map((l) => (
          <View key={l.text} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <View style={{ width: 14, paddingTop: 4, alignItems: "center" }}>
              {l.ok ? (
                <CheckGlyph color={c.ok} size={12} />
              ) : (
                <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: c.mutedForeground, marginTop: 5 }} />
              )}
            </View>
            <Text style={{ ...t.callout, color: l.ok ? c.foreground : c.mutedForeground, flex: 1 }}>{l.text}</Text>
          </View>
        ))}
      </View>
      {action !== null ? (
        <Button
          size="compact"
          variant={action.kind === "checkout" ? "primary" : "outline"}
          label={opening ? "正在打开…" : action.label}
          disabled={disabled}
          onPress={() => onAction(action)}
        />
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 3: 名册进门那两态给钮**

`mobile/src/roster/RosterScreen.tsx`：
1. 头注第 4–5 行 `//   一句实话、不画钮（A5 之前手机上办不了订阅）；建失败 → 原因 + 重试钮、不自动重试；` 换成 `//   一句实话 + 一颗去「订阅」的钮（A5 起手机上办得了订阅）；建失败 → 原因 + 重试钮、不自动重试；`（按源文件原样定位这一行；若它与上一行的断行位置不同，只改「不画钮（A5 之前手机上办不了订阅）」这一截的意思）。
2. `function GateView({ gate, ensureError, loadError }: { gate: RosterGate; ensureError: string | null; loadError: string | null }) {` 换成 `function GateView({ gate, ensureError, loadError, onSubscribe }: { gate: RosterGate; ensureError: string | null; loadError: string | null; onSubscribe: () => void }) {`
3. 它里面的 `const say = (lead: string, hint: string) => (` 那一段（到 `);` 为止）换成：

```tsx
  const say = (lead: string, hint: string, action: string) => (
    <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
      <View style={{ gap: space.xs }}>
        <Text style={{ ...t.headline, color: c.foreground }}>{lead}</Text>
        <Text style={{ ...t.callout, color: c.mutedForeground }}>{hint}</Text>
      </View>
      <View style={{ alignItems: "flex-start" }}>
        <Button size="auto" label={action} onPress={onSubscribe} />
      </View>
    </View>
  );
```

4. 两个 case：

```tsx
    case "no_subscription":
      return say("订阅 Pro 或 Max 之后才建得了智能体。", "在「订阅」里挑一档，订好回来就能用。", "去订阅");
    case "plan_too_low":
      return say("你现在的订阅档位建不了智能体，Pro 或 Max 才行。", "在「订阅」里换到 Pro 或 Max。", "去换档");
```

5. `RosterScreen` 里渲染 `GateView` 那一处 `<GateView gate={gate} ensureError={home.ensureError} loadError={home.loadError} />` 加一个 prop：`onSubscribe={() => navigation.navigate("Subscription")}`。

（订好回来：名册是 `useFocusEffect` 刷新的，还没有主场时 `refreshHome` 会重拉订阅，档位对了就自己建主场——这条路 A1 就在，不用改。）

- [ ] **Step 4: 手机 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck
```

Expected: 零错误。

- [ ] **Step 5: 提交**

```
feat(mobile): 订阅页；名册没订阅 / 档位不带那两态给一颗去订阅的钮（#1356 A5）

档位卡只列这个 App 用得上的档 + 此刻订着的那一档 + Free，从贵到便宜；没订阅「订阅 X」走 checkout，
订着的人「换到 X」走 Portal（ADR-0203 决定 18）；扣款没成功那张给「更新付款方式」；「管理订阅 · 发票」
订过才画。回来那几秒页顶写「正在从 Stripe 同步…」。

名册那两态 A1 时「不画一颗点了没去处的钮」（手机上办不了订阅），现在有了去处。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/account/SubscriptionScreen.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx mobile/src/roster/RosterScreen.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 6: 文件——一层一页、一个文件一页

那台电脑上的工作文件夹（`/work`）。一次只列一层（`files` 帧），点目录压一页、点文件压一页预览；最外层那一页上面一条搜索框（按名找；`?` 开头按内容找）。文件只读、开头 64 KB、等宽、可以长按选中。**读不到 ≠ 空**：出错时上一份清单留在原地，错误另起一行。

**Files:**
- Create: `mobile/src/machine/FilesScreen.tsx`、`mobile/src/machine/FilePreviewScreen.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`

**Interfaces:**
- Consumes: Task 3 的 `FILES_FOOTER`、`FILES_SEARCH_PLACEHOLDER`、`baseName`、`workEntryRows`、`workFolderText`、`workFolderTruncated`、`workHitRows`、`workFileText`、`parseFileQuery`（在 `workFilesView`）；Task 4 的 `RowGlyph`、`Row` 的 `detail`、`useNow`；既有 `cloudClient.workspaceFiles` / `workspaceFilesSearch`、`ensureUid`、`useHome`。
- Produces: 路由 `Files: { path: string }`（`""` = 最外层）、`FilePreview: { path: string }`（Task 7 不用；Task 8 的「它们的电脑」链到 `Files`）。

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里 `Subscription: undefined;` 之后加：

```ts
  /** 那台电脑上的一层文件夹（A5）；path 相对 /work，"" = 最外层。点子目录压一页同名屏 */
  Files: { path: string };
  /** 一个文件（A5）：只读，开头 64 KB */
  FilePreview: { path: string };
```

`mobile/src/nav/RootNavigator.tsx`：import 区加 `import { FilesScreen } from "../machine/FilesScreen.js";`、`import { FilePreviewScreen } from "../machine/FilePreviewScreen.js";`；`Subscription` 那一行之后加：

```tsx
        {/* 标题由这两页自己按路径 setOptions（最外层写「文件」，其余写那一段的名字） */}
        <Root.Screen name="Files" component={FilesScreen} options={{ title: "文件", headerBackTitle: "返回" }} />
        <Root.Screen name="FilePreview" component={FilePreviewScreen} options={{ title: "", headerBackTitle: "返回" }} />
```

- [ ] **Step 2: `mobile/src/machine/FilesScreen.tsx`**

```tsx
// 文件（#1356 A5，spec §5.8）：它们那台电脑上的工作文件夹（/work，ADR-0251）。一次只列一层（files 帧，ADR-0253），
// 点目录压一页、点文件压一页预览；最外层那一页上面一条搜索框（按名找；`?` 开头按内容找，桌面同一个约定）。
// **读不到 ≠ 空**：出错时上一份清单留在原地，错误另起一行（ADR-0243 那一族）。文件下不到手机上（组尾说清）。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import {
  FILES_FOOTER, FILES_SEARCH_PLACEHOLDER, baseName, workEntryRows, workFolderText, workFolderTruncated, workHitRows,
} from "../../../src/shared/mobileMachine.js";
import type { CsWorkHit, CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import { parseFileQuery } from "../../../src/shared/workFilesView.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space } from "../theme.js";
import { Button, Field, Group, Hint, Note, Page, Row, Spinner, useNow } from "../ui.js";

type Props = NativeStackScreenProps<RootStackParams, "Files">;

export function FilesScreen({ route, navigation }: Props) {
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const now = useNow(60_000);
  const [node, setNode] = useState<CsWorkNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CsWorkHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: path === "" ? "文件" : baseName(path) });
  }, [navigation, path]);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, path);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setError(null);
    setNode(r.value);
  }, [homeId, path]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 搜索只在最外层那一页（files_search 本来就搜整个文件夹）。去抖 250ms；空的 = 回到清单
  const q = path === "" ? parseFileQuery(query) : null;
  const term = q?.term ?? null;
  const content = q?.content ?? false;
  useEffect(() => {
    if (term === null || homeId === null) {
      setHits(null);
      setSearchNote(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const r = await cloudClient.workspaceFilesSearch(homeId, term, content);
        setSearching(false);
        if (r.ok) {
          setHits(r.value);
          setSearchNote(null);
          return;
        }
        // 降级要说出来：不说的话空结果读起来就是「那台电脑上没有」（桌面同一条）
        setHits([]);
        setSearchNote(r.message);
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [term, content, homeId]);

  if (homeId === null) {
    return <Page><Hint>还没有智能体，也就还没有这台电脑。</Hint></Page>;
  }

  const openDir = (p: string): void => navigation.push("Files", { path: p });
  const openFile = (p: string): void => navigation.push("FilePreview", { path: p });
  const notice = node === null ? null : workFolderText(node);
  const truncated = node === null ? null : workFolderTruncated(node);
  const rows = node !== null && node.kind === "dir" ? workEntryRows(path, node.entries, now) : [];

  return (
    <Page>
      <View style={{ gap: space.md }}>
        {path === "" ? (
          <Field value={query} onChangeText={setQuery} placeholder={FILES_SEARCH_PLACEHOLDER} returnKeyType="search" />
        ) : null}
        {hits !== null ? (
          <View style={{ gap: space.sm }}>
            {searchNote !== null ? <Note tone="warn">{searchNote}</Note> : null}
            {hits.length === 0 && searchNote === null && !searching ? (
              <Hint>{`没有找到「${(term ?? "").trim()}」`}</Hint>
            ) : null}
            {hits.length > 0 ? (
              <Group>
                {workHitRows(hits).map((h) => (
                  <Row key={h.key} leading={<RowGlyph name={h.icon} />} label={h.title} detail={h.detail} chevron onPress={() => openFile(h.path)} />
                ))}
              </Group>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: space.sm }}>
            {error !== null ? (
              <View style={{ gap: space.sm }}>
                <Note tone="warn">{node === null ? `读不到这个文件夹：${error}` : `这一刻读不到（${error}），下面是上一次的。`}</Note>
                <View style={{ alignItems: "flex-start" }}>
                  <Button size="auto" variant="outline" label="重试" onPress={() => void load()} />
                </View>
              </View>
            ) : null}
            {node === null && error === null ? <Spinner /> : null}
            {notice !== null ? <Hint>{notice}</Hint> : null}
            {rows.length > 0 ? (
              <Group {...(truncated === null ? {} : { footer: truncated })}>
                {rows.map((r) => (
                  <Row
                    key={r.key}
                    leading={<RowGlyph name={r.icon} />}
                    label={r.name}
                    {...(r.meta === "" ? {} : { detail: r.meta })}
                    {...(r.opens === null ? {} : { chevron: true, onPress: () => (r.opens === "dir" ? openDir(r.path) : openFile(r.path)) })}
                  />
                ))}
              </Group>
            ) : null}
            {path === "" ? <Hint>{FILES_FOOTER}</Hint> : null}
          </View>
        )}
      </View>
    </Page>
  );
}
```

- [ ] **Step 3: `mobile/src/machine/FilePreviewScreen.tsx`**

```tsx
// 一个文件（#1356 A5）：只读，开头 64 KB（files 帧的上限，ADR-0251），等宽、可以长按选中拷走；二进制 / 截断 / 空文件
// 各说一句（shared 的 workFileText）。按名搜出来的可能是个文件夹——那就把这一页换成文件夹那一页。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { baseName, workFileText } from "../../../src/shared/mobileMachine.js";
import type { CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { MONO, space, usePalette } from "../theme.js";
import { Button, Card, Hint, Note, Spinner } from "../ui.js";

type Props = NativeStackScreenProps<RootStackParams, "FilePreview">;

export function FilePreviewScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const [node, setNode] = useState<CsWorkNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: baseName(path) });
  }, [navigation, path]);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, path);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (r.value.kind === "dir") {
      navigation.replace("Files", { path });
      return;
    }
    setError(null);
    setNode(r.value);
  }, [homeId, path, navigation]);
  useEffect(() => {
    void load();
  }, [load]);

  const notice = node === null ? null : workFileText(node);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
    >
      {error !== null ? (
        <View style={{ gap: space.sm }}>
          <Note tone="warn">{`读不到这个文件：${error}`}</Note>
          <View style={{ alignItems: "flex-start" }}>
            <Button size="auto" variant="outline" label="重试" onPress={() => void load()} />
          </View>
        </View>
      ) : null}
      {node === null && error === null ? <Spinner /> : null}
      {node !== null && node.kind === "file" && node.text !== "" ? (
        <Card>
          <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: c.foreground }}>{node.text}</Text>
        </Card>
      ) : null}
      {notice !== null ? <Hint>{notice}</Hint> : null}
    </ScrollView>
  );
}
```

- [ ] **Step 4: 手机 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck
```

Expected: 零错误。

- [ ] **Step 5: 提交**

```
feat(mobile): 那台电脑的文件——一层一页、一个文件一页、最外层能搜（#1356 A5）

files 帧一次只列一层（ADR-0253），点目录压一页、点文件压一页预览；最外层上面一条搜索框，按名找、`?`
开头按内容找（桌面同一个约定，判据在 shared）。文件只读、开头 64 KB、等宽可选中；三种「空」分开说。
读不到 ≠ 空：出错时上一份清单留着，错误另起一行。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/machine/FilesScreen.tsx mobile/src/machine/FilePreviewScreen.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 7: 记忆——清单、一页、改一页；名册搜索的记忆那一半

记忆清单读 `wiki/index.md`（分组照索引，`agents` 那一组换成「各只自己那一页」），点一页压进去：标题、「谁写的 · 什么时候 · 常驻」、摘要、正文（纯文本可选中）、「它提到的」那几页；右上「改」压一页表单：标题 / 摘要 / 常驻 / 正文，右上「存」。手机上不新建、不删除。名册搜索：打开搜索时读一次记忆索引，有字时名册结果底下多一组「记忆」。

**Files:**
- Create: `mobile/src/machine/WikiScreen.tsx`、`mobile/src/machine/WikiPageScreen.tsx`、`mobile/src/machine/WikiEditScreen.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/roster/RosterScreen.tsx`

**Interfaces:**
- Consumes: Task 3 的 `WIKI_ABSENT`、`WIKI_EMPTY`、`WIKI_FOOTER`、`wikiGroupsOf`、`wikiGroupTitle`、`wikiPageFrom`、`wikiMetaLine`、`wikiLinkRows`、`wikiMatches`、`wikiEditError`、`type WikiPageLoad`；Task 4 的 `useMachine`、`refreshWiki`、`RowGlyph`、`Row` 的 `detail`、`useNow`、`Labeled`；既有 `HeaderTextButton`、`cloudClient.workspaceFiles` / `workspaceWikiWrite`、`ensureUid`、`WIKI_DIR` / `WIKI_TITLE_MAX` / `WIKI_SUMMARY_MAX`（`src/shared/wiki.ts`）、`type WikiPage`。
- Produces: 路由 `Wiki: undefined`、`WikiPage: { path: string }`（path 是 wiki 目录下的相对路径，如 `customers/acme.md`）、`WikiEdit: { path: string }`（Task 8 的「它们的电脑」链到 `Wiki`）。

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里 `FilePreview: { path: string };` 之后加：

```ts
  /** 记忆清单（A5）：它们自己维护的 wiki */
  Wiki: undefined;
  /** 记忆里的一页（A5）；path 是 wiki/ 底下的相对路径，如 customers/acme.md */
  WikiPage: { path: string };
  /** 改记忆里的一页（A5） */
  WikiEdit: { path: string };
```

`mobile/src/nav/RootNavigator.tsx`：import 三个屏（`WikiScreen` / `WikiPageScreen` / `WikiEditScreen`，都从 `../machine/…js`）；`FilePreview` 那一行之后加：

```tsx
        <Root.Screen name="Wiki" component={WikiScreen} options={{ title: "记忆", headerBackTitle: "返回" }} />
        <Root.Screen name="WikiPage" component={WikiPageScreen} options={{ title: "", headerBackTitle: "返回", headerShadowVisible: false }} />
        <Root.Screen name="WikiEdit" component={WikiEditScreen} options={{ title: "改这一页", headerBackTitle: "返回", headerShadowVisible: false }} />
```

- [ ] **Step 2: `mobile/src/machine/WikiScreen.tsx`**

```tsx
// 记忆（#1356 A5，spec §5.8）：它们自己维护的那一叠互链页面（ADR-0282 的 wiki，住在那台电脑的 wiki/ 里）。清单读
// wiki/index.md（分组照索引：常驻 / 各只自己那一页 / 各个目录），点一页压进去看。手机上能改、不能新建或删（demo 只有
// 「改」；新建要起路径名，留在电脑上）。**读不到 ≠ 空**：上一份清单留在原地，错误另起一行。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { WIKI_ABSENT, WIKI_EMPTY, WIKI_FOOTER, wikiGroupsOf, wikiGroupTitle } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Button, Group, Hint, Note, Page, Row, Spinner } from "../ui.js";
import { refreshWiki, useMachine } from "./machineStore.js";

export function WikiScreen() {
  const navigation = useNavigation();
  const ws = useHome().home;
  const { wiki } = useMachine();
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId !== null) void refreshWiki(homeId);
    }, [homeId]),
  );

  if (homeId === null) {
    return <Page><Hint>还没有智能体，也就还没有记忆。</Hint></Page>;
  }
  const groups = wikiGroupsOf(wiki);
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        {wiki.kind === "error" ? (
          <View style={{ gap: space.sm }}>
            <Note tone="warn">{groups === null ? `这一刻读不到记忆：${wiki.message}` : `这一刻读不到最新的（${wiki.message}），下面是上一次的。`}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshWiki(homeId)} />
            </View>
          </View>
        ) : null}
        {wiki.kind === "loading" ? <Spinner /> : null}
        {wiki.kind === "absent" ? <Hint>{WIKI_ABSENT}</Hint> : null}
        {groups !== null && groups.length === 0 ? <Hint>{WIKI_EMPTY}</Hint> : null}
        {(groups ?? []).map((g) => (
          <Group key={g.name} header={wikiGroupTitle(g.name)}>
            {g.entries.map((e) => (
              <Row
                key={e.path}
                leading={<RowGlyph name="book" />}
                label={e.title}
                detail={e.summary === "" ? e.path : e.summary}
                chevron
                onPress={() => navigation.navigate("WikiPage", { path: e.path })}
              />
            ))}
          </Group>
        ))}
        {groups !== null && groups.length > 0 ? <Hint>{WIKI_FOOTER}</Hint> : null}
      </View>
    </Page>
  );
}
```

- [ ] **Step 3: `mobile/src/machine/WikiPageScreen.tsx`**

```tsx
// 记忆里的一页（#1356 A5）：标题、「谁写的 · 什么时候 · 常驻」、摘要、正文（纯文本，可长按选中；markdown 不渲染——手机
// 端没有 markdown 渲染器，不为它加依赖）、「它提到的」那几页（正文里的 [[链接]]）。右上「改」压改这一页。
// **读不到 ≠ 空**：上一次读到的这一页留着，错误另起一行。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { wikiGroupsOf, wikiLinkRows, wikiMetaLine, wikiPageFrom } from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, type WikiPage } from "../../../src/shared/wiki.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { type as t, space, usePalette } from "../theme.js";
import { Card, Group, Note, Row, Spinner, useNow } from "../ui.js";
import { refreshWiki, useMachine } from "./machineStore.js";

type Props = NativeStackScreenProps<RootStackParams, "WikiPage">;

export function WikiPageScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const { wiki } = useMachine();
  const now = useNow(60_000);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (homeId === null) return;
    await ensureUid();
    const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${path}`);
    const got = r.ok ? wikiPageFrom(path, r.value) : { ok: false as const, message: r.message };
    if (!got.ok) {
      setError(got.message);
      return;
    }
    setError(null);
    setPage(got.page);
  }, [homeId, path]);
  // 改完回来要看见新的；索引没读过（从名册搜索直接点进来）就顺手读一次，「它提到的」要靠它认标题
  useFocusEffect(
    useCallback(() => {
      void load();
      if (homeId !== null) void refreshWiki(homeId);
    }, [load, homeId]),
  );

  const loaded = page !== null;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (loaded ? <HeaderTextButton label="改" disabled={false} onPress={() => navigation.navigate("WikiEdit", { path })} /> : null),
    });
  }, [navigation, loaded, path]);

  const links = page === null ? [] : wikiLinkRows(page, wikiGroupsOf(wiki) ?? []);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
    >
      {error !== null ? <Note tone="warn">{page === null ? error : `这一刻读不到最新的（${error}），下面是上一次的。`}</Note> : null}
      {page === null && error === null ? <Spinner /> : null}
      {page !== null ? (
        <>
          <View style={{ gap: 6 }}>
            <Text style={{ ...t.title, color: c.foreground }}>{page.front.title}</Text>
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{wikiMetaLine(page, now)}</Text>
            {page.front.summary !== "" ? <Text style={{ ...t.callout, color: c.foreground }}>{page.front.summary}</Text> : null}
          </View>
          <Card>
            <Text selectable style={{ ...t.callout, lineHeight: 23, color: page.body.trim() === "" ? c.mutedForeground : c.foreground }}>
              {page.body.trim() === "" ? "这一页还没有正文。" : page.body.trim()}
            </Text>
          </Card>
          {links.length > 0 ? (
            <Group header="它提到的">
              {links.map((e) => (
                <Row key={e.path} leading={<RowGlyph name="book" />} label={e.title} chevron onPress={() => navigation.push("WikiPage", { path: e.path })} />
              ))}
            </Group>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
```

- [ ] **Step 4: `mobile/src/machine/WikiEditScreen.tsx`**

```tsx
// 改记忆里的一页（#1356 A5）：标题 / 摘要 / 常驻 / 正文，右上「存」。走 wiki_write 帧——服务端与 wiki 工具同一条写入
// 路径（人改的和它们改的过同一道门：盖章、索引、日志、备份，ADR-0282）。**整页替换**：页头里的 sources 这张表改不了，
// 原样带回去（不带就是人每改一句正文就顺手删掉了它，桌面同一条）。进来时现读一遍，改的是此刻那一版。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { wikiEditError, wikiPageFrom } from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, WIKI_SUMMARY_MAX, WIKI_TITLE_MAX, type WikiPage } from "../../../src/shared/wiki.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { MONO, type as t, radius, space, usePalette } from "../theme.js";
import { Field, Labeled, Note, Spinner } from "../ui.js";
import { refreshWiki } from "./machineStore.js";

type Props = NativeStackScreenProps<RootStackParams, "WikiEdit">;

export function WikiEditScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { path } = route.params;
  const homeId = useHome().home?.id ?? null;
  const [page, setPage] = useState<WikiPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [pinned, setPinned] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (homeId === null) return;
      await ensureUid();
      const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${path}`);
      const got = r.ok ? wikiPageFrom(path, r.value) : { ok: false as const, message: r.message };
      if (!got.ok) {
        setLoadError(got.message);
        return;
      }
      setPage(got.page);
      setTitle(got.page.front.title);
      setSummary(got.page.front.summary);
      setPinned(got.page.front.pinned);
      setBody(got.page.body);
    })();
  }, [homeId, path]);

  const dirty = page !== null
    && (title !== page.front.title || summary !== page.front.summary || pinned !== page.front.pinned || body !== page.body);

  const save = async (): Promise<void> => {
    if (page === null || homeId === null || busy) return;
    const bad = wikiEditError({ title, summary, pinned, sources: page.front.sources });
    if (bad !== null) {
      setError(bad);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await cloudClient.workspaceWikiWrite(homeId, {
      op: "write", path, title, summary, pinned, body, sources: [...page.front.sources],
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    // 标题 / 摘要 / 常驻改了，索引跟着变
    void refreshWiki(homeId);
    navigation.goBack();
  };

  // 「存」挂法照 AgentSettingsScreen：按下去调 ref 里最新的 save；setOptions 只在「按不按得动 / 正在存」变了时重设
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderTextButton label={busy ? "正在存…" : "存"} disabled={!dirty || busy} onPress={() => void saveRef.current()} />
      ),
    });
  }, [navigation, dirty, busy]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      {loadError !== null ? <Note tone="warn">{`读不到这一页：${loadError}`}</Note> : null}
      {page === null && loadError === null ? <Spinner /> : null}
      {page !== null ? (
        <>
          <Labeled label="标题" error={null}>
            <Field value={title} onChangeText={setTitle} placeholder="这一页叫什么" maxLength={WIKI_TITLE_MAX} editable={!busy} />
          </Labeled>
          <Labeled label="摘要" hint="索引里就这一行" error={null}>
            <Field value={summary} onChangeText={setSummary} placeholder="一句话说这一页是什么" maxLength={WIKI_SUMMARY_MAX} editable={!busy} />
          </Labeled>
          <View style={{
            flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 10,
            backgroundColor: c.card, borderRadius: radius.control, borderWidth: 1, borderColor: c.input,
          }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...t.body, color: c.foreground }}>常驻</Text>
              <Text style={{ ...t.footnote, color: c.mutedForeground }}>每一轮都带给所有智能体（常驻页合计有字数上限）</Text>
            </View>
            <Switch value={pinned} onValueChange={setPinned} disabled={busy} />
          </View>
          <Labeled label="正文" hint="用 [[路径]] 链到别的页" error={null}>
            <TextInput
              multiline
              value={body}
              onChangeText={setBody}
              editable={!busy}
              placeholder="这一页记下什么"
              placeholderTextColor={c.mutedForeground}
              textAlignVertical="top"
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                minHeight: 240, borderRadius: radius.control, borderWidth: 1, borderColor: c.input,
                backgroundColor: c.card, color: c.foreground,
                paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontFamily: MONO, fontSize: 14, lineHeight: 20,
              }}
            />
          </Labeled>
          {error !== null ? <Note tone="error">{error}</Note> : null}
        </>
      ) : null}
    </ScrollView>
  );
}
```

（`WIKI_TITLE_MAX` / `WIKI_SUMMARY_MAX` 都从 `src/shared/wiki.ts` 导出——Task 3 读过：`export const WIKI_TITLE_MAX = 80`、`WIKI_SUMMARY_MAX = 140`。服务端对正文另有自己的校验，超了它回的那句原话会落在页底的错误里。）

- [ ] **Step 5: 名册搜索的记忆那一半**

`mobile/src/roster/RosterScreen.tsx`：
1. import 区加：`import { wikiGroupsOf, wikiMatches } from "../../../src/shared/mobileMachine.js";`、`import { RowGlyph } from "../chrome/RowGlyphs.js";`、`import { refreshWiki, useMachine } from "../machine/machineStore.js";`；`Group`、`Row` 若还不在它从 `../ui.js` 的那条 import 里就加上。
2. `RosterScreen` 函数体里 `const shown = useMemo(() => filterRosterItems(items, query), [items, query]);` 之后加：

```tsx
  // 搜索的记忆那一半（spec §5.2 / §5.8）：打开搜索时读一次记忆的索引，有字时名册结果底下多一组「记忆」
  const machine = useMachine();
  useEffect(() => {
    if (searching && homeId !== null) void refreshWiki(homeId);
  }, [searching, homeId]);
  const memoryHits = useMemo(
    () => (searching ? wikiMatches(wikiGroupsOf(machine.wiki) ?? [], query) : []),
    [searching, machine.wiki, query],
  );
  const hasQuery = query.trim() !== "";
```

3. `FlatList` 的三个 props：
   - `ListHeaderComponent`：保留原来那段「读不到的那句 + 重试」，在它后面并列加上「搜索时两组都有才画组头『智能体』」——整个 prop 换成：

```tsx
          ListHeaderComponent={
            <>
              {home.loadError !== null ? (
                // 读不到 ≠ 空：旧的名册照画，失败那句挂在上面
                <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
                  <Note tone="warn">{home.loadError}</Note>
                  <Button size="auto" variant="outline" label="重试" onPress={() => void refreshHome()} />
                </View>
              ) : null}
              {hasQuery && shown.length > 0 && memoryHits.length > 0 ? <SectionLabel text="智能体" /> : null}
            </>
          }
```

   - `ListEmptyComponent`：条件从 `query.trim() !== ""` 改成 `hasQuery && memoryHits.length === 0`（名册没命中但记忆命中时不说「没有找到」），里面那段 `<Text …>` 原样。
   - `ListFooterComponent` 换成：

```tsx
          ListFooterComponent={
            hasQuery && memoryHits.length > 0 ? (
              <View style={{ paddingTop: space.md }}>
                <SectionLabel text="记忆" />
                <View style={{ paddingHorizontal: space.lg }}>
                  <Group>
                    {memoryHits.map((e) => (
                      <Row
                        key={e.path}
                        leading={<RowGlyph name="book" />}
                        label={e.title}
                        detail={e.summary === "" ? e.path : e.summary}
                        chevron
                        onPress={() => navigation.navigate("WikiPage", { path: e.path })}
                      />
                    ))}
                  </Group>
                </View>
              </View>
            ) : __DEV__ && !searching ? (
              <View style={{ padding: space.lg }}>
                <Button variant="quiet" label="形象陈列馆（开发用）" onPress={() => navigation.navigate("FaceGallery")} />
              </View>
            ) : null
          }
```

4. 搜索框的占位字 `placeholder="搜名字、职责、最后一句"` → `placeholder="搜名字、职责、最后一句、记忆"`。
5. 文件末尾（`RosterScreen` 之外）加一个小组件：

```tsx
/** 搜索结果里的组头（demo 的 .grouphdr）：小字弱色，左边与名册那一行的文字对齐 */
function SectionLabel({ text }: { text: string }) {
  const { c } = usePalette();
  return <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 20, paddingBottom: space.xs }}>{text}</Text>;
}
```

（`homeId` 在 `RosterScreen` 里已经有：`const homeId = home.home?.id ?? null;`——A1 为入场动效定义的；若它定义在 `shown` 之后，就把新加的这段挪到它之后。`t` 是 `RosterScreen.tsx` 里 `type as t` 的别名，已在 import 里。）

- [ ] **Step 6: 手机 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck
```

Expected: 零错误。

- [ ] **Step 7: 提交**

```
feat(mobile): 记忆——清单、一页、改一页；名册搜索多出记忆那一半（#1356 A5）

清单读 wiki/index.md（分组照索引），一页里是标题、谁写的 · 什么时候 · 常驻、摘要、正文与「它提到的」；
改一页走 wiki_write（与 wiki 工具同一条写入路径），整页替换所以 sources 原样带回去。手机上不新建、
不删除（demo 只有「改」）。「连到这一页的」换成「它提到的」：反向链接要把每一页读一遍。

名册搜索：打开时读一次记忆索引，有字时名册结果底下多一组「记忆」。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/machine/WikiScreen.tsx mobile/src/machine/WikiPageScreen.tsx mobile/src/machine/WikiEditScreen.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx mobile/src/roster/RosterScreen.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 8: 这周用了多少、它们的电脑、应用

用量页：页顶一张卡（大数字 = 占你周额度的百分之几；分母读不到时报调用次数）+ 一行说明 + 一根条，下面「谁用掉的」每只一行（脸、名字、百分比、一根按本组合计归一化的淡条），组尾说分母是什么。它们的电脑：一组四行（文件 / 应用 / 记忆 / 这周用了多少），组头「几只共用这一台」、组尾「一阵子没活干会自己睡着」。应用：接着的那几个，只列、不画状态、不给钮，组尾说清在电脑上接、这里看不出连没连上。

**Files:**
- Create: `mobile/src/machine/UsageScreen.tsx`、`mobile/src/machine/MachineScreen.tsx`、`mobile/src/machine/AppsScreen.tsx`、`mobile/src/account/QuotaCard.tsx`（只放 `toneColor` 的那一半；卡本身 Task 9 补）
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`

**Interfaces:**
- Consumes: Task 1 的 `usageHeadline`、`usageRows`、`usageScale`、`type UsageRowView`；Task 3 的 `USAGE_EMPTY`、`usageHeroText`、`usageNote`、`usageTone`、`machineRows`、`machineShareText`、`MACHINE_FOOTER`、`type MachineRowView`、`appRows`、`APPS_EMPTY`、`APPS_FOOTER`；Task 2 的 `type QuotaToneView`；Task 4 的 `useMachine`、`refreshUsage`、`refreshWiki`、`useBilling`、`refreshBilling`、`Meter`、`RowGlyph`、`useNow`；既有 `Face`、`Avatar`、`useHome`、`refreshHome`。
- Produces: 路由 `Usage: undefined`、`Machine: undefined`、`Apps: undefined`；`mobile/src/account/QuotaCard.tsx` 的 `toneColor(c: Palette, tone: QuotaToneView): string`（Task 9 的两扇窗那张卡用同一份）。

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里 `WikiEdit: { path: string };` 之后加：

```ts
  /** 这周用了多少（A5）：每只智能体占你周额度的百分之几 */
  Usage: undefined;
  /** 它们的电脑（A5）：文件 / 应用 / 记忆 / 用量 */
  Machine: undefined;
  /** 应用（A5）：接着的那几个，只列 */
  Apps: undefined;
```

`mobile/src/nav/RootNavigator.tsx`：import 三个屏（`UsageScreen` / `MachineScreen` / `AppsScreen`，从 `../machine/…js`）；`WikiEdit` 那一行之后加：

```tsx
        <Root.Screen name="Usage" component={UsageScreen} options={{ title: "这周用了多少", headerBackTitle: "返回" }} />
        <Root.Screen name="Machine" component={MachineScreen} options={{ title: "它们的电脑", headerBackTitle: "返回" }} />
        <Root.Screen name="Apps" component={AppsScreen} options={{ title: "应用", headerBackTitle: "返回" }} />
```

- [ ] **Step 2: `mobile/src/account/QuotaCard.tsx`（先放色档那一半）**

```tsx
// 额度的颜色（#1356 A5）：色档 → 条与数字的颜色。颜色只用来说「出事了」——充足时是弱色（ADR-0239）。
// 两扇窗那张卡（Task 9 补在这个文件里）与用量页的大数字共用这一份。
import type { QuotaToneView } from "../../../src/shared/mobileAccount.js";
import type { Palette } from "../theme.js";

export function toneColor(c: Palette, tone: QuotaToneView): string {
  return tone === "deny" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
}
```

- [ ] **Step 3: `mobile/src/machine/UsageScreen.tsx`**

```tsx
// 这周用了多少（#1356 A5，spec §5.8）：这一周智能体们用掉了你周额度的百分之几、谁用掉的。**不报钱，报占比**
// （ADR-0264 决策 9：云端那几轮烧的是你的订阅额度，那笔钱在月费里）。判据是桌面那一份（workspaceUsageView，A5 挪进
// shared）+ 手机说法（mobileMachine）；分母读不到时报调用次数，组尾说清换了口径。读不到 ≠ 空：上一份照画。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { USAGE_EMPTY, usageHeroText, usageNote, usageTone } from "../../../src/shared/mobileMachine.js";
import { usageHeadline, usageRows, usageScale, type UsageRowView } from "../../../src/shared/workspaceUsageView.js";
import { refreshBilling, useBilling } from "../account/billingStore.js";
import { toneColor } from "../account/QuotaCard.js";
import { Meter } from "../chrome/Meter.js";
import { Face } from "../face/Face.js";
import { useHome } from "../home/homeStore.js";
import { type as t, space, usePalette } from "../theme.js";
import { Avatar, Button, Card, Group, Hint, Note, Page, Spinner, useNow } from "../ui.js";
import { refreshUsage, useMachine } from "./machineStore.js";

export function UsageScreen() {
  const { c } = usePalette();
  const ws = useHome().home;
  const { usage: load } = useMachine();
  const { billing } = useBilling();
  const now = useNow(60_000);
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId !== null) void refreshUsage(homeId);
      void refreshBilling();
    }, [homeId]),
  );

  if (ws === null) {
    return <Page><Hint>还没有智能体，也就还没有用量。</Hint></Page>;
  }
  const usage = load.kind === "ok" ? load.usage : load.kind === "error" ? load.usage : null;
  const error = load.kind === "error" ? load.message : null;
  if (usage === null) {
    return (
      <Page>
        {error !== null ? (
          <View style={{ gap: space.sm }}>
            <Note tone="warn">{`读不到用量：${error}`}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshUsage(ws.id)} />
            </View>
          </View>
        ) : (
          <Spinner />
        )}
      </Page>
    );
  }

  const head = usageHeadline(usage);
  const rows = usageRows(ws, usage);
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        {error !== null ? <Note tone="warn">{`这一刻读不到最新的用量（${error}），下面是上一次的。`}</Note> : null}
        <Card style={{ alignItems: "center", paddingVertical: 20 }}>
          <Text style={{ fontSize: 38, lineHeight: 44, fontWeight: "700", letterSpacing: -1, color: c.foreground }}>
            {head.percent ?? `${head.calls} 次`}
          </Text>
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{usageHeroText(usage, billing, now)}</Text>
          {head.fill !== null ? (
            <Meter fill={head.fill} color={toneColor(c, usageTone(usage))} style={{ alignSelf: "stretch", marginTop: 4 }} />
          ) : null}
        </Card>
        {rows.length === 0 ? (
          <Hint>{USAGE_EMPTY}</Hint>
        ) : (
          <Group header="谁用掉的" footer={usageNote(usageScale(usage))}>
            {rows.map((r) => <UsageRow key={r.agentId === "" ? "_unattributed" : r.agentId} row={r} />)}
          </Group>
        )}
      </View>
    </Page>
  );
}

/** 用量那一行（demo 的 usage 那一列）：脸（名册里查不到的不给脸，退首字母——ADR-0264）+ 名字 + 百分比，底下一根淡条
    （这一只在这几只合计里的比重，各行加起来正好是 1——不按最大值归一化，那样花得最多的那只常年满格） */
function UsageRow({ row }: { row: UsageRowView }) {
  const { c } = usePalette();
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 11, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {row.avatar !== null ? <Face slot={row.avatar.slot} tier="s" label={row.name} /> : <Avatar name={row.name} size={26} />}
        <Text style={{ ...t.body, fontSize: 15, color: c.foreground, flex: 1, minWidth: 0 }} numberOfLines={1}>{row.name}</Text>
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>{row.percent}</Text>
      </View>
      <Meter fill={row.share} color={c.mutedForeground} dim />
    </View>
  );
}
```

- [ ] **Step 4: `mobile/src/machine/MachineScreen.tsx`**

```tsx
// 它们的电脑（#1356 A5，spec §5.8）：它们共用的那一容器一卷（ADR-0232）。一组四行——文件 / 应用 / 记忆 / 这周用了多少。
// 数字只报查得到的（shared 的 machineRows）：磁盘、文件数、「等你登录」都问不出来，所以不画（spec §10 第 80–81 条）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { MACHINE_FOOTER, machineRows, machineShareText, type MachineRowView } from "../../../src/shared/mobileMachine.js";
import { RowGlyph, type RowGlyphName } from "../chrome/RowGlyphs.js";
import { useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Group, Hint, Page, Row } from "../ui.js";
import { refreshUsage, refreshWiki, useMachine } from "./machineStore.js";

const GLYPH: Record<MachineRowView["key"], RowGlyphName> = { files: "folder", apps: "plug", wiki: "book", usage: "chart" };

export function MachineScreen() {
  const navigation = useNavigation();
  const ws = useHome().home;
  const m = useMachine();
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId === null) return;
      void refreshWiki(homeId);
      void refreshUsage(homeId);
    }, [homeId]),
  );

  if (ws === null) {
    return <Page><Hint>还没有智能体，也就还没有这台电脑。</Hint></Page>;
  }
  const rows = machineRows({ apps: ws.connectors.length, wiki: m.wiki, usage: m.usage });
  const go = (key: MachineRowView["key"]): void => {
    if (key === "files") navigation.navigate("Files", { path: "" });
    else if (key === "apps") navigation.navigate("Apps");
    else if (key === "wiki") navigation.navigate("Wiki");
    else navigation.navigate("Usage");
  };
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Group header={machineShareText(ws)} footer={MACHINE_FOOTER}>
          {rows.map((r) => (
            <Row
              key={r.key}
              leading={<RowGlyph name={GLYPH[r.key]} />}
              label={r.title}
              detail={r.detail}
              {...(r.value === null ? {} : { value: r.value })}
              chevron
              onPress={() => go(r.key)}
            />
          ))}
        </Group>
      </View>
    </Page>
  );
}
```

- [ ] **Step 5: `mobile/src/machine/AppsScreen.tsx`**

```tsx
// 应用（#1356 A5，spec §5.8）：接着的那几个（workspace_connectors，桌面贡献进来的）。**只列，不画状态、不给钮**：
// 连没连上 / 要不要重新登录只活在桌面进程里，手机问不出来；接新的、登录都在电脑上做（spec §10 第 80 条）。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { View } from "react-native";
import { APPS_EMPTY, APPS_FOOTER, appRows } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import { space } from "../theme.js";
import { Group, Hint, Page, Row } from "../ui.js";

export function AppsScreen() {
  const ws = useHome().home;
  // 清单跟着名册那份快照走（connectors 就在里面）；进这一页拉一次新的
  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );
  if (ws === null) {
    return <Page><Hint>还没有智能体。</Hint></Page>;
  }
  const rows = appRows(ws);
  return (
    <Page>
      {rows.length === 0 ? (
        <View style={{ gap: space.sm }}>
          <Hint>{APPS_EMPTY}</Hint>
          <Hint>{APPS_FOOTER}</Hint>
        </View>
      ) : (
        <Group footer={APPS_FOOTER}>
          {rows.map((r) => (
            <Row key={r.key} leading={<RowGlyph name="plug" />} label={r.title} detail={r.detail} />
          ))}
        </Group>
      )}
    </Page>
  );
}
```

- [ ] **Step 6: 手机 tsc**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck
```

Expected: 零错误。`Face` 的 `label` 若是必填以外的某种类型，照 `mobile/src/face/Face.tsx` 的签名传；`Avatar` 的签名是 `{ url?: string; name: string; size?: number }`。

- [ ] **Step 7: 提交**

```
feat(mobile): 这周用了多少、它们的电脑、应用（#1356 A5）

用量页报占比不报钱（ADR-0264 决策 9），分母读不到时报调用次数、组尾说清换了口径；大数字底下「本周还剩
X%」取自账号的额度窗，不拿 100 减。它们的电脑是一组四行，数字只报查得到的——磁盘、文件数、「等你登录」
都问不出来，不画；「一直开着」不写（容器空闲会停）。应用只列、不画状态：连没连上手机问不出来。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/machine/UsageScreen.tsx mobile/src/machine/MachineScreen.tsx mobile/src/machine/AppsScreen.tsx mobile/src/account/QuotaCard.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 9: 账号页 + 设置 + 名册那颗账号钮

账号页从上往下：首字圆 + 名字 + 邮箱 + 档位药丸 → 两扇窗那张卡 → 一组（订阅 / 这周用了多少 / 它们共用的一台电脑）→ 设置 → 退出登录（组尾一句）。后两行只在有主场时画。A0 那组「连接」诊断（中继地址 + 版本）挪进设置。设置：外观（跟随系统 / 浅色 / 深色，单选的勾）+ 连接。名册那颗账号钮：名字与首字改走 shared；右上角那枚点不画（数据源查过了，头注说清）。

**Files:**
- Rewrite: `mobile/src/account/AccountScreen.tsx`
- Create: `mobile/src/account/PlanPill.tsx`、`mobile/src/account/SettingsScreen.tsx`
- Modify: `mobile/src/account/QuotaCard.tsx`（补上卡本身）、`mobile/src/roster/AccountButton.tsx`、`mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`

**Interfaces:**
- Consumes: Task 2 的 `ACCOUNT_FOOTER`、`accountBadge`、`accountInitial`、`accountName`、`accountQuota`、`subscriptionValue`、`THEME_PREFS`、`type AccountQuota`、`type QuotaToneView`；Task 3 的 `machineShareText`；Task 4 的 `useBilling`、`refreshBilling`、`useThemePref`、`setThemePref`、`Meter`、`RowGlyph`、`Row` 的 `detail` / `checked`、`useNow`；Task 8 的 `toneColor`；既有 `authNoticeOf`、`NoticeLine`、`RELAY_BASE`、`useHome`、`supabase`、`app.json`。
- Produces: 路由 `Settings: undefined`；`PlanPill({ id, label })`、`QuotaCard({ quota })`。

- [ ] **Step 1: 路由**

`mobile/src/nav/types.ts` 的 `RootStackParams` 里 `Apps: undefined;` 之后加：

```ts
  /** 设置（A5）：外观 + 连接诊断 */
  Settings: undefined;
```

`mobile/src/nav/RootNavigator.tsx`：import `import { SettingsScreen } from "../account/SettingsScreen.js";`；`Apps` 那一行之后加：

```tsx
        <Root.Screen name="Settings" component={SettingsScreen} options={{ title: "设置", headerBackTitle: "返回" }} />
```

- [ ] **Step 2: 档位药丸 `mobile/src/account/PlanPill.tsx`**

```tsx
// 档位那枚小药丸（#1356 A5；demo 的 .pill）。四色与桌面 PlanBadge 同一套语义（ADR-0240）：Free 弱色、Lite 绿、Pro 点缀蓝、
// Max 橙——`warn` 在别处的意思是「出事了」，Max 借形不借义（桌面那边记着同一笔账）。
import { Text, View } from "react-native";
import type { PlanBadgeId } from "../../../src/shared/billingView.js";
import { usePalette, withAlpha } from "../theme.js";

export function PlanPill({ id, label }: { id: PlanBadgeId; label: string }) {
  const { c } = usePalette();
  const fg = id === "lite" ? c.ok : id === "pro" ? c.brand : id === "max" ? c.warn : c.mutedForeground;
  return (
    <View style={{
      height: 24, paddingHorizontal: 9, borderRadius: 999, justifyContent: "center",
      backgroundColor: id === "free" ? c.secondary : withAlpha(fg, 0.18),
    }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg }}>{label}</Text>
    </View>
  );
}
```

- [ ] **Step 3: 两扇窗那张卡——补进 `mobile/src/account/QuotaCard.tsx`**

把 Task 8 那个文件的头注第一行改成 `// 两扇额度窗那张卡 + 额度的颜色（#1356 A5）：还剩百分之几、一根按剩余填的条、什么时候刷新。颜色只用来说「出事了」——`，并在文件里补上（import 区相应补 `Text` / `View`、`AccountQuota`、`type as t` / `usePalette`、`Card`、`Meter`）：

```tsx
import { Text, View } from "react-native";
import type { AccountQuota } from "../../../src/shared/mobileAccount.js";
import { Meter } from "../chrome/Meter.js";
import { type as t, usePalette } from "../theme.js";
import { Card } from "../ui.js";

/** 账号页那张卡（demo 的 account 两栏）：左 5h、右本周；还没查到写「正在查额度…」，没有窗时说为什么（shared 的 accountQuota） */
export function QuotaCard({ quota }: { quota: AccountQuota }) {
  const { c } = usePalette();
  if (quota.kind === "loading") {
    return <Card><Text style={{ ...t.callout, color: c.mutedForeground }}>正在查额度…</Text></Card>;
  }
  if (quota.kind === "none") {
    return <Card><Text style={{ ...t.callout, color: c.mutedForeground }}>{quota.text}</Text></Card>;
  }
  return (
    <Card>
      <View style={{ flexDirection: "row", gap: 18 }}>
        {quota.windows.map((w) => (
          <View key={w.key} style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{w.label}</Text>
            <Text style={{ marginTop: 1 }} numberOfLines={1}>
              <Text style={{ fontSize: 20, lineHeight: 25, fontWeight: "600", color: w.tone === "neutral" ? c.foreground : toneColor(c, w.tone) }}>
                {w.remaining}
              </Text>
              <Text style={{ ...t.footnote, color: c.mutedForeground }}> 可用</Text>
            </Text>
            <Meter fill={w.fill} color={toneColor(c, w.tone)} style={{ marginTop: 7 }} />
            <Text style={{ ...t.footnote, color: c.mutedForeground, opacity: 0.7, marginTop: 6 }} numberOfLines={1}>{w.refresh}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
```

- [ ] **Step 4: 设置 `mobile/src/account/SettingsScreen.tsx`**

```tsx
// 设置（#1356 A5，spec §5.8）：只留有后端的两组——外观（这台手机自己的偏好）与连接诊断（A0 那两行，从账号页挪过来）。
// demo 里的「通话时麦克风常开」「它们的声音」「提醒」「隐私与数据」都没有后端（推送没有凭据那一层、声音 #1372），
// 画出来就是点了不生效的开关（#722），不画。外观是单选清单（iOS 设置的语汇）不是 demo 的分段控件：RN 没有原生分段控件，
// 不为它加依赖。
import { View } from "react-native";
import { THEME_PREFS } from "../../../src/shared/mobileAccount.js";
import { RELAY_BASE } from "../relay.js";
import { space } from "../theme.js";
import { setThemePref, useThemePref } from "../themePref.js";
import { Group, Page, Row } from "../ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function SettingsScreen() {
  const pref = useThemePref();
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Group header="外观" footer="只改这台手机。跟随系统时，系统切深浅色它也跟着切。">
          {THEME_PREFS.map((p) => (
            <Row key={p.key} label={p.label} checked={pref === p.key} onPress={() => void setThemePref(p.key)} />
          ))}
        </Group>
        {/* 纯诊断信息——不做成按钮，长按能选中拷走就够了（A0 的那一组，原样搬过来） */}
        <Group header="连接" footer="出问题时把这两行长按拷下来一起发过来。">
          <Row label="中继" value={RELAY_BASE} mono />
          <Row label="版本" value={appJson.expo.version} mono />
        </Group>
      </View>
    </Page>
  );
}
```

- [ ] **Step 5: 账号页 `mobile/src/account/AccountScreen.tsx`（整份重写）**

```tsx
// 账号页（#1356 A5，spec §5.8；A0 那版只有邮箱 + 退出 + 连接诊断）。从上往下：我是谁（首字圆 + 名字 + 邮箱 + 档位）
// → 两扇额度窗（还剩百分之几）→ 订阅 / 这周用了多少 / 它们共用的一台电脑 → 设置 → 退出。判据全在 shared 的
// mobileAccount（还没查到 ≠ 没订阅，ADR-0240）；连接诊断挪进了「设置」。后两行只在有主场时画（没有它们就没有可看的）。
// 头像圆是实色点缀色，不是 demo 的渐变（渐变要 expo-linear-gradient，不为一个圆加依赖）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import {
  ACCOUNT_FOOTER, accountBadge, accountInitial, accountName, accountQuota, subscriptionValue,
} from "../../../src/shared/mobileAccount.js";
import { machineShareText } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { NoticeLine } from "../gate/NoticeLine.js";
import { useHome } from "../home/homeStore.js";
import { supabase } from "../supabase.js";
import { type as t, space, usePalette } from "../theme.js";
import { Group, Note, Page, Row, useNow } from "../ui.js";
import { refreshBilling, useBilling } from "./billingStore.js";
import { PlanPill } from "./PlanPill.js";
import { QuotaCard } from "./QuotaCard.js";

export function AccountScreen() {
  const { c } = usePalette();
  const navigation = useNavigation();
  const ws = useHome().home;
  const { billing, loadError } = useBilling();
  const now = useNow(60_000);
  const [who, setWho] = useState<{ name: string; email: string | null } | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      setWho({ name: accountName(u), email: u?.email ?? null });
    });
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refreshBilling();
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshBilling();
    });
    return () => sub.remove();
  }, []);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住，这一屏不用管。
  // 但登出会失败：断网而 access token 又过期时，supabase 刷新不了 session，就原样留着本地那份、
  // 也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生（A0 原话）
  const [busy, setBusy] = useState(false);
  const [signOutNotice, setSignOutNotice] = useState<AuthNotice | null>(null);
  const signOut = (): void => {
    void (async () => {
      setBusy(true);
      setSignOutNotice(null);
      try {
        const { error } = await supabase.auth.signOut();
        if (error) setSignOutNotice(authNoticeOf(error.message));
      } catch (e: unknown) {
        setSignOutNotice(authNoticeOf(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    })();
  };

  const name = who?.name ?? "";
  const badge = accountBadge(billing);
  const sub = subscriptionValue(billing);
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 4 }}>
          <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: c.brand, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 22, fontWeight: "600", color: c.primaryForeground }}>{accountInitial(name)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 20, lineHeight: 25, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }} numberOfLines={1}>
              {who === null ? "读取中…" : name}
            </Text>
            {who?.email ? <Text style={{ ...t.footnote, color: c.mutedForeground }} numberOfLines={1}>{who.email}</Text> : null}
          </View>
          {badge !== null ? <PlanPill id={badge.id} label={badge.label} /> : null}
        </View>

        {loadError !== null ? <Note tone="warn">{loadError}</Note> : null}
        <QuotaCard quota={accountQuota(billing, now)} />

        <Group>
          <Row
            leading={<RowGlyph name="spark" />}
            label="订阅"
            {...(sub === null ? {} : { value: sub })}
            chevron
            onPress={() => navigation.navigate("Subscription")}
          />
          {ws !== null ? (
            <Row leading={<RowGlyph name="chart" />} label="这周用了多少" chevron onPress={() => navigation.navigate("Usage")} />
          ) : null}
          {ws !== null ? (
            <Row
              leading={<RowGlyph name="cloud" />}
              label="它们共用的一台电脑"
              detail={machineShareText(ws)}
              chevron
              onPress={() => navigation.navigate("Machine")}
            />
          ) : null}
        </Group>

        <Group>
          <Row leading={<RowGlyph name="gear" />} label="设置" chevron onPress={() => navigation.navigate("Settings")} />
        </Group>

        <Group footer={ACCOUNT_FOOTER}>
          <Row label={busy ? "退出中…" : "退出登录"} align="center" tone="destructive" disabled={busy} onPress={signOut} />
        </Group>
        {signOutNotice ? <NoticeLine notice={signOutNotice} /> : null}
      </View>
    </Page>
  );
}
```

- [ ] **Step 6: 名册那颗账号钮**

`mobile/src/roster/AccountButton.tsx`：
- 头注第 2–3 行 `// 名字先取 OAuth 带来的 user_metadata，没有就用邮箱（原 nav/AvatarButton.tsx 的取法）。` 与 `// 右上角那枚「有应用等你登录」的点在 A5（spec §5.8）——数据源查清之前不画。` 换成：

```ts
// 名字与首字走 shared 的 accountName / accountInitial（账号页同一份）。
// 右上角那枚「有应用等你登录」的点**不画**：A5 查过数据源——应用要不要重新登录只活在桌面进程里（McpHub 的
// needs-auth），托管箱还把不 live 的整台滤掉，手机从哪条路都问不出来（spec §10 第 80 条；补数据源另开 issue）。
```

- import 区加 `import { accountInitial, accountName } from "../../../src/shared/mobileAccount.js";`
- `useEffect` 里那三行（`const u = …`、`const meta = …`、`setName(meta.name ?? meta.full_name ?? u?.email ?? "");`）换成 `setName(accountName(data.session?.user));`
- `{(name.trim() || "·").slice(0, 1).toUpperCase()}` → `{accountInitial(name)}`

- [ ] **Step 7: 手机 tsc + 整个门禁**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm --prefix mobile run typecheck
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log
```

Expected: 手机 tsc 零错误；`GATE_EXIT=0`（本地时间 00:00–01:59 之间跑，门禁那一句前面加 `TZ=UTC `）。

- [ ] **Step 8: 提交**

```
feat(mobile): 账号页做全、设置；名册账号钮的名字走 shared（#1356 A5）

账号页：首字圆 + 名字 + 邮箱 + 档位 → 两扇窗（还剩百分之几）→ 订阅 / 这周用了多少 / 它们共用的一台电脑
→ 设置 → 退出。还没查到 ≠ 没订阅（ADR-0240）。A0 的连接诊断挪进设置；设置只留外观与连接——demo 里
那几样开关没有后端，不画（#722）。名册那颗钮上「有应用等你登录」的点不画：数据源查过了，手机问不出来。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add mobile/src/account/AccountScreen.tsx mobile/src/account/PlanPill.tsx mobile/src/account/QuotaCard.tsx mobile/src/account/SettingsScreen.tsx mobile/src/roster/AccountButton.tsx mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

### Task 10: 收尾文档

spec 记下这一片的偏离与取舍（§5.8 改写、§8 A5 一行、§10 第 80–92 条、§12 第 6 条）、`AGENTS.md` 索引加一条、`mobile/README.md` 跟上。**这一片没有 ADR**：服务端一行没改、协议不进位，判据都是 spec §5.8 的落地 + §6 的既有规矩（同 A3）。

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§2、§5.2、§5.8、§8、§10、§12）
- Modify: `AGENTS.md`（「Where to find things」里 A4 那一条之后加一条）
- Modify: `mobile/README.md`（第 5 行的进度那一句 + 「结构」那一节里新目录）

- [ ] **Step 1: spec**

1. §2 第 55 行 `设计写在这里、另开 plan（不在本轮）：A4 语音、A5 账号与那台电脑（含搜索记忆、那枚「等你登录」的点）。` → `设计写在这里、另开 plan（不在本轮）：A4 语音、A5 账号与那台电脑（含搜索记忆、那枚「等你登录」的点）——两片都已做完，见 §5.7 / §5.8。`
2. §5.2 第 118 行里 `（我的名字首字；A5 之前进一页只有邮箱 + 退出登录的精简账号页）` → `（我的名字首字；进去是 §5.8 的账号页）`；第 119 行里 `没订阅 → 一句实话「订阅 Pro 或 Max 之后才建得了智能体」（A5 之前手机上办不了订阅，不画一颗点了没去处的钮）；档位不带 → 同理；` → `没订阅 → 一句实话「订阅 Pro 或 Max 之后才建得了智能体」+ 一颗「去订阅」（A5 之前手机上办不了订阅，那时不画钮）；档位不带 → 同理，钮写「去换档」；`；第 125 行 `记忆那一半归 A5。` → `记忆那一半 A5 接上（§10 第 92 条）。`
3. §5.8 那一段（`### 5.8 账号与那台电脑（A5，另开 plan）` 连同下面那一句）整段换成：

```markdown
### 5.8 账号与那台电脑（A5）
账号页（我是谁 + 档位、额度两扇窗报「还剩百分之几」、订阅、这周用了多少、它们共用的一台电脑、设置、退出）；订阅页（档位卡、结账 / Portal 开在 App 内浏览器里）；那台电脑（文件 / 应用 / 记忆 / 用量）；设置（外观 + 连接诊断）；名册搜索的记忆那一半。账号那颗钮右上角那枚 `--warn` 的点**数据源查过了、不存在**，不画。源：E（`/billing/v1/me`、`checkout`、`portal`、`workspace-usage`）+ CS（控制房的 `files` / `files_search` / `wiki_write`）+ SB（主场快照里的 `connectors`）+ L（外观偏好）。实现以 §10 第 80–92 条为准（plan：`docs/superpowers/plans/2026-09-27-mobile-agents-a5-account.md`）。
```

4. §8 表格 A5 那一行 `| A5 | 账号与那台电脑 | A1 | 另开 plan |` → `| A5 | 账号与那台电脑 | A1 | 一个 PR（不跑库、不部署；plan：2026-09-27-mobile-agents-a5-account） |`
5. §10 第 79 条之后、`（写 plan / 实现期间的偏离追加在这里。）` 之前追加（每条前面空一行，同上面那几条的排法）：

```markdown
80. **账号钮上那枚「有应用等你登录」的点不画，应用那一页不画状态点**：数据源查过了（2026-09-27）——needs-auth 只活在桌面主进程 `McpHub` 的内存里，托管箱 `buildEscrowDoc` 把不 live 的整台滤掉，edge 没有状态端点，手机从哪条路都问不出来（§5.8「查不到就不画」）。应用那一页只列（名字 + 「全部工具 / N 个工具」），组尾照实说「它们此刻连没连上，这里看不出来」；demo 的「接新的」「去登录」两张抽屉不做——登录发生在电脑上。补数据源另开 issue。

81. **那台电脑那一页不画磁盘条、不报文件数、不写「一直开着」**：磁盘读数只在 runtime 里当闸（ADR-0287）、不进任何帧；`files` 帧一次一层、没有递归计数（ADR-0253）；容器空闲一阵会停（ADR-0199），改成组尾一句「一阵子没活干它会自己睡着，有活时再醒——文件都还在」。磁盘下发另开 issue。

82. **两扇窗的名字与倒计时用桌面那一份**（「5h / 本周」「1h 38m 后刷新」「4d 后刷新」），不是 demo 的「5 小时窗 / 本周窗 / 1 小时 38 分后刷新」：同一扇窗在几块屏幕上不能有两种叫法（#1229 定的三处一起改，手机是第四处）。

83. **订阅页只列这个 App 用得上的档**（服务端下发的 `capabilities.workspace` 为真）+ 此刻订着的那一档（订着 Lite 的人得看得见自己在哪，卡上写「不带智能体——这个 App 里用不上」）+ Free；从贵到便宜。卡上那几行从能力推，不照抄 demo（「最多 3 只」「它们的电脑一直开着」都不是事实），档与档的区别由组尾一句说：「几档的区别在额度」。

84. **钮的去处照 ADR-0203 决定 18**：没订阅（含退订过）「订阅 X」走 checkout；订着的人「换到 X」走 Portal（再开一张 checkout 会变成两条订阅，网关回 409）；扣款没成功另一张卡「更新付款方式」走 Portal；「管理订阅 · 发票」只在订过的人那里画（从没订过的人没有 Stripe 客户，点下去必然失败）。Portal 不带深链（`flow_data`），「换到 X」落在 Portal 首页、人再点一次换档——深链要改 edge + 部署，另开 issue。

85. **支付页开在 App 内浏览器里**（`expo-web-browser` 的 `openBrowserAsync`，SFSafariViewController，整屏升起、左上「完成」）。Stripe 走完落在 edge 自己那一句话的页面、**不回跳 App**，所以回来靠人点「完成」——关掉那一刻重拉订阅；结账那一趟没变就隔 2 秒再拉，最多两次（webhook 可能比人点「完成」还慢），这几秒页顶一行「正在从 Stripe 同步…」。不走 IAP（§12 第 6 条）。

86. **设置只留两组**：外观（跟随系统 / 浅色 / 深色，存在这台手机的 kv-store 里，靠 `Appearance.setColorScheme` 生效，不跟账号走、登出不清）与连接诊断（A0 那两行从账号页挪过来）。demo 的「通话时麦克风常开」「它们的声音」「提醒」「隐私与数据」没有后端（推送没有凭据那一层；声音 #1372），不画（#722）。外观是单选清单（右边一枚勾），不是 demo 的分段控件（RN 没有原生分段控件，不为它加依赖）。

87. **账号页的头像圆是实色点缀色**，不是 demo 的渐变（渐变要 `expo-linear-gradient`，不为一个圆加依赖）；「这周用了多少」「它们共用的一台电脑」两行只在有主场时画；两扇窗还没查到写「正在查额度…」，没有窗时说为什么（扣款没成功 / 没订阅两句分开说）。

88. **退出那一组的组尾照实说**：「退出只影响这台手机；它们在云端手上的活不会停。」demo 写「会把这台手机上的缓存清掉」——登出只清 supabase 的 session 与名册那一份，说不上「缓存」。

89. **记忆：手机上只看与改**（demo 只有「改」），新建 / 删除留在电脑上（新建要起合法的路径名）。改是整页替换，页头的 `sources` 原样带回去。正文按纯文本显示（手机端没有 markdown 渲染器）。demo 的「连到这一页的」（反向链接）换成「它提到的」（正文里的 `[[链接]]`，按索引认标题）——反向链接要把每一页都读一遍。索引里 `agents` 那一组的组头写「各只自己那一页」。

90. **文件：一次一层、目录压一页**；搜索只在最外层那一页（按名 / `?` 开头按内容，桌面同一个约定，判据抬进 shared 的 `parseFileQuery`）；文件只读、显示开头 64 KB、等宽可选中，下不到手机上（组尾说清）。demo 行上的「开发 · 12:41」（谁写的）没有——`files` 帧不带作者，第二行写大小与时间。

91. **用量页大数字底下补「本周还剩 X%」**，取自账号的额度窗，不拿 100 减上面那个数（你在电脑上用掉的也算在同一扇窗里）；分母读不到时大数字报调用次数、不画条，组尾说清换了口径。电话那一格没订阅 / 扣款没成功两句改成指去「账号 → 订阅」（第 72、78 条里「不指去哪儿续」那半句从此不成立）；名册「没订阅 / 档位不带」那两态给钮（§5.2）。

92. **名册搜索多出「记忆」一组**：打开搜索时读一次记忆的索引，按标题 / 摘要 / 路径过滤（不分大小写、封顶 20 条），有字时画在名册结果底下；两组都有时名册那组的组头写「智能体」。搜索框占位字「搜名字、职责、最后一句、记忆」。
```

6. §12 第 6 条 `6. **不开 IAP**：A5 之前手机上办不了订阅，没订阅的人在手机上只能看到一句实话。` → `6. **不开 IAP**：A5 起手机上能订阅，支付页开在 App 内浏览器里走 Stripe（§10 第 85 条）——手机端不上架所以不牵扯 App Store 的规矩，上架那天要重判（2026-09-11 spec §8 第 1 条）。`

- [ ] **Step 2: `AGENTS.md` 索引**

在「Where to find things」里 A4 那一条（以 `` - `mobile/modules/otto-speech/` / `src/shared/voiceSession.ts` `` 开头）之后加一条：

```markdown
- `src/shared/mobileAccount.ts` / `src/shared/mobileMachine.ts` / `mobile/src/account/` / `mobile/src/machine/` — **手机端「智能体」单栏 A5：账号与那台电脑**（#1356，spec §5.8）。账号页（首字圆 + 名字 + 档位、两扇窗报还剩百分之几、订阅 / 这周用了多少 / 它们共用的一台电脑、设置、退出）、订阅页（只列这个 App 用得上的档 + 此刻订着的 + Free；没订阅走 checkout、订着的人换档只走 Portal，ADR-0203 决定 18；支付页开在 App 内浏览器里，Stripe 走完不回跳 App，关掉那一刻重拉、结账后没变再拉两次）、那台电脑（文件一次一层 / 应用只列 / 记忆能看能改 / 用量报占比不报钱）、设置（外观存在这台手机上，靠 `Appearance.setColorScheme`；连接诊断）、名册搜索的记忆那一半。**数字只报查得到的**：「应用等你登录」（只活在桌面 `McpHub` 内存里，托管箱还把不 live 的滤掉）、磁盘用量（ADR-0287，不出 runtime）、文件总数（一次一层）这一片开工时逐条验过都问不出来，所以账号钮上那枚点、应用状态点、磁盘条、文件数都不画（spec §10 第 80–81 条；补数据源各另开 issue）。判据全在 shared（进 vitest），为此桌面渲染层三份纯逻辑挪进 shared（`workspaceUsageView` / `workFilesView` / `billingError`，桌面改 import、行为不变），桌面文件页的 `?` 开头按内容搜抬成 `parseFileQuery` 两端共用。**服务端一行没改、不进协议位、不用部署**。真机一次没跑过（登录后的流程要人输密码）
```

- [ ] **Step 3: `mobile/README.md`**

- 第 5 行那一句的末尾 `进度见 spec …` 之前，把 `A3 接上了群聊（…）；` 之后补上 `A4 接上了语音通话（要开发版）；A5 做全了账号页（额度两扇窗、订阅、这周用了多少、它们共用的一台电脑、设置）与名册搜索的记忆那一半；`（按源文件原样定位插入点；若 A4 已经在那一句里，只补 A5 那半句）。
- 「## 结构」那一节里按既有的写法加两行：`src/account/` —— 账号页、订阅页、设置、订阅快照（A5）；`src/machine/` —— 它们的电脑：文件、应用、记忆、这周用量（A5）。

- [ ] **Step 4: 门禁**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log
```

Expected: `GATE_EXIT=0`（`tests/docs/adrNumbers.test.ts` 不受影响——这一片不加 ADR）。

- [ ] **Step 5: 提交**

```
docs: A5 的偏离记进 spec §10 第 80–92 条，§5.8 / §8 / §12、索引与手机 README 跟上（#1356 A5）

最要紧的两条：账号钮上那枚「等你登录」的点、应用状态点、磁盘条、文件数都不画——数据源开工时逐条查过，
手机问不出来（§10 第 80–81 条）；支付页开在 App 内浏览器里，Stripe 走完不回跳 App，关掉那一刻重拉
（第 85 条）。这一片没有 ADR：服务端一行没改、协议不进位，判据是 §5.8 的落地 + §6 的既有规矩。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git add docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md AGENTS.md mobile/README.md
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a5-account-4e639a && git commit -F .superpowers/commit-msg.txt
```

---

## 收尾（控制方做，不派给子 agent）

1. 整条分支终审（最强档模型，按 spec §5.8 / §6 / §10 第 80–92 条核）→ 一轮修复 → 一轮复审。
2. iOS 模拟器冒烟（Expo Go 即可——A5 不碰原生；开发版也行）：名册账号钮 → 账号页（登录前的部分：`index.ts` 换根组件对着假数据核排版，验完 `git checkout -- mobile/index.ts`）；登录后的流程列进 PR 的真机清单（agent 不替人输密码）。
3. 另开 issue：①应用状态与「等你登录」的数据源（桌面把 MCP 连接状态写到手机读得到的地方）；②runtime 把工作卷磁盘用量下发给客户端（`workspace_state` 帧加一格）；③Portal 深链（`flow_data`，edge 改动 + 部署）。三条的号回填进 spec §10 第 80 / 81 / 84 条与 AGENTS.md 那一行。
4. 推分支、开 PR（引用 #1356，不关它）、CI 绿后 merge commit 合并。
