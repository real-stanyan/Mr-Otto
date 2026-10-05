# 应用连接卡：智能体要用一个还没连上的应用时，会话里出卡、正看着就弹窗（#1666）

## 0. 需求与已定的事

维护者原话：「如果智能体办一些事需要外部应用登录的话，跳一个快捷方式的弹窗给用户，让用户点击进去快捷连接需要操作的应用」。

brainstorming 里已定：

- **应用 = 连接器目录里的应用**（`MCP_CATALOG`，82 个）。不跳别的 App 本体，不做任意网页登录。
- **形式 = 会话里一张卡 + 正看着时自动弹居中弹窗**。卡在日志里，离开再回来还在；弹窗只弹一次。
- **做法 A**：显式工具 + 登录过期自动兜底，卡片事件的生命周期照选人卡（ADR-0361）。
- **一期只做云端智能体 + 手机**。桌面本地会话已有 `mcp_authorize`，不动。
- demo：`https://claude.ai/artifact/54HPipjsHkFqT7Vne6pnw2` 下半页（维护者看过，没提改动）。

## 1. 调研改了设计的两处

1. **runtime 看不见主人的「云箱」**：`/px/v1/cloud*` 对平台身份回 403（`services/edge/src/edge.ts:336`），它能读的只有 `/px/v1/grants`，那里只列状态正常、这个人用得了的应用，登录过期的整台不进。所以 **「没接过 / 登录过期 / 接了没开给这里」三种情况由手机判断**：卡里只存目录 id，手机拿自己的 `cloudView` 和这个工作区的授权算出该显示哪个按钮。runtime 只管一件事：这个应用此刻已经在智能体的工具里了，就不发卡，直接让它用。
2. **选人卡点完不起新一轮**（它直接拨电话，结果靠通话自己的汇报回到模型）。连接卡要「连上了接着办」，所以照 `queuePairCallSummary` 那条路：写一条带 `greeting` 的开场白，`coordinator.enqueue` 起一轮。

## 2. 事件

新事件类型 `app_connect`（`src/session/events.ts`），`ignorable: true`，形状照 `friend_pick`：

```ts
interface AppConnectEvent {
  type: "app_connect";
  connectId: string;
  phase: "offered" | "connected" | "dismissed";
  fromAgentId: string;
  // offered 才有：
  catalogId?: string;      // MCP_CATALOG 的 id，如 "supabase"
  appName?: string;        // 发卡那一刻目录里的名字（目录改名也画得出）
  why?: string;            // 智能体说的为什么要连，≤ 120 字
  reason?: "missing" | "needs_login";  // 工具主动发 = missing；409 兜底 = needs_login
  ignorable: true;
}
```

- 过期与被顶掉在读的时候算（照 `friendPickStatus`）：发出后 **24 小时**没动 = 过期；同一会话里同一个 `catalogId` 发了新卡，旧卡算被顶掉。
- 要登记的地方照 `friend_pick` 抄：`KNOWN_EVENT_TYPES_MAP`、`persistencePolicy`（持久化）、`agentView`（keep）、`deriveMessages`（不进模型）、`contextEstimate`、`cloudTimeline.hiddenFromCloudTimeline`、`sessionPackage`（strip）、`taskSync`、桌面 `Timeline.tsx`（不画）。
- 新 greeting 值 `"app_connected"`（`user_message.greeting` 联合尾巴加一个）：连上后那条开场白。

## 3. runtime

### 3.1 工具 `request_app_connect`

- 参数：`{ app: string; why: string }`。`app` 先按目录 id 精确匹配，再按名字不分大小写匹配，都没有回错误「目录里没有这个应用」。
- 谁有：云端会话里的 L0 管理员和 L1 专员；**外联会话不给，受监督的那一轮不给**（朋友点起的轮不能替主人要授权）；只在主人自己的主场工作区给（团队工作区一期回「团队里先不支持，让主人去 我 → 应用 里连」）。
- 先查这一轮的 grants 快照：这个应用已经在工具里 → 回「X 已经连上了，直接用它的工具」，不发卡。
- 同一会话同一应用已有一张开着的卡 → 不重发，回「卡已经在会话里了，等主人点」。
- 每会话每小时最多 3 张卡（同 `RELAY_TO_OWNER_PER_HOUR_MAX` 那种窗口）。
- 发卡：`logAppConnect({ phase: "offered", ... reason: "missing" })`。工具结果文本让模型用一句话告诉主人要连什么（这一句会走现有的回复推送，主人不在这页也收得到），然后这一轮停下，别再试那个应用。
- 不过审批门：它只是在自己会话里画一张卡，真正的授权在主人手里（同 ADR-0358 不掀审批的论证）。

### 3.2 登录过期兜底

- `pxTools.ts` 调连接器工具拿到 409 `code: "needs_login"` 时，把 code 留下来（现在只留了 message）。
- runtime 自动发一张 `reason: "needs_login"` 的卡（`catalogId` 从 `serverId` 的 `cloud-<catalogId>` 取；不是这个形状的就不发卡），同样「已有开着的卡不重发」。
- 工具错误文本改成「X 的登录过期了，已经在会话里请主人重新登录；这一轮别再调它」。

### 3.3 帧 `app_connect`（主人点了之后）

- 上行 `{ t: "app_connect", connectId, outcome: "connected" | "dismissed" }`，下行 `{ t: "app_connect_result", connectId, ok, message? }`。`CS_PROTOCOL_VERSION` 28 → 29。
- 只有会话主人能点（同 `pickFriend` 的 `byUid !== opts.ownerUid` 闸）；卡不是开着的（已连 / 已忽略 / 过期 / 被顶掉）就拒。
- `connected`：清 `grantsSnapshot`（否则 60 秒内下一轮还看不到新工具），写 `phase: "connected"`，再写一条 `greeting: "app_connected"` 的开场白（「主人连上了 X，接着办刚才的事」，mentions 发卡那只），`enqueue` 起一轮。这条开场白算主人亲口（`openingTraits` 的 `ownerSpoke` 放行）：只有主人点得出来，工具又不在受监督轮里给。
- `dismissed`：写 `phase: "dismissed"`，**不起新一轮**；模型下一轮从时间线读到「主人没连 X」（`deriveMessages` 给它一句旁白）。

## 4. 手机

### 4.1 卡（`mobileChat` 行 `app_connect` + `Bubbles.tsx` 的 `AppConnectCard`）

- 长在发卡那只的气泡位置（左边、智能体底色），照 demo：应用图标 + 一句标题 + 智能体给的 why，底下两格按钮「不用了 | 主按钮」。
- 主按钮和标题由手机算：

| 手机看到的情况 | 标题 | 主按钮 | 点了做什么 |
|---|---|---|---|
| 云箱里没有这个应用 | 要连上 X 才能办 | 去连接 | `ConnectAppDialog`（新接，Supabase 这种要填参数的在弹窗里填） |
| 有，状态 `needs_login` | X 的登录过期了 | 重新登录 | `ConnectAppDialog relogin` |
| 有、状态正常，但没开给这个工作区 | X 还没开给这里 | 打开 | `lendToTeam(...on: true)` |
| 有、正常、已开给这里 | （卡直接当成可以点「已连上」） | 好了，接着办 | 直接发 `connected` 帧 |

- 结局状态：已连上（绿字「已连上，接着办」）、已忽略（「没连。要用再跟我说。」）、过期 / 被顶掉（「这张卡过期了」）。
- 只有主人能点；别人只读（同选人卡的 `canPick`）。

### 4.2 自动弹窗

- 条件全满足才弹：这张卡是**这次打开页面之后新到的**（seq 大于进页时日志里最大的 seq；翻历史、重进页面都不弹）、状态开着、我是主人、页面在前台。每张卡最多弹一次（内存里记 `connectId`）。
- 弹窗用 `mobile/src/dialog.tsx` 的居中 `Dialog`：图标、「管理员」、标题、why，主按钮同卡，次按钮「稍后」（只关弹窗，卡还在）。
- 主按钮：先让弹窗 `visible=false`，等 `onExited` 再挂 `ConnectAppDialog`（`ConnectAppDialog.tsx:4` 的坑：系统登录页不能叠在一个正在收起的 Modal 上）。
- `ConnectAppDialog` 的 `onClose(landed)` 拿到连上的应用 → 发 `connected` 帧；拿到 null（人取消了）→ 卡保持开着。

### 4.3 桌面

- 一期不画卡。云会话页给一条灰色旁白「X 请你在手机上连 Y」，结局写「已连上 Y」/「没连 Y」。

## 5. 测试

- shared：`appConnectFoldOf` / `appConnectStatus`（过期、被顶掉）；手机端状态判断（四种情况）；`mobileChat` 行；帧解析（上下行、未知 outcome 拒）。
- runtime：工具（目录匹配、已在工具里不发卡、已有开卡不重发、每小时上限、外联 / 受监督 / 团队工作区不给）；409 兜底发卡；`app_connect` 帧（非主人拒、卡不开拒、connected 清快照 + 写开场白 + 起一轮、dismissed 不起轮）。
- 门禁 `npm test`。

## 6. 不做 / 留着

- 不跳别的 App 本体、不做任意网页登录。
- 团队工作区一期不发卡。
- 桌面不画卡。
- 卡不进推送的专门通道，靠工具让模型说的那一句走现有回复推送。

## 7. 部署

runtime 部署 → 手机热更新。协议号 +1：旧手机连新 runtime 会被握手拒、提示更新（同以往每次协议 +1）。无 migration。

## 8. ADR

合并时领号（现在最大 0372）：「智能体要连应用时发连接卡 — 状态由手机判断 — 连上起一轮、忽略不起轮」。
