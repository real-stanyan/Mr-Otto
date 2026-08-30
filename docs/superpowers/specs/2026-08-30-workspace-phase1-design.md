# 工作区（团队频道）一期设计 — 工作区 + 成员 + 连接器池 + 共享查看会话

日期：2026-08-30 · Task issue：#811 · 状态：待 stanyan 审阅

## 0. 背景与总路线

工作区 = **成员名单 + 连接器授权池 + 会话列表** 三样东西的组织单位（类 Discord 频道）。
总路线四个子系统分三期（#811）：

| 期 | 内容 | 依赖 |
|---|---|---|
| **一期（本 spec）** | 工作区、成员、连接器池（escrow 群组化）、共享查看会话 | 无——全站在现有积木上 |
| 二期 | 云 agent runtime + 每工作区 Docker 沙箱 + 群聊会话协议 | 一期的工作区实体 |
| 三期 | 平台统一 key + 计量计费 | 二期的云执行面 |

已定的方向性决策（本次设计对话，stanyan 选定）：群聊 Agent 云端执行；ExecutionWorld
接每工作区一个云沙箱；模型调用平台统一 key + 计费。云 runtime 可行性 spike 已验通
（#811：agent 核心零 electron 耦合，VPS Docker 里完整 turn 跑通）。

一期刻意不含以上任何一条——它验证的是「团队空间」这个概念本身有没有人要，
且每一块都是 ADR-0197 / ADR-0177 已有机制的群组化推广，风险最小、可独立发布。

## 1. 数据模型

### 1.1 Supabase 新表（真库，直连不经中继——同好友系统，ADR-0114）

```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_uid uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  uid uuid not null references auth.users(id),
  role text not null default 'member',      -- 'owner' | 'member'，一期只有两档
  added_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, uid)
);
```

RLS：成员可读本工作区两表；owner 可写 members（拉人/踢人）；成员可删自己那行（退群）。
建群时 owner 自动成为第一行 member（role='owner'）。

**`workspaces` 的 select policy 必须写成 `owner_uid = auth.uid() OR is member`**，
不能只认「是成员」——建群时 insert `workspaces` 一行后紧跟着 `RETURNING`，此时
`workspace_members` 里 owner 自己那行还没插入，若 select policy 只放行「在
`workspace_members` 里能查到自己」，这次 `RETURNING` 会被 RLS 挡在前面（owner
此刻在两张表的意义上都还不是「成员」）。加上 `owner_uid = auth.uid()` 这一支，
建群这一步不依赖插入顺序或事务内可见性假设。

**拉人限定好友**：邀请候选 = owner 的 accepted 好友（`friendships` 表现有口径）。
成员↔成员之间**不要求**互为好友——工作区成员关系本身就是关系闸的依据（见 §2.3）。

### 1.2 会话发布（共享查看）

```sql
create table workspace_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  publisher_uid uuid not null,
  title text not null,
  pkg_id text not null,              -- 指向 session-packages 桶里的包（见下）
  updated_at timestamptz not null default now()
);
```

RLS：成员可读；publisher 可写/删自己发布的。快照本体不落这张表——`pkg_id` 指向
`session-packages` 桶（migration 0014）里 `{publisher_uid}/{pkg_id}/` 的包，
复用 0014 的包机制，下载权限见 migration 0015 的 storage policy（ADR-0198 推翻
本节初稿的 jsonb 快照方案：包机制已有隐私闸/上传/导入全链路，jsonb 要重造一遍
且 2 MiB 顶不住附件）。

### 1.3 不新增 edge 存储

工作区目录数据全在 Supabase。edge（Escrow DO）只在**闸序查询**时按需查 Supabase
（现有 friendshipQuery 同款路径），不复制成员名单——复制品会陈旧，而踢人要立即生效（§5）。

## 2. 连接器池 — escrow 授权的群组化（ADR-0197 推广）

### 2.1 授权形状：EscrowGrant 加一个变体

`src/shared/remote/pxEscrow.ts`（两方共用一份，纪律不变）：

```ts
export type EscrowGrant =
  | { friendUid: string;   allow: AllowEntry[] }   // 现状：按好友
  | { workspaceId: string; allow: AllowEntry[] };  // 新增：按工作区
```

`v` 保持 1；`parseEscrowDoc` 放行两种形状。**部署顺序：edge 先上**（旧客户端的文档
只有 friendUid 变体，新 edge 照收；反过来旧 edge 收到 workspaceId 变体会 400 bad_doc）。

### 2.2 谁能把连接器拉进池

**任何成员**都可以把自己已接通的 MCP server 授给工作区——不只 owner。机制上每个
贡献者就是一个 host：往**自己的** escrow 箱里写一条 `{ workspaceId }` grant，
escrowSync 四触发源 + 防抖上传全复用，一行不改编排。UI 沿用 `proxyShare.ts` 的
勾选表换算（服务级 + 工具级白名单，`tools: []` = 整服务放行）。

**不做自动全授**（ADR-0177 的判断在群组场景更成立）：拉连接器进工作区必须过一张
与 ShareGrantDialog 同款的确认框，明示「工作区全体成员（含未来加入者）将以你的
身份使用这些工具」。

### 2.3 三道闸的群组化（edge px.ts，闸序不变：身份 → 关系 → 白名单）

- **身份**：不变。帧里自称的 fromUid 只核对，查授权按通道绑定的那个。
- **关系**：grant 是 friendUid 变体 → 查 friendships（现状）；是 workspaceId 变体 →
  查 `workspace_members`：**fromUid 和 hostUid 都得在籍**。host 退群/被踢 = 它贡献的
  授权立即失效，和「删好友 = 代理权限跟着死」同构（ADR-0162）。
- **白名单**：不变，`grantAllows` 同口径。

查询失败语义沿用现状：**「拿不到」≠「被清空」**，deny 用可区分的 code，
B 侧保留旧缓存不误清（ADR-0197 已钉）。

### 2.4 B 侧借用

`pxCloudClient.fetchGrants` 返回的授权多一种来源标注（`via: { workspaceId }`）。
借用台账（allBorrows/usableBorrows）、`routedBorrowMcp` 现选路、命名空间前缀
（按 host uid 短标签，ADR-0166）全部不变——工作区借用就是一条普通借用，只是
授权依据从好友关系换成了在籍关系。审计回流（pxAuditSync）不变：账本来就按
(hostUid, serverId, tool) 记，grant 带 workspaceId 后 A 的调用记录多一列「经由哪个工作区」。

## 3. 撤销与级联（一期的安全核心）

| 动作 | 效果 | 生效时机 |
|---|---|---|
| owner 踢人 / 成员退群 | 该 uid 借用即刻被关系闸拒；其贡献的连接器整批失效 | 立即（闸现查在籍） |
| 贡献者撤某台连接器 | 从自己箱里删那条 workspaceId grant，escrowSync 重传 | 下次上传（在线即秒级） |
| owner 删工作区 | Supabase 级联删两张表；各贡献者箱里的悬空 grant 被关系闸拒（查无此籍） | 立即 |
| 贡献者登出 | 现有语义：purge() 清整箱（ADR-0197），工作区授权随箱亡 | 立即 |

悬空 grant（工作区已删但贡献者离线没重传）**闸上拒、台账上标**，不静默消失——
「撤销要说出口」的既有纪律（ADR-0168）。

## 4. 共享查看会话（发布制，非直播）

### 4.1 机制

成员把一个本地会话**发布**到工作区：快照走 ADR-0177 分享会话的同一条脱敏/隐私闸
（log-only 事件剥掉、session_shared 进隐私闸），落 `workspace_sessions.doc`。
可**重新发布**（覆盖同 id）、可**撤下**（删行）。查看端只读渲染，复用分享会话的
已有查看组件。**不做 live 直播**——那是二期群聊协议的事，一期发布制已够
「给队友看我做了什么」。

### 4.2 连带借用

发布时弹 ShareGrantDialog 同款确认：`serversUsedInSession` 反查本会话用过且
此刻还连着的 server，默认全勾、可减——勾了的变成 §2 的 workspaceId grant。
与 1:1 分享的差别只在授权对象（工作区 vs 单个好友）。

## 5. UI（一期最小面）

- 侧栏新增「工作区」区块：列表 + 建群入口。
- 工作区页三个 tab：**会话**（发布列表 + 查看）、**连接器**（池内清单：谁贡献的、
  白名单摘要、自己贡献的可撤；「拉入连接器」走 §2.2 确认框）、**成员**
  （名单 + owner 的拉人/踢人；拉人候选 = 好友列表）。
- 连接器状态行沿用 A 侧 hostStatus 口径：贡献者离线但箱在 = 「云端可用」
  不说「没连上」（ADR-0197 已钉的措辞）。

## 6. 测试

- `tests/shared/pxEscrow.test.ts` 扩：两种 grant 变体的 parse/构造/换算。
- `services/edge` 纯逻辑层：workspaceId 变体的关系闸（在籍/不在籍/host 不在籍/
  工作区已删/查询失败保缓存），跑在根门禁里（ADR-0129 的分层不变）。
- 级联表（§3）每行一条测试。
- 发布快照：隐私闸剥离断言复用 ADR-0177 的既有测试口径。
- e2e（不进 gate）：建群 → 拉好友 → 拉连接器 → 对方借用 → 踢人失效，一条冒烟。

## 7. 一期明确不做

群聊会话（多人 + Agent）、云端执行、平台 key/计费、live 直播、角色体系
（只有 owner/member）、非好友邀请（链接邀请）、工作区级聊天频道（纯文字群聊——
一期的会话是「发布的 agent 会话」，不是 IM）、附件超 2 MiB 的会话发布。

## 8. 风险与开放问题

- **workspaceId grant 撞旧 edge**：部署顺序钉死 edge 先行；`checks/relay.mjs` 真
  workerd 验里加一条两变体往返。
- **成员↔成员非好友**：借用方 UI 里 host 显示用 profiles 的昵称/短标签，
  不依赖好友关系存在。
- **Supabase 表演进**：migration 在 Cloud 真库跑（本机 memory 已钉：老栈 otto-db-1
  已退役，别打错库）。
