# Otto 应用——智能体按客人需求定制生成的小程序框架 —— 设计

- 日期：2026-10-05
- Task issue：#1591
- 维护者原话：「我想在 Otto 中打一个框架，类似微信小程序。但是和微信小程序不同的是，这些应用完全可以根据用户需求高度客制化，有 Agent 帮助客人制作。」
- 关系：分级调度与任务实体（ADR-0365 / 0367，#1571）、沙箱（DockerWorld）、聊天里的卡（审批卡 / 任务卡）、名片（ADR-0354）、定时任务（ADR-0359）、消息推送（ADR-0338）、热更新与原生包的界线（ADR-0340）
- 范围：**手机端 + 云 runtime + Supabase**。桌面不在本期。

## 0. 维护者已拍板（2026-10-05，会话里）

1. **要做多页、要原生能力**——不止单文件 HTML。
2. **桥的第一版 = `storage + ask + share`**，原生能力按需加。
3. **样板应用：日历提醒 + 记事本**——智能体可读、协助提醒、协助记事、UI 精美。
4. （§8 三问的回答，同日）`ask` 的回答**两边都有**（应用里显示、聊天里留全文）；应用专员**新加 `apps` 域**；设计系统**由应用专员自己设计**
   （不预写，专员按「精美」自己定色板 / 字号 / 组件并写进 manifest，后续版本沿用）。

## 1. 已验前提（2026-10-05，只读核过）

- 手机里已有 `react-native-webview` 13.16、`expo-file-system`、`expo-notifications`（本地通知 + 远程推送都在用）、`expo-camera` /
  `expo-image-picker`、`expo-haptics`、`expo-sqlite`、`expo-web-browser`。**没有** `expo-calendar`——要写进系统日历得加原生件，
  走 TestFlight 包（ADR-0340：原生改动不走热更新）。
- Supabase Storage 已有 `chat-media` 桶（图片 / 视频 / 语音），上传走可续传；没有应用用的桶。
- 定时任务表 `agent_routines`（0058）与 runtime 的 tick 调度器已上线：到点自己起一轮、能打电话 / 推送。**提醒可以直接骑在它上面**。
- 任务实体（`task_*` 事件 + `tasks` 投影）与分级（管理员拆任务派给专员）已上线：「客人说一句 → 管理员派给应用专员 → 做出来」这条链
  不用新开。
- 聊天里已有三种卡（审批 / 任务 / 选人）与「卡 → 一次动作」的模式；名片（ADR-0354）已有「把一样东西发给朋友、对方接受即复制」的模式。
- 最新 migration 0062；协议版本 28。

## 2. 它是什么（一句话 + 三个不同）

**说一句话就有的私人小工具**：每个应用是为这一个用户写的一份小网页（多页，一个压缩包），跑在 Otto 的沙箱 WebView 里，数据存在它自己的
格子里，逻辑不够的地方喊智能体。和微信小程序的三个不同：
- 小程序是开发者写给所有人的；Otto 应用是智能体写给**你一个人**的，改需求 = 出新版本。
- 小程序有一整套 API；Otto 应用只有一座**窄桥**（`window.otto`），窄到能审、能沙箱、模型写得对。
- 小程序靠商店分发；Otto 应用靠**名片式分享**——朋友拿到的是副本，让自己的管理员再改。

## 3. 形状

### 3.1 应用包

一个应用版本 = Storage 里 `apps/<appId>/<version>/` 下的一个 **zip**：

```
manifest.json    名字 / 图标 / 版本 / 入口页 / 页面清单 / 要哪些桥能力 / 数据 schema / 作者智能体
index.html       入口
pages/*.html     多页（页面之间用普通 <a href> 或 otto.nav(page)）
app.js / app.css 任意数量的静态文件
```

- 手机下载 zip 解到沙箱目录（`expo-file-system`），WebView 以 `file://` 载入——多页、相对路径、本地资源都天然成立，离线也能开。
- **没有外网**：WebView 的请求策略只放 `file://` 与桥；`<script src="https://…">` 一律不装（manifest 的 `capabilities` 里没有 `net`，
  第一版也不给 `net`）。要数据走桥。
- 清单里的 `capabilities` 是**白名单**：没声明的桥能力调了就拒（同连接器的工具白名单口径）。

### 3.2 桥（`window.otto`，第一版四件 + 原生能力按需）

| 能力 | 签名 | 落在哪 |
|---|---|---|
| `storage` | `get(key) / set(key, value) / list(prefix) / remove(key)`；每个应用一个命名空间 | Supabase 表 `app_data`（`app_id, uid, key, value jsonb, updated_at`），手机本地 SQLite 缓存、离线先写后同步 |
| `ask` | `ask(text, {context?})` → 起一轮给**管理员**，带这个应用的名字与可选上下文；回答回到应用（也在聊天里留一条） | 走现成的 `say`，开场白带 `app: { id, name }` 字段（新 greeting 一档，向后兼容） |
| `share` | `share()` → 系统分享单 / 发名片给朋友 | 名片信封多一种 `app` 卡（ADR-0354 的形状） |
| `nav` | `nav(page)` / `back()` | 宿主换页（多页的最小支持） |
| **原生能力**（按清单声明） | `notify.schedule({at, title, body})` 本地通知；`remind.create({at, text, repeat})` = 建一条定时任务；`camera.pick()` 相册 / 拍照；`haptic()` | `expo-notifications` / `agent_routines` / `expo-image-picker` / `expo-haptics`——**都已在包里，不打原生包**。系统日历读写（`calendar.*`）要 `expo-calendar`，排二期原生包 |

桥是**消息桥**：WebView `postMessage` ↔ 宿主，每个调用带 id，宿主按 manifest 的 capabilities 判、按应用的命名空间限、按现成的审批规则走
（要动钱 / 发消息 / 碰别的应用的数据的，桥里没有口子）。

### 3.3 智能体那一侧

- **应用专员**：新加 `apps` 域（清单加一项；工具面 = `build_app` + `app_data` 读写 + 只读内置工具）。管理员收到「我要一个记账本」→ `create_task` → 派给应用专员（没有就按护栏雇一只）。
- **`build_app(manifest, files)` 工具**（只有 dev 域有）：① 静态检查——manifest 合规、没有外链脚本、capabilities ⊆ 允许的集合、文件数 /
  体积上限；② 在 runtime 的沙箱里 headless 开一遍入口页不报错（Docker 里已有 node，加 jsdom 或 playwright-lite）；③ 打 zip 上传
  Storage；④ 落 `app_version` 行 + 在对话里落一张**应用卡**（`app_card` 事件：预览图 / 版本 / 「装上」）。
- **智能体可读**：`app_data_read(appId, prefix)` / `app_data_write(...)` 两把刀（管理员与应用专员有）——「上周吃饭花了多少」「帮我记一条」
  都从这里走。写要过审批（主场免审那条规矩原样）。
- **改 = 新版本**：在聊天里说「加个分类」或应用里点「改一下」（= `ask` 带上下文）→ 同一条任务链 → `build_app` 出 v+1 → 卡上「更新」。
  每一版都留着，能回退。

### 3.4 手机那一侧

- 「应用」页（已有，今天列的是接入的连接器）多一段「我的应用」：图标网格，点开进 `AppScreen`（WebView 宿主 + 桥 + 顶栏「改一下 / 分享 / 版本」）。
- 聊天里的应用卡：预览图 + 名字 + 版本 + 「装上 / 打开 / 更新」。
- 首次打开先下载 zip 到本地；之后离线可开；有新版本时卡上与应用页角标提示。

### 3.5 数据与隐私

- `app_data` 按 `(app_id, uid)` 隔离，RLS 只给本人；智能体读写走 runtime 的 service role + 工具的审批规则。
- 应用包本身只有本人能下（Storage RLS）；分享 = 复制一份到对方名下（同名片的「接受即复制」）。
- 生成的 HTML/JS 过一遍 threat scan（同 create_agent），再过静态检查。

## 4. 样板：日历提醒 + 记事本

一个应用两页：**日历**（月视图 + 当天的提醒列表 + 新建提醒）、**记事**（列表 + 编辑，支持 `#标签`）。

- 提醒 = `remind.create` → 一条定时任务（0058）：到点 runtime 起一轮，管理员按 ADR-0359 的规矩推送 / 打电话；应用里看到的「下次提醒」
  读的就是那一行。
- 智能体协助：聊天里说「明天 9 点提醒我交房租」→ 管理员 `app_data_write` 进提醒 + 建定时任务，应用打开就有；「帮我记一下今天和小红聊的」
  → 写进记事；「这周有什么要做的」→ `app_data_read` 读提醒 + 记事答。
- UI 精美：**应用专员自己定设计系统**（色板 / 字号 / 间距 / 组件样式），写进 manifest 的 `design` 一格，同一个应用的后续版本沿用、
  不每版重来；专员的提示词里写明「先定设计系统再写页面，别一页一个样」。
- 这一只打通全链：说一句 → 生成 → 装上 → 用 → 智能体读写 → 改一版 → 分享给朋友。

## 5. 分期

| 期 | 内容 | 能不能 OTA |
|---|---|---|
| **1 骨架** | manifest + zip 包规范、Storage 桶与 `app_data` / `app_version` 表（migration）、桥的 `storage / ask / nav / share`、`AppScreen` 宿主、应用卡事件、`build_app` + 静态检查、应用专员提示词 + 设计系统 | 手机那半能；表与 runtime 不能 |
| **2 原生能力（不打包的那批）** | `notify / remind / camera / haptic`；样板「日历提醒 + 记事本」用这些做出来 | 能（原生件都已在包里） |
| **3 分享与版本** | 名片式分享、对方管理员再改、版本回退 UI | 能 |
| **4 原生包那批** | `expo-calendar`（系统日历）、将来要的别的原生件 | 不能（TestFlight） |
| **5 对外** | 应用发布成 `mrotto.agency/a/<id>` 公开网页（edge 托管），店主做的东西给顾客用 | edge 部署 |

**实施状态（2026-10-05）**：第 1 期拆成 a（runtime 半）与 b（手机半），plan 在 `docs/superpowers/plans/2026-10-05-otto-apps-p1.md`。1a 已做：`src/shared/apps.ts` / `build_app` / `app_card` / `apps` 域 / 0063。plan 对本文的三处小修也生效：**不打 zip**（按文件表逐个传与下，对象路径 `<uid>/<appId>/<version>/<path>`）；`build_app` 只给管理员与 apps 域专员；`ask` 第一期只走聊天那一侧。1b 未做。

## 6. 否掉的备选

- **只做单文件 HTML**：维护者要多页与原生能力。
- **给应用开外网**：开了就审不住（任何一段生成的 JS 都能往外发数据）；要数据走桥，桥能审。
- **让应用直接调模型**：绕过管理员 = 绕过分级与额度；一律 `ask` 给管理员。
- **用 React Native 动态组件而不是 WebView**：RN 不能热加载任意组件；WebView 是唯一能装「生成的 UI」的容器。

## 7. 推翻它的前提

- 哪天 WebView 装不下要的体验（性能 / 手势）→ 回头看 RN 侧的受限组件集。
- 哪天应用要跨用户的实时数据（多人共用一个应用）→ `app_data` 的隔离要重想，那是「应用社交」的下一步。

## 8. 已拍板（原待拍板，2026-10-05）

1. `ask` 的回答两边都有：应用里显示摘要、聊天里留全文。
2. 应用专员新加 `apps` 域。
3. 设计系统由应用专员自己设计，写进 manifest，后续版本沿用。
