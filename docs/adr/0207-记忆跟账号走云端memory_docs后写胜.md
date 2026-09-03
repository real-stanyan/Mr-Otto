# 0207 记忆跟账号走：云端 `memory_docs` 表 + 本地缓存，后写胜

日期：2026-09-03 ｜ 状态：已定 ｜ 关联：#852、ADR-0116（推翻其隐含的「记忆在本机」）、ADR-0187（账号抽屉）、ADR-0197（pxEscrowSync 的防抖上传模式）、ADR-0204（主题桶）
spec：docs/superpowers/specs/2026-09-02-topic-memory-design.md §6

## 背景
记忆按账号分抽屉（`~/.mr-otto/accounts/<hash>/memories/`）但只在本机：换电脑登同一个号，记忆是空的。
用户要的是 Claude.ai 那种「记忆跟账号走」。

## 决定
1. **一张表** `memory_docs(uid, key, content, updated_at)`，主键 `(uid, key)`，RLS 只允本人；`key` = `memoryRelPath`
   的相对路径（`memories/USER.md`、`memories/topics/work.md`、`.../work.label`、`memories/projects/<hash16>/MEMORY.md`、
   `.../root.txt`）。migration `supabase/migrations/0019_memory_docs.sql`（issue 里写的 0017 已被订阅制占）。
2. **本地是缓存，后写胜**（`src/shared/memoryReconcile.ts` 的 `planReconcile`）：内容相同不动（时间戳来自两台钟，
   内容才是事实）；只有本地 → 推；只有云端 → 拉；都有且不同 → `updated_at` 新于本地 mtime 则拉，否则推（相等本地胜）。
3. **写路径只有一个口**：`src/main/memoryFiles.ts`（accountConfig 下 `memories/` 前缀的所有读/写/删，写完回调 `onWrite`）
   + `LocalWorld.config.write` 的 `onConfigWrite` 钩子（工具那条路）。两条钩子都汇进 `src/main/memorySync.ts`。
   原本写路径散在四处（memoryEditDeps / 三个设置页 handler 的裸 rm/writeFile / LocalWorld），散着挂就会漏，
   漏一处云端就少一份。`tests/architecture.test.ts` 钉住：碰 memories/ 路径符号的文件不许再 import node:fs。
4. **两个触发点，不轮询**：本地写完 → 防抖 800ms 上传（同 pxEscrowSync）；登录恢复 → 全量对账。
   从云端写本地那一刻 `muted`，否则写本地 → touched → 再推回去是死循环。
5. **离线不阻塞、登出不清**：没登录/断网时 pending 留着、状态 `off`/`error`，会话照常开始（「先落盘再喂模型」的
   节奏不变），回线（下次登录恢复 / retry 30s）补推。登出不清本地抽屉——抽屉本来就按 uid 隔离。
6. **空 = 删**：本地读回空串就 `DELETE` 云端那行——记忆清空了云端不该留一份空的；删桶/删项目档同理。

## 被否掉的路
- CRDT / 三路合并：记忆是策展文本不是账本，两台机同时改同一桶是极少数情形，真丢了 `memory_user_edit` 里有 `before`。
- 每次会话开始先拉云端：断网会卡会话开始，违背「先落盘再喂模型」。
- 把云端当唯一事实、本地不落盘：离线不可用，且 `memory_loaded` 快照要同步读。

## 已知天花板
- 后写胜有损（见上）。
- **项目档实际不跨机**：key 含 `projectMemoryDir(root)` 的路径哈希，换机器路径不同 → 另一台机拉下来的是别的
  hash 目录，本机的项目根解析不到它。解法是 key 换成 remote URL 哈希，那是 ADR-0116 第一条「作用域键」的重审，
  另开 issue。
- 手机端可读同一张表（friendsApi 直连 Supabase 的先例），本轮不做手机端 UI。
- 表未建（migration 没跑）时同步静默失败，状态行显示「同步失败，会自动重试」，本地照常。

## 什么前提垮了要重看
- memories/ 之外出现新的记忆落点 → 架构断言的符号表与 memoryFiles 的围栏一起扩。
- `memoryRelPath` 的形状变了 → 云端旧 key 成孤儿，要写一次 key 迁移。
- 出现第二个写 memories/ 的进程（cloud runtime 也要记忆）→ 「本地是缓存」的前提变成「两个缓存」，后写胜要重估。
