// authConfig — Supabase 项目公开配置。桌面与手机端**共用同一份**:
// 两个客户端连的必须是同一个项目,分成两份迟早只改一处。
// ANON_KEY 是公开值（RLS 兜底权限），写死在代码里无害；真正的密钥/service role key 绝不进这个文件。
//
// 2026-08-25 起从自托管 Supabase（otto-auth.stan.damianslife.com，Hetzner VPS
// docker 栈）迁到 Supabase Cloud 托管项目 kpeemypbhkynapkjzewr：托管版自带
// 验证邮件通道（邮箱密码注册要发确认邮件，自托管得自己配 SMTP relay），
// 且不用再养那套 docker 栈。迁移与退役的全部权衡见 ADR-0098。

export const SUPABASE_URL = "https://kpeemypbhkynapkjzewr.supabase.co";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwZWVteXBiaGt5bmFwa2p6ZXdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MzM4MzQsImV4cCI6MjEwMzIwOTgzNH0.Gedo9lfFzPf_WS4KpWmfYCMt9mMl_8T2Q9slZuFJCQo";
