-- 0052_chat_media.sql —— 聊天里发图片和视频（#1443 P1，ADR-0343）。幂等，重跑不炸。同 0044 / 0049 / 0050 的约定：
-- Management API 逐条发。**部署顺序：先跑这份、再发手机热更新**——反过来时手机读私聊要 media 那一列，
-- 列不在就退回不带它的查询（friendsApi 的容错），文字照常；发图片 / 视频那一步上传会被 bucket 不存在拒掉，
-- 输入栏底下说一句「没发出去」，不出别的事。**尚未在生产执行。**
--
-- 文件放 Storage，消息里只带引用（设计稿 v1 第 1 条）。两个私有 bucket：
-- · dm-media   —— 朋友私聊。路径 `<发送方>/<接收方>/<uuid>.<扩展名>`（视频封面 `<uuid>.poster.jpg`）。
--                写：第一段是自己、第二段是已接受的好友；读：收发双方。保留期：永久（第 8 条）。
-- · chat-media —— 云会话（P2 起用，策略现在一并建好）。路径 `<团队>/<会话>/<sha256>.<扩展名>`。
--                写与读：这条会话所在团队的在籍成员，或这条会话的客人（0043），且这条会话真的属于路径里那个团队。
--                删除由 runtime 用 service key 做（P6：删会话时一起删），客户端没有删除策略。
--
-- 两个 bucket 都**没有 update 策略**：路径带随机 id（或内容哈希），对象不可改；客户端上传一律 x-upsert: false。
-- 判据里不把路径段 cast 成 uuid：一段乱写的路径 cast 失败会让整条语句抛错（同 0043 is_session_guest 收 text 的理由），
-- 改成拿库里的 uuid 转 text 去比，只会「对不上」不会炸。
--
-- 大小与格式上限写在 bucket 上：50MB（= 视频上限，src/shared/chatMedia.ts 的 VIDEO_MAX_BYTES；也是 Supabase Free
-- 档的单文件上限）；只收 JPEG / PNG / MP4 / MOV——HEIC 在手机上转成 JPEG 再传（桌面解不了、模型不收）。
-- 重跑会把上限改回这一份（on conflict do update），手动在后台调过的话会被覆盖。
--
-- messages.media：可空的 jsonb，非空时是 1..9 个元素的数组（形状由客户端的 parseDmMedia 逐格验，库只管个数）。
-- 纯媒体消息的 body 写占位「[图片]」/「[视频]」（第 3 条）——0001 那条 body 1..4000 的 check 一个字不动，
-- 老客户端、会话列表第二行、推送正文照常读 body。messages 早已进 supabase_realtime，新列自动跟着推。

-- ── bucket ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dm-media', 'dm-media', false, 52428800, array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 52428800, array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── dm-media ─────────────────────────────────────────────────────────────
-- 写：只能以自己名义（第一段 = 自己），且对方（第二段）是已接受的好友——同 messages 的 insert 策略（0001）
drop policy if exists "dm_media_insert" on storage.objects;
create policy "dm_media_insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dm-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee::text = (storage.foldername(name))[2])
          or (f.addressee = auth.uid() and f.requester::text = (storage.foldername(name))[2])
        )
    )
  );

-- 读：收发双方。删了好友之后照样读得到旧消息里的图（私聊记录还在，图不该先没了）
drop policy if exists "dm_media_select" on storage.objects;
create policy "dm_media_select" on storage.objects for select to authenticated
  using (
    bucket_id = 'dm-media'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (storage.foldername(name))[2] = auth.uid()::text
    )
  );

-- 删：只有上传者本人（上传了一半、消息没写成时把孤儿收掉）
drop policy if exists "dm_media_delete_own" on storage.objects;
create policy "dm_media_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'dm-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── chat-media（P2 起用）─────────────────────────────────────────────────
drop policy if exists "chat_media_insert" on storage.objects;
create policy "chat_media_insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.workspace_sessions s
      where s.id::text = (storage.foldername(name))[2]
        and s.workspace_id::text = (storage.foldername(name))[1]
        and (public.is_ws_member(s.workspace_id, auth.uid()) or public.is_session_guest(s.id::text, auth.uid()))
    )
  );

drop policy if exists "chat_media_select" on storage.objects;
create policy "chat_media_select" on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.workspace_sessions s
      where s.id::text = (storage.foldername(name))[2]
        and s.workspace_id::text = (storage.foldername(name))[1]
        and (public.is_ws_member(s.workspace_id, auth.uid()) or public.is_session_guest(s.id::text, auth.uid()))
    )
  );

-- ── messages.media ──────────────────────────────────────────────────────
alter table public.messages add column if not exists media jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_media_shape' and conrelid = 'public.messages'::regclass) then
    -- case 而不是 and：jsonb_array_length 对标量会抛错，SQL 不保证 and 的求值顺序
    alter table public.messages add constraint messages_media_shape check (
      media is null
      or case when jsonb_typeof(media) = 'array' then jsonb_array_length(media) between 1 and 9 else false end
    );
  end if;
end $$;
