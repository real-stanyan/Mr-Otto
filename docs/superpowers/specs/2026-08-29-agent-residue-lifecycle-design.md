# Agent 副作用生命周期：进程组硬杀 + 树外残留审计/收尸

日期：2026-08-29 · Task issue：#759 · 状态：已批准（brainstorm 定稿）

## 背景与问题

真实事故（2026-08-29，宿主机）：agent 起的 iOS Simulator boot 后无人 shutdown 挂了 4 天，
298 个 CoreSimulator 进程持续渲染导致整机发热；另有 next-server 挂 5 天、python http.server
挂 3 天。根因不是「agent 太耗」，是**没有收尸机制**。对照 Mr Otto 现状，同样的三个洞：

1. **孙进程逃逸**：`localWorld.ts` 的 `spawn(cmd, {shell: true})` 配 `timeout`/`killSignal`/
   abort `signal`，三条 kill 路径都只打到 shell 本身。命令里 `&`、自 fork、daemonize 的
   孙进程在 shell 死后被 reparent 到 launchd，30 分钟超时杀了个寂寞。
   `execDetached` 注释「app 退出时随主进程死」只对直接子进程成立。
2. **树外驻留**：`xcrun simctl boot` 压根不留子进程（simulator 挂在 CoreSimulator/launchd
   下），任何基于进程树的 kill 都摸不到。仓里已有 simctl 能力 seam（#401 模拟器面板），
   agent 操控 simulator 是一等能力，这个洞必然会被踩。
3. **无收尸审计**：session 归档 / app 退出时没有「这个 bot 留下了什么」的盘点，
   泄漏无感知，攒到发热才发现。

## 方案总览（已选定：方案 A）

两条腿配合：

- **腿1 进程组硬杀**：精确、零误报，堵洞 1
- **腿2 快照差分探测器**：覆盖树外残留，堵洞 2 和 3

弃选方案（记录 trade-off）：
- 环境变量标记全扫（`ps -E` 匹配 `MR_OTTO_SESSION`）：能精确认领被 reparent 的孙进程，
  但 launchd 起的进程不继承 env——simctl 这个最大头恰好漏；且全表扫环境变量慢而脆。
  将来可作为腿1 的补充，不冲突。
- 只等 v2 Docker：容器死=全死结构性解决洞 1/3，但宿主副作用（simctl）仍不管，且 v1 用户裸奔。

## 第 1 节：进程组硬杀（腿1）

改动点：`src/world/localWorld.ts`。

`exec` / `execDetached` 的 spawn 加 `detached: true`——子进程成为独立进程组组长
（pgid = child.pid）。所有 kill 路径从「杀 shell」改为「杀全组」：

```ts
const child = spawn(cmd, { shell: true, detached: true, /* 其余不变 */ });

function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try { process.kill(-pid, signal); }   // 负 pid = 全组
  catch { /* 组已死，常态 */ }
}
```

三条 kill 路径统一走 `killGroup`：

1. **超时**：Node 原生 `timeout` 选项只杀直接子进程，改为自管定时器——到时
   `killGroup("SIGTERM")`，5 秒宽限后组内仍有存活则 `killGroup("SIGKILL")`。
2. **turn 中断**（abort signal）：现用 spawn 的 `signal` 选项同样只杀 shell，
   改为 abort 监听器里 `killGroup`。
3. **app 退出**：`before-quit` 遍历存活登记表（第 2 节）全部 `killGroup`。

语义不变：被杀仍是 `exitCode 124 + stderr 标注`；`detached: true` 不配 `unref()`——
要的只是进程组隔离，不是脱管。

**明示防不住的**：命令里显式 `setsid`/`nohup` 双重 fork 脱组的，以及 simctl 类树外
驻留——后者是腿2 的活，前者进 escaped 检测（第 2 节）也只能事后发现。

## 第 2 节：存活登记表（LiveGroupRegistry）

位置：`src/world/liveGroups.ts`（或 localWorld 内部模块）。

```ts
interface LiveGroup {
  pgid: number;
  cmd: string;        // 头 200 字符，展示用
  startedAt: number;
  kind: "exec" | "detached";
}
```

- spawn 成功登记；`close` 事件注销。
- **注销时探活**：`close` 只代表 shell 死了。注销前 `process.kill(-pgid, 0)` 探一次组——
  组里还有活口 = **泄漏出走（escaped）**，移入 escaped 列表而不是静默删除。
  这是残留清单的第一个数据源：零成本、零误报。
- app `before-quit`：live + escaped 全部 `killGroup`。

esbuild/watch 类合法长活不误伤：它们走 `run_in_background`（30 分钟超时语义不变），
只是超时到点后从「杀 shell 留孤儿」变成「全组清掉」——这正是修复本身。

## 第 3 节：树外残留探测器（腿2）

### Capability 接口

`ExecutionWorld` 加可选字段（同 `browser?`/`mcp?` 先例，既有假 world 零改动）：

```ts
// src/world/executionWorld.ts
residue?: ResidueCapability;

interface ResidueCapability {
  snapshot(): Promise<ResidueSnapshot>;
  diff(before: ResidueSnapshot, after: ResidueSnapshot): ResidueItem[];
  cleanup(item: ResidueItem): Promise<CleanupResult>;
}

interface ResidueItem {
  detector: "simulators" | "ports" | "process_groups";
  id: string;            // sim UDID / "port:3000" / pgid
  label: string;         // "iPhone 17 (iOS 26.5)" / "端口 3000 (next-server)"
  confidence: "owned" | "suspected";
  cleanupHint: string;   // 将执行什么："simctl shutdown <udid>" / "kill 进程组 <pgid>"
}
```

### v1 三个探测器（LocalWorld 实现）

| 探测器 | snapshot | 归属判定 | cleanup |
|---|---|---|---|
| `process_groups` | 第 2 节 escaped + live 列表 | 自己登记的 = **owned** | `killGroup` |
| `simulators` | `simctl list -j` booted 集合（对齐 #401 的 simctl seam） | session 期间新 boot 的 = **suspected**（用户可能自己开的） | `simctl shutdown <udid>` |
| `ports` | `lsof -iTCP -sTCP:LISTEN -P -n` | 新端口且 pid 属于 escaped 组 = **owned**；仅新端口 = **suspected** | owned 走 killGroup；suspected 只展示不提供一键杀（杀不明进程越权） |

基线快照在 `session_created` 时拍并落事件；diff 在触发点执行。suspected 的误报
（用户 session 期间自己开的东西）靠「清单+确认」兜底——多显示一行，不勾即过。

### 处置策略（已定：列清单 + 用户确认一键清）

符合危险操作审批哲学：用户可能故意留着 dev server 自己用，不自动杀。
owned 默认勾选，suspected 默认不勾。

## 第 4 节：事件 + 触发点 + UI

### 新事件（`src/session/events.ts`，纯新增 = 向后兼容）

```ts
ResidueBaselineEvent   { type: "residue_baseline", snapshot }     // session_created 后拍
ResidueDetectedEvent   { type: "residue_detected", items }        // 审计注记，模型不消费
ResidueCleanedEvent    { type: "residue_cleaned", item, result }  // 每清一项落一条
```

审计注记地位同 `background_task_completed` 先例。v1 模型不可见——不喂「你留了残留」
给模型；模型自清能力是后话，届时另开 issue。

### 触发点（三个）

1. **turn 收口**：只查 escaped 列表（内存读，零成本）。有新增泄漏 →
   落 `residue_detected` + UI 角标。
2. **session 归档 / bot 关闭**：全量 diff（跑 simctl + lsof，约几百 ms），弹清单。
3. **app before-quit**：owned 进程组直接 `killGroup`（自己登记的，无误杀可能，
   不弹窗不阻塞退出）；树外残留（simulator）**不杀**，`residue_detected` 已持久化——
   **下次启动重放事件日志**，`residue_detected` 减 `residue_cleaned` 的差集，
   逐项探活后弹「上次残留」清单。孤儿 sim 攒 4 天的事故，下次开 app 第一眼看见。

### UI（渲染进程，走 ShellBridge）

- ShellBridge 新增：`residueList(sessionId)`、`residueClean(sessionId, itemIds)`。
- 清单面板：按 detector 分组；owned 默认勾选，suspected 默认不勾；
  一键清 = 逐项 cleanup、逐项落 `residue_cleaned`。
- 失败项（sim 已被手动关掉等）标记「已消失」，不算错误。

## 第 5 节：测试

- `tests/world/`：假时钟测超时全组杀（起 `sh -c 'sleep 100 & sleep 100'` 验孙进程死）；
  escaped 探活逻辑（close 后组内仍有活口 → 进 escaped）。
- 探测器：simctl / lsof 输出用 fixture 喂 `diff` 纯函数；snapshot 采集薄壳不测真机。
- 事件重放：residue 差集重建「上次残留」清单。
- 既有假 world 零改动验证 = 类型编译通过（capability 可选）。

## 边界（YAGNI，明确不做）

- 不做模型可见的残留提示 / 模型自清（后话，另开 issue）
- 不做 suspected 端口的一键杀（越权）
- 不做 cron 式周期扫描（三个触发点够）
- 不动 v2 Docker 规划（容器世界可不实现 residue 或只实现 simulators 探测器）
