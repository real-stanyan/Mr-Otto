-- 0055 的验收：跑完迁移后执行，两行都要 PASS。

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "两个 bucket 都放行了 audio/mp4"
  from storage.buckets where id in ('dm-media', 'chat-media') and 'audio/mp4' = any(allowed_mime_types);

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "原来的四种格式还在、上限没变"
  from storage.buckets where id in ('dm-media', 'chat-media')
   and file_size_limit = 52428800
   and allowed_mime_types @> array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'];
