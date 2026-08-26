# ADR-0112：MCP 的 OAuth 授权——回调走 loopback 临时端口，凭据存独立文件

日期：2026-08-26
状态：已接受
相关：设计文档 `docs/superpowers/specs/2026-08-26-mcp-oauth-agent-config-design.md`（§3.2 / §3.3 / §4 / §5.1 / §7）、ADR-0049（MCP 进入范围）、ADR-0050（MCP 骑在 world 接缝上、SDK 单点 import）、ADR-0113（agent 自助配置的权限边界）、ADR-0114（工具表按 turn 重算）

## 背景

托管版 MCP server（`mcp.supabase.com` 是眼下撞上的那个）默认走 OAuth。本仓的 MCP 客户端此前只支持静态 header（`src/main/mcpClient.ts`），于是裸 URL 必定 401，UI 上显示一行红字「需要授权」，而这行红字后面**没有任何可点的东西**——用户唯一的出路是自己去服务商后台建 PAT、复制、回来手填一行 header。

这把凭据的保管责任推给了用户，而且 PAT 会过期、不能撤销单个客户端、明文躺在 `~/.mr-otto/mcp.json` 里。

已经在的底子不少：0600 凭据落点的口径（`keyVault.ts`）、`McpAuthRequiredError` → `needs-auth` 状态（`mcpClient.ts` / `mcpHub.ts`）、`needs-auth` 的状态灯与错误行（`McpSettings.tsx`）。缺的是「授权」这个动作本身，和 token 的存放处。

## 决定

### 一、OAuth 协议本身一行都不自己实现

这一条值得单独写在最前面，因为它决定了后面所有决策的尺寸。

**SDK 1.30.0 的 `StreamableHTTPClientTransport` 已经接受 `authProvider`**。授权服务器元数据发现、动态客户端注册（DCR）、PKCE、code 换 token、401 时用 refresh_token 静默续期——这几件事 SDK 全做了。

我们要供的只有两样：

1. 一个把凭据存到磁盘的 `OAuthClientProvider` 实现（「凭据存哪」）
2. 一个能收回调 code 的 loopback 服务器（「怎么开浏览器、code 怎么回来」）

**不自己实现 OAuth 协议。** 每多写一行协议代码，就多一处会与 RFC 或与服务端实现分叉的地方，而这类分叉的症状是「在某一家服务商上莫名其妙不通」——最难查的那种。

一个例外：**`state` 必须我们自己验**。SDK 的 `finishAuth(code)` **只收 code**，不验 state。所以 provider 的 `state()` 生成的那串同时交给 loopback，回调里对不上就拒绝并关端口。这是 loopback 回调唯一的防伪造闸，漏了它整条路就是敞开的。

### 二、回调走 loopback 临时端口

授权时在 `127.0.0.1:0`（系统分配随机端口）起一个一次性 http server，`redirect_uri = http://127.0.0.1:<port>/callback`，收到一次请求后立刻 `close()`；超时自杀。

超时定在 **5 分钟**（`AUTH_TIMEOUT_MS`），不是设计初稿写的 60 秒：人要在浏览器里登录、可能还要选组织、再点同意——一分钟根本不够。

**理由**：RFC 8252 的标准做法，Claude Code / Cursor 走的都是这条。动态客户端注册时服务端对 `http://127.0.0.1` 的 redirect_uri 几乎都接受。

**被否掉的路**：

- **`mrotto://` 深链**：基础设施现成（`deepLink.ts`），不用起本地端口。但部分 OAuth 服务端拒绝非 http 的 `redirect_uri`——可能在 Supabase 这第一个用例上就撞墙，而这正是本设计的触发场景。
- **loopback 为主、深链兜底**：两套路径都要写要测，复杂度翻倍，换来的是一个**尚未观测到**的故障模式（端口起不来）的兜底。等真撞上再补。

**推翻它的前提**：真的观测到「loopback 端口起不来」（企业防火墙 / 极端沙箱环境）的用户报告，那时深链兜底才值那份复杂度。

### 三、token 存独立文件

`~/.mr-otto/mcp-auth.json`，0600，与 `mcp.json` 平级。按 server id 分组，存 DCR 拿到的 client 信息（`client_id` / `client_secret`）、`access_token` / `refresh_token` / 过期时间、以及 `code_verifier`。

**理由**：`mcp.json` 有两条性质决定了 token 不能进去——

1. 它要保持与 Claude Code 的 `.mcp.json` **格式兼容**（用户能把已有配置直接粘过来，反过来也一样）
2. 用户**会手编它**

OAuth token 会被程序定期刷新重写。把「程序拥有的、频繁变动的状态」和「用户拥有的、手写的配置」混在一个文件里，两边都会出问题。

**被否掉的路**：

- **safeStorage 加密**：安全性更高（macOS 走钥匙串），但与现有 `keys.json` 两套口径，且加密块不可读不可排查。要改就该连 `keys.json` 一起改，那是另一个决策，不搭在这次。

**推翻它的前提**：`keys.json` 那一侧先决定改走 safeStorage——两边口径应当同进同退，单独把 `mcp-auth.json` 加密只会制造第三种口径。

### 四、切成三层，SDK 只在一处出现

有一条既有不变量约束了切法：`tests/architecture.test.ts` 钉死**只有 `src/main/mcpClient.ts` 能 import `@modelcontextprotocol/sdk`**（ADR-0050）。OAuth 要用 SDK 的 `OAuthClientProvider` 接口，新建一个 import SDK 的文件会直接撞红这条断言。

所以：

```
src/main/mcpAuthStore.ts  mcp-auth.json 读写，0600，抄 keyVault 口径。
                          纯存储，零 SDK import，纯函数可单测
src/main/mcpOAuth.ts      loopback 回调服务器（node:http）+ 开浏览器。
                          零 SDK import；起端口/收一次/校验 state/超时自杀 全在这
src/main/mcpClient.ts     +createOAuthProvider(): 把上面两个包成 SDK 的
                          OAuthClientProvider，塞进 StreamableHTTPClientTransport；
                          +authorizeMcpServer(): 编排一次完整授权
```

SDK 类型（`OAuthTokens` / `OAuthClientInformation`）只出现在 `mcpClient.ts` 里；`mcpAuthStore.ts` 用自己的等价形状（`Record<string, unknown>`，都是普通 JSON 对象，适配就是 `mcpClient` 里一处结构性赋值）。这样架构断言不破、存储层也能脱离 SDK 单测。

### 五、授权的数据流

```
连接失败 → McpAuthRequiredError → hub 标 needs-auth（现状已有）
  ↓
hub.authorize(id)
  ├─ 起 loopback 127.0.0.1:0 /callback，一次性，5 分钟超时自杀
  ├─ 造 transport（authProvider = createOAuthProvider(store, id, loopback)）
  ├─ client.connect() → SDK 走发现 / DCR / PKCE，调 provider.redirectToAuthorization
  │   → shell.openExternal 开浏览器 → connect 抛 UnauthorizedError（预期内）
  ├─ 等 loopback 收到回调：校验 state（不匹配立即拒绝并关端口），拿 code
  ├─ transport.finishAuth(code) → SDK 换 token → provider.saveTokens 落盘
  └─ hub.reconnect(id)
  ↓
后续每次连接：SDK 从 provider.tokens() 读 token
  过期/401 → SDK 用 refresh_token 静默续 → 续不动才回落 needs-auth
```

一处实现期才浮出来的时序细节：**回调可能早于 `waitForCode` 到达**。真实时序是 `client.connect()` 先开浏览器、抛 `UnauthorizedError`，调用方接住之后才轮到 `waitForCode`——中间这段窗口里用户完全可能已经点完同意了。所以 loopback 里留了一个 `pending` 缓冲；没有它就会丢掉那次回调然后干等到超时，一个只在「用户手速快」时复现的 bug。

### 六、`mcp_authorize` 不设审批门

它必然弹出浏览器、用户必须亲手在服务商页面点同意——**人天然在环里**，再加一道门是重复劳动而非安全增益。（与 ADR-0113 里 `mcp_configure` 必须过门形成对照：那一条人不在环里，所以门是唯一的闸。）

## 后果

### 安全不变量

- **token 不进事件日志**。事件日志不可删，进去 = 永久泄漏（同 `keyVault.ts` 顶部的三条不变量）。
- **token 不过 `ShellBridge` 回渲染层**。渲染层只能问「这台授权了没」，拿不到 token 本身。
- **`mcp-auth.json` 0600**，与 `keys.json` / `mcp.json` 同档。
- **`state` 参数必须校验**，不匹配立即拒绝并关端口。
- **loopback 只收一次请求**，收完立刻 `close()`，不留一个长期监听的本地端口。

### 已知限制

- **手机远程审批场景下无法完成授权**（ADR-0096）：`mcp_authorize` 弹的是桌面浏览器，手机端点不了。本次不解决，记为限制。
- **不做 OAuth 的 server 不受影响**：静态 header 那条路原样保留，不是替换关系。
- 删除一台 server 时顺手清它的凭据——否则 `mcp-auth.json` 会攒下一堆没人认领的 token。
