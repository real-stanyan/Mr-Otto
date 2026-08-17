// authConfig — Supabase 项目公开配置。
// ANON_KEY 是公开值（RLS 兜底权限），写死在代码里无害；真正的密钥/service role key 绝不进这个文件。
// SUPABASE_URL 的公网通道还在等网关规则打通，不影响 Task 5——单测全部注入假 client，不发真请求。

export const SUPABASE_URL = "https://otto-auth.duckdns.org";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2OTQwMzY4LCJleHAiOjIxMDIzMDAzNjh9.fAajGeN-r_OVpUE0Cm-PhUeQTHxH7bHC7VpbdNQ-D8c";
