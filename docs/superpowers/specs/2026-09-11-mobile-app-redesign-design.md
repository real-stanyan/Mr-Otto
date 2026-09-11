# 手机端重设计（任务 / 项目 / 团队三栏）——界面层总纲

- 日期：2026-09-11
- Task issue：#1237
- 状态：demo 已过（维护者 2026-09-11「按照这个版本做吧」）；本 spec 待过目；ADR 编号合并时认领（项目 ADR-0074）
- Demo：`.demo/mobile-app-redesign.html`（单文件、零依赖，42 屏 + 7 个弹层；从 gitignore 里的 `.superpowers/demo/otto-app.html` 拷进来入库，账号邮箱换成占位——仓库是公开的）。**实现以 demo 为准**，与 demo 不同的地方集中在 §10
- 需求原话（维护者，#1237）：「用 apple design skill 重新设计 otto app 的每一个页面……现在我们有任务/项目/团队 3 栏。任务和团队都是有云通道的，项目是本地的。所以，设计理念是在 App 上要获得和桌面端几乎一致的体验，包括语音通话等，而且 App 上要更着重于语音通话。App 是作为一个脱离了桌面端，也可以完全独立运行，帮用户完成项目或需求的一个端口。」
- 维护者拍板（#1237 正文 + demo 评审时的逐条意见）：
  1. **项目也能上云跑**（项目仓库 clone 进云端容器，电脑睡着手机照样干活）——后端另起子项目，见 §6 的 B1。
  2. **语音是会话页里的模式，不加第四个页签**。评审最后一轮改了落点：通话入口从输入框的大麦克风**挪到导航栏右上角**（任务会话 / 项目会话 / 新任务 / 团队群聊四处同一格），输入框统一成一张通栏卡片 + 发送钮。
  3. Demo 一次铺满全部页面。
  4. 评审里定下的界面规矩（§3 展开）：品牌是 Mr. Otto 不是水獭，logo 与登录页背景动画与桌面同步、深色底下动画也是深色；团队输入框不选模型（模型配在各个智能体上）、不放头像名册那一排、右边是发送钮不是麦克风；「管理员」只属于团队，任务里不出现；模型选单要能选图像模型；导航栏不能太长；表单与确认类用居中弹窗不用抽屉；登录页的忘记密码 / 注册、账号里的管理订阅都要有；整体不要「AI 味」。

## 0. 位置：界面层总纲，下面挂八个前端子项目 + 四个后端子项目

这份 spec 只管**界面层**：每一屏长什么样、数从哪儿来、和桌面共用哪一份判据。数据层已有或正在做的不重判：

| 数据层 | 状态 | 本 spec 怎么用 |
|---|---|---|
| ① 任务会话云端日志（#1223，ADR-0291，migration 0036） | 已合 | 任务栏直连 Supabase 读写，照 ① spec §3.9「③ 手机」契约 |
| ② 云端兜底执行器（#1253） | 在做（另一条 lane） | 电脑睡着时有人答；`pen_busy` 排队 / 问卷卡照 ② spec §3.10 |
| ③ 手机任务会话客户端（#1254） | 未开工 | = 本 spec 的 M2，界面照 demo |
| ④ 一对一语音 + 音色（#1255，Blocked by #1254） | 未开工 | = 本 spec 的 M7 的一半 |
| 团队云会话 cs 协议（ADR-0199 起，协议 19） | 已上线，桌面在用 | 手机做第二个 cs 客户端（M3） |
| 手机 ↔ 桌面加密中继（ADR-0094 / 0095 / 0100 / 0142） | 已上线 | 项目栏继续走它（M4） |
| 订阅计费 edge 端点（ADR-0203） | 已上线 | 账号与订阅直调（M5） |

拆分、依赖与顺序在 §6。每个子项目各自一份 plan（带后端改动的先补小 spec），本文件只定它们共同遵守的东西。

## 1. 已验前提

读代码 / 读依赖清单验出来的。**demo 只在浏览器里跑过，一次没上过真机**。

| 事实 | 出处 |
|---|---|
| 手机端今天是桌面的加密投影：四个阶段 loading / signIn / pair / fleet，三个页签 会话 / 好友 / 设置，范围写死「看时间线 + 审批 + 回一条话」 | `mobile/App.tsx:47-93, 453-509`、`mobile/README.md`、ADR-0094 |
| 手机端没有导航库；`App.tsx` 一个文件 73 KB；组件层 `mobile/src/ui.tsx`（Button / Group / Row / DetailBar / Avatar…），令牌 `mobile/src/theme.ts` 逐值抄自桌面 `app.css` | `mobile/` 全目录 |
| Expo SDK 57 的 Expo Go 自带：`react-native-screens` 4.26、`react-native-reanimated` 4.5.1、`react-native-gesture-handler` 2.32、`react-native-safe-area-context`、`react-native-svg` 15.15、`react-native-keyboard-controller` 1.21、`expo-blur`、`expo-glass-effect`、`expo-haptics`、`expo-audio`、`expo-speech`（系统 TTS）、`expo-notifications`、`expo-web-browser`、`expo-document-picker`、`expo-router` | 主 checkout 的 `mobile/node_modules/expo/bundledNativeModules.json` |
| **语音识别（STT）不在 Expo Go 里**：上面那份清单没有任何 speech-recognition 模块 → ④ 与团队通话的「人说话」要 dev build | 同上 |
| demo 的图标大多是 lucide 的路径（`plus` / `search` / `arrow-up`…），`spark` 是自画的；桌面是 lucide | demo 的 `I()` 图标表 |
| 桌面云会话客户端 `src/main/cloudSessionClient.ts`（1099 行）运行时只 import `src/shared/remote/*` 与 `src/shared/islandTabs.ts`；对 `session/store`、`session/events`、`shared/shellBridge`、`main/proxyManager` 全是 `import type` | 该文件 68-94 行 |
| 团队的 Supabase 读写 `src/main/supabaseWorkspacesApi.ts` 只依赖 supabase-js + `src/shared/*`；`workspaceManager.ts` 依赖 `node:crypto` 与 `proxyStore`，留在桌面 | 两个文件的 import |
| 手机要用的界面判据有一批在渲染层 `src/renderer/src/lib/`：`billingView`、`chatBubbles`、`agentMentionInput`、`cloudModelStatus`、`modelMenu`、`forgotPassword`（`OTP_LENGTH = 8`）只依赖 `src/shared/`；`cloudTimeline` / `workspaceView` / `workspaceUsageView` 还依赖渲染层的 `agentAvatar`；`voiceCallView` 依赖 zustand 的 `store.js` | 各文件 import |
| edge 计费四个端点：`GET /billing/v1/me`、`GET /billing/v1/workspace-usage`、`POST /billing/v1/checkout`（`{planId}` 或 `{addon:true, quantity}`，已订阅回 409）、`POST /billing/v1/portal`；付款完成落 `/billing/v1/done` 一句话页面 | `services/edge/src/edge.ts:340-430` |
| `portalParams` 只带 `customer` + `return_url`，没有 `flow_data`：点「换一档」只能进 Portal 首页，进不了那一档的确认页 | `services/edge/src/billing.ts:157-162` |
| 订阅投影不记 `cancel_at_period_end`：「已取消续费、服务到 9 月 30 日」这一态今天读不出来 | `services/edge/src/billing.ts` 的 `actionFromEvent` 只认 status / period |
| `mobile/` 的类型检查不在门禁里（根 tsconfig 排除它，#422 未收口） | #422、`mobile/README.md` |
| 仓库公开 | `gh repo view` |

## 2. 边界

做：
- demo 里的 42 屏 + 7 个弹层全部落成 RN（§4 清单）。
- 导航骨架与设计系统（令牌 / 字 / 弹簧 / 材质 / 按压 / 弹窗）一次立好，后面各屏只拼；抽屉跟 M2 的第一个消费方（模型选单）一起立（§10）。
- 与桌面共用判据：手机要用的纯逻辑**挪进 `src/shared/`**，不抄第二份。
- 每一屏的「还没查到」「读不到」「没有」「没权限」分开说（§5）。

不做（本 spec，明写）：
- 任何后端（表 / RPC / runtime / edge）——需要的后端改动在 §6 列成 B1–B4，各自开 issue / spec。
- Android 的专门适配（跟随 RN 默认；验收只在 iPhone 上做）。
- iPad 布局（`supportsTablet: true` 保留，按手机布局拉伸）。
- 手机上的文件编辑器（demo 明写「手机上没有编辑器」）。
- App Store 上架（牵涉 IAP，§8 第 1 条）。

## 3. 设计语言（全 app 共同遵守）

### 3.1 令牌、字、图标

- 颜色只用 `mobile/src/theme.ts`（逐值抄自桌面 `app.css`，名字逐字对齐）。**蓝色一屏只给一个主动作**；彩色只用来说「出事了」（`warn` / `destructive`），其余靠材质与字重分层——同桌面 ADR-0264「图标底座中性、不上彩色方块」。
- 字阶沿用 `theme.ts` 的 `type`（大字负字距、正文 0、脚注微正），不另起一套。
- 图标：demo 同一份路径经 `react-native-svg` 画（demo 的图标大多是 lucide 的路径，`spark` 是自画的；照 lucide 画会和过目的那版不一样）。不引 `lucide-react-native`（§10）。

### 3.2 导航

- **三个页签：任务 / 项目 / 团队**。页签栏毛玻璃（`expo-blur`；demo 取 blur 24–28 + saturate 160–180%），角标只在「团队」那一格（被 @ 的未读，与桌面 ADR-0256 同一份判据）。
- 每个页签一个**原生栈**（`@react-navigation/native-stack`，底下是 `react-native-screens` = UINavigationController）：推入 / 返回 / 左缘右划都是系统的，天然可打断——这是 apple-design「跟手、可打断」最便宜的来源。桌面 ADR-0264 自写弹簧是因为 web 上没有原生栈，手机上没这个理由。
- 页签根的导航栏：左边是大标题 + 一行状态（「1 条在跑 · 4 条闲着」），右边三枚：搜索、新建（任务：新任务；项目：新项目；团队：新团队）、头像（进账号）。**导航栏只放这些**（评审意见：header 不能太长）。
- 会话页导航栏右上：**电话**（语音）+「⋯」会话菜单；项目会话多一枚「文件夹」（项目文件）。四处电话同一格（拍板 2）。
- **全屏模态从底部升起、原路回落**：语音通话、App 内浏览器（Stripe）。
- **选择器用底部抽屉**（下拉可关、带动量）：模型、附件、上下文、会话菜单、@ 名册。
- **表单与确认用居中弹窗**（scale .96→1 + 暗幕，同桌面 ADR-0265 的 `useConfirm`）：邮箱登录表单、审批详情、解散团队、降档 / 取消订阅。其中前三个 demo 里还是抽屉，见 §10。

### 3.3 动效与触感

- 弹簧用 Apple 两参数口径（response / damping），默认临界阻尼；只有带动量的手势（抽屉下拉、页面右划松手）才给 .82–.86 的回弹。demo 实际用的档：response `.28–.42 s`、damping `.82–1`。换算照 `src/shared/appleSpring.ts`（ω₀ = 2π / response）：M0 / M1 用 RN 自带的 `Animated.spring`（吃同一套物理量），M2 起手势驱动的抽屉用 `react-native-reanimated`（§10）。
- 按压反馈在按下那一刻：按钮 `scale .96–.98`；列表行用高亮不用缩放（一列里某行缩小会打断基线，同 ADR-0264）。
- 系统「减弱动态效果」开着时：推入 / 升起一律退成交叉淡入，弹簧不回弹（`ui.tsx` 的 `useReduceMotion` 已有）。
- 触感（`expo-haptics`）只在四处：批准 / 拒绝落定、发送、通话接通 / 挂断、抽屉吸附。多了就没人注意了。

### 3.4 文案

- 品牌是 **Mr. Otto**，logo 用桌面同一张。登录页与冷启动的背景是桌面同一套抖动波场（`src/shared/dither.ts`，手机已在用），**深色模式下波场也是深色**。
- 界面文案**不出现「水獭」**：团队里的叫「智能体」（桌面渲染层用了 61 处，是主流叫法），任务里对面叫「Otto」。demo 里还剩 18 处「水獭」，实现时一并换掉。维护者已确认（§11）；桌面渲染层还剩的那几个文件另开 #1264（§8 第 6 条）。
- 同一件事与桌面**用同一个词**：团队（不叫工作区）、智能体、免审批、会话、归档、订阅额度。

## 4. 屏幕清单与数据来源

括号里是 demo 的屏幕 id。「源」一栏：**SB** = 直连 Supabase（用户 JWT + RLS）、**CS** = cs 帧经中继到 VPS runtime、**RL** = 加密中继到自己的桌面（ADR-0094 投影）、**E** = edge HTTP、**L** = 本机。

### 4.1 进门（M1）

| 屏 | 做什么 | 源 | 今天 |
|---|---|---|---|
| 冷启动（splash） | 波场 + logo | L | 有（`BootSpinner` + dither） |
| 登录（signin） | 邮箱密码 / Google / GitHub；「忘记密码？」「没有账号？注册」 | SB auth | 有，要重排 |
| 注册（signup）+ 等确认信（confirmMail） | 邮箱 + 两次密码；发信后停在「去邮箱点一下」 | SB `signUp` | 没有 |
| 忘记密码（forgot → forgotCode → forgotSet） | 发码 → **8 位**验证码（4 + 4 两组，`OTP_LENGTH`）→ 设新密码 | SB `resetPasswordForEmail` / `verifyOtp{type:"recovery"}` / `updateUser` | 没有 |

- 忘记密码走验证码不走链接（同桌面 ADR-0194：每一跳都是一个人会走丢的地方）。验完 recovery OTP 拿到的是真 session——**设完新密码之前不放进 app**（同桌面 `holdGateForPasswordReset`）。
- 扫码配对**不再是进门的一步**：登录后直接进三栏；「设备与配对」在设置里，项目栏要用电脑时才需要（§4.4）。

### 4.2 任务（M2 = #1254 ③）

| 屏 | 源 | 说明 |
|---|---|---|
| 列表（tasks） | SB `task_sessions` + realtime | 在跑的置顶，带执行方标签（本机 / 云端 / 另一台电脑，按 `pen_holder` 分）；底下一行「已归档」 |
| 开局（taskNew） | SB `task_append(expected_seq 0, [session_created, user_message])` | 不带 workspace（① §3.9）；四个示例话头 |
| 会话（taskChat） | SB 事件 select + realtime；发话 `task_append(user_message, holder "phone:<deviceId>")` | `executor_changed` 画一行分隔（「电脑睡着了，这一轮由云端接手」）；撞 `pen_busy` 的那条画「等对面说完」、问卷卡走 `task_answer`（② §3.10） |
| 已归档（archive） | SB | 恢复 = `session_unarchived`（human 类事件） |
| 搜索（search） | 当前那一栏的源 | 三栏共用一屏，从哪一栏点进来就搜哪一栏；v1 只搜已加载的标题 + 最近一句，不做全文 |

- 「没人会答」= 笔空 + 电脑心跳陈旧 + 没订阅 → 输入框上方一行「电脑不在线；云端接手要订阅」（① §3.9）。
- **任务里没有「管理员」、没有 @ 名册**（那是团队的东西）。
- 模型选单两格「文字 / 图像」（同桌面 ADR-0261），Auto 是一个取值（ADR-0244 / 0249）；落 `model_changed` / `image_model_changed`（human 类，免笔）。
- 附件：Storage `task-attachments`，对象名 `<uid>/<sha256 hex>`（① §3.6）。
- 上下文环：手机端从事件现算（`src/shared/contextEstimate.ts`），额度那半读 `/billing/v1/me`（ADR-0254 / 0255 口径）。

### 4.3 团队（M3）

| 屏 | 源 | 说明 |
|---|---|---|
| 列表（teams） | SB（团队、云会话、`workspace_mentions`） | 每个团队一组，组头 ⚙ 进设置；@ 我的未读角标（ADR-0256） |
| 新建（teamNew） | SB insert（RLS `can_create_workspace()`） | 档位不带团队能力时说清去哪儿换档（ADR-0242 的四态） |
| 群聊（teamChat） | CS：hello → welcome → backlog + 直播 + `delta` 流式 | 输入框**不选模型、没有名册那一排、右边是发送**；@ 走抽屉（智能体 + 成员，ADR-0252）；不 @ 就是 ADR-0270 派活；审批卡；通话那一行居中 + 头像（ADR-0286） |
| 设置目录（teamSettings） | SB | 七格推入页 + 最底下红字「解散团队」（ADR-0264） |
| 智能体 / 改智能体（teamAgents / teamAgentEdit） | SB | 型号白名单、连接器白名单（ADR-0221「空 = 全给」口径） |
| 成员（teamMembers） | SB | |
| 连接器（teamConnectors） | SB | 只读；授权要在借出方电脑上点 |
| 文件（teamFiles） | CS 控制房 `files` / `files_result` | 只读树 + 预览（ADR-0251 / 0253） |
| 全部会话（teamSessions） | SB | 进行中在上、归档在下（ADR-0264 决策 8） |
| Wiki（teamWiki） | 读走 CS `files`（wiki 就在工作文件夹的 `wiki/` 里，桌面也这么读），改走控制房 `wiki_write` | 可改，与智能体改的走同一道门（ADR-0282） |
| 用量（teamUsage） | E `/billing/v1/workspace-usage` | 报占所有者本周额度的百分比，不报钱（ADR-0264） |

- cs 客户端**不另写一份**：把 `src/main/cloudSessionClient.ts` 的核心挪到 `src/shared/remote/`，桌面主进程与手机各自注入传输（`wsTransport.ts` 两端本来就共用）与 JWT。§1 只核了 import，挪之前要把全文过一遍有没有漏网的运行时依赖。
- 团队的 Supabase 读写同理：`supabaseWorkspacesApi.ts` 挪进 `src/shared/`，`workspaceManager.ts` 留在桌面。

### 4.4 项目（M4）

| 屏 | 源 | 说明 |
|---|---|---|
| 列表（projects） | RL `fleet`（按项目分组）+ 云端项目（B1 之后） | 每个项目一行机器状态：本机在线 / 云端 / 电脑睡着（「现在只能聊和记，动文件等它醒」） |
| 新建（projectNew） | RL（选电脑上的文件夹）/ B1（连 Git 仓库）/ 空项目 | 后端没到位的那一项**画灰并说清缺什么**，不画一个点了没反应的钮 |
| 会话（projectChat） | RL `timeline` / `send` / `approve` / `deny` / `upload` | 审批只两档（ADR-0096）；「在这个项目里新开一段」要**新帧 `create`** |
| 文件（projectFiles） | RL **新帧**（列目录 / 读文件） | 只读，走桌面 `filesService.ts`（ADR-0092 的三条安全边界原样） |

- 项目栏是 ADR-0094「投影窗口」那条路，**决定 5「手机永不产生事实」在这一栏原样成立**；新帧只扩命令面（决定 4 的五个词再加三个：`create`、列目录、读文件）。任务栏的写法是 ADR-0291 已经放宽过的（human 类事件经 RPC），团队栏写事实的是 runtime。三栏三种写法，各有出处，不混。
- 电脑不在线时项目栏不是空白：列表照画上次的 `fleet` 快照 + 时间，会话页只读并说「等 <电脑名> 醒」。

### 4.5 语音（M7）

| 屏 | 源 | 说明 |
|---|---|---|
| 一对一（call） | ④ #1255 | 任务会话里的 Otto；「通话中」是日志事实（④ 的边界） |
| 团队（callTeam） | CS `call` + `voice_call_changed`；TTS 走 E `/llm/v1/speech` | 头像格 + 状态词 + 两行字幕（ADR-0278 的 `callTiles` 判据）；结束 = 全组，静音 = 本机（ADR-0271） |

- 放音用 `expo-audio`（Expo Go 就有）；**听写要 dev build**（§1），所以「人说话」那半跟 ④ 一起走 dev build，放音那半可以先上。
- 半双工 / 插嘴要回声消除（ADR-0273 / 0277）；iOS 上 `AVAudioSession` 的 voiceChat 模式自带，写 ④ 的 spec 时验。

### 4.6 账号、订阅与设置（M5 / M6）

| 屏 | 源 | 说明 |
|---|---|---|
| 账号（account） | E `/billing/v1/me` + SB profile | 档位徽章四色（ADR-0240）；两扇窗报「还剩百分之几」（ADR-0239）；热力图 + 各模型占比今天只有 RL 的 `stats` 帧给得出（ADR-0115，要电脑在线），电脑不在时那一块说「电脑不在线，用量明细看不到」，额度两扇窗照画；管理订阅；退出登录 |
| 管理订阅（subscription / subPastDue / subEnding / subFree） | E checkout / portal | 换档**只走 Portal**（ADR-0203 决定 18，已订阅的人不开第二张 checkout）；降到 Lite / 取消订阅先弹一张说后果的居中弹窗 |
| App 内浏览器（stripeWeb） | `expo-web-browser`（SFSafariViewController） | 整屏升起，左上「完成」；回来后「正在从 Stripe 同步…」→ 重拉 `/billing/v1/me` |
| 设置目录（settings） | — | 语音与音色 / 记忆 / 连接器 / 设备与配对 / 通知 / 好友 / 外观 / 隐私与安全 / 关于 |
| 语音与音色（voice） | ④ 定落点（`profiles` 或独立表） | 试听走 `/llm/v1/speech`；「可以插嘴」按设备能力说支不支持 |
| 记忆（memory） | SB `memory_docs` | 四档，能改能删，后写胜（ADR-0207） |
| 设备与配对（devices） | SB（`mobile/src/devicesApi.ts`，已有）+ 扫码配对（ADR-0142，已有） | |
| 通知（notifs） | B3 | 推送后端到位前只画**本机**那半开关，并写明「电脑和云端还不会推到手机」 |
| 好友（friends） | SB（`mobile/src/friendsApi.ts`，已有） | 换皮不换逻辑（ADR-0114） |

- demo 里设置目录的「连接器」直接推到了团队连接器那一页，那是 demo 省事。个人连接器（桌面 MCP）住在电脑上：手机 v1 要么经 RL 拉一份只读清单（又一个新帧），要么这一行不列——写 M6 的 plan 时二选一。

## 5. 状态与降级（每一屏都要过的四条）

1. **还没查到 ≠ 没有**：`billing === null` 不退成 Free（ADR-0240）；团队能力 `unknown` 不并进「没订阅」（ADR-0217）；列表首帧画骨架，不画空态。
2. **读不到 ≠ 空**：读失败时上一份留在原地，错误另起一行（ADR-0243 / 0251）。
3. **说不清就不画钮**：点了必然失败的钮不画（#722 那一族）——没订阅不画语音、非所有者不画「免审批」开关、后端没到位的「连 Git 仓库」画灰并写一句缺什么。
4. **离线**：任务栏 SB 读不到时画缓存 +「离线」；团队栏 cs 断线时输入框上方一行「正在重连」，发出去的话按 `CloudAck.unknown` 画「不确定有没有发出去」（ADR-0228）；项目栏见 §4.4 末。

## 6. 子项目与顺序

| # | 子项目 | 依赖 | issue |
|---|---|---|---|
| M0 | 骨架与设计系统：导航库、三栏壳、令牌 / 字 / 弹簧 / 材质 / 弹窗、图标；今天的功能搬进新壳（会话页 → 项目栏根，好友 / 设置 → 账号栈），任务 / 团队两栏先是一句「下一步做」的空态（抽屉挪到 M2，§10） | — | #1237 |
| M1 | 进门：登录 / 注册 / 忘记密码 / 确认信 / 冷启动 | M0 | #1237（与 M0 同一个 PR） |
| M2 | 任务栏 | M0、①（已合）；`pen_busy` 与问卷卡等 ② 合并 | #1254 |
| M3 | 团队栏（群聊 + 设置七页 + 新建 + @ + 审批）+ cs 客户端挪进 shared | M0 | 新开 |
| M4 | 项目栏（中继投影 + 三个新帧） | M0 | 新开 |
| M5 | 账号与订阅 | M0；B2、B4 | 新开 |
| M6 | 设置（记忆 / 设备 / 通知 / 好友 / 外观 / 关于） | M0；通知那一页的推送要 B3 | 新开 |
| M7 | 语音：团队通话 + 一对一 | M3；④（#1255）；dev build | #1255 + 新开 |

后端（不在 `mobile/`，各自 spec）：
- **B1 项目上云**（拍板 1）：项目仓库 clone 进云端容器；凭据 / 沙箱 / 计费面重判——它放宽了 #1223 拍板 ①「云端无沙箱」的适用范围。
- **B2 Portal 深链**：`portalParams` 带 `flow_data`（`subscription_update_confirm` / `subscription_cancel`）+ `after_completion` 回 `/billing/v1/done`。
- **B3 推送**：设备 token 表 + 发送方 + 四类事件（被 @ / 待审批 / 跑完 / 通话开始）。
- **B4 订阅投影记 `cancel_at_period_end`**：「已取消续费」读得出来。

顺序建议 **M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7**。B2 / B4 小，随 M5 走；B1、B3 大，各自排期。**第一份 plan = M0 + M1**（`docs/superpowers/plans/2026-09-11-mobile-m0-m1-shell-and-gate.md`）。

手机端没有发布渠道（Expo Go / 自签），中间态只有维护者看得到，所以 M0 合进 main 时任务 / 团队两栏是空态可以接受——空态写实话，不画假数据。

M0 的 PR 带一份 ADR：手机端从「投影窗口」扩成三栏客户端（ADR-0094 背景里那句范围作废，决定 1–6 在项目栏原样成立），以及导航 / 动效依赖的选择。`mobile/README.md` 的「范围只有两件事」同一个 PR 改。

## 7. 测试与验收

- **纯逻辑进 `src/shared/`，测试进 `tests/shared/`**，跟着根门禁跑——这是 `mobile/` 类型检查不在门禁（#422）时唯一有保障的那一层。
- 每个手机 PR 手跑 `npm --prefix mobile run typecheck`，结果写进 PR 正文（#422 收口前的约定）。
- 每个子项目收尾：在 iOS 模拟器上把 demo 对应的屏逐一过一遍，截图与 demo 并排对照，偏差记进 §10。
- 真机手验另列清单（毛玻璃、弹簧手感、键盘推起输入框、触感、放音），跟着真机验收欠账汇总走（#907 的形状）。

## 8. 已知代价

1. **App Store 的 IAP 规矩**：iOS 上卖数字订阅，美国区以外原则上要走 IAP；demo 的「Stripe 页整屏升起」只在美国区放宽外链之后成立。本 spec 不上架，上架前要单独判（可能要 IAP，或按区收起购买入口）。
2. demo 从没在真机上跑过；毛玻璃、弹簧手感、键盘推起输入框这三样在 RN 上一定有偏差。
3. `mobile/` 的类型检查不在门禁（#422）：收口前靠手跑 + PR 正文。
4. 项目栏依赖桌面在线；B1 之前电脑睡着时项目栏只能看快照。
5. cs 客户端挪进 shared 是桌面也要动的重构，回归面在桌面云会话。
6. 去「水獭」只做手机端；桌面剩下的另开 #1264，过渡期两端措辞不一致。
7. 上 dev build 之后告别 Expo Go（STT）：开发走 `expo run:ios` + 签名。
8. 通知在 B3 之前只是本机开关，写明白，不假装会推。
9. 账号页的热力图与模型占比要电脑在线（今天只有 RL 的 `stats` 帧算得出）。

## 9. 否决的候选

- **Expo Router（文件路由）**：入口要换成 `expo-router/entry`、目录改成 `app/`，还要和现在 metro 的 `watchFolders` + `.js → .ts` 解析一起重配；它底下就是 react-navigation，直接用后者少一层、改动面小。
- **手写栈导航 + 手势**（像桌面 ADR-0264）：桌面是 web 上没有原生栈才自写；手机有 UINavigationController，手写只会在「半路反向」「左缘右划」上更差。
- **原生页签栏（iOS 26 液态玻璃）**：外观随系统版本变，团队角标与 demo 对不齐；先用 JS 页签栏 + 毛玻璃，等 iOS 26 普及再判。
- **手机上抄一份 cs 客户端**：1099 行的协议状态机（liveBuffer 合并、seenSeqs 去重、ACK 超时三态）抄两份必然分家。
- **手机直接跨目录 import 渲染层的 lib**：`src/renderer` 是桌面渲染层，手机 import 它会让「这一层能不能碰 DOM / zustand」变成两边都要守的规矩；挪进 `src/shared/`，交给架构断言守。
- **第四个「语音」页签 / 底栏大麦克风**：拍板 2 否掉。
- **输入框里的大麦克风当通话入口**：评审最后一轮挪到导航栏（它和团队页的通话钮重复，还挤掉了发送钮）。

## 10. 与 demo 不同的地方（实现以这里为准）

1. 「用邮箱登录」表单、审批详情、「解散团队？」三个弹层：demo 是底部抽屉，实现改**居中弹窗**——维护者在订阅页说「采取弹窗显示，不要下拉框」，表单与确认类一律照这条（订阅页那两张 demo 里已经是）。
2. 设置目录的「连接器」：demo 推到团队连接器，实现是个人连接器（§4.6 末）。
3. 文案里的「水獭」全部换掉（§3.4）。
4. 图标不引 `lucide-react-native`，用 demo 同一份路径经 `react-native-svg` 画（§3.1）：demo 的 `spark` 不是 lucide 原图。
5. `react-native-reanimated` / `react-native-gesture-handler` / 底部抽屉挪到 M2（§3.3）：M0 / M1 没有手势驱动的动效，抽屉的第一个消费方是 M2 的模型选单。
6. 找回密码第二步的说明去掉「邮件里那条链接点了也算」：手机端没有接 `mrotto://auth-callback` 的深链（Expo Go 里 scheme 也不是它），这句话在手机上是假的。
7. **弹窗的退场要放得出来**：plan 里确认信、找回密码两张弹窗的「稍后再说」「取消」直接把弹窗卸掉，`Dialog` 收不到 `visible=false`，140ms 的退场是死代码。实现改成弹窗自己持有 `open`：按钮只把它关掉，`Dialog` 放完退场调 `onExited`，调用方在那里才卸载；退场途中不接手指（Task 7 审查回流）。以后每一张「有值才画」的弹窗都照这条。
8. 减弱动态效果时，页签与右上头像的按压反馈退成透明度 0.7：plan 只写了缩放，而 §3.3 要的是「缩放退成透明度」，不是没有反馈。
9. 几处不改变画面的小处：进门那两处报错（闸门上、找回密码弹窗里）共用 `mobile/src/gate/NoticeLine.tsx` 一份画法；找回密码的「按住闸门」写在 `try` 里（写在外面的话，落盘失败会让锁住的弹窗一颗钮都点不动）；expo-haptics 57 的枚举是 `ImpactFeedbackStyle`（plan 写成 `ImpactStyle`）；`app.json` 多了 `expo-font` 插件那一行（`expo install` 自动加的，Expo Go 下不起作用，M7 换 dev build 时要它）。
10. 登录之后先落在「项目」栏，不是 demo 的「任务」：M0 里任务 / 团队两栏还是实话空态，第一眼不该落在一张空卡上；M2 接上任务栏后改回（`mobile/src/nav/RootNavigator.tsx` 的 `initialRouteName`）。
11. 终审回流（计划层面的缺陷，实现照改）：退出登录失败要说出来（断网且 token 过期时 supabase 既不登出、也不发 `SIGNED_OUT`）；session 任何时候没了都清掉「按住」（`shared/mobileGate.ts` 的 `resetHoldSurvives`），「以后再说」也自己收起弹窗；找回密码的三种报错（验证码不对或过期、新旧密码相同、登录状态没了）有了人话，桌面同一张表跟着受益。

（写 plan / 实现期间的偏离与复审裁定追加在这里。）

## 11. 维护者拍板（2026-09-11，对这份 spec 回了「ok」）

1. 界面文案去「水獭」：团队里的叫「智能体」、任务里对面叫「Otto」，照此做；桌面渲染层剩下的另开 #1264。
2. #422 走 B（`mobile/` 类型检查纳入根门禁 + CI 先装手机依赖），这是门禁改动（L1），另走自己的 PR；在它合并之前，手机 PR 手跑 `npm --prefix mobile run typecheck` 并写进 PR 正文。
3. 第一份 plan 做 M0 + M1（`docs/superpowers/plans/2026-09-11-mobile-m0-m1-shell-and-gate.md`），顺序照 §6。
