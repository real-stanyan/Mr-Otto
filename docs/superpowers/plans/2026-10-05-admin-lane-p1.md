# 管理员车道与镜像卡 · 第 1 期实施计划（#1605）

Spec：`docs/superpowers/specs/2026-10-05-admin-lane-design.md`（已合，#1611）。第 1 期 = 卡 + 接 / 不接 + 24h。拆三片，各自一个 PR：

| 片 | 内容 | 能不能 OTA |
|---|---|---|
| **a 事实** | 两个事件 `collab_request` / `collab_decision` + 登记清单；`tasks.ts` 折 `collaborator.state`；`chat_kind = 'admins'` 的 migration 0064；`chatKind` 联合类型多一支 | 表不能；其余随 b |
| **b runtime** | `admins` 车道的开 / 找（daemon）；`adminLaneBridge`（镜像 `collab_request` / 回复 / `collab_decision`，复用 laneBridge 四道闸）；`invite_collaborator` 换落点 + 取 `quote` 与 `result`；B 点「接」= B 的主人轮（`greeting: "collab_accept"`）；24h 扫描 | runtime 部署 |
| **c 手机** | 朋友私聊页的镜像卡（从 B 的 admins 日志折）+ 接 / 不接（写 `collab_decision`）；A 的任务卡「协作：… · 等 TA 点头 / 在办 / 不方便 / 对面没回」；「管理员之间 · N 条 ›」折叠行 + 只读 `AdminLaneScreen` | OTA |

## 对 spec 的小修（实施时发现）

1. **`collab_decision` 由谁落**：spec 写「B 点的落 B 那份、镜像回 A」。手机不直接写事件表——走 B 那条 admins 会话的 `say`（`greeting: "collab_accept" | "collab_decline"`），runtime 在 say 里落 `collab_decision` 再镜像；这样审批与 ownerSpoke 的判据都是现成的。
2. **`quote.ownerLine` 从哪取**：任务所在会话里 `task_created` 之前最近一条主人的 `user_message`（去掉 `[名字]: ` 前缀）；取不到用任务 `brief`。
3. **24h 扫描**挂在 `reportScheduler` 同一拍里（每分钟），不另开定时器。

## 片 a 的清单

- `src/session/events.ts`：`CollabRequestEvent` / `CollabDecisionEvent`（形状见 spec §3.2）；`KNOWN` 登记。
- 登记八处（同 `task_*`）：agentView keep / persistencePolicy / sessionPackage strip / taskSync executor / contextEstimate 不计 / cloudTimeline 藏 / deriveMessages 投影（request → 「[协作请求 r_…] A 的管理员 X 找你…」给 B 的管理员；decision → 「[对面主人：接了 / 不接 / 没回]」给 A 的管理员）/ persistencePolicy.test。
- `src/shared/tasks.ts`：`collaborator.state: "pending" | "accepted" | "declined" | "expired"`；`task_collab` 落 pending；`collab_decision` 按 requestId → taskId 推状态（请求事件带 taskId，所以 fold 要先见过 request；B 那份日志里没有任务，不折）。
- `src/shared/collab.ts`：`collabRequestText` / `collabDecisionText`（投影文案）、`COLLAB_EXPIRE_MS = 24h`。
- `supabase/migrations/0064_admin_lanes.sql`：`chat_kind` 多 `'admins'`（check 多一支：`agent_ids = ['admin']`、`peer_uid not null`）；`ws_sessions_one_admins_per_peer on (workspace_id, peer_uid) where chat_kind = 'admins'`。
- `chatKind` 联合类型：`session_created.cloud.chat.kind` 多 `"admins"`；消费方逐个过 tsc。
- 测试：`tests/session/collabEvents.test.ts`（登记八处 + fold）、`tests/shared/collab.test.ts` 加文案。
