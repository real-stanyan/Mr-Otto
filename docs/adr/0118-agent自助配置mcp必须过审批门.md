# ADR-0118：agent 自助配置 MCP 的权限边界——必过审批门，卡片必须逐字段

> 原为 ADR-0113。合并前 origin/main 上另一条车道先落了 0113 这个号，按项目 ADR-0074 在本 PR 内顺延改号；照旧号来的引用按这行解析。

日期：2026-08-26
状态：已接受
相关：设计文档 `docs/superpowers/specs/2026-08-26-mcp-oauth-agent-config-design.md`（§3.1 / §6 / §7）、ADR-0117（OAuth 授权）、ADR-0119（工具表按 turn 重算）、ADR-0054（子 agent 的 MCP 工具靠白名单点名）、ADR-0041（授权记忆与 hunk 级审批）

## 背景

接一台 MCP server 的门槛在用户这边：得知道 URL 或 npm 包名、知道要填哪些参数、知道认证方式。这些信息 **agent 比用户更容易拿到**。想要的形态是用户在对话里说「帮我接上 supabase」，agent 查目录、提议配置、落盘、拉起授权、当场就能用新工具。

但「agent 能写配置」这件事本身是个权限问题，不是一个功能选项。

## 决定

### 一、`mcp_configure` 必须过审批门

agent 调 `mcp_configure` 工具，`requiresApproval: true`（`src/tools/mcpConfigure.ts`），审批卡片展示完整的 `command` / `args` / `url` / `headers` 明细（值遮罩、键名保留），用户点同意才落盘。

**理由**：stdio 类型的 server 配置就是 `command + args + env`——agent 能自由写盘，等于**绕开了 `bash` 工具的审批门拿到任意命令执行**，还附带任意环境变量。这不是「MCP 功能的一个选项」，是权限系统上的一个洞。

**被否掉的路**：

- **http 自由 / stdio 必审**：风险面确实小一档，但用户要理解「为什么有的问有的不问」，规则复杂度换来的顺畅有限。
- **全自由，只记事件日志**：事后可见不等于可控，落盘那一刻已经跑完了。
- **agent 只能改已存在的 server**：接不住「帮我接上 supabase」这句话，等于没做。

**推翻它的前提**：如果将来 stdio server 一律跑在 bot 自己的容器里（v2 Docker，ADR-0050 提到的方向），「任意命令执行」的爆炸半径缩到容器内，那时可以重新评估 http/stdio 分档。

### 二、卡片必须逐字段，不能折成一句话

审批预览（`src/main/approvalPreview.ts`）为 `mcp_configure` 加一种预览：

- **stdio**：逐行列出 `command`、每一条 `arg`、`env` 的**键名**（值遮罩）
- **http**：`url` 全文、`headers` 键名（值遮罩）
- **删除**：列出被删的是哪台、它当前有几把工具

这张卡片是这条路上**唯一的安全闸**。卡片含糊 = 闸形同虚设，所以明细必须逐字段列。

### 三、内置小目录 + 搜索兜底

仓内维护 `src/shared/mcpCatalog.ts`，十几条常见 server（supabase / github / notion / linear / sentry / …），每条含 URL 或 npm 包名、必填参数、认证方式。做成 `mcp_catalog` 工具给 agent 查；不在单上的走 `web_search`。

**理由**：目录会过时，但它覆盖绝大多数请求且结果确定。纯靠搜索每次多花几秒且可能拿到错 URL——虽然有审批门兜底，但**让用户在审批卡片上判断一个 URL 对不对，是把认知负担还给了用户**。

**推翻它的前提**：目录的维护成本超过它省下的搜索次数（比如 server 生态变动太快，半数条目常年是错的），那就该退回纯搜索。

### 四、完整的配置流

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
hub.onChange → 下一个 turn 工具表重算（ADR-0119）→ 新工具进入模型可见表
  ↓
agent：「接好了，现在能查你的表结构了」
```

工具层照旧只依赖 `ExecutionWorld` / `McpCapability`（硬规则）：`mcp_configure` / `mcp_authorize` 需要的是「写配置」和「发起授权」两个新能力，加在 `McpCapability` 接口上，由 `mcpHub` 实现、`index.ts` 用 `withMcp` 注入——与既有的 `callTool` / `readResource` 同一条路，工具层依然不知道 hub 和 SDK 的存在。

## 实施过程中发现的漏洞——「卡片含糊 = 闸形同虚设」的实证

这一节不是补充说明，它是上面第二条论断的证据，值得原样留着。

`mcp_configure` 最初校验 url 用 `new URL(url).protocol`，**但存盘的和上审批卡的是模型给的原始字符串**。

WHATWG 的 URL 解析在解析前会剥掉所有 ASCII tab / LF / CR。于是：

```
"https://good.com" + "\n".repeat(30) + "@evil.com/mcp"
```

解析出的 host 是 **`evil.com`**。而审批卡片第一行显示的是 `https://good.com`，恶意那一半被三十个换行推到滚动框的折叠线以下。**用户是在给一个他没读到的主机签字。**

修法三件套（`src/shared/mcp.ts` 的 `normalizeMcpHttpUrl`）：

1. **拒绝含控制字符的 url**——合法的 MCP 端点不会有 tab / 换行。刻意选「拒绝」而不是「静默吃掉后再归一化」：静默归一化会把「模型/用户的错误输入」伪装成「系统悄悄接受了一次改写」。
2. **存盘存归一化后的 `parsed.href`**，不是原始串。
3. **预览与配置共用同一个函数**——`approvalPreview.ts` 的 `mcp_configure` 分支和 `mcpConfigure.ts` 调的是同一个 `normalizeMcpHttpUrl`。

第三条是这个洞真正的教训所在：**卡片显示的值必须与实际写盘的值是同一个字符串，不存在「原始串」和「解析后」两种读法的空间。** 一道闸只要显示的和执行的能分叉，它就不是闸。

（顺带：`normalizeMcpHttpUrl` 也只认 `http:` / `https:`——`file://` / `data:` 之类在这里没有任何正当用途，而它们能让一次「配置 MCP」变成读本地文件的惊喜面。）

## 后果

- **子 agent 默认拿不到这三把刀**（`mcp_catalog` / `mcp_configure` / `mcp_authorize`）。ADR-0054 的白名单点名制，不点名即无——派活给子 agent 时不该顺带给出改系统配置的能力。
- `mcp_authorize` **不设审批门**（理由见 ADR-0117 第六条：人天然在环里）。
- **目录会过时**：`mcpCatalog.ts` 是手工维护的快照，不在单上的 server 靠 `web_search` 兜底。
- 审批门是**这条路上唯一的闸**这件事，本身就是脆弱点：任何绕过审批的机制（bypass 模式、钩子改参、未来的批量授权）落到 `mcp_configure` 上都要单独想一遍，不能默认它跟别的工具一档。
