// authConfig — Supabase 项目公开配置。
// ANON_KEY 是公开值（RLS 兜底权限），写死在代码里无害；真正的密钥/service role key 绝不进这个文件。
// SUPABASE_URL 域名 2026-08-17 从 otto-auth.duckdns.org 改为
// otto-auth.stan.damianslife.com（duckdns 前面的网关只对手动登记的规则放行，
// 这个域名从未登记过；改用网关持有通配符证书、自动放行的 *.stan.damianslife.com
// 子域，详见 deploy/otto-auth/README.md「TLS 部署」）。公网通道已验证可达
// （curl /auth/v1/health 返回 200 JSON）。

export const SUPABASE_URL = "https://otto-auth.stan.damianslife.com";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2OTQwMzY4LCJleHAiOjIxMDIzMDAzNjh9.fAajGeN-r_OVpUE0Cm-PhUeQTHxH7bHC7VpbdNQ-D8c";
