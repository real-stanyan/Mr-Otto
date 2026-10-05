-- 0069_chat_files.sql —— 聊天里发文件、智能体把做好的文件交给人（#1683）。幂等，重跑不炸。
-- 同 0052 / 0055 的约定：Supabase SQL editor 手动执行一次。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**——
-- 反过来手机传 PDF 会被 bucket 的 mime 白名单拒掉，runtime 把 create_document 做好的文件传进 chat-media 也会被拒
-- （toolFiles 的立场是「传不上去就跳过」：模型说「发给你了」，人什么都没收到）。
--
-- 只动两个 bucket 的 allowed_mime_types：在 0055 那份（图片 / 视频 / 语音）后面加上 src/shared/chatMedia.ts 的
-- DOC_MIME_TYPES（PDF、Word、Excel、PPT、纯文本、CSV、Markdown）。单文件上限仍是 50MB（客户端与 runtime 判 20MB）。
-- messages.media 那一格的形状不变（messages_media_shape 只管个数），新的 kind:"file" 由客户端的 parseDmMedia 逐格验：
-- 老客户端认不出这个 kind → 整份丢、画占位正文「[文件] 名字」，说的仍是实话。路径规矩、RLS 策略都不变（0052）。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dm-media', 'dm-media', false, 52428800, array[
  'image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'audio/mp4',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/markdown'
])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 52428800, array[
  'image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'audio/mp4',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/markdown'
])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
