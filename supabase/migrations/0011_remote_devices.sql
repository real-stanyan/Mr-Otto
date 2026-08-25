-- 远程中继的设备登记表(spec: docs/superpowers/specs/2026-08-25-mobile-remote-control-design.md)。
--
-- 这是手机端功能**唯一**新增的持久化。会话内容一个字节都不落库:
-- 网关是盲管道,桌面不在线时手机显示"你的 Mac 不在线"。
--
-- 公钥进库是故意的,私钥永远不进:身份私钥只在各自设备的 Keychain/Keystore 里。
-- 库里泄漏这张表 = 泄漏"谁有几台设备",不等于泄漏任何一条会话。

create table if not exists public.devices (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  device_id    text        not null,
  kind         text        not null check (kind in ('desktop', 'mobile')),
  -- base64url 的原始公钥(各 32 字节 → 43 字符)
  identity_pub text        not null,
  kx_pub       text        not null,
  -- APNs/FCM token,只有 mobile 有
  push_token   text,
  label        text        not null default '',
  last_seen    timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.devices enable row level security;

-- 和 profiles 的 select policy(对所有登录用户开放,ADR-0055 订正里记着)**刻意不同**:
-- 那张表要支持"按邮箱精确搜好友",这张表没有任何跨用户的用途。
-- 别人能读到我的设备列表 = 别人知道我有几台机器、什么时候在线,没有任何收益。
create policy devices_select_own on public.devices
  for select using (auth.uid() = user_id);

create policy devices_insert_own on public.devices
  for insert with check (auth.uid() = user_id);

-- 只允许改自己的行,且不允许把行改到别人名下(using 管旧行,with check 管新行)
create policy devices_update_own on public.devices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy devices_delete_own on public.devices
  for delete using (auth.uid() = user_id);

-- 网关按 user_id 找同户的另一端;last_seen 用于清理僵尸登记
create index if not exists devices_user_kind_idx on public.devices (user_id, kind);
