# Mr Otto web search — 设计 v1

日期:2026-08-17　状态:已批准(会话内)

## 目的与范围

给 agent 加联网搜索能力:第四个原生工具 `web_search` + 第五个 `web_extract`,
后端为 anysearch 云 API(https://api.anysearch.com/mcp,JSON-RPC 2.0)。

**明确不做**:
- anysearch 的垂直域搜索(`get_sub_domains`/`sub_domain_params`)、批量搜索(`batch_search`)
- 搜索后端切换 UI(后端可替换性由架构保证,不由配置项保证)
- 装 anysearch-skill 为 otter skill 的路线(已否决,见下)

## 背景事实(已验证)

- anysearch-skill / anysearch-mcp-server 两个仓库都只是客户端,endpoint 硬编码
  云端,搜索后端(爬虫/索引)不开源,**不可自托管**
- 匿名可用(按 IP 低限额);免费邮箱注册发 key(`as_sk_` 前缀)提额;
  有无 key 功能零区别,只差限流
- 协议:POST 单端点,body 为 JSON-RPC 2.0 `{"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"search"|"extract","arguments":{...}}}`;响应取 `result.content[]`
  中 text 项;extract 输出本身就是 markdown,适合直接喂模型

## 架构

### ExecutionWorld 加网络 seam(硬规则合规)

```ts
export interface ExecutionWorld {
  fs: { ... };
  exec(...): Promise<ExecResult>;
  /** JSON POST。v1 LocalWorld 用全局 fetch;v2 Docker 按 bot 走代理/断网 */
  http: {
    postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
  };
}
```

- 工具只碰 `world.http`,不 import fetch——网络成为 capability,v2 可按 bot 隔离
- `withAbortSignal` 装饰器把 signal 一并焊进 http(搜索可中断,语义同 exec:
  中止必须 reject AbortError,不得伪装成请求自身失败)
- `withExecOutput` 不覆盖 http:搜索无直播语义

### 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `web_search` | `query`(必填非空)、`max_results`(可选,默认 5,1-10) | JSON-RPC `search`,content 文本拼接返回 |
| `web_extract` | `url`(必填非空) | JSON-RPC `extract`,返回整页 markdown |

- 两者 `requiresApproval: false`——纯读,与 read_file 同级
- 错误(限流/超时/网络断/响应形状不对)抛 Error,走既有 `status:"error"` 管线,
  模型看到错误文本自行决定重试
- anysearch 只是后端:哪天换 SearXNG/Tavily,改的只是工具内的 endpoint 与 body
  组装,工具名、参数、事件日志、UI 全不动

### API key

- 落点:现有 keyVault(`userData/keys.json`,0600,boot 时 `applyToEnv`),
  条目名 `ANYSEARCH_API_KEY`——机制是通用 name/value,零改动
- 主进程组装工具时读 env:有 key 加 `Authorization: Bearer <key>` 与
  `X-Anysearch-Client` 头,没有匿名裸跑
- key 不进工具参数、不进事件日志、不回流渲染层(渲染层只见布尔)——与模型
  API key 同一条纪律
- KeysPage(模型配置页)加一行「搜索 · AnySearch」,复用现有 key 行组件

### 事件日志

零 schema 变更:`tool_call`/`tool_result` 本来就装任意工具名,纯新增向后兼容。
搜索结果全文落 `tool_result`(model-visible means logged),重放永真。

## 安全条款

- anysearch key 不进 git;本次实施期间 key 曾进入聊天记录(用户粘贴),
  风险低(免费搜索 key、无支付面),在意可去 anysearch 控制台轮换
- 匿名/带 key 均为出站 HTTPS 到固定域名;v2 Docker 化时此出站走 world.http
  seam,可按 bot 管控

## 测试

- 工具单测(vitest,tests/ 镜像结构):假 `world.http`,验参数校验、JSON-RPC
  body 形状、content 拼接、错误穿透、max_results 边界
- LocalWorld.http 单测:注入假 fetch,验 header 组装(有/无 key)、非 2xx 抛错、
  AbortSignal reject
- 不打真 API:限额宝贵,CI 不依赖外网

## 已否决的备选

- **装成 otter skill(零代码)**:SKILL.md 全文注入上下文且永不折叠;每次搜索
  走 bash 审批;依赖 python 脚本环境;UI 无独立工具卡片
- **SearXNG 自托管**:真开源、无限流,但要多维护一台服务 + 自写 extract;
  留作后端替换选项,seam 已为它留好口
- **anysearch-mcp-server**:MVP 明确不做 MCP;且它同样只是云 API 适配器
