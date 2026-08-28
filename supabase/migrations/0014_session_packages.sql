-- 0014_session_packages.sql —— 会话分享的 Storage bucket + RLS（issue #611，PR#2）
--
-- @好友分享会话：发送方把会话包（manifest.json + events.jsonl + 附件字节）上传到
-- Storage，DM 里只发一个带路径的「信封」，接收方按路径下载、导入、fork 继续执行。
--
-- 与 0001 同一约定：在 Supabase SQL editor 手动执行一次（幂等，重跑不炸）。
--
-- 权限模型复用 friendships：bucket 私有，只有「与上传者是 accepted 好友」的人能下载。
-- 路径约定：session-packages/{sender_uid}/{pkg_id}/...——第一段位是发送方 uid，
-- RLS 靠它判断「这是谁发的、我和ta是不是好友」。

-- ── bucket：私有（public = false），不挂 CDN ─────────────────────────────
insert into storage.buckets (id, name, public)
values ('session-packages', 'session-packages', false)
on conflict (id) do nothing;

-- ── RLS：只对收发双方开放 ────────────────────────────────────────────────
-- storage.objects 的 RLS 默认已启用（Supabase 内置），这里只补策略。
-- name 列存的是完整对象键「{sender_uid}/{pkg_id}/{file}」，第一段 = 发送方 uid。
-- (storage.foldername(name))[1] 取第一段位。

-- 上传：只能往「自己的 uid 开头」的路径写（不能假冒别人发）
drop policy if exists "session_packages_insert_own" on storage.objects;
create policy "session_packages_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'session-packages'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 覆盖/更新：同上传（重发同一个 pkg 会覆盖，内容寻址语义不变）
drop policy if exists "session_packages_update_own" on storage.objects;
create policy "session_packages_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'session-packages'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 下载：上传者本人，或与上传者是 accepted 好友的人
drop policy if exists "session_packages_select_friend" on storage.objects;
create policy "session_packages_select_friend"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'session-packages'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and least(f.requester, f.addressee) = least(auth.uid(), ((storage.foldername(name))[1])::uuid)
          and greatest(f.requester, f.addressee) = greatest(auth.uid(), ((storage.foldername(name))[1])::uuid)
      )
    )
  );

-- 删除：只有上传者本人（撤回分享 = 删掉对象；DM 里的信封会随之失效——
-- 接收方下载不到就渲染「分享已被撤回」，这是 feature 不是 bug）
drop policy if exists "session_packages_delete_own" on storage.objects;
create policy "session_packages_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'session-packages'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
