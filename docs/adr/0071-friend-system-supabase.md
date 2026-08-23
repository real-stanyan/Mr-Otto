# 0071. 好友系统走 Supabase 直连(表 + RLS + Realtime,无自建服务器)

> 原为 ADR-0014。撞号改号（issue #230）：`docs/adr/` 下 0014 曾同时有两份，
> 本篇是较晚合并的那份，按新规则（AGENTS.md「Roles of issues & PRs」的
> ADR 编号 claim-at-merge）改到当时最大号 +1。**2026-08-23 之前的 commit
> message 和已关闭的 issue 里仍写着 ADR-0014**——那些改不动，靠这一行认领。
> 留在 0014 的那份是分支选择器（`0014-branch-picker.md`）。

日期:2026-08-18
状态:已采纳

## 背景

Mr Otto 已有 Supabase OAuth 账号体系(ADR 前置:account.ts,自托管实例)。
需要真人用户互加好友:关系链 + 在线状态 + 一对一 DM。

## 决策

1. **无自建服务器**:三张表(profiles/friendships/messages) + RLS 承担全部授权;
   presence/消息推送走 Supabase Realtime。备选"自建后端"因部署运维成本否决,
   "纯轮询"因在线状态/消息延迟差否决。
2. **窄接口注入**:FriendsManager 依赖 FriendsApi(照 account.ts 的 SupabaseLike
   模式),真 supabase 查询链隔离在 supabaseFriendsApi.ts;单测零网络。
3. **真 client 单实例双出口**:createSupabaseAuthClient 返回 {auth, raw},
   AccountManager 与好友网关共用同一登录态——两个 client 会各自持 session,拒绝。
4. **错误结构化回流**:好友 bridge 方法回 FriendsResult(ok:false 带人话),
   不走 invoke reject——网络/RLS 拒绝是常态分支,不是异常。
5. **DB 变更走 supabase/migrations/ 编号文件**,手动在 SQL editor 执行,
   不改旧文件。前提失效点:若将来接 supabase CLI 管线,本条重议。

## 后果

- 客户端逻辑全部可离线测;RLS 是唯一授权层,migration 里每条 policy 带意图注释,
  人工在 Supabase 后台验证。
- Realtime 依赖自托管实例开着 realtime 服务;掉线重连由 supabase-js 兜,
  重连后重拉快照。
