# 订阅用户的灵动岛重设计（方向 A）

- Issue: #1229
- 状态：已定方向，实现中
- 前置阅读：ADR-0059/0061/0063（岛的三次形态）、ADR-0209/0239/0240/0248/0254/0255（订阅那一族的口径）、ADR-0259（侧栏三档切换器）、ADR-0256（未读 @ 画点不画数）

## 1. 病在哪

岛的展开态上半区今天是 `IslandDisplay` 的**二选一**：会话 fleet，或者「用量模式」那张表（`islandUsage`：每个模型 今天/7天/14天 token 数）。

那张表是 BYOK 时代的产物。ADR-0248 之后**订阅用户不许自带 key**，于是他看到的每一个 token 数都是一个他无法据此行动的数字：他既不能换一款便宜的省钱（钱在月费里），也不能去关掉哪一台。订阅用户真正会问的那句话——「我还剩多少、什么时候刷新」——岛上一个字都没有，而 ADR-0209/0239/0254 已经为这句话定过三遍口径了。

第二处病：岛只有一份平铺的会话列表，而侧栏早在 ADR-0259 就分成了**任务 / 项目 / 团队**三档。同一批会话在两块屏幕上是两种组织方式，且岛上那份还看不见「有人在团队里 @ 了我」。

## 2. 决策

### 决策 1：额度是**页脚**，不是一个模式

展开态从上到下：**顶栏（logo + 三档切换器 + 未读点）→ 列表 → 详情 → 额度页脚**。

页脚一行说完：`[档位徽章] 当主那扇窗 · 剩余% · 条 · 倒计时`。

否决的两个方向（demo 里都做出来给维护者点过）：

- **页眉双表**（额度当第一眼，两扇窗并排）：与账号页 `PlanQuotaSection` 同一套语言、两扇窗都在场，但它把「我有哪几只水獭在跑」挤到了下半屏——而人拉开岛八成正是为了看那个。额度是每天问一两次的事，会话是每分钟。
- **环境**（不给额度任何区块，只有一根 3px 剩余线 + 每行底下「这只吃掉多少」的细柱）：零纵向像素成本，还多回答了「是谁在吃」；代价是**不报数**，真到 90% 它也只是变红一根线。行底细柱另有 ADR-0239 点过的名：满格底色会被读成「这一行选中了」。

代价（明写）：页脚只报**当主**那一扇（`bindingWindow`），另一扇要悬停 `title` 才知道——一行放不下两扇。

### 决策 2：同一条页脚，两个主语

没有订阅的人不是「额度为 0」，他是**没有额度可言**（ADR-0255 把这两件事记成两条，`quotaAlert` 对 `windows === null` 一个像素都不画）。但把页脚整条抽掉，等于 BYOK 用户从此比今天少一块东西——今天那张用量表就是他唯一能在岛上看到的账。

所以页脚是一个**二选一的联合体**（`IslandRail`）：

- `kind: "quota"` —— 有订阅：档位 + 当主窗 + 剩余% + 条 + 倒计时
- `kind: "spend"` —— 没订阅但日志里有过计费调用：本周用量
- 两者都不成立（`billing` 还没查到 / 从没跑过一次调用）：**整条不画**，回到改动前的样子

**`spend` 报 token 不报钱。** 与我在 demo 里给维护者看的措辞（`本周 $2.14`）不同，理由是数据：`store.billedUsage()` 回的 `BilledRow` 只有 `{ts, model, promptTokens, completionTokens, cachedTokens}`——**没有 route、没有 credit**，一个 `$` 数字要现查 `modelPricing` 拼出来，而那张表里 `UNPRICED` 是常态（ADR-0241）。混着算不出来的时候退回 token 总数，正是 `CostPanel` 和 ADR-0239 已经定过两遍的规矩；在一条 420pt 的页脚上重新实现一遍「清一色才报得出合计」的分支判断，换来的是一个多数时候画不出来的 `$`。

### 决策 3：三档切换器住在 helper 里，不走线

`IslandDisplay` 那个二选一是**设置项**（落盘 `island.json`、设置页有一格、每次 `pushFleet` 带在线上）。三档切换器不是设置项，是**此刻在看哪一档**——与 `selectedSessionId`、`collapsedWorkspaces` 同一族的 helper 进程内存态（ADR-0063 已经为后两者定过这个位置）。

于是线上加的不是「当前哪一档」，而是**每一行属于哪一档**：

- `IslandAgent.kind?: "task" | "project" | "team"`
- `IslandAgent.groupLabel?: string | null` —— 组头写什么；`null` = 这一档不分组（任务档就是平铺）

Swift 侧照旧只做「连续切段」，顺序仍由主进程的 `orderedVisibleSessions` 定死。

**缺席 = `"project"`**：旧 helper 忽略新字段，新 helper 遇到旧主进程时全部落进项目档——也就是改动前的行为。

### 决策 4：未读 @ 由渲染层推给主进程

`workspace_mentions` 是**渲染层直连 Supabase** 拉的（#1064），主进程手里没有。两条路：主进程自己再拉一份（多一处查询 + 一份缓存 + 一条 realtime 通道），或渲染层把已经算好的 `unreadMentionCounts(...).total` 推一笔给主进程。

选后者。代价明写：**主窗没开时那个数是陈旧的**，而岛可能还开着。这个代价可接受的理由是它的失败方向——陈旧只会让角标少亮或多亮一会儿，而主窗关着的时候人本来也不在看岛做决定；反过来（主进程自建一条 realtime 通道）要为一个角标复制 #1064 的整条链路。

线上是 `IslandFleet.unreadMentions?: number`，缺席 = 不画（同 `quotaAlert` 对 `null` 的处置：还没查到不是「没有」）。

### 决策 5：两处改名，且**知道它是三处一起改**

- `WINDOW_LABELS.h5`：`"5 小时窗"` → `"5h"`
- `countdown()`：`"…后恢复"` → `"…后刷新"`，时长写成 `1h 38m`；天那一档跟着写 `4d`，不到一分钟写 `<1m`

两个都是**共用函数**，消费方是岛 / 账号页 / 上下文浮层。改了就是三处一起改，**这正是要的**：同一扇窗在两块屏幕上不能有两种叫法（ADR-0209 已经为「同一扇窗两个界面不能给出两个数」立过这条）。

顺带修一处存量不一致：`BillingSettings.tsx` 把 `"5 小时窗"` 写死在 JSX 里，没走 `WINDOW_LABELS`——不改的话账号页会是唯一一处还叫老名字的地方，而它恰恰是那个常量的主消费方。

**不在射程内**：`modelRoute.ts` 那三处 `「X 恢复」` 是 blocked 文案里的另一句话（说的是「这条路什么时候通」不是「这扇窗什么时候刷新」），本次不动。

### 决策 6：删掉 `IslandDisplay` / `islandUsage` 整条链

决策 1 之后那张表没有位置了，决策 2 之后 BYOK 用户也不再需要它当唯一的账。留着它意味着「不分屏」这条口径只兑现了一半。

删除面：`shared/islandUsage.ts`、`IslandDisplay` 类型、`IslandSettings`、`main/islandSettingsStore.ts`、`fleet.display` / `fleet.usage` 两个线上字段、`trim.ts` 里为它们开的那道闸、设置页那一格、Swift 的整张用量表 + 厂商 logo 资源查找、`tests/shared/islandUsage.test.ts`、`tests/main/islandSettingsStore.test.ts`。

删测试**不是为了让门禁变绿**（ADR-0020 那条 L1 红线）：产品代码在同一个 PR 里一起删，被删的是没有了消费方的东西。

## 3. 分片（提交顺序）

1. `WINDOW_LABELS` / `countdown` 改名 + `BillingSettings` 走常量 + 既有测试跟着改
2. `src/shared/islandRail.ts`：页脚的纯投影（`IslandRail` 二选一）+ 测试
3. 线上字段：`IslandAgent.kind/groupLabel`、`IslandFleet.rail/unreadMentions`；`islandProjection` 跟着算 + 测试
4. 主进程接线：`pushFleet` 算 rail；新 IPC 通道收渲染层推来的未读数
5. 删 `IslandDisplay` / `islandUsage` 整条链
6. Swift：顶栏切换器 + 页脚 rail，删用量表
7. ADR（编号合并前 re-fetch 再定，项目 ADR-0074）

## 4. 已知未做

- 岛上的三档**不与侧栏那一档联动**（各看各的）——它们回答的是不同的问题：侧栏答「我现在要进哪条」，岛答「我这会儿盯哪一批」。
- `spend` 那一支不报钱（决策 2）。
- 主窗关着时未读数陈旧（决策 4）。
- Swift 那一半没有自动化测试，`native/MrOttoIsland/Tests` 只有 Codable 往返——顶栏与页脚的版式靠真机看。
