# ADR-0028：profiles 是身份的事实来源，首登引导标记落在库里

日期：2026-08-19
状态：已接受

## 背景

一个人在这个系统里有两份身份数据：

- `auth.users.user_metadata` —— OAuth provider 给的（Google/GitHub 的昵称和头像），
  `account.ts` 的 `toAccountInfo` 把它投影成 `AccountInfo`，侧栏和账号页显示的就是它。
- `public.profiles` —— 好友系统读写的那张表（ADR-0014）。**好友列表、聊天头部、
  牌桌座位牌上显示的都是它**。

这两份数据从来没有被谁裁决过谁说了算，因为在 issue #95 之前，用户根本没有改资料的入口——
两份数据都来自同一次 OAuth，长得一样，冲突从不发生。一旦允许用户自己改，问题立刻是三个：

1. `handle_auth_user_upsert`（0001）里 `avatar_url = excluded.avatar_url` 是无条件覆盖。
   `auth.users` 在每次登录/刷新令牌时都会被 update，触发器随之开火——
   **用户设的头像最多活到下次登录**。同一个函数里 name 早就写成了"本地非空就不覆盖"，
   头像那行只是漏了。
2. 改完名字，好友那边变了，自己界面上没变（自己看的是 `auth.users`）。
   这是最难自证的一类 bug：用户没法验证自己改成功了没有。
3. 判不出"新用户"。触发器用邮箱前缀兜底填 name，所以 `name` 永远非空，
   拿"资料是不是空的"当首登信号一次都不会命中。

## 决定

### 一、profiles 是身份的事实来源，auth.users 只是它的初值

渲染层显示身份一律走 `lib/identity.ts` 的 `displayIdentity(account, profile)`：
profiles 的字段非空就用它，否则退回 `AccountInfo`。

理由：**自己看到的必须和好友看到的是同一个**。既然好友只能看到 profiles，
那 profiles 就是身份，`auth.users` 只是注册那一刻的初值。退回逻辑保留是因为
profiles 是异步拉回来的，冷启动那半秒不该是一张空白的脸。

配套的 migration 0007 把触发器的头像那行改成和 name 同一条规则：
`case when profiles.avatar_url = '' then excluded.avatar_url else profiles.avatar_url end`
—— provider 的值只填空位，不覆盖用户写过的。空位仍然接受（把头像清空之后
下次登录还能捡回 provider 的图），所以这不是"永不更新"。

### 二、首登信号是 `profiles.onboarded_at`，不是本地标记

新增可空列 `onboarded_at`。为空 = 没走过引导；有值 = 走过了。
"完成"和"以后再说"都盖章，Esc/点遮罩/× 都不盖。

- **不用本地文件/localStorage**：换台机器、重装、清缓存都会让引导回来，
  而"欢迎新用户"对一个用了三个月的人来说就是 bug。
- **不用 boolean**：时间戳能回答"什么时候进来的"，布尔只能回答"是不是"，
  前者是后者的超集，存储代价一样。
- **过期/重弹不做**：引导只有一次，不需要状态机。

存量用户在**建列的那一次**统一盖章。这个回填必须和 `add column` 绑在同一个
"列本来不存在"的判断里——写成 `add column if not exists` + `update ... where onboarded_at is null`
的话，重复执行会把此刻正等着看引导的新用户一起盖掉，引导再也不弹。

### 三、头像存 data URL，不建对象存储

用户选的图在渲染层裁成 256×256、编成 webp（Safari 退回 jpeg）、存进
`profiles.avatar_url` 这个 text 列，硬顶 128KB（`shared/profile.ts` 的 `AVATAR_MAX_CHARS`，
主进程校验、渲染层压缩共用同一个常量）。

理由：这套 Supabase 是自托管的，Storage 没配，而且没有 VPS 访问权（同 #77 的处境）。
data URL 意味着零新基建。代价是头像跟着好友列表和每条邀请一起被查出来——
好友量级两位数时可以接受；真要长起来，第一步是把头像挪出好友列表的 select，
按需单独取。

准入只放行 `https://` 和 `data:image/(png|jpeg|webp|gif);base64,`。
这个串最终会变成渲染层的 `<img src>`，`javascript:` 之类必须在进库前就挡住。

整条链全在渲染层：`<input type="file">` / `FileReader` / `canvas` 都是 Web API，
不是 Node API，没有碰"渲染进程不许直接摸 Node"那条硬规则。

### 四、引导弹窗可以关，关掉不算走完

Esc / 点遮罩 / 右上角 × 都能关，且**不盖章**——下次登录还会被问一次。

理由：关不掉的模态是一种收费站。用户可能只是想先进去看看这软件是干嘛的，
再决定要不要认真起个名字。"以后再说"和"直接关掉"的区别只在于前者表达了
"别再问我"，所以只有它盖章。

### 五、profiles 没有推送频道

`myProfile` / `updateProfile` 是纯请求-应答。主进程不会背着渲染层动这张表——
它只被用户自己在这台机器上改，回值即新状态。登录时由 `onAccountChanged`
触发一次补拉，冷启动时由 `boot()` 补拉（`onAccountChanged` 只在登录态**变化**时开火，
而冷启动恢复出来的登录是一次性读到的，少了这句重启后会一直用着 provider 的旧名字）。

## 后果

- 用户改名/换头像后，自己界面和好友界面是同一份数据，不再需要"重启看看"。
- 头像不再被登录覆盖。这条是 0007 的 check 里唯一的回归断言。
- 引导只弹给真正的新用户，且只弹一次，跨设备一致。
- migration 0007 需要手动执行（`supabase/README.md`）。执行前：
  `onboarded_at` 列不存在 → 读资料报错 → 身份退回 `AccountInfo`（就是改动前的行为），
  引导不弹、改资料报错，其余功能不受影响。
- 头像的 128KB 硬顶写在 `shared/profile.ts`：渲染层拿它当压缩目标，主进程拿它当准入线。
  两个数字各写各的话，会出现"压出来的图正好过不了自己的校验"。
