-- 0055 语音消息（#1492，ADR-0351）：两个媒体 bucket 放行 audio/mp4（m4a / AAC）。幂等，重跑不炸。
-- 同 0052 / 0053 的约定：Supabase SQL editor / Management API 手动执行一次。**部署顺序：先跑这份、再发手机热更新**——
-- 反过来手机传语音会被 bucket 的 mime 白名单拒掉（friendsApi.storageError 翻成「这个格式传不上去」）。
-- messages.media 那一格的形状不变（messages_media_shape 只管个数），新的 kind:"audio" 由客户端的 parseDmMedia 逐格验：
-- 老客户端认不出这个 kind → 整份丢、画占位正文「[语音]」，说的仍是实话。**还没有在生产执行**。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dm-media', 'dm-media', false, 52428800, array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'audio/mp4'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 52428800, array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'audio/mp4'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
