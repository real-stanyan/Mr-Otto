# MCP：接外部工具服务器

日期：2026-08-21　　架构决定见 `docs/adr/0047-mcp-进入范围.md`、`docs/adr/0048-mcp-骑在-world-接缝上.md`

## 目标

Otto 能连 MCP（Model Context Protocol）服务器，把外部 server 提供的 **tools /
resources / prompts** 三样东西接进来：tools 变成模型能调的刀，resources 变成模型
能读的料，prompts 变成能插进输入框的模板。用户在设置页里增删改 server，看得见谁连上了、
谁在等授权、谁挂了。

## 范围声明的变更

`AGENTS.md` 开头原文写着「明确不做：多 agent 编排、MCP、插件系统」。本设计把 MCP 这一项
从「不做」挪进范围。这是 **L1 协议改动**，走 issue + ADR + PR，合并前需要 `stanyan`
在 PR 评论里明确同意（ADR-0006 / ADR-0034）。

「不做插件系统」这一条**原样成立**：MCP server 是跨进程的外部程序，通过标准协议对话，
不向 Otto 进程里注入任何代码。这与 skill（纯提示词注入，ADR-0007）是同一种克制的两种形态 ——
可执行扩展面在进程外，不在进程内。

## 不做（本版边界）

- **resources 自动注入上下文**。resource 只能由模型主动读（工具调用），不做"连上就把
  server 的资源塞进 system prompt"。理由见 §五。
- **sampling**（server 反过来请求 Otto 调模型）。MCP 协议里有，本版不实现——它把
  server 变成了会花你钱的一方，授权模型要单独设计。
- **roots**（把工作区目录告诉 server）。下一版再说。
- **server 的进程管理面板**（重启/看日志/改 env 后热重载）。本版只有连/断。
- **per-会话启用哪几个 server**。全局一份清单，全会话共用（§二）。
- **OAuth 完整流程**。`needs-auth` 状态和 Authorize 按钮先画出来，点击行为本版只支持
  「打开浏览器让你去授权，然后把 token 粘回来」这条土路。

---

## 一、接缝：MCP 是一种 World 能力

硬规则：**工具实现只依赖 `ExecutionWorld` 接口，禁止直接 import fs / child_process**。
stdio 传输要 spawn 子进程，所以 MCP 客户端不能住在工具层。

照 `browser`（ADR-0035）/ `openTerminal`（ADR-0031）/ `http`（ADR-0008）已经走过三遍的
同一条路：**MCP 是 `ExecutionWorld` 上的一个可选能力**。

```ts
// src/world/executionWorld.ts

export interface McpToolInfo {
  /** server 自报的原始工具名（未加前缀） */
  name: string;
  description: string;
  /** JSON Schema，原样透给模型 */
  inputSchema: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments: readonly { name: string; description?: string; required?: boolean }[];
}

export type McpStatus = "connecting" | "connected" | "needs-auth" | "failed";

/** 一台**配置过**的 server 及其能力。三个 list 是快照，不是订阅——
    server 发 list_changed 通知时由 hub 重新拉，工具层永远只看到当下这份。
    没连上时三个 list 是空的，`live` 为 false —— 工具层靠 live 决定
    `Tool.available()`（见 §四第 3 点：挂载一次定终身，可用与否是活的） */
export interface McpServerHandle {
  id: string;
  name: string;
  status: McpStatus;
  /** status === "connected" 的糖。工具层只关心这一个布尔 */
  live: boolean;
  tools: readonly McpToolInfo[];
  resources: readonly McpResourceInfo[];
  prompts: readonly McpPromptInfo[];
}

export interface McpCapability {
  /** 把所有 enabled 的 server 连一遍，全部落定（connected / needs-auth / failed）后 resolve。
      幂等：已经连上的不重连。agent.ts 拼工具表之前 await 它（§三、§四第 3 点） */
  ready(): Promise<void>;
  /** 全部**配置过**的 server，连没连上都在。
      挂载需要全集（工具表一次拼好），可用性由每台的 live 决定 */
  servers(): readonly McpServerHandle[];
  callTool(serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  getPrompt(serverId: string, name: string, args: Record<string, string>): Promise<string>;
}

export interface ExecutionWorld {
  // ...既有字段
  /** 可选：这个世界能不能连 MCP server。
      与 browser 同一种注入方向——LocalWorld 造不出 hub（它要管进程生命周期、
      要向渲染层推状态），由 index.ts 用 withMcp 焊进来。
      v2 SandboxWorld 把 stdio server spawn 进容器，这一层接口一字不改。 */
  mcp?: McpCapability;
}

export function withMcp(world: ExecutionWorld, mcp: McpCapability): ExecutionWorld {
  return { ...world, mcp };
}
```

**必须同时改的两处**：`withAbortSignal` 和 `withExecOutput` 是逐字段枚举重建 world 的
（不是 spread），新增 `mcp` 字段必须在这两个装饰器里补上透传，否则包一层就把 MCP 能力
弄丢了。`withAbortSignal` 还要把 signal 绑进 `callTool` / `readResource`。

### `McpContent`

MCP 的返回是一个 content 数组（text / image / resource 三种）。定义在
`src/shared/mcp.ts`（渲染层也要认它）：

```ts
export type McpContent =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "resource"; uri: string; text?: string; mimeType?: string };
```

工具层负责把它压成喂给模型的字符串；image 那一支走已有的 `ImageDescribed` 那条路
（视觉桥 `visionBridge.ts`），本版先只取 text，image/resource 折成一行说明。

---

## 二、配置：`~/.otter/mcp.json`

一份全局清单，全会话共用。格式与 Claude Code 的 `.mcp.json` 兼容（同名字段同语义），
这样用户能直接把已有配置粘过来。

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- 有 `command` = stdio；有 `url` = Streamable HTTP。两者都有 = 报错，不猜。
- `enabled: false` 可关掉某台而不删配置。
- 解析是纯函数 + fs 接口注入（抄 `skills.ts` 的 `SkillDirReader` 形状），测试喂假实现。
- **每次开设置页现读磁盘**，无缓存：配置是用户随时手改的外部文件。
- 写回时保留未知字段（用户可能手写了本版不认识的键，不能替他删）。

### key 不落日志

`env` / `headers` 里是凭据。走已有的 key 遮罩过桥（ADR-0044）：渲染层只拿得到
`ghp_a1b2*****f9e0` 这种遮罩串，真值只在主进程。设置页显示遮罩，编辑时留空 = 不改。

---

## 三、连接生命周期：`src/main/mcpHub.ts`

对照 `browserHub.ts` / `terminalHub.ts`。**`@modelcontextprotocol/sdk` 只允许这个文件
import**，别处一律拿 `McpCapability` 接口——依赖树上多一棵树是有成本的，把它锁在一个
文件里，将来换实现只动这一处。

| 状态 | 含义 | UI |
|---|---|---|
| `connecting` | 正在起进程 / 握手 | 灰点脉冲 |
| `connected` | `initialize` 完成，三个 list 已拉到 | 绿点 |
| `needs-auth` | HTTP server 返回 401 | 黄点 + Authorize 钮 |
| `failed` | 起不来 / 握手失败 / 中途崩了 | 红点 + 错误文本 |

- **应用启动时不连，会话装配时连**。`agent.ts` 拼工具表之前 `await hub.ready()`，
  hub 把所有 `enabled` 的 server 连一遍（并发，各自超时 10s，连不上的标 `failed` 继续）。
  理由：冷启动不该被 5 个 `npx` 拖住，但工具表是一次性拼好的（§四第 3 点），
  拼的时候必须已经知道每台提供了什么。用户打开设置页也触发同一个 `ready()`。
- stdio server 崩了：不自动重启（重启一个自己会崩的进程只是把问题变成噪音），标 `failed`，
  用户在设置页手点重连。
- server 发 `notifications/tools/list_changed` → hub 重拉那台的 list → 推给渲染层。
- 应用退出时 `close()` 所有 client，stdio 子进程跟着走。

---

## 四、tools 怎么进 agent

一台 server 的每个 tool 包成一个 `Tool`（`src/tools/mcpTool.ts`）：

```ts
export function createMcpTools(mcp: McpCapability): Tool[] {
  return mcp.servers().flatMap((s) =>
    s.tools.map((t) => ({
      def: {
        name: `mcp__${s.name}__${t.name}`,
        description: t.description,
        parameters: t.inputSchema,
      },
      requiresApproval: true,
      available: () => mcp.servers().some((x) => x.id === s.id && x.live),
      async run(args, world, ctx) {
        const content = await world.mcp!.callTool(s.id, t.name, args, ctx?.signal);
        return renderMcpContent(content);
      },
    }))
  );
}
```

三点：

1. **名字加前缀 `mcp__<server>__<tool>`**，与 Claude Code 一致。避开与内置工具撞名
   （某台 server 完全可能提供一个叫 `bash` 的工具）。
2. **`available()` 而不是不挂载**。`engine.ts:208` 已经是这个语义：`available()` 为 false
   的工具不进声明表，但留在 `toolsByName` 里。
3. **装配时机**。`agent.ts` 里 `tools` 数组是一次性拼好的（`agent.ts:277`），
   这是本仓已有的"挂载一次定终身"语义（`tool.ts:19` 那段注释）。所以装配前必须
   `await hub.ready()`（§三），让每台 server 的工具清单都已到手，再一次性挂全。

   由此而来的两个限制，本版接受，写进设置页的提示文案：
   - **新增/删除 server 要重开会话才生效**。已开的会话工具表不变。
   - **装配时连不上的 server，它的工具这一整个会话都不存在**（没有清单就无从挂起）。
     后来连上了也不会凭空出现——`available()` 管的是"挂着的刀能不能用"，不是"凭空长刀"。

   会话中途 server 掉线则相反：工具还挂着，`available()` 转 false，从模型看到的声明表里
   消失；掉线前已发出的那次调用仍能收到一句人话的报错。

`agent.ts` 的改动是两处：拼表前先等，然后一行展开。

```ts
if (world.mcp) await world.mcp.ready();
// ...
const tools: Tool[] = [
  // ...既有
  ...(world.mcp ? createMcpTools(world.mcp) : []),
];
```

---

## 五、resources：模型主动读，不自动注入

新增一把内置工具 `mcp_read_resource`（不加 server 前缀——它是 Otto 自己的刀）：

```
mcp_read_resource(server: string, uri: string) -> string
```

server 的 resource 清单**进工具描述**（`description` 里列出来），模型据此知道有什么可读。
清单很长时截断并说明截断了。

**为什么不自动注入**：自动注入会造出一份模型看得见、却不在事件日志里的内容，
直接撞硬规则「append-only 事件日志是唯一事实来源；先落盘再喂模型」。要合规就得为
"注入了哪些 resource" 造一个新 SessionEvent，并保证重放时能拿回**当时那一版**的
resource 内容（server 上的文件早变了）——代价远大于收益。走工具调用则天然合规：
读取动作就是一次 `ToolExecutionStarted` + `ToolResult`，内容原样落盘，重放拿到的是
当时读到的那一份。

---

## 六、prompts：走输入框，不走 skill 注入

原设计说"prompts 复用 skill 注入面（ADR-0007）"。改掉：MCP prompt 带**参数**
（`arguments: [{name, required}]`），skill 是无参数的纯文本包，硬塞进去会丢掉参数这一层。

改成：**prompts 进 composer 的斜杠命令面**。用户敲 `/`，MCP prompt 和内置命令一起出现；
选中一个带参数的 prompt，先填参数再展开成文本落进输入框。

- 展开后的文本就是普通用户消息，进 `UserMessage` 事件，重放零特殊化。
- 不新增事件类型。

UI 用 `prompt-library` 元素（§八）。

---

## 七、审批与事件

### 审批

- 所有 MCP 工具 `requiresApproval: true`。server 是外部代码，`readOnlyHint` 是它自报的，
  不采信（与浏览器不采信页面自报 URL 是同一个判断）。
- 复用 ADR-0041 的授权记忆，grant scope 按完整工具名 `mcp__github__create_pr` 记。
  这样"永久允许读 issue"不会顺带允许"建 PR"。
- 审批卡预览（`approvalPreview.ts` 加一支）：server 名 + 工具名 + 参数 JSON。
  参数里疑似凭据的字段（key/token/secret/password）显示遮罩。

### 事件

**不新增 SessionEvent。** MCP 工具调用就是普通的 `ToolExecutionStarted` + `ToolResult`，
schema 一字不动，旧日志照样重放。

代价说清楚：重放一段用了 MCP 的老会话时，日志里只有工具名和结果，没有"当时连的是哪台
server 的哪个版本"。接受——工具名里已经带了 server 名，够定位；把 server 版本也钉进日志
是可观测性诉求，不是重放正确性诉求。

---

## 八、UI：assistant-ui elements 映射

仓里 `src/renderer/src/components/elements/` 已经贴了 31 个 element，MCP 要用的一半已在。

### 要装的（2 个）

`components.json` 里注册表别名已配好（`@assistant-ui` → `https://r.assistant-ui.com/{name}.json`）：

```bash
npx shadcn@latest add @assistant-ui/elements-mcp-server-panel @assistant-ui/elements-prompt-library
```

贴完手改两处（与仓里已有那 31 个同样的改法）：上游 `from "./surfaces"` → `@/lib/surfaces.js`；
import 补 `.js` 后缀。

| 元素 | 上游 API | 用在哪 |
|---|---|---|
| `mcp-server-panel` | `McpServerPanel({ servers, expandedId, onToggle, onAuthorize })`；`McpServer = { id, name, transport, status, tools[] }`；status 四态 `connected \| connecting \| needs-auth \| failed` | 设置页 MCP 栏目的主体。`transport` 字段正好是 `stdio` / `streamable-http`；`needs-auth` 自带 Authorize 钮 |
| `prompt-library` | `SavedPrompt = { id, name, body, variables[] }` | composer 里选 MCP prompt、填参数（§六）。`variables` 对上 MCP 的 `arguments` |

### 已有、直接复用（6 个）

| 元素 | 用在哪 |
|---|---|
| `elicitation-form` | **MCP elicitation** —— server 调到一半问用户要字段。props 里的 `server` 参数本来就是为它留的。当前被 ask_user 占着，加一个调用方即可 |
| `permission-grant` | MCP 工具审批。本仓已改造过（`actions` 整排替换，带拒绝理由 + 只批一次） |
| `tool-error` | server 掉线 / 调用失败，带 attempt 计数与 retry |
| `spec-sheet` | 展开的 server 详情：transport / command / protocol version / env 键名 |
| `data-table` | 该 server 的 tools 与 resources 清单 |
| `tool-group` | 多个 MCP 调用并发时折成一行（上游 #32 Parallel tools） |

### 不装

`connection-state` / `quota-banner` / `agent-card` / `settings-panel` / `file-tree` ——
功能与 `mcp-server-panel` + `spec-sheet` 重叠。连接状态并进 server-panel 的状态灯。

### 设置页

`SettingsSection` 加 `"mcp"` 一档（与 `account` / `keys` / `appearance` / `skills` 并列）。

> **与并行工作的协调**：另一条 lane 正在给 `store.ts` / `App.tsx` 加 `"agents"` 档
> （Subagent 栏目）。这两处改的是同一行 union 类型和同一个 switch。MCP 这条 lane
> **等 Subagent 的 PR 合进 main 之后再动这两个文件**，避免在 PR 里手工解冲突。

---

## 九、ShellBridge 面

渲染进程只通过 `ShellBridge` 与后端通信（硬规则）。新增：

```ts
listMcpServers(): Promise<McpServerStatus[]>;   // 含遮罩后的 env/headers
saveMcpServer(id: string, cfg: McpServerConfig): Promise<McpServerStatus[]>;
removeMcpServer(id: string): Promise<McpServerStatus[]>;
connectMcpServer(id: string): Promise<McpServerStatus[]>;   // 手动重连
listMcpPrompts(): Promise<McpPromptInfo[]>;                 // composer 的斜杠面用
expandMcpPrompt(serverId: string, name: string, args: Record<string,string>): Promise<string>;
onMcpStatusChanged(cb: (s: McpServerStatus[]) => void): () => void;   // hub 推
```

三个写操作都返回全量刷新后的清单——存完立刻拿到最新镜像，不用再补一次 refresh
（照 subagent 那条 lane 的做法）。

---

## 十、测试

统一放 `tests/`，镜像 `src/` 结构（ADR-0016）。

| 文件 | 测什么 |
|---|---|
| `tests/main/mcpConfig.test.ts` | 解析 / 写回 / 未知字段保留 / stdio 与 http 二选一的报错 / 遮罩 |
| `tests/tools/mcpTool.test.ts` | 前缀命名、`available()` 随 server 增删、content 压成字符串、signal 透传 |
| `tests/world/executionWorld.test.ts` | `withAbortSignal` / `withExecOutput` 透传 `mcp`（回归：这两个装饰器是枚举式重建） |
| `tests/main/mcpHub.test.ts` | 状态机四态迁移；`list_changed` 重拉；退出时全部 close。SDK 以假 transport 注入 |
| `tests/tools/mcpReadResource.test.ts` | 清单进 description、截断说明、未知 uri 报错 |

`mcpHub` 的测试不起真进程：SDK 的 `Client` 接一个内存 transport。

---

## 十一、协议动作

按 ADR-0006 / ADR-0012，本设计触及两处 L1 内容，全部走 issue + ADR + PR：

1. **Protocol gap issue**：范围声明从「不做 MCP」改为「做 MCP client」
2. `docs/adr/0047-mcp-进入范围.md`：为什么改，边界在哪，「不做插件系统」为何仍成立
3. `docs/adr/0048-mcp-骑在-world-接缝上.md`：对照 ADR-0008 / 0031 / 0035 —— 同一句话的第四次复述
4. PR 改 `AGENTS.md` 两处：
   - 开头的范围声明
   - Tech stack 加 `@modelcontextprotocol/sdk`

   **两处都是 L1，合并前需要 `stanyan` 在 PR 评论里写明同意。**

> **ADR 编号在合并时认领，不在开分支时认领**（ADR-0048 并行 lane 条款）。0046 已被
> Subagent 那条 lane 占用（未合并）。合并前重新 fetch：若有别的协议 PR 先落地，
> 在本 PR 内重编号。

---

## 实施顺序

分成能各自过门禁的几段，每段一个 Task issue：

1. `mcpConfig.ts` + 测试（纯函数，无依赖，先落）
2. `McpCapability` 接口 + 两个装饰器透传 + 回归测试
3. `mcpHub.ts` + SDK 依赖 + 测试（假 transport）
4. `mcpTool.ts` + `agent.ts` 挂载 + 测试
5. `mcp_read_resource` 工具
6. ShellBridge 面 + 设置页 MCP 栏目（**等 Subagent PR 合入后**）
7. prompts 进 composer 斜杠面
8. 审批预览 + 凭据遮罩

1–5 是后端，可以在 Subagent 那条 lane 还没合的时候并行推进——它们碰的文件完全不重叠。
