# Mr Otto 用户登录系统 — 设计 v1

日期:2026-08-17　状态:已批准(会话内)

**变更记录**:2026-08-17 用户改选网关通配符子域(`otto-auth.stan.damianslife.com`
替换 `otto-auth.duckdns.org`)。原因:duckdns 域名前面的网关只对手动登记的规则
放行,`otto-auth.duckdns.org` 从未登记过,实测连高位端口也被网关滤掉;
`*.stan.damianslife.com` 网关持有通配符 Let's Encrypt 证书,任意子域自动放行,
443 在网关终止 TLS 后以明文 HTTP 转发到这台 VM 的 80。连带影响:这台 VM 上
**不再需要 certbot**,TLS 由网关代管——Task 2 原计划的"nginx + certbot"缩成
"nginx 反代"。详见 `deploy/otto-auth/README.md`「TLS 部署」。

## 目的与范围

登录换来的身份将来用于:①同步用户配置的模型 API Key ②同步会话 ③同步 skill,
以及更远的好友系统。**本期只做「登录 + 账号身份」**;云同步是下一期(单独设计,
含 API Key 端到端加密的专门讨论),好友系统更后。数据库与账号模型按"将来要同步"预留。

分期:

1. **本期**:自托管 Supabase(第二套栈)+ Google/GitHub OAuth 登录 + Otto 账号 UI
2. 下期:数据云同步(Key 加密方案单独设计)
3. 以后:好友系统
4. Apple 登录:留坑(需 Apple Developer 付费账号 + 域名验证,暂不做)

## 基础设施(已确认的事实)

- 服务器:`ssh stan@65.109.113.168 -p 2222`,Ubuntu,24G 内存(闲 19G),
  Docker 29 + Compose v5,sudo 可用
- 机上已有:dryrun 项目的 Supabase 全家桶(Kong `127.0.0.1:8000`、pooler
  `127.0.0.1:5432/6543`)、glitchtip(`127.0.0.1:8080`)、n8n(`0.0.0.0:5678`)、
  nginx(80,仅 default 站点,无 TLS)
- 域名:`otto-auth.stan.damianslife.com` → `65.109.113.168`(已验证解析,无 AAAA)

## 服务器侧

- **第二套 Supabase 栈**(官方 docker compose,项目名 `otto`),与 dryrun 完全隔离。
  端口错开且全部只绑 `127.0.0.1`:Kong → `8100`,pooler → `5433/6544`。
  不与 dryrun 共用 auth.users(GoTrue 用户表是实例级的,共用将来拆不开)
- **nginx** vhost `otto-auth.stan.damianslife.com` 反代 Kong(8100);**certbot** 签
  Let's Encrypt,强制 HTTPS
- **GoTrue**:开 Google + GitHub 两个 external provider;**关闭邮箱密码注册**
  (只走 OAuth);`SITE_URL` / `URI_ALLOW_LIST` 放行 `mrotto://auth-callback`
- **Studio 只绑 localhost**,要用走 SSH 隧道,不出公网
- 数据库建 `public.profiles` 表(`id` 外键 `auth.users.id`、`display_name`、
  `avatar_url`),**RLS 开启**:用户只能读写自己那行。这是下期同步的地基

## 客户端侧(Otto app)

- **动线**:设置页「账号」区 →「用 Google / GitHub 登录」→ 弹**系统浏览器**
  (不用内嵌 WebView:浏览器已有登录态,且 Google 封杀内嵌登录)→ GoTrue 授权
  完成跳 `mrotto://auth-callback?code=...` → macOS 唤起 Otto → 主进程 **PKCE**
  换会话
- **`@supabase/supabase-js` 只装主进程**:换码、token 自动刷新
- **token 存储**:access/refresh token 落 `userData/auth.json`(0600),与 keyVault
  同款待遇;**永不回流渲染层**
- **ShellBridge 新增**:`getAccount(): { signedIn, email, name, avatarUrl }`、
  `signIn(provider)`、`signOut()`,外加登录状态变化推送(渲染层只见 profile,
  与"API Key 只回布尔"同一条纪律)
- **深链**:`app.setAsDefaultProtocolClient("mrotto")` + macOS `open-url` 事件

## 与事件日志的边界

登录是 **app 级状态,不是会话事件**:模型看不到你是谁,不落 SessionEvent,
不碰 deriveMessages,schema 零改动。"model-visible means logged" 的逆命题:
非 model-visible 就不进日志。

## 安全条款

- Google/GitHub client secret 只存服务器 `.env`,永不进 git、不发聊天
- Supabase anon key 打包进客户端是设计如此(只配合 RLS 使用);service_role key
  绝不离开服务器
- refresh token = 长期登录凭证,只存主进程可读的 0600 文件
- 云端存 API Key 的加密方案 = 下期设计的必答题,本期不碰

## 测试

- 主进程单测(vitest):PKCE 回调 URL 解析、token 存取(注入 fs,复用 keyVault
  测法)、深链参数解析
- 服务器:部署后 `curl https://otto-auth.stan.damianslife.com/auth/v1/health`
- 端到端:真人各点一遍 Google / GitHub 登录 + 登出 + 重启后仍登录

## 用户侧杂务(需本人账号,agent 不代办)

1. Google Cloud Console 建 OAuth client(Web application),回调
   `https://otto-auth.stan.damianslife.com/auth/v1/callback`,得 client ID + secret
2. GitHub Developer settings 建 OAuth App,回调同上,得 client ID + secret
3. 两组凭证 SSH 直接粘进服务器 env 文件(路径和格式由 agent 备好),不发聊天

## 已否决的备选

- **复用 dryrun 的 Supabase**:auth.users 实例级共享,两项目用户混表,拆不开
- **Cloudflare Workers/自建 VPS 手写 OAuth**:三家 provider 各写一遍,慢
- **本机回环端口回调**(代替深链):可行但浏览器留尾巴页、端口占用要处理
- **sslip.io/nip.io**:不在 PSL,Let's Encrypt 配额全球共享,签证书碰运气
- **无域名邪道**(Google 原生 PKCE + signInWithIdToken):GitHub 不发 id_token,
  绕不过服务器回调,复杂度反而翻倍
