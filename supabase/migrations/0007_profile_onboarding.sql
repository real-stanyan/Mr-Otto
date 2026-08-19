-- 首登引导 + 用户自改资料(issue #95)。在 Supabase SQL editor 手动执行一次,可重复执行。
--
-- 解三件事:
--   ① profiles 没有"这个人是不是第一次进来"的信号 —— 触发器用邮箱前缀兜底填 name,
--      所以 name 永远非空,判不出首次登录。新增 onboarded_at 显式记录"引导走完了"。
--   ② avatar_url 每次登录被 provider 覆盖 —— 0001 的触发器对 name 做了"本地非空就不覆盖",
--      唯独 avatar_url 是无条件写回。用户自己设的头像下次登录就没了。
--   ③ 存量用户不该被补弹引导 —— 建列的那一次顺手盖章。

-- ── ① 引导标记 + 存量用户一次性盖章 ──────────────────────────
-- 可空 = 没走完引导;有值 = 走完了(点了"完成"或"以后再说",两者都算见过)。
-- 不用 boolean:时间戳能回答"什么时候进来的",布尔只能回答"是不是",而前者是后者的超集。
--
-- 建列和回填必须绑在同一个"列本来不存在"的判断里,不能拆成
-- `add column if not exists` + `update ... where onboarded_at is null`:
-- 后者在重复执行时会把此刻正等着看引导的新用户一起盖掉,引导再也不弹。
-- 回填只在建列的那一次发生 —— 本迁移之前注册的人早就在用了,给他们补一个
-- "欢迎新用户"的弹窗只会像 bug
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'onboarded_at')
  then
    alter table public.profiles add column onboarded_at timestamptz;
    update public.profiles set onboarded_at = now();
  end if;
end $$;

-- ── ② 触发器:provider 的值只填空位,不覆盖用户自己写的 ──────────
-- 与 0001 的差异只有 avatar_url 那一行(name 的写法原样保留,这里是把同一条规则
-- 推广到头像)。整函数重建而不是 alter:pg 没有"改一行函数体"这回事
create or replace function public.handle_auth_user_upsert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, avatar_url, updated_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'user_name',
             split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', ''),
    now()
  )
  on conflict (id) do update
    set email = excluded.email,
        -- 只在本地还没名字时接受 provider 的名字:profiles_update_self 允许用户
        -- 自己改名,每次 auth.users 更新都覆盖回去等于静默丢用户的数据
        name = case when profiles.name = '' then excluded.name else profiles.name end,
        -- 头像同理。auth.users 在每次登录/刷新令牌时都会被更新,原来那句无条件
        -- 覆盖意味着"用户设的头像最多活到下次登录"
        avatar_url = case when profiles.avatar_url = '' then excluded.avatar_url
                          else profiles.avatar_url end,
        updated_at = now();
  return new;
end $$;
drop trigger if exists on_auth_user_upsert on auth.users;
create trigger on_auth_user_upsert
  after insert or update on auth.users
  for each row execute function public.handle_auth_user_upsert();

-- 触发器插新行时不带 onboarded_at(默认 null)= 只有新注册的人会看到引导。
-- 写权限沿用既有的 profiles_update_self:自己的行自己改,不需要新 policy
