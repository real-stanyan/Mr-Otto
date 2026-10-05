# 手机上接 Apple 健康：智能体按需读说话人自己手机的 HealthKit（#1656）

- 日期：2026-10-05
- Issue：#1656
- 范围：iOS 手机端 + 云 runtime。桌面端不读健康数据（Mac 上没有 HealthKit 数据），只是照常在轨迹里看得到这次工具调用。
- 维护者明说：不参考 `~/system` 的 /health 域，从零做。

## 1. 背景与已验证的事实

- 仓库此前零 HealthKit 代码（`git grep -i healthkit` 零命中；`mobile/app.json` 无 entitlement、无 `NSHealthShareUsageDescription`）。
- **没有任何「在手机上执行的工具」**。手机只是云 runtime 的 guest 连接（ADR-0317 后不再连桌面）；
  现有跨设备工具只有借来工具 px（好友桌面 / edge 托管凭据，ADR-0151、ADR-0197），都不在手机上跑。
- runtime **能定向单发**：relay 按 cid 寻址、从不广播（`services/edge/src/worker.ts:214-216`），
  runtime 侧 `globalSend(cid, msg)`（`services/runtime/src/daemon.ts:531`）。
- 但 `say` 的 cid **没进 turn**：`frameHandler` `case "say"` 只把 `entry.uid` 交给 `session.say`；
  turn 只知道 `fromUid`（`turnCoordinator.ts` 的 `TurnJob`）。一个 uid 可同时挂多条 cid（手机 + 桌面）。
- 手机**切后台即断 WS**（`mobile/src/cloud/cloudClient.ts:78-88` → `pause()`），回前台重连**换新 cid**。
- 手机聊天流**不画任何工具调用**：带 toolCalls 的 `assistant_message` 被 `hiddenFromCloudTimeline` 藏掉，
  `mobileChat.rowOf` 对 `tool_result` 回 null。
- 协议版本严格相等、无最低版本闸（`frameHandler.ts:240`）。origin/main 上 `CS_PROTOCOL_VERSION = 28`，
  但已有 5 处注释写「协议 29」（`collab_decide`、`app_accept` 等，#1605 / #1648）而常量没升——合并时一并理顺。
- HealthKit 事实（Apple 文档，实现时以真机为准）：
  - 只读授权只需 `NSHealthShareUsageDescription`；`toShare` 为空时运行时不需要 `NSHealthUpdateUsageDescription`。
    **但上传校验需要**（2026-10-05 build 10 实测：带 HealthKit entitlement 时 `exportArchive` 缺它就 EXPORT FAILED），
    所以照样加上，文案照实写「只读取、不写入」。
  - **读权限被拒时 HealthKit 不告诉 App**，查询照常成功、返回空——这是 Apple 的隐私设计，无法区分「没数据」与「没授权」。
  - 设备锁屏时健康数据库加密不可读；本设计只在 App 前台（WS 连着）时取数，天然避开。
  - 部分 iPad `HKHealthStore.isHealthDataAvailable()` 为 false。
  - App Review 5.1.3：健康数据不得用于广告 / 数据挖掘，不得存 iCloud，须在隐私政策写明。

## 2. 决定

**按需拉取，工具在手机上跑**：智能体调 `read_health`，runtime 给说话人那台声明了能力的手机单发查询帧，手机读 HealthKit 回帧。

### 2.1 权限边界（维护者选定「只读说话人自己的手机」）

- 手机「设置」新增「Apple 健康」开关，**默认关**。打开 → 弹 iOS HealthKit 授权页；开着才向 runtime 声明能力。
  `isHealthDataAvailable()` 为 false 的设备开关置灰并说明。
- `read_health` **仅当以下三条同时成立**时出现在这一轮的工具表里：
  1. 这一轮是人发起的：`fromUid` 有值，且不是 relay turn（智能体 @ 智能体接力）。
  2. `fromUid` 名下此刻有一条声明了 health 能力的在线连接。
  3. 不是定时任务、不是好友私聊车道里对面智能体的那一轮（这两类本就不满足 1，此条是断言，写成测试）。
- 群里：Alice 发言 → 读 Alice 的手机，回答全群可见。这是 Alice 自己选在群里问。
- **不弹审批**（是说话人本人在问）。手机聊天流里出一行灰字「读取了健康数据：睡眠、心脏 · 9月28日–10月4日」。

### 2.2 否掉的

- **事件日志驱动（仿审批）**：写 `health_request` 事件广播全房、手机看到再答。好处是断线重连能补答；
  但请求会扩散到桌面等所有连接、要客户端再过滤，且问的人此刻必在前台，补答价值低。
- **复用 px 通道**：那是 MCP server + 凭据托管的形状，手机两样都不是，硬套比新写更别扭。
- **手机定期同步到云端**：维护者没选；健康数据长期存服务端，隐私分量最重。
- **手动附带**：智能体不能主动看，维护者没选。

### 2.3 隐私代价（必须写明）

读回的数据作为普通 `tool_result` 落进云端会话库（`/var/lib/otto-runtime/<ws>.db`）——Hard rule「先落盘再喂模型」的必然结果，
不做旁路。由此：
- 只回**按天聚合**，不回原始样本（同时控 token）。
- 隐私政策补健康数据一段（用途：仅用于回答你本人的提问；送模型供应商；不用于广告；随会话删除而删除）。
- 送审时 App Review 备注写明。

## 3. 改动

### 3.1 协议（`src/shared/remote/cloudSession.ts` + 新 `src/shared/health.ts`）

```ts
// src/shared/health.ts —— 纯类型 + 纯函数，两端共用
export const HEALTH_METRICS = [
  "steps", "distance", "activeEnergy", "flights", "exerciseMinutes", "standHours",
  "sleep",
  "heartRate", "restingHeartRate", "hrv", "spo2",
  "bodyMass", "bodyFat",
  "workouts",
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];

/** from / to 是手机本地日历的日期 YYYY-MM-DD，闭区间，跨度 ≤ 92 天 */
export interface HealthQuery { metrics: HealthMetric[]; from: string; to: string }

export interface HealthDay {
  date: string;                    // YYYY-MM-DD
  steps?: number; distanceM?: number; activeKcal?: number; flights?: number;
  exerciseMin?: number; standHours?: number;
  /** 算在醒来那天；单位分钟 */
  sleep?: { inBedMin?: number; asleepMin?: number; coreMin?: number; deepMin?: number; remMin?: number; awakeMin?: number };
  heartRate?: { min: number; avg: number; max: number };   // bpm
  restingHeartRate?: number;      // bpm
  hrv?: number;                   // ms，SDNN 当天平均
  spo2?: { min: number; avg: number };                     // 百分比 0–100
  bodyMassKg?: number; bodyFatPct?: number;                 // 当天最后一条
}
export interface HealthWorkout {
  start: string; end: string;     // ISO，带偏移
  type: string;                   // HKWorkoutActivityType 的英文名，如 "running"
  durationMin: number; distanceM?: number; activeKcal?: number;
}
export type HealthResult =
  | { ok: true; days: HealthDay[]; workouts: HealthWorkout[] }
  | { ok: false; error: string };

export function parseHealthQuery(x: unknown): HealthQuery | null;   // 形状 + 日期合法 + 跨度 ≤ 92 天 + metrics 去重非空
export function parseHealthResult(x: unknown): HealthResult | null; // 形状校验；序列化后 > 64KB 判 null
export function formatHealthForModel(q: HealthQuery, r: HealthResult): string; // 见 3.2
```

帧（协议 +1，号以合并时 main 为准）：

```ts
// CsUp（手机 → runtime）
| { t: "caps"; health: boolean }                                  // welcome 后发一次；开关变动再发
| { t: "health_result"; reqId: string; result: HealthResult }
// CsDown（runtime → 单个 cid）
| { t: "health_query"; reqId: string; query: HealthQuery }
```

`caps` 用独立帧不塞 `hello`：切开关不用重连。

### 3.2 runtime

- `services/runtime/src/frameHandler.ts`
  - `case "caps"`：记 `capsOf(cid) = { health }`；cid 断开时清掉。
  - `case "health_result"`：`parseHealthResult` 不过 → 丢；交 broker，broker 核对**回帧 cid 就是当初发请求的那条**，对不上丢。
  - 能力表放在 healthBroker 里（不在 frameHandler）：`cidOf(uid)` 回该 uid 名下声明了 health 的连接中**最近声明的那一条**。
- 新 `services/runtime/src/healthBroker.ts`
  - `request(cid, query, signal): Promise<HealthResult>`；`reqId` 随机。
  - 结束于：收到回帧 / 30 秒超时（`{ok:false, error:"手机 30 秒没回"}`）/ `signal` abort / 该 cid 断开（`"手机断开了"`）。
  - 纯逻辑，发送函数与时钟注入，便于测。
- 新 `services/runtime/src/healthTool.ts`：`read_health`
  - `def.parameters`：`{ metrics: HealthMetric[], from: "YYYY-MM-DD", to: "YYYY-MM-DD" }`；description 写明日期是用户本地日历、
    跨度上限、只回按天聚合、空值可能是未授权。
  - `requiresApproval: false`。
  - **调用时才选 cid**（`healthCidOf(fromUid)`）——手机回前台会换 cid，turn 开始时那条可能已经没了。选不到 → 抛错「你的手机现在没连着（App 不在前台）」。
  - 参数不过 `parseHealthQuery` → 抛错，错误信息说清哪里不对。
  - 输出 `formatHealthForModel`：首行写范围与时区说明，之后每天一行、只列有值的字段；训练单列；
    某个请求了的 metric 在整个区间全空 → 末尾注一句「以下类别无数据（可能未授权或未记录）：…」。
- `services/runtime/src/sessionService.ts` 的 `tools()`：按 2.1 三条件加入。

### 3.3 手机原生模块 `mobile/modules/otto-health`

照 otto-paste 的结构（`expo-module.config.json` + `index.ts` 用 `requireOptionalNativeModule`，Expo Go 下为 null + podspec + Swift）。

- `isAvailable(): boolean`
- `requestAuthorization(): Promise<void>`——读 14 类对应的 HK 类型，`toShare` 为空。
- `query(metrics, from, to): Promise<{days, workouts}>`——在**手机当前时区**按自然日切。
  - 累计类（步数 / 距离 / 活动能量 / 楼层 / 锻炼分钟 / 站立小时）：`HKStatisticsCollectionQuery` `.cumulativeSum`，按天。
    站立小时用 `appleStandHour` 分类样本计数。
  - 心率 / 血氧：`.discreteMin/.discreteAverage/.discreteMax`；静息心率、HRV：`.discreteAverage`。
  - 体重 / 体脂：`HKSampleQuery` 取每天最后一条。
  - 睡眠：`HKCategoryTypeIdentifier.sleepAnalysis` 样本，按分期累加分钟，**归到样本结束（醒来）那天**；
    多来源重叠（手表 + 手机）时优先 Apple Watch 来源，避免重复计。
  - 训练：`HKWorkout` 样本列表。
- `app.json`：`ios.entitlements` 加 `com.apple.developer.healthkit: true`；`ios.infoPlist` 加
  `NSHealthShareUsageDescription`（「你问智能体健康相关的问题时，读取你的步数、睡眠、心率、体重和体能训练来回答。」）。
  Apple 开发者后台 App ID 勾 HealthKit（维护者操作）。

### 3.4 手机 JS

- 新 `mobile/src/health/healthPrefs.ts`：开关状态持久化；变动时对当前 room 发 `caps`。
- `mobile/src/cloud/cloudClient.ts`：
  - welcome 后发 `caps`。
  - 收 `health_query` → `parseHealthQuery` → 原生 `query` → 回 `health_result`；原生抛错回 `{ok:false, error}`；
    开关已关仍收到 → 回 `{ok:false, error:"用户已关闭 Apple 健康"}`。
- 设置页（`mobile/src/account/SettingsScreen.tsx`）加一行开关；打开时先 `requestAuthorization()`。
- `src/shared/mobileChat.ts`：不加新行种，复用现成的 `note`（muted 灰字，Bubbles 已经会画）。`chatRows` 的循环里从
  `assistant_message.toolCalls` 记 `toolCallId → args`，遇到 `name === "read_health"` 的 `tool_result` 产出一行
  `note`，文字由 `healthReadLineText(args, status)` 给。其他工具照旧不画。

### 3.5 ADR

新 ADR「手机端执行的工具通道」：定向单发 + 能力声明 + 调用时选 cid + 结果照常落盘；记 2.2 否掉的三条与 2.3 隐私代价。
编号合并时认领（ADR-0074）。

## 4. 测试（vitest，`tests/` 镜像 `src/`）

- `tests/shared/health.test.ts`：`parseHealthQuery`（坏日期、from > to、跨度 93 天、空 metrics、未知 metric）；
  `parseHealthResult`（坏形状、超 64KB）；`formatHealthForModel`（只列有值字段、全空类别注释、训练列表）。
- `tests/runtime/healthBroker.test.ts`：正常回帧、超时、abort、cid 断开、错 cid 回帧被丢、reqId 不认识被丢。
- `tests/runtime/healthTool.test.ts`（或并入 sessionService 的工具表测试）：有能力连接 → 出现；relay turn / 无 `fromUid` /
  该 uid 无能力连接 / 别人的能力连接 → 不出现；调用时连接已断 → 抛错。
- frameHandler：`caps` 记录与断开清理；`health_result` 走 broker。
- `tests/shared/mobileChat.test.ts`：`read_health` 调用 + 结果产出 `health_read` 行；其他工具仍不产行。
- 协议版本常量的现有钉子测试（`tests/runtime/humanCallFrames.test.ts:23`）随版本号更新。
- Swift 不在门禁里：先模拟器（「健康」App 手动加样本）冒烟，再真机 TestFlight。

## 5. 发版

1. runtime 部署（WSL `otto-runtime`）。协议严格相等：部署后 build 9 及更早的手机会被拒，要更新——现有惯例。
2. `mobile/app.json` runtimeVersion 6 → 7，`native-build.json` 同步；TestFlight build 10（上传前问维护者）。
3. 维护者：Apple 开发者后台 App ID 勾 HealthKit；隐私政策补段；送审备注。

## 6. 不做

- 写入 HealthKit。
- 后台 / 锁屏时取数（静默推送唤醒）——需要时另开 issue。
- 定时任务、好友智能体读健康数据。
- 原始样本级数据。
- Android（Health Connect）。
