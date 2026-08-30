# ADR-0193：agent 副作用生命周期——进程组硬杀 + 树外残留审计

- 状态：已接受
- 日期：2026-08-30
- 相关：issue #759、设计稿 `docs/superpowers/specs/2026-08-29-agent-residue-lifecycle-design.md`（方案选型、
  被弃方案、逐节实现细节全在那儿，本 ADR 只记决策与后果）、ADR-0092（simctl 台账）、ADR-0139（后台任务面板）

## 背景

真实事故（2026-08-29，本机）：水獭起的 iOS Simulator boot 之后没人 shutdown，挂了 4 天、298 个
CoreSimulator 进程持续渲染把整机烤热；另有 next-server 挂 5 天、python http.server 挂 3 天。

根因不是「水獭太耗」，是**没有收尸机制**。同样的三个洞在本仓都在：

1. **孙进程逃逸**——`localWorld.ts` 的 `spawn(cmd, {shell: true})` 配 `timeout` / `killSignal` /
   abort `signal`，三条 kill 路径**都只打到 shell 本身**。命令里带 `&`、自 fork、daemonize 的孙进程
   在 shell 死后被 reparent 到 launchd，30 分钟超时杀了个寂寞。
2. **树外驻留**——`xcrun simctl boot` 压根不留子进程（simulator 挂在 CoreSimulator/launchd 下），
   任何基于进程树的 kill 都摸不到它。而 simctl 在本仓是一等能力（ADR-0092），这个洞必然被踩。
3. **无收尸审计**——归档 / app 退出时没有「这只水獭留下了什么」的盘点，泄漏无感知，攒到发热才发现。

这三个洞的共同点：**失败是安静的**。没有报错、没有红字，只有一台越来越烫的机器。

## 决策

### 一、kill 的单位从「进程」换成「进程组」

`spawn` 加 `detached: true`（子进程成为组长），三条 kill 路径统一走 `killGroup(-pgid)`。
`detached` **不配 `unref()`**——要的是进程组隔离，不是脱管。语义不变（超时仍是 `exitCode 124`）。

明示防不住的写在设计稿里：命令里显式 `setsid` / `nohup` 双重 fork 脱组的，只能事后由 escaped 检测发现。

### 二、`close` 不等于死亡：注销前探活，活口进 escaped

`LiveGroupRegistry`（`src/world/liveGroups.ts`）登记每个进程组，注销时先 `process.kill(-pgid, 0)`
探一次——组里还有活口 = **泄漏出走**，移入 escaped 而不是静默删除。这是残留清单的第一个数据源：
零成本、零误报。

### 三、树外残留走 `ExecutionWorld` 的可选 capability，不直连 fs/child_process

`residue?: ResidueCapability`（`snapshot` / `cleanup`），与 `browser?` / `mcp?` 同一先例——
既有的假 world 零改动。LocalWorld 的实现用 simctl + lsof 拍快照，与 baseline 做**差集**：
只有「这个会话开始之后才出现的」才算残留。

**没有 baseline 就不做**（review I5）。原先兜底成空快照，等于宣称「这台机器开机时零端口零模拟器」，
于是整机的 LISTEN 端口和 booted 模拟器全被算成本会话新增的残留，进了一个默认勾选、一按就清的清单。
「不知道」的正确表达是不出清单，不是出一份把用户自己的东西也勾上的清单。

### 四、三个新事件，全是新增，旧日志照常重放

`residue_baseline` / `residue_detected` / `residue_cleaned`。清单由 `detected` 减 `cleaned` 的
**差集投影**得出（`session/residueProjection.ts`），符合「任何投影必须可从日志推导」这条 Hard rule。
新增事件类型对旧日志向后兼容（Hard rule 第四条）。

### 五、清理结果的判据是 `kind` 这个事实，不是 `ok + note` 这组线索

`CleanupResult.kind: "cleaned" | "gone" | "skipped" | "failed"`，配一个纯函数 `residueSettled`。

**这条是本 lane 最贵的一课。** 在此之前结果只有 `ok` 和一句中文 `note`，而三处消费方
（差集投影 / store 的精确摘除 / 面板的划线）各自用 `ok || note` **猜**「算不算清完了」——于是
「信号发了但进程还活着」这种真失败，因为带了 note，被三处**一致地**当成成功抹掉。三处一致地错，
比一处错更难发现：没有任何地方对不上账。

配套两条：`cleaned` 只在**探活确认目标已经不在了**之后才允许回（发了信号 ≠ 死了，SIGTERM 可以被忽略）；
`cleanup` **不许 throw**（一次失败不该炸掉整轮清理）。`note` 降级为给人看的一句话，永远不作判据。

### 六、残留是 **app 级**事实，直播不按 sessionId 分流

进程组 / 模拟器 / 端口都不属于哪个会话。归档路径尤其要命：归档那一刻算出来的全量 diff 是
ports/simulators 类残留的**唯一**来源，而归档**同时**把 currentSessionId 清成了 null——按会话分流的话，
这批残留永远到不了用户眼前，只能等下次重开 app 由 boot 重放。

代价：清理那条 IPC 仍然要一个 sessionId 才定位得到 world 的能力，而弹窗此刻可能挂在 welcome 页。
用事件自带的那个兜住（`lastResidueSessionId`），清理能力本身退到任意还活着的 agent——能力是 app 级的，
挂在谁的 world 上都等价。

### 七、`pgid` 是结构化字段，不从中文文案里 regex 回捞

清理侧原先靠 `/kill 进程组 (\d+)/` 从 `cleanupHint` 那句人话里解析 pgid。**文案一改就静默失效**，
而文案是最容易改的东西。`ResidueItem.pgid` 变成事实字段，`cleanupHint` 回落成纯展示；旧日志重放
出来的条目没有这个字段，走 fallback。

## 后果

- **误杀的方向被钉死**：核不上身份的进程组一律不清（`commandMatches` 双向包含 + 最短长度闸）。
  宁可漏报一条陈旧残留，不可把回收给别人的 pgid 当成自己的残留杀掉。
- **suspected 端口只展示不清理**：没法安全 kill 一个不确定是谁在监听的端口，所以连 checkbox 都不给。
- **`failed` 留在清单上**。清单会因此显得「清不干净」——这是对的：进程确实还在跑，从 UI 上抹掉
  等于撒谎。
- **天花板**：`setsid` / `nohup` 双重 fork 脱组的命令仍然只能事后发现；lsof / simctl 是 macOS 路径，
  换平台要换实现（capability seam 的意义正在于此）。
- **推翻它的前提**：如果哪天 v2 的 Docker per bot 落地，洞 1 和洞 3 由「容器死 = 全死」结构性解决，
  腿1 可以退成容器内的清理；但**宿主副作用（simctl 起的 simulator 跑在宿主上）仍然不受容器管**，
  腿2 不会因此作废。
