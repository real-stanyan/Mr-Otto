# 0008. ExecutionWorld 网络 seam 与可替换搜索后端

日期:2026-08-17　状态:已接受

## 背景

web_search/web_extract 需要出站 HTTP。硬规则:工具只依赖 ExecutionWorld,
不得直接触碰 Node API——网络若绕过 seam,v2 Docker 化时无法按 bot 管控出站。

## 决定

1. ExecutionWorld 加 `http.postJson(url, body, { headers?, signal? })`:
   工具的全部网络面。LocalWorld 用全局 fetch + 30s 超时;withAbortSignal
   一并焊 signal(中断语义对齐 exec,ADR-0006:外力中断必须 reject,
   不伪装成请求自身失败)。
2. 搜索后端 = anysearch 云 API(JSON-RPC,不可自托管,两个官方仓库均为
   客户端)。协议细节收在 src/tools/anysearch.ts 一个文件——换
   SearXNG/Tavily 只改它,工具名/参数/事件日志/UI 不动。
3. key 经 keyVault(ANYSEARCH_API_KEY)注入工厂闭包,不进工具参数:
   参数落事件日志,日志不可删,key 进去 = 永久泄漏。匿名可用(低限额)。

## 否决

- postJson 泛化成完整 HTTP client(method/stream):YAGNI,当前唯一
  消费者是 JSON-RPC,面越小 v2 越好管。
- 装 anysearch-skill 为 otter skill:SKILL.md 常驻上下文、每次搜索过
  bash 审批、依赖 python 环境(spec「已否决的备选」)。

## 代价

- 匿名限额未知,撞墙表现为工具报错,模型可见可重试;换 key/换后端均不动上层。
- http seam 出现让「工具能碰的世界」多了一维,v2 SandboxWorld 必须实现它
  (断网 bot = postJson 直接 reject)。
