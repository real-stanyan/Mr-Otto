# 工作区二期设计：云 agent runtime + 每工作区沙箱 + 群聊会话协议

日期：2026-08-31 ｜ 入口 issue：#816 ｜ 总路线：#811（一期已上线：PR #814 / ADR-0198）

## 0. 范围与已定前提

本 spec 一次覆盖二期全部三块：云 runtime、每工作区 Docker 沙箱、群聊 turn 协议（用户选择「一个 spec 全包」，不做单人竖切分期）。三期（平台统一 key + 计费强制执行）不在本 spec，但本期埋计量。

已定前提（#816，不重议）：

- 群聊 Agent 云端执行；ExecutionWorld 接每工作区一个 Docker 沙箱（持久卷 + git clone）。
- spike 已验通：agent 核心（loop/session/model/tools/world）零 Electron 耦合，纯 Node + VPS Docker 完整 turn 跑通；better-sqlite3 prebuilt 可用。
- 基础设施：VPS（ssh -p 2222，docker 29 + node 24）、edge Worker（relay + Escrow DO）、Supabase Cloud。
- 已知缺件：云端 Approver 路由（审批闸 fail-closed 已有，缺「请求送到人面前」那半）。

本期六个架构决策（设计对话已定）：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 权威 event log | VPS SQLite（EventStore 原样复用）+ relay 直播 |
| 2 | 沙箱编排 | dockerode 直管；loop 在宿主 daemon，容器只执行工具 |
| 3 | 群聊 turn 协议 | @提及显式触发 + 中途发言在模型调用边界注入本 turn |
| 4 | 审批归属 | 发起人审批 + owner 可代批；超时 deny；谁批的进日志 |
| 5 | 部署通道 | 单仓 esbuild bundle + 脚本部署 + 协议版本握手 |
| 6 | 过渡期模型 key | 维护者 key 配 VPS env；本期埋计量（usage 事件 + usage_ledger 镜像），额度强制执行留三期 |

## 1. 组件与拓扑

```
桌面/手机客户端 ←→ edge relay（现有 Worker）←→ otto-runtime（VPS 宿主 daemon，新）
                                                      ├─ EventStore（VPS SQLite，权威）
                                                      ├─ LoopEngine + ModelAdapter（key 在宿主 env）
                                                      └─ DockerWorld ──dockerode──→ 每工作区容器 + 持久卷
```

新增单元：

- **`services/runtime/`**：VPS daemon，与 `services/edge/` 平级。装配现有 agent 核心，新增：relay 连接（复用 `src/shared/remote/wsTransport.ts` 与 `wire.ts`——「三方共用一份」变四方共用）、云会话管理器、审批路由器、usage 记录器。纯逻辑与 daemon 装配层分文件：纯逻辑进根门禁 vitest（与 edge 的 `relay.ts`/`worker.ts` 分层同款纪律），装配层单独 tsconfig。
- **`src/world/dockerWorld.ts`**：新 ExecutionWorld 实现，工具经 dockerode exec 进工作区容器执行。loop 在宿主，容器里只有工具执行——模型 key 与 MCP 凭据永不进容器。
- **wire 协议 `cs_*` 帧族**（cloud session）：`cs_hello`（握手，带 JWT + protocolVersion）、`cs_create` / `cs_archive`、`cs_say`（发消息，mention 显式标记）、`cs_event`（事件流推送）、`cs_backlog`（按 seq 补差量）、`cs_approve`（审批应答）、`cs_config`（owner 发工作区云配置：repo URL + PAT）。定义住 `src/shared/remote/`，三端共用。

身份与成员闸（复刻一期已验模式）：

- 成员接 runtime：握手帧带 Supabase JWT，runtime 用 `SUPABASE_JWT_SECRET` 验签得 uid（relay 已有同款）。
- 在籍校验：runtime 用 service key 查 `workspace_members`，60s 缓存 + fail-closed——与 Escrow DO `workspaceOk()` 同一模式。踢人 ≤60s 内云会话对其关门。
- 房间粒度：每个云会话一个 relay 房间（`cs:<workspaceId>:<sessionId>`）。runtime 常驻房间，成员来去自由；事件帧广播给房内全员，补历史走定向帧。

连接器（工作区池）走云执行面：turn 里的 MCP 调用由 runtime 打 edge 的 px call。runtime 以平台身份（与 edge 的共享 secret）自证，声明 fromUid = 本条 turn 发起人；edge 三道闸（身份/在籍/白名单）照跑。runtime 不持有任何成员的 MCP 凭据，密封箱纪律不破。

## 2. 会话生命周期、event log、直播

生命周期：

1. 成员在工作区页点「新建云会话」→ 客户端 `cs_create`（带 JWT）。
2. runtime 验籍 → 开 EventStore（`/var/lib/otto-runtime/<workspaceId>/sessions.db`，每工作区一库、sessionId 分键）→ 确保沙箱容器在跑 → 开 relay 房间 → Supabase `workspace_sessions` 插行（该表一期已有，加 `kind` 列区分：`"package"` = 已发布包（存量默认）、`"cloud"` = 云会话）。
3. 会话列表 = 查 `workspace_sessions`；进会话 = 入房 + `cs_backlog` 拉补历史。
4. 归档：owner 或发起人可归档。容器不删、卷不动、日志留 VPS；`workspace_sessions` 行标 archived。

Event log 与直播：

- 权威日志只在 VPS SQLite。「先落盘再喂模型」在 runtime 进程内闭环——硬规则原样成立，投影（模型上下文 / 各端 UI）都从日志前缀推导。
- 每条落盘事件同时广播进房（`cs_event`）。断线重连：客户端报最后 seq，runtime 补差量。
- 客户端投影层复用现有 renderer 管线：云会话在 UI 里就是一个 session，事件源从 IPC 换成 relay 流；`runtimeHydration` 的「只填空不覆盖」规则照用。渲染进程仍只经 ShellBridge——relay 流由主进程接、按现有事件推送口径转发。

## 3. 群聊 turn 协议

共识底座：所有消息进 append-only 日志、全员可见；同一会话同时只跑一条 turn。

- `cs_say` 一律先落 `chat_message` 事件（带 fromUid）再广播——含不触发 turn 的闲聊。
- 只有 mention 标记显式为真的消息触发 turn。mention 在帧里显式带，不做文本猜测——与 ADR-0179「@好友不发给模型」同款：发送侧动作信号显式化。
- turn 进行中到达的所有消息（含闲聊）在下一次模型调用边界注入本 turn 上下文。event-sourced 投影天然支持：模型上下文 = 日志前缀的投影。
- turn 跑着时新的 @Agent 不排队生成新 turn，只作为注入消息进当前 turn。「排队」语义留给用户自己再 @ 一次——不做隐形队列。
- 群聊上下文里每条人话带发言人标签（`[昵称(uid短前缀)]: ...`），Agent 知道在跟谁说话。标签用日志里钉死的发言时快照，不随昵称漂移。

## 4. 审批路由

- `approval_request` 事件落盘 + 广播进房。UI 侧只有发起人和 owner 看到可点的审批卡，其余成员看只读状态。
- 应答 `cs_approve` 带 uid；runtime 校验 uid ∈ {turn 发起人, workspace owner} 且在籍，通过才落 `approval_response` 事件（记谁批的，全员可见）→ 喂回 approvalGate。
- 超时 10 分钟自动 deny 落盘。发起人/owner 都不在线时 turn 卡在闸上直到超时——fail-closed 不变。
- 手机端复用 remoteBridge 审批卡先例，接 `cs_*` 流。

## 5. 沙箱编排

- 每工作区一容器 + 一具名卷（`otto-ws-<workspaceId>`），dockerode 直管，label 记归属与创建时间。统一镜像 `otto-sandbox`（node + git + 常用工具），Dockerfile 进本仓。
- 资源上限：`--memory 2g --cpus 2 --pids-limit 512`。容器默认可出网（agent 要 npm install / git clone），网络白名单这刀本期不动——容器里没有任何凭据可漏。卷配额靠 VPS 磁盘监控兜底。
- 生命周期：首个云会话建容器；空闲 30 分钟停容器（stop，卷在）；再来会话重启。工作区删除 = 容器 + 卷一起删。孤儿回收：daemon 启动时按 label 对账 Supabase，工作区已不存在的容器/卷标记 7 天后删。
- git clone：工作区云配置（repo URL + 可选 PAT）由 owner 经已鉴权 `cs_config` 发 runtime，VPS 落盘 0600，不进 Supabase。clone 在容器内执行——token 经 exec 传参，不写进镜像层；credential helper 存卷内 0600（容器本身就是该工作区的信任域）。

## 6. 部署、版本、计量

- esbuild 打 `services/runtime/` 成单 bundle（better-sqlite3 原生件随包）；`npm run runtime:deploy` = rsync + systemd 重启。
- `cs_hello` 带 `protocolVersion`（整数，破坏性变更 +1）。不匹配：客户端提示升级；runtime 拒帧不崩。
- 计量：ModelAdapter 出口记 `model_usage` 事件（uid = turn 发起人、workspaceId、model、input/output tokens）进 event log；异步镜像写 Supabase `usage_ledger`（service key；写失败不阻塞 turn，补偿靠日志重放）。migration 建 `usage_ledger` + RLS（本人只读自己的行）。
- 三期衔接（本期不实现，只留位）：额度 = `plans` + `subscriptions`（周期从 Stripe current_period 继承），计量单位归一化 credits（每模型乘数表版本化），起 turn 前查额度（60s 缓存 fail-closed），turn 中途超额跑完再拦下一条。

## 7. 错误处理

- 容器死：turn 报错落盘，daemon 不崩；下一 turn 重建容器。
- relay 断线：runtime 指数退避重连；事件照落盘（直播断，权威库不断），重连后客户端按 seq 补。
- Supabase 查籍失败：缓存过期后 fail-closed 拒新帧，但不踢已在房间里的旧连接——与一期 grants「拿不到 ≠ 被清空」同口径。
- usage 镜像写失败：不阻塞，日志里有权威记录可重放补账。

## 8. 测试

- 纯逻辑进根 vitest：turn 协议状态机（触发/注入/单 turn 互斥）、审批校验（归属/超时/在籍）、成员闸缓存、`cs_*` 帧编解码、usage 事件形状。
- `checks/` 加 runtime 冒烟：起 daemon + 假 relay + 假模型，跑一条完整 turn，验日志落盘与事件流。
- DockerWorld 走 VPS 真机手验清单（沙箱建/停/删、exec、clone）。
- e2e 桌面侧：云会话渲染冒烟（未连 runtime 时不崩、状态文案对）。

## 9. 明确不做（YAGNI）

- 网络出口白名单 / seccomp 细化（容器无凭据，先不做）。
- 多 Agent 编排（AGENTS.md 明确不做）。
- 额度强制执行、Stripe 接入、平台 key（三期）。
- 云会话导出成 session package / 与一期发布制互转（后续按需）。
- turn 队列（显式再 @ 一次即可）。
