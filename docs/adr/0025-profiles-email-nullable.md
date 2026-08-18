# ADR-0025：profiles.email 可空 + 部分唯一索引

- 状态：已接受
- 日期：2026-08-18
- 关联：issue #62，migration `supabase/migrations/0001_friends.sql`，ADR-0014（好友系统）

## 背景

`profiles` 是 `auth.users` 的公开投影，唯一用途是**邮箱精确搜索找人**（好友系统只有这一个找人入口，德州的好友门又建在好友关系上）。

0001 初版把这一列写成 `email text unique not null`。它对着生产库跑的时候撞上了另一个问题（真库 `profiles` 是旧形状，见 #62），但 `unique not null` 本身还藏着第二颗雷：

`email` 是从 `auth.users.email` 投影过来的，而 GoTrue 的 `auth.users.email` **可以为 null** —— 手机注册、匿名注册、只绑了不给邮箱的 OAuth provider，都是 null。触发器把 null 落到一个 `not null` 列上，只有两条路：

- 直接写 null → 触发器抛错 → 因为它挂在 `auth.users` 的 insert 上，**注册当场失败**
- `coalesce(new.email, '')` → 第一个无邮箱用户占掉 `''`，**第二个无邮箱用户注册失败**（唯一冲突）

两条都是"注册挂掉"，而且是延迟引爆：单人自测期永远碰不到。#62 记的那次事故正是同一张表上的触发器炸了注册，代价是所有新用户都进不来且没有任何告警。

## 决策

`profiles.email` 可空；唯一性用**部分唯一索引**表达：

```sql
create unique index if not exists profiles_email_unique
  on public.profiles (email) where email is not null;
```

- 有邮箱的用户之间仍然全局唯一（搜索按邮箱定位到唯一一个人这一点不变）
- 无邮箱的用户任意多个共存（Postgres 的唯一索引本就放过 null，部分索引只是把意图写明）
- 触发器直写 `new.email`，不做 `coalesce`：**没有邮箱就是 null，不是空字符串**。`''` 是个会跟真实值抢唯一槽位的假值

渲染层类型 `FriendProfile.email` 保持 `string`，在主进程边界上 `?? ""` 归一（`toFriendProfile`）—— null 只活在数据库和 `ProfileRow` 里。

## 后果

- 无邮箱用户**搜不到、也加不了好友**。这是正确行为而不是缺陷：搜索的语义就是"按邮箱找"，没邮箱自然不在结果里。等有第二种找人方式（用户名/邀请码）时再说。
- 与 0001 初版的声明不一致，因此 0001 被直接改写而不是加一个 0006 —— 该文件是手工执行的可重跑脚本，收敛到当前声明的形状就是它的契约（#62 的教训：幂等不能只是"重跑不报错"）。
- 前提若不成立就该推翻：如果将来**强制**每个账号都必须有邮箱（关掉手机/匿名注册），那 `not null` 会比部分索引更早暴露数据问题，届时应改回去。
