# MCP 连接器目录页 —— 仓内精选 + 公开注册表长尾

- 日期：2026-08-28
- 状态：设计已确认，待实现
- 相关：issue #661、ADR-0049（MCP 进入范围）、ADR-0050（MCP 骑在 world 接缝上）、ADR-0118（agent 自助配置 MCP 必须过审批门）、ADR-0121（MCP OAuth 回调走 loopback，凭据存独立文件）

## 一、问题

用户想接一台 MCP server，眼下只有两条路：在设置页的「新建 MCP server」对话框里手打 URL 或命令，或者在对话里跟水獭说「帮我接上 supabase」让它查 `mcp_catalog`。

两条路都要求用户**先知道有这么一台 server 存在**。没有一个「翻一翻有什么能接」的地方。

具体的缺口三条：

1. `MCP_CATALOG` 那 9 条只被 `src/tools/mcpCatalog.ts` 消费，renderer 里零引用——它是给水獭看的，不是给人看的
2. `CatalogEntry` 没有图标字段，卡片网格画不出来
3. 9 条手写清单撑不起一个搜索框

本设计做一张可浏览、可搜索、点一下就装上的连接器目录页，并给它接一个撑得起搜索的数据源。

## 二、既有底子

不是从零开始。已经在的：

| 已有 | 位置 |
|---|---|
| stdio + Streamable HTTP 两种传输 | `src/main/mcpClient.ts:124` |
| OAuth 授权（loopback 回调） | `src/main/mcpOAuth.ts` |
| 0600 凭据落点 | `src/main/mcpAuthStore.ts` |
| 9 条手写配置模板 + `searchCatalog` | `src/shared/mcpCatalog.ts` |
| 已装 server 的表格、状态灯、编辑态、授权按钮 | `src/renderer/src/components/McpSettings.tsx` |
| 参数表单的纯逻辑 | `src/renderer/src/lib/mcpForm.ts` |
| agent 自助配置 + 审批门 | `src/tools/mcpConfigure.ts`（ADR-0118） |

缺的是目录页本身、注册表数据源、两者之间的映射层，以及 `world.http` 上的一个 GET。

## 三、验过的前提

以下不是推测，是 2026-08-28 对 `registry.modelcontextprotocol.io` 打真请求得到的结果。写下来是为了让下一班不用重验，也为了让前提失效时能被认出来。

| 前提 | 验法 | 结果 |
|---|---|---|
| 注册表活着 | `GET /v0/servers` | 200 |
| 服务端搜索可用 | `GET /v0/servers?search=notion&limit=3` | 返相关结果 |
| 条目字段 | 扫 100 条的 key 并集 | `$schema` `name` `title` `description` `version` `remotes[]` `packages[]` `repository` `websiteUrl` `icons` `_meta` |
| 远程条目的凭据模板 | `remotes[].headers[]` | 带 `name` / `value`（形如 `Bearer {smithery_api_key}`）/ `isRequired` / `isSecret` / `description` |
| 本地条目的启动方式 | `packages[]` | `registryType`(npm/pypi/oci) / `identifier` / `version` / `runtimeHint`(npx/uvx) / `environmentVariables` / `transport` |
| **图标基本没有** | 扫 100 条 | **7 / 100 有 `icons`** |
| 同一 server 多版本重复 | 首页两条都是 `ac.inference.sh/mcp`，1.0.0 与 1.0.1 | 需按 `_meta["io.modelcontextprotocol.registry/official"].isLatest` 过滤 |
| 翻页是游标不是 offset | `metadata.nextCursor` | 是 |
| **全量拉不动** | 循环翻页 `limit=100` | 两分钟没到底 |
| **注册表是开放投稿的** | 搜 `notion` | 头两条 `ai.smithery/smithery-notion`、`com.mcparmory/notion`，都是中间商包装，不是 Notion 官方那台 |
| `world.http` 没有 GET | 读 `src/world/executionWorld.ts:261` | 只有 `postJson` |

另外一条口径上的事实：截图里 Claude 那个「Show all 2232」是 Anthropic 自家人工策展的目录，**没有公开接口**，Otto 拿不到。本设计接的是 MCP 协议官方的公开注册表，两者不是一回事。

## 四、决策与理由

### 4.1 分两层，信任边界画在层之间

**决定**：

| | 精选层 | 长尾层 |
|---|---|---|
| 来源 | `src/shared/mcpCatalog.ts` 仓内常量 | `registry.modelcontextprotocol.io` |
| 何时出现 | 面板一打开，零网络 | 用户敲字才拉 |
| 核验 | 人工过目，进过 PR review | 无 |
| UI | 带「已核验」角标 | 分隔线以下，标「来自公开注册表，未经核验」 |

精选层从 9 条扩到约 20 条，补齐 Notion / Linear / Figma / Slack / filesystem / playwright 这类常用的。

**理由**：注册表开放投稿，搜一个知名服务返回的头几条往往是中间商包装（三、验过的前提最后一行）。把它直接当目录首屏，等于把「哪台是官方的」这个判断推给用户。而首屏本来也不能用注册表——它按字母序返回，第一条是 `ac.inference.sh`，没有任何排名信号。所以首屏只能是自己策展的那份，长尾只在用户明确搜索时才出现，并且明确标注未核验。

**被否掉的**：
- *只做精选层，不接注册表*：搜索框后面没东西，用户搜不到的一律回到「跟水獭说」，那就没解决问题。
- *只做注册表，废掉精选*：首屏无从排序，且把中间商条目摆在官方条目前面。
- *把注册表结果按某种启发式重排（名字像官方的排前）*：猜测发布者身份是一件会猜错的事，猜错的代价是用户装上一台假冒的 server。宁可不排，明说未核验。

**推翻它的前提**：如果注册表将来引入了可信的官方认证标记（类似截图里那个小勾徽章），且该标记可从 API 读到，那么「未经核验」这条分隔线可以改成按标记分组，精选层的存在意义随之下降。

### 4.2 搜索走 live query，不做本地全量同步

**决定**：用户在搜索框敲字，主进程 debounce 250ms 后打 `GET /v0/servers?search=&limit=50`，结果直接画出来。不落盘、不做全量同步、不做过期刷新逻辑。

**理由**：全量同步在成本一侧已经被验掉了——翻页两分钟没到底（三、验过的前提）。而它换来的两样好处都不成立：「离线可浏览」对一个装上也要联网才能用的东西没有价值；「搜索即时」的代价是引入一套「什么时候算陈旧、什么时候重抄」的逻辑，这是本设计里唯一会自己长出维护成本的部分。

**被否掉的**：
- *首次全量同步到本地*：见上。
- *构建期打快照塞进安装包*：内容冻结在发版那一刻，新 server 要等 Otto 下一次更新；且 2000+ 条进安装包。
- *渲染进程直连注册表*：违反 ShellBridge 硬规则，不予考虑。

**推翻它的前提**：如果注册表提供了增量接口（`?since=`）或者一个可直接下载的全量 dump，全量同步的成本项就消失了，届时值得重新评估。

### 4.3 stdio 条目一键装要弹确认卡

**决定**：从**长尾层**点 `+` 装一台 stdio server，落盘前弹一张确认卡，正文直说「这会从 npm/PyPI 下载 `<包名>` 并在你的电脑上运行它」，附发布者与仓库链接。精选层的 stdio 不弹（已人工核过）。

**理由**：`packages[]` 条目装上意味着 Otto 会 `npx <identifier>` / `uvx <identifier>`，从公共包仓库下载并在用户本机执行任意代码。注册表开放投稿，所以这等于一键运行一个陌生人发布的包。用户在「新建 MCP server」对话框里手打命令也是执行任意代码，但那是用户自己敲进去的——从搜索结果里点一下不是一回事，点击的人未必知道自己触发了什么。

这道确认与 ADR-0118 的审批门是**两回事**，各管一侧：审批门管的是水獭替用户做决定，这张确认卡管的是用户在信息不足时替自己做决定。

**被否掉的**：
- *只给 remote 条目一键装，stdio 只显示配置让用户自己粘*：最保守，但把 filesystem / playwright / git 这批最有用的本地 server 全挡在外面。
- *两种都装，不额外确认*：摩擦最小，但把「从陌生人的包里跑代码」降成了一次无语境点击。

**推翻它的前提**：如果 stdio server 一律跑进 bot 自己的容器（v2 Docker，ADR-0050 提到的方向），爆炸半径缩到容器内，这张确认卡可以降级为一行说明。

### 4.4 图标一律不外链

**决定**：渲染进程不出现 `<img src="<远程 URL>">`，一张远程图片都不加载。**长尾层一律首字母色块**；**精选层用打进包的本地 SVG**（`src/renderer/src/assets/mcp/<key>.svg`），`CatalogEntry.icon` 存的是**资源键，不是 URL**。

**理由**：让渲染进程直接加载注册表条目里的任意 URL，等于每翻一次目录就把用户 IP 交给一批陌生服务器，且这批 URL 由投稿者自由填写。

本节曾写成「有 `icons` 的由主进程代下」，写实现计划时改掉了：只有 7/100 的注册表条目有图标，为这 7% 造一条下载 + 缓存 + 失败兜底的链路不划算，而首字母色块本来就要写（93% 的条目走的就是它）。砍掉代理这一层，安全边界也从「代理后可控」收紧成「压根不出网」。精选层只有约 20 条，图标打进包即可。

**被否掉的**：
- *直接 `<img src>`*：见上。
- *主进程代下远程图标*：见上，为 7% 造一个子系统。
- *完全不显示图标，全用色块*：更省事，但精选层那 20 条是有官方图标的，卡片认知效率差很多。

### 4.5 `world.http` 开一个 `getJson`

**决定**：在 `src/world/executionWorld.ts:261` 的 `http` 接缝上加 **`getJson?(url, opts)`——可选字段**，`src/world/localWorld.ts:180` 实现，`withAbortSignal`（`:317`）条件透传（`withExecOutput` 的 `:366` 是整对象透传，不用改）。

**为什么可选**：仓里有 35 处测试假 world 写着 `http: { postJson: async () => ({}) }`，做成必填会让它们全红，而那些红跟网络能力毫无关系。仓内已立先例——`execDetached?` / `openTerminal?` / `browser?` / `simulator?` 都是可选，注释原文是「可选 = 向后兼容（假 world 零改动）」。缺席的语义是「这个世界不提供 GET」，调用方据此退回 web_search；v2 Docker 世界若要断网，不实现即可。

**理由**：4.6 让 `mcp_catalog` 工具查注册表，而工具只能依赖 `ExecutionWorld`（硬规则，`tests/architecture.test.ts` 第 1 条）。现有接缝只有 `postJson`，注册表是 GET。这是 ADR-0050「MCP 骑在 world 接缝上」的正常延伸——把新能力加到缝上，而不是在工具里绕过缝。

**被否掉的**：
- *在工具里直接 `fetch`*：违反硬规则，且 `src/tools/` 目前零处 `fetch(`，破例的成本是把这条干净的边界弄脏。
- *用 `postJson` 打 GET 接口*：注册表不接受 POST。

### 4.6 agent 侧回退到注册表，而不是回退到 web_search

**决定**：`src/tools/mcpCatalog.ts` 的 `run()`：精选层没命中 → 打注册表 → 渲染成同样的文本块，尾巴加一句「来自公开注册表，未经核验，装之前跟用户确认发布者」。工具仍免审批（只读）；装依旧过 `mcp_configure` 的审批门。

**理由**：现在的回退话术是「查不到再用 web_search」，而 `src/shared/mcpCatalog.ts` 的文件头自己写了这个取舍的代价——web_search「每次多花几秒、还可能拿到错 URL」，且「让用户在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户」。注册表返回的是结构化配置，比从网页里读出来的 URL 准。这是对既有取舍的改进，不是新增一条路。

**被否掉的**：
- *不接，注册表只给 UI*：水獭发现不了面板之外的 server，「帮我接上 X」这句话的覆盖面不变。
- *单开一个 `mcp_registry_search` 工具*：工具表多一条，且水獭得自己选先调哪个——而正确顺序是固定的（精选优先），固定的顺序应该写在代码里而不是交给模型判断。

## 五、模块与数据流

```
用户敲字
  └─ McpDirectory.tsx  ──ShellBridge──▶  main/mcpRegistry.ts
                                            │  GET /v0/servers?search=
                                            ▼
                                        shared/mcpRegistry.ts（纯映射）
                                            │  RegistryServer[] → CatalogEntry[]
                                            ▼
                        UI 卡片 ◀───────────┴──────────▶ tools/mcpCatalog.ts
                                                          （经 world.http.getJson）
```

**`src/shared/mcpRegistry.ts`（纯逻辑，可测，不碰 node builtin）**

映射规则：

```
过滤  _meta["io.modelcontextprotocol.registry/official"].isLatest === true
去重  按 name 保留一条
remotes[0].type === "streamable-http"  → transport: "http", url
  headers[] 中 isRequired 的            → params（isSecret 的标出来）
否则 packages[0]                        → transport: "stdio"
  runtimeHint(npx/uvx) + identifier      → command / args
  environmentVariables 中 isRequired 的   → params
两者皆无                                 → 丢弃该条
```

`CatalogEntry` 剩下三个字段的取法：

- **`id`**（建议的 server id）：注册表的 `name` 形如 `ai.smithery/smithery-notion`，含点和斜杠，不是合法 id。取最后一段做 slug，用既有的 `mcpServerIdError`（`src/renderer/src/lib/mcpForm.ts`）校验，撞已存在的 id 就补数字后缀。用户可改。
- **`auth`**：有 `isSecret` 的 header 或环境变量 → `"token"`；两者皆无 → `"none"`。**不猜 `"oauth"`**——注册表没有这个字段，猜错的代价是 UI 上出现一颗点了没用的授权按钮。真需要 OAuth 的 server 连上会 401，现有的 `needs-auth` 状态与授权按钮（ADR-0121）会接住，这条路已经通了。
- **`authNote`**：拼 header / 环境变量的 `description`；都没有就写「这台 server 来自公开注册表，配置未经核验」。

输出复用既有的 `CatalogEntry` 形状。下游（UI / `mcp_catalog` / `mcp_configure`）吃同一个形状。两个新字段的落点不一样：

- **`icon?: string` 加在 `CatalogEntry` 上**，值是打进包的资源键（4.4），可选，现有 9 条字面量不受影响。
- **`verified` 不加在 `CatalogEntry` 上**，而是 UI 层的包装类型 `DirectoryItem { entry; verified; installed }`。核验与否是**来路**的性质，不是条目自身的属性——同一份配置从精选层拿是核过的，从注册表拿就不是。放在包装上，`MCP_CATALOG` 那批字面量一个字都不用改。

`src/shared` 不碰 node builtin（`tests/architecture.test.ts` 第 5 条，手机端 import 同一份源码）。

**`src/main/mcpRegistry.ts`（唯一打注册表的地方）**

`searchRegistry(query, signal): Promise<CatalogEntry[]>`。debounce 在渲染进程侧做（250ms），`AbortSignal` 接上——用户继续打字就掐掉上一条在途请求。不落盘。

**`src/renderer/src/components/McpDirectory.tsx`**

挂在 `McpSettings` 上方；下面保留现有的已装列表。发现在上，管理在下，不新开视图。

- 空 query：精选网格
- 有 query：精选里模糊匹配的排前，注册表结果排后，中间一条分隔线注明未核验
- 卡片：图标 / 名字 / 一句话 / 右侧 `+` 或 ✓（已装的走现有 `McpServerRow` 编辑态）
- 点 `+`：无参数的 http 直接落盘并触发 `authorizeMcpServer`；有参数的走小表单（复用 `mcpForm.ts`）；长尾层的 stdio 先弹 4.3 的确认卡

## 六、测试

- `tests/shared/mcpRegistry.test.ts` —— 映射纯逻辑。样本是仓内一份**真实的注册表响应 JSON**（含多版本重复、缺 `icons`、`remotes` 与 `packages` 两种形态、以及一条两者皆无的），断言过滤、去重、映射结果。不打网。
- `tests/shared/mcpCatalog.test.ts` —— 扩到新增的精选条目（既有用例已断言字段与占位符自洽）。
- 真打注册表的那一层不进门禁：它依赖外部网络，红了不代表本仓坏了。与 `services/edge/checks/relay.mjs` 同一个口径。

## 七、拆分与顺序

串行 4 个 PR，每个自带测试、单独绿门禁：

1. **映射层** —— `src/shared/mcpRegistry.ts` + 真实 JSON 样本 + 测试。纯逻辑，无 UI 无网络。
2. **世界接缝** —— `world.http.getJson` 接口 + `localWorld` 实现 + 两处透传。
3. **目录页 UI** —— `McpDirectory.tsx` + `main/mcpRegistry.ts` + ShellBridge 方法 + 精选层扩到 ~20 条（含图标）。
4. **agent 侧** —— `tools/mcpCatalog.ts` 回退注册表。

ADR 编号在合并前认领（项目 ADR-0074：撞号时改成 `max + 1` 并加 `原为 ADR-00XX` 行）；当前 `docs/adr/` 最大号是 0161。一条 ADR 覆盖 4.1 至 4.6，`world.http.getJson` 在同一条里带过。

## 八、不做的

- 不做本地全量同步、不做离线目录（4.2）
- 不做「热门度 / 下载量」排序——注册表不提供这个信号，自己编一个等于猜
- 不做分类筛选（截图里那个 `Filter: All`）——精选层 20 条不需要筛，长尾层有搜索框
- 不碰已装 server 的管理界面，`McpServerRow` 原样保留
- 不做 Anthropic 那份 2232 条目录的抓取——没有公开接口
