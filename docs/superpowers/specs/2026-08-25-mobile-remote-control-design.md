# Mr Otto 手机端：远程投影与审批

日期：2026-08-25 · 状态：设计已定，待实施计划

## 一句话

手机端不是新子系统，是**给一个已存在的协议换第二种传输**：灵动岛（`src/main/islandBridge.ts`）
已经定义了「主进程之外的消费者收状态、回四个命令」这套契约，手机就是隔着公网的第三个消费者。

## 范围

**做**：看当前会话在干什么、收审批推送、点同意/拒绝、发一条追问。

**不做**：手机上建会话、改设置、看文件树、切模型、管 MCP。整条 `ShellBridge`（998 行）不上公网。

**首发平台 iOS**，Android 留到接 FCM 时另设计（推送机制完全不同）。

## 约束与前提

- **Apple Developer 账号（99 USD/年）是硬前提**。免费个人 team 能签能装（7 天过期），够开发切片 1–6；
  APNs 推送必须付费账号。桌面签名（ADR-0026 / ADR-0075）本来也需要，一次买断两处。
- 现有基建：Supabase 自托管（OAuth + 表 + RLS + Realtime）、`services/gateway`（Hetzner VPS，
  验 Supabase JWT，nginx 已关 `proxy_buffering`）。
- ADR-0027 / ADR-0055 已记载自托管 Realtime 链路不可靠（#77 静默死了半个多月），
  故**不用 Realtime 做中继**，在网关上新开 WSS 端点。

---

## 一、整体形状

### 四方

**桌面主进程** 新增 `src/main/remoteBridge.ts`，与 `islandBridge.ts` 平级、共用同一个投影源
（`islandProjection.ts` 的 `reduceIsland` / `IslandFleet`）。对外持一条**出站** WSS 长连接到网关，
用户机器不开任何入站端口，NAT 后可用。

**otto-gateway** 新增中继端点 `/rl/v1`。只做三件事：

1. 验 Supabase JWT，认出是哪个 `user_id`
2. 把同一 `user_id` 名下的桌面连接与手机连接的字节互转
3. 手机不在线时，按桌面递来的信号帧发一条 APNs

它读不懂任何一个负载字节。

**Supabase** 新增 `devices` 表：

| 列 | 说明 |
|---|---|
| `user_id` | 属主 |
| `device_id` | 设备唯一 id |
| `kind` | `desktop` \| `mobile` |
| `identity_pub` | Ed25519 公钥（握手签名） |
| `kx_pub` | X25519 公钥（推送密钥协商，见第二节） |
| `push_token` | APNs token，仅 mobile |
| `label` | 人话名字（"Stan 的 MacBook Pro"） |
| `last_seen` | 时间戳 |

RLS：只能读写 `user_id = auth.uid()` 的行。migration 走 `supabase/migrations/` 编号文件（ADR-0071）。
**这是唯一新增的持久化。**

**手机 app**（Expo / React Native）：登录同一账号 → 列出自己名下 desktop 设备 → 一键连接 →
握手 → 收 fleet 快照 → 渲染 → 点审批。

### 三条不变量

1. **手机是投影，不是事实源。** 桌面先落盘 SQLite，再投影，再加密外推。手机上的一切操作都是
   **命令**，回到桌面变成 `approval_decision` 事件落盘，再投影回两端。手机永不产生事实。
   （对齐 AGENTS.md 硬规则「append-only 事件日志是唯一事实来源；先落盘再喂模型」）
2. **不做「投影的投影」。** ADR-0059 明确否决过「主窗算好状态转发给岛」。桌面推的是
   `IslandFleet` / `deriveMessages` 这两层已定义的投影，不是渲染层的 React 状态。手机自己渲染。
3. **网关不落盘会话内容。** 它只有 `devices` 表和内存里的连接对。桌面不在线时手机显示
   「你的 Mac 不在线」，不做离线缓存——核心场景本来就要求桌面在线（它正卡在审批门里等你）。

### 两种帧，订阅式

`IslandAgent` 的实际形状只有 `title / phase / currentTool / pendingApproval / workspace / turnDiff`，
**不含任何对话内容**，一帧几百字节。但用户要判断该不该同意 `rm -rf build/`，得看见
Otto 前面说了什么。所以：

| 帧 | 内容 | 推送时机 | 体积 |
|---|---|---|---|
| `fleet` | `IslandFleet` 原样 | 每次投影变化 | 小，常推 |
| `timeline` | 单会话的 `deriveMessages` 投影，经 `trimForMobile` 裁剪 | 仅手机 `watch(sessionId)` 之后 | 需裁剪 |

手机切走发 `unwatch`。**不订阅就零流量**——蜂窝网上这条很重要。

`trimForMobile(messages)` 是纯函数：长工具输出/diff 截断并留标记（"在电脑上看全文"），
有体积上界，可单测。裁剪只作用在 `timeline` 这一路。

---

## 二、加密、配对、推送

> 本节涉及安全边界，用词从严。

### 不自己搓密码学

两端实时流都用 libsodium（桌面 `libsodium-wrappers`，Expo 侧 `react-native-libsodium`）——
它把 nonce 管理、乱序检测、rekey 都包掉了。iOS 推送侧的解密用 CryptoKit（见「推送」）。

### 每台设备两把静态密钥

| 密钥 | 算法 | 用途 | 私钥落点 |
|---|---|---|---|
| identity | Ed25519 | 签握手临时公钥 | 系统安全存储 |
| kx | X25519 | 推送密钥协商 | 系统安全存储 |

公钥两把都进 `devices`。**不做 Ed25519 → X25519 转换**：libsodium 能转，但显式两把不容易出错。

私钥落点走 macOS Keychain / iOS Keychain / Android Keystore。
**不沿用 `src/main/keyVault.ts`**——那是 `userData/keys.json` 0600 明文文件，对 API key 是既定权衡，
对身份私钥不够。

### 握手（每次连接）

双方各生成一对**临时** X25519，签名后交换：

```
{ ephPub, sig = Ed25519_sign(ephPub || connectionNonce) }
```

`connectionNonce` 由双方各出一半拼成，防跨连接重放。验签用**对端已 pin 住的** Ed25519 公钥。

会话密钥 = `crypto_kx_*_session_keys(ephPair, peerEphPub)`，两个方向各一把。
传输用 `crypto_secretstream_xchacha20poly1305`。

得到：**前向保密**（临时密钥每连接一换，事后拿到静态私钥也解不开旧密文）+ 双向认证。

### 配对：TOFU，不扫码

需求是「按账号配对，不扫二维码」。账号配对与 E2E 天然打架：密钥若从账号体系下发，
掌握 Supabase 的人就能发一把假的，中间人成立。折中是 TOFU（首次信任）：

- 手机首次连某台桌面时，把它的 `identity_pub` **pin 进本地**
- 之后公钥对不上就**拒绝连接并红字告警**，不静默接受；换电脑要用户显式确认一次
- 两端角落各显示一个 6 位指纹（两把 `identity_pub` 排序后 SHA-256 截断），想核对的人自己核，不强制

### 威胁模型，边界说清

| 威胁 | 结论 |
|---|---|
| 被动读盘的服务器 | 拿不到明文 ✅ |
| 服务器/网络主动篡改运行中的连接 | 签名挡住 ✅ |
| 服务器在手机首次 pin **之前**下发假公钥 | **中间人成立** ❌ |
| 元数据（何时有会话、何时卡审批、推了多少字节） | **网关可见** ❌ |

后两条是「不扫码」和「E2E 不覆盖元数据」的固有代价，接受并记录。
要堵第三条只能补带外验证（扫码 / 强制核指纹）。

### 推送：两个信道，两套 AEAD

**NSE 是原生 iOS 扩展，跑不了 RN 的 JS**，解密必须 Swift 写。仓库已有 Swift 链
（`native/MrOttoIsland`），且 CryptoKit 自带 X25519 / HKDF / AES-GCM，零第三方依赖。

由此逼出两个约束：

**① 推送负载不能用连接密钥。** 推送到达时连接不存在，临时密钥还没生成。必须用长期密钥：

```
pushKey = HKDF-SHA256( X25519(mobile_kx_priv, desktop_kx_pub), "otto-push-v1" )
```

**代价：推送负载没有前向保密。** 静态私钥日后泄漏，历史推送密文可解。
唯一缓解：**推送负载只放摘要**（动词 + 目标 + 会话标题，截断），
永不放文件内容、命令全文、工具输出。实时流的前向保密不受影响。

**② 两套 AEAD。** CryptoKit 没有 libsodium 的 `secretstream`，读不了它的密文格式。

| 信道 | 算法 | 密钥 | 前向保密 |
|---|---|---|---|
| 实时流 | libsodium `secretstream_xchacha20poly1305` | 每连接临时 | 有 |
| 推送负载 | **AES-256-GCM** 一次性封装 | `pushKey`（长期） | 无 |

AES-GCM 三家（CryptoKit / Node `crypto` / libsodium）都有，互通。
硬凑一套的代价是在 Swift 侧手搓 XChaCha20，不划算。

APNs 负载上限 4KB，摘要绰绰有余。

**流程**：桌面进审批门时，若网关告知手机端不在线，桌面发信号帧
`{ notify: "approval", payload: <AES-GCM 密文> }` → 网关原样塞进 APNs（`mutable-content: 1`）
→ NSE 用共享 Keychain 里的 `pushKey` 解密 → 改写通知文案 → 锁屏显示
「Otto 想跑 `rm -rf build/`」。

**工程活**（进切片表）：

- Expo config plugin：加 NSE target、App Group、Keychain access group entitlement。
  要 `prebuild`，**从此不是纯 managed workflow**。
- `pushKey` 存在 app 与 NSE 共享的 Keychain access group 里。
  `expo-secure-store` 对 access group 支持不全，大概率换 `react-native-keychain`（支持 `accessGroup`）。
  **这个第一天验**，别等写 NSE 才发现拿不到密钥。

### 命令面：白名单 + 砍掉两个档

上行命令用 `islandBridge.ts` 里 `decodeCommand` 同款校验器，**逐字段类型检查，认不出来的整条丢弃**。
手机端词汇 **五个**：`approve` / `deny` / `send` / `watch` / `unwatch`。
任何 `ShellBridge` 方法都不上公网。

与岛的差异一处：岛有 `focusSession`（点列表行 → 聚焦本机主窗并切会话），
**手机端不要它**——「切到哪个会话」在手机上是本地视图状态，由 `watch` / `unwatch` 表达，
不该变成一条能远程操纵桌面窗口的命令。反向的 `watch` / `unwatch` 是岛不需要的
（stdio 管道零成本全推，公网要按需订阅）。

**安全取舍**：桌面审批卡实际有四档（`deny` / `abort` / `approve_session` / `approve_always`，
见 `src/main/uiApprover.ts` 的 `availableDecisionsFor`）。
**手机端只开「本次同意」和「拒绝」**，不开 `approve_session`，更不开 `approve_always`。

理由：手机是最容易在不专心状态下误触的终端（走路、锁屏刚解、通知栏顺手点）。
误触「本次同意」代价是跑一条命令；误触 `approve_always` 代价是往磁盘写了一条永久授权，
从此那类命令再也不问了。两个代价不在一个量级，而手机恰恰是判断质量最低的地方。
永久档留给坐在电脑前的人。

---

## 三、代码落点

### 复用面：不需要拆 monorepo

实测（`grep`）：

- `src/shared/*.ts` —— **零个** node builtin、零个 electron。已经是纯的。
- `src/session/*.ts` —— 只有 `store.ts`（better-sqlite3）与 `attachments.ts`（node:fs）不纯；
  `deriveMessages` / `events` / `microCompact` / `barrenTurns` / `activeSkills` 全纯。

v1 直接跨目录 import，靠 metro `watchFolders` 指到仓库根。省掉一整轮重构。

**已知摩擦**：仓库用 ESM 风格写 `from "./events.js"`（实际文件是 `.ts`）。
Metro 默认解析不了，要在 `metro.config.js` 加 `resolveRequest` 把 `.js` 后缀改回去（十几行）。
第一天会卡半小时，先写在这里。

### 仓库布局

`mobile/` 放仓库根，与 `native/MrOttoIsland/` 平级。

**不开新仓库**：`IslandFleet` / `SessionEvent` / 命令词汇必须两端同步演进，分仓 = 保证漂移。
原生岛当初也留在本仓，一致。

### 门禁加两条

`tests/architecture.test.ts` 现管四条边界，加两条。
按 AGENTS.md「**新增更严的断言 = L2**」，可跟自己的 PR 走：

5. `src/shared` + 移动端复用的那批 `src/session` 文件，不许 import 任何 node builtin / electron。
   错误信息写清「这些文件手机端也要跑，碰了 Node 就断了 Expo 那条路；要用 Node 能力请放 `src/main`」。
6. `mobile/` 不许 import `src/main`。

第 5 条尤其重要：把「这批文件是纯的」从一个**当前碰巧成立的事实**，变成一条**会红的规则**。

### 测试策略：零网络

照搬 `islandBridge.ts` 已在用的注入模式（`SpawnFn` / `IslandChild`）——
传输层收窄成可注入接口，单测塞假 socket。

| 对象 | 测法 |
|---|---|
| 帧编解码 | `encodeFrame` / `decodeFrame` 对着 `encodeState` / `decodeCommand` 写，畸形输入一律 `null`，表驱动 |
| 握手 | 两侧都是纯函数，同进程对打。**必测三条负例**：签名被篡改 → 拒；pin 的公钥对不上 → 拒；重放旧 `connectionNonce` → 拒 |
| 命令白名单 | 每个非白名单形状逐条断言被丢弃。`approve_always` / `approve_session` 各写一条**具名**测试——这是上面那个安全取舍的可执行版本，具名才能在有人想「顺手开一下」时红得清楚 |
| `trimForMobile` | 纯函数，断言输出体积上界 + 截断处留了标记 |
| 网关中继 | 两个假 socket 对接，断言字节原样穿过，**且从没被 `JSON.parse` 过、没进日志**——「盲管道」这个性质要有测试守着，否则三个月后有人为调试加一行 `console.log(payload)`，E2E 就漏了 |
| e2e | `tests/e2e/` 已有 HOME 隔离 + 假模型（ADR-0076）。后续加「桌面起会话 → 假手机客户端连本地中继 → 点同意 → 桌面 turn 继续」。**不进 v1 门禁** |

### ADR（一文件一决策，编号合并时 claim，ADR-0074）

1. 手机端是隔着公网的第三个投影窗口——复用岛协议、两种帧、timeline 订阅式
2. 中继与 E2E——TOFU 账号配对、网关零落盘、威胁模型边界（含元数据不覆盖的承认）
3. 手机审批只开两档——安全取舍
4. 推送两套 AEAD——NSE 逼出的长期密钥与前向保密取舍

---

## 四、切片顺序

每刀独立跑绿，不留半成品。前四刀**不需要 Apple 账号，也不写一行 UI**。

| # | 内容 | 依赖 |
|---|---|---|
| 1 | 帧协议 + 命令白名单（纯 TS，零传输） | — |
| 2 | 握手与加密（纯 TS，进程内对打） | — |
| 3 | 网关中继端点 + `devices` 表 + RLS + `services/gateway/checks/` 补一条 | — |
| 4 | 桌面 `remoteBridge.ts`（注入式 socket，与 islandBridge 平级） | 1,2,3 |
| 5 | Expo 骨架：metro 解析、登录、设备列表、pin、fleet 列表页 | 4；免费个人 team 够 |
| 6 | `timeline` 订阅 + 审批两档 | 5 |
| 7 | **无内容**推送打通链路（验 APNs 通了） | **付费开发者账号** |
| 8 | NSE 解密改写文案 | 7 |

**7 与 8 分两刀**：APNs 本身的坑（证书、entitlement、token）和 NSE 的坑（entitlement、
keychain 共享、Swift 解密）搅在一起排查会很痛苦。分开每次只调一件事，
7 是一个能回答「推送到底通没通」的检查点。最终形态仍是 NSE。

---

## 五、会推翻本设计的前提

- **若要防主动作恶的服务端**：TOFU 不够，得补带外验证（扫码 / 强制核指纹）。第二节威胁模型第三行。
- **若手机端范围扩到「开新会话 / 改设置」**：窄命令面不再成立，要重议上公网的接口边界，
  且远程唤起 agent loop 的风险面完全是另一回事。
- **若 `IslandFleet` 将来要装对话内容**：两种帧的分工失效，`fleet` 帧也得进裁剪路径。
- **若接 Android**：FCM data message + headless JS 解密，机制与 NSE 完全不同，需另写一节。
- **若 Supabase Realtime 被证明长期稳定**：中继理论上可以退回 Realtime broadcast 省一个端点，
  但 ADR-0027 的理由（自托管链路不可靠）不变，且 broadcast 不落盘、手机冷启动拿不到快照，
  大概率仍不划算。
