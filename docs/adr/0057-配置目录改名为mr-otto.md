# 0057 用户配置目录从 `.otter` 改名为 `.mr-otto`

## 状态

已接受(2026-08-22)。修正 ADR-0007 / 0048 / 0049 里出现的 `~/.otter/…` 路径。

## 背景

产品已改名 Mr Otto(仓库目录沿用 Otter 是有意的,见 AGENTS.md),但用户手编配置
的目录一直叫 `.otter`:`~/.otter/{mcp.json,skills/,agents/}` 和 `<工程>/.otter/agents/`。
设置页、提示文案到处印着旧名,用户看到的是一个已经不存在的产品名。

## 决策

1. 目录名统一为 `.mr-otto`,用户级和工作区级同名。常量只在 `src/main/configDir.ts`
   一处(`CONFIG_DIR`),其它地方不再手写字面量。
2. **整目录改名搬家,不双读**:`configDir(parent)` 在新目录不存在、旧目录存在时
   `rename(.otter → .mr-otto)`。两份并存等于两处真相,以后哪份生效说不清;
   搬家一次性、幂等,搬不动(权限/跨设备)就吞掉留在原地下次再试。
3. 触发点:主进程启动时算 mcp/skill 路径那一刻搬用户级;`listSubagents(workspace)`
   每次扫描前搬用户级 + 当前工作区级(工作区只有打开它时才知道)。
4. Electron 的 `userData`(sessions.db / keys.json / auth.json)不在此列——它早已钉在
   `mr-otto`(index.ts 顶部的 setPath),本 ADR 只管人手编的那一份。
5. `window.otter` 这个 ShellBridge 挂载名**不改**:它是代码 API,用户看不见,改了是
   一次全仓 rename 的噪音,零收益。

## 后果

- 文档/提示里的 `~/.otter/…` 全部改为 `~/.mr-otto/…`。
- 老机器首启后 `~/.otter` 消失、内容原样出现在 `~/.mr-otto`;工作区里的 `.otter/agents`
  在下一次扫描时同样被搬——用户的 git 仓库会因此多一条改名 diff,这是预期内的。
