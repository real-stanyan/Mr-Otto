-- 0029 的验收：跑完迁移后执行，三行都要 PASS。

select case when count(*) = 3 then 'PASS' else 'FAIL: ' || count(*) end as "三个档都开了 image"
  from public.plan
 where id in ('lite', 'pro', 'max') and (capabilities ->> 'image')::boolean is true;

-- 视频**没有**跟着开：产品上暂时不做（这一行防的是「顺手全开」）
select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end as "video 仍然全关"
  from public.plan
 where id in ('lite', 'pro', 'max') and (capabilities ->> 'video')::boolean is true;

-- addon 不是档位，不该被这条迁移碰到
select case when capabilities = '{}'::jsonb then 'PASS' else 'FAIL: ' || capabilities::text end as "addon 行没被动过"
  from public.plan where id = 'addon';
