# MCP OAuth 授权 + agent 自助配置 MCP

- 日期：2026-08-26
- 状态：设计已确认，待实现
- 相关：ADR-0049（MCP 进入范围）、ADR-0050（MCP 骑在 world 接缝上）、ADR-0054（子 agent 的 MCP 工具靠白名单点名）、ADR-0041（授权记忆与 hunk 级审批）、ADR-0044（key 遮罩过桥）

## 一、问题

托管版 MCP server（`mcp.supabase.com` 是眼下撞上的那个）默认走 OAuth。本仓的 MCP 客户端只支持静态 header（`src/main/mcpClient.ts:101`），于是裸 URL 必定 401，UI 上显示一行红字 `需要授权`，而这行红字后面**没有任何可点的东西**——用户唯一的出路是自己去服务商后台建 PAT、复制、回来手填一行 header。这把凭据的保管责任推给了用户，而且 PAT 会过期、不能撤销单个客户端、明文躺在 `~/.mr-otto/mcp.json` 里。

第二个问题是配置本身的门槛：用户要接一台 server，得知道 URL 或 npm 包名、知道要填哪些参数、知道认证方式。这些信息 agent 比用户更容易拿到。

本设计解决两件事：

1. **OAuth**：`needs-auth` 的 server 旁边给一颗「授权」按钮，点了开浏览器，回来就绿。
2. **agent 自助配置**：用户在对话里说「帮我接上 supabase」，agent 查目录、提议配置、过审批门落盘、拉起授权、当场就能用新工具。

## 二、既有底子

不是从零开始。已经在的：

| 已有 | 位置 |
|---|---|
| 0600 凭据落点的口径 | `src/main/keyVault.ts` |
| `McpAuthRequiredError` → `needs-auth` 状态 | `src/main/mcpClient.ts:20` / `mcpHub.ts:203` |
| `needs-auth` 状态灯与错误行 | `src/renderer/src/components/McpSettings.tsx:60,445` |
| 工具审批门 `requiresApproval` | `src/tools/tool.ts` |
| 遮罩往返合并（防星号覆盖真凭据） | `src/main/mcpHub.ts` `mergeMaskedCreds` |

缺的是「授权」这个动作本身、token 的存放处、agent 侧的把手，以及一条会话内的工具表热更新路径。

## 三、决策与理由

### 3.1 agent 配 MCP 走审批门

**决定**：agent 调 `mcp_configure` 工具，`requiresApproval: true`，审批卡片展示完整的 `command` / `args` / `url` / `headers` 明细（值遮罩、键名保留），用户点同意才落盘。

**理由**：stdio 类型的 server 配置就是 `command + args + env`——agent 能自由写盘，等于绕开了 `bash` 工具的审批门拿到任意命令执行，还附带任意环境变量。这不是「MCP 功能的一个选项」，是权限系统上的一个洞。

**被否掉的**：
- *http 自由 / stdio 必审*：风险面确实小一档，但用户要理解「为什么有的问有的不问」，规则复杂度换来的顺畅有限。
- *全自由，只记事件日志*：事后可见不等于可控，落盘那一刻已经跑完了。
- *agent 只能改已存在的 server*：接不住「帮我接上 supabase」这句话，等于没做。

**推翻它的前提**：如果将来 stdio server 一律跑在 bot 自己的容器里（v2 Docker，ADR-0050 提到的方向），「任意命令执行」的爆炸半径缩到容器内，那时可以重新评估 http/stdio 分档。

### 3.2 OAuth 回调走 loopback 临时端口

**决定**：授权时在 `127.0.0.1:0`（系统分配随机端口）起一个一次性 http server，`redirect_uri = http://127.0.0.1:<port>/callback`，收到一次请求后立刻关闭；60 秒无人到访自杀。

**理由**：RFC 8252 的标准做法，Claude Code / Cursor 走的都是这条。动态客户端注册（DCR）时服务端对 `http://127.0.0.1` 的 redirect_uri 几乎都接受。

**被否掉的**：
- *`mrotto://` 深链*：基础设施现成（`deepLink.ts`），不用起本地端口。但部分 OAuth 服务端拒绝非 http 的 `redirect_uri`——可能在 Supabase 这第一个用例上就撞墙，而这正是本设计的触发场景。
- *loopback 为主、深链兜底*：两套路径都要写要测，复杂度翻倍，换来的是一个尚未观测到的故障模式（端口起不来）的兜底。等真撞上再补。

### 3.3 token 存独立文件

**决定**：`~/.mr-otto/mcp-auth.json`，0600，与 `mcp.json` 平级。结构按 server id 分组，存 DCR 拿到的 client 信息（`client_id` / `client_secret`）、`access_token` / `refresh_token` / 过期时间、以及 PKCE 的 `code_verifier`。

> 2026-08-26 订正：本句原本还列了「授权服务器元数据缓存」一项，那是写在「以为要自己实现 OAuth 协议」的阶段。§4 后来订正为「不自己实现 OAuth 协议」——元数据发现归 SDK，`OAuthClientProvider` 上的 `saveDiscoveryState` / `discoveryState` 是可选成员，本仓不实现，元数据每次连接由 SDK 自己重新发现、不落盘。这句字段清单当时漏改，实现（`McpAuthRecord`）始终只有上面三项。详见 ADR-0112。

**理由**：`mcp.json` 有两条性质决定了 token 不能进去——它要保持与 Claude Code 的 `.mcp.json` 格式兼容（用户能把已有配置直接粘过来，反过来也一样），而且用户会手编它。OAuth token 会被程序定期刷新重写，把「程序拥有的、频繁变动的状态」和「用户拥有的、手写的配置」混在一个文件里，两边都会出问题。

**被否掉的**：
- *safeStorage 加密*：安全性更高（macOS 走钥匙串），但与现有 `keys.json` 两套口径，且加密块不可读不可排查。要改就该连 `keys.json` 一起改，那是另一个决策，不搭在这次。

### 3.4 LoopEngine 工具表按 turn 重算

**决定**：`LoopEngineOptions.tools` 从 `Tool[]` 放宽成 `Tool[] | (() => Tool[])`，**每个 turn 开始时重算一次，turn 内冻结**。

**理由**：`engine.ts:115-128` 把 `toolsByName` 折在构造那一刻，`createMcpTools` 也是装配时快照（`agent.ts:480`）。所以 agent 配完、连上，**本会话它自己用不了那批新工具**——这正好毁掉「在聊天里配」想要的那种顺畅。

turn 内必须冻结：模型看到的声明表和 dispatch 时查的 `toolsByName` 必须是同一份。若 turn 中途换表，模型按旧表发出的调用会在新表里查不到，收到「未知工具」——这是 `mcpTool.ts` 顶部注释已经明确要避免的那类失败。

**顺带修好的存量问题**：会话中途 MCP server 重连或新增，当前会话一直看不见。这不是新功能的副产品，是现在就存在的缺陷。

**被否掉的**：
- *告诉用户下个会话生效*：改动最小，但把「配好了」和「能用了」拆成两步，用户得自己记住去重开会话。
- *逐会话重装配 engine*：不动 engine 内部，但「什么时候重装配」（turn 中途？）和状态交接是新的一类 bug 源，比改 engine 内部更难测。

### 3.5 内置小目录 + 搜索兜底

**决定**：仓内维护 `src/shared/mcpCatalog.ts`，十几条常见 server（supabase / github / notion / linear / sentry / …），每条含 URL 或 npm 包名、必填参数、认证方式。做成 `mcp_catalog` 工具给 agent 查；不在单上的走 `web_search`。

**理由**：目录会过时，但它覆盖绝大多数请求且结果确定。纯靠搜索每次多花几秒且可能拿到错 URL——虽然有审批门兜底，但让用户在审批卡片上判断一个 URL 对不对，是把认知负担还给了用户。

## 四、模块划分

有一条既有不变量约束了切法：`tests/architecture.test.ts:90` 钉死 **只有 `src/main/mcpClient.ts` 能 import `@modelcontextprotocol/sdk`**（ADR-0050）。OAuth 要用 SDK 的 `OAuthClientProvider` 接口，新建一个 import SDK 的文件会直接撞红这条断言。

另一个事实决定了要写多少代码：**SDK 1.30.0 的 `StreamableHTTPClientTransport` 已经接受 `authProvider`**，授权服务器元数据发现、动态客户端注册、PKCE、code 换 token、401 时用 refresh_token 续期——这几件事 SDK 全做了。我们要供的只有两样：一个把凭据存到磁盘的 `OAuthClientProvider` 实现，和一个能收回调 code 的 loopback 服务器。**不自己实现 OAuth 协议**。

因此切成三层：

```
src/main/mcpAuthStore.ts  ~/.mr-otto/mcp-auth.json 读写，0600，抄 keyVault 口径。
                          按 server id 分组存 client 信息 / tokens / code_verifier。
                          纯存储，零 SDK import，纯函数可单测
src/main/mcpOAuth.ts      loopback 回调服务器（node:http）+ 开浏览器。
                          零 SDK import；起端口/收一次/校验 state/超时自杀 全在这
src/main/mcpClient.ts     +createOAuthProvider(): 把上面两个包成 SDK 的
                          OAuthClientProvider，塞进 StreamableHTTPClientTransport；
                          +authorizeMcpServer(): 编排一次完整授权
src/shared/mcpCatalog.ts  常见 server 目录（纯数据 + 纯函数）
src/tools/mcpCatalog.ts   查目录
src/tools/mcpConfigure.ts 增/改/删 server（过审批门）
src/tools/mcpAuthorize.ts 拉起授权
```

SDK 类型（`OAuthTokens` / `OAuthClientInformation`）只出现在 `mcpClient.ts` 里；`mcpAuthStore.ts` 用自己的等价形状（都是普通 JSON 对象，适配就是一处结构性赋值），这样架构断言不破、存储层也能脱离 SDK 单测。

工具层照旧只依赖 `ExecutionWorld` / `McpCapability`（硬规则）。`mcp_configure` / `mcp_authorize` 需要的是「写配置」和「发起授权」两个新能力，加在 `McpCapability` 接口上，由 `mcpHub` 实现、`index.ts` 用 `withMcp` 注入——与既有的 `callTool` / `readResource` 同一条路，工具层依然不知道 hub 和 SDK 的存在。

## 五、数据流

### 5.1 授权

```
连接失败 → McpAuthRequiredError → hub 标 needs-auth（现状已有）
  ↓
hub.authorize(id)
  ├─ 起 loopback 127.0.0.1:0 /callback，一次性，5 分钟超时自杀
  │   （人要在浏览器里登录 + 点同意，60s 不够）
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

`state` 的校验必须由我们做：SDK 的 `finishAuth(code)` 只收 code，不验 state。provider 的 `state()` 生成的那串同时交给 loopback，回调里对不上就拒。

### 5.2 agent 自助配置

```
用户：「帮我接上 supabase」
  ↓
agent 调 mcp_catalog("supabase") → 拿到 URL 模板与必填参数
  ↓
（参数缺失时）agent 调 ask_user 问 project_ref 之类
  ↓
agent 调 mcp_configure({ id, kind:"http", url, headers:{} })
  ↓ requiresApproval：审批卡片列出完整 url / headers 键名
用户点同意 → 落盘 mcp.json → hub 尝试连接 → needs-auth
  ↓
agent 调 mcp_authorize("supabase") → 浏览器弹出 → 用户点同意 → 连上
  ↓
hub.onChange → 下一个 turn 工具表重算 → 新工具进入模型可见表
  ↓
agent：「接好了，现在能查你的表结构了」
```

## 六、UI

`McpSettings.tsx:445` 那条错误行旁边加一颗「授权」按钮，`needs-auth` 时出现，点击调 `hub.authorize(id)`，期间按钮转成 loading，成功后状态灯自己变绿（走既有的 `onChange` 推送）。

审批卡片（`approvalPreview.ts`）为 `mcp_configure` 加一种预览：
- stdio：逐行列出 `command`、每一条 `arg`、`env` 的**键名**（值遮罩）
- http：`url` 全文、`headers` 键名（值遮罩）
- 删除：列出被删的是哪台、它当前有几把工具

这张卡片是这条路上唯一的安全闸。卡片含糊 = 闸形同虚设，所以明细必须逐字段列，不能折成一句「配置一台 MCP server」。

## 七、安全与不变量

- **token 不进事件日志**。事件日志不可删，进去 = 永久泄漏（同 `keyVault.ts` 顶部的三条不变量）。
- **token 不过 `ShellBridge` 回渲染层**。渲染层只能问「这台授权了没」，拿不到 token 本身。
- **`mcp-auth.json` 0600**，与 `keys.json` / `mcp.json` 同档。
- **`state` 参数必须校验**，不匹配立即拒绝并关端口——这是 loopback 回调唯一的防伪造闸。
- **loopback 只收一次请求**，收完立刻 `close()`，不留一个长期监听的本地端口。
- **子 agent 默认拿不到这三把刀**（ADR-0054 白名单点名制，不点名即无）。派活给子 agent 时不该顺带给出改系统配置的能力。
- `mcp_authorize` **不设审批门**：它必然弹出浏览器、用户必须亲手在服务商页面点同意——人天然在环里，再加一道门是重复劳动而非安全增益。

## 八、测试

测试统一放 `tests/`，镜像 `src/` 结构。

| 文件 | 钉住什么 |
|---|---|
| `tests/main/mcpOAuth.test.ts` | `state` 不匹配必须拒绝；loopback 只接受一次请求；超时后端口关闭；回调带 `error=access_denied` 时给人话而不是干等 |
| `tests/main/mcpAuthStore.test.ts` | 文件 0600；刷新覆盖旧 token；坏 JSON 当「还没授权过」而不是抛错；清除只清一台不误伤同伴 |
| `tests/main/mcpOAuthProvider.test.ts` | provider 的读写往返（client 信息 / tokens / verifier）；`redirectUrl` 跟着 loopback 走 |
| `tests/tools/mcpConfigure.test.ts` | `requiresApproval: true` 钉死（回归闸）；参数校验；审批预览包含 command 全文与 env 键名 |
| `tests/tools/mcpCatalog.test.ts` | 查得到 / 查不到时的返回形状 |
| `tests/loop/engine.test.ts` | turn 之间工具表会变；turn 之内不变；`deferredExposed` 集合跨轮存活；传数组的老调用方行为不变 |
| `tests/architecture.test.ts` | 现有断言自动看住新模块（SDK 仍只在 `mcpClient.ts`） |

E2E（`tests/e2e/`，不在门禁里）：假 OAuth 服务端 + 假模型，跑一遍「agent 配置 → 审批 → 授权 → 用新工具」的完整链路。

## 九、已知限制

- **手机远程审批场景下无法完成授权**（ADR-0096）：`mcp_authorize` 弹的是桌面浏览器，手机端点不了。本次不解决，记为限制。
- **目录会过时**：`mcpCatalog.ts` 是手工维护的快照，不在单上的 server 靠 `web_search` 兜底。
- **不做 OAuth 的 server 不受影响**：静态 header 那条路原样保留，不是替换关系。

## 十、协议动作

- 3 份 ADR：OAuth 授权（回调通道 + token 存储）/ agent 自助配置的权限边界 / LoopEngine 工具表按 turn 重算
- 1 个 Task issue + branch PR，PR 合并时关闭 issue
- 在 worktree 里做（主目录另有并行 agent）
