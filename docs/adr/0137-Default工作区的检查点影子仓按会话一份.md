# 0137 Default 工作区的检查点影子仓按会话一份

日期：2026-08-26 ｜ 状态：已定 ｜ 关联：#573、#559、ADR-0090（影子 git）、ADR-0135

## 背景

检查点影子仓按 workspace 一份（`workspaceStoreName`）。Default 工作区（#559）被
所有「任务」会话共写：A 会话「回到这一步」`reset --hard` 会把 B 会话的文件一起
回退。项目工作区理论上同病，但 Default 的并发概率高得多——它是所有零决策任务
的落点。

## 决定

- **Default 工作区：影子仓按会话一份**（`sessionCheckpointStoreName(workspace, sessionId)`
  = `<workspace哈希>-<sessionId>`）。B 在 A 快照之后新建的文件在 A 的仓里是
  untracked，`reset --hard` 天然不碰——A 回退不再吞 B 的新产出。
- **项目工作区维持共享一份**：大仓按会话复制血亏（blob 不共享），且同一工程多
  会话回退同一份磁盘现实是可理解的 git 语义。
- `createAgent` 的 `checkpoints` 参数扩为 **值或工厂**：sessionId 在 createAgent
  里才出生，Default 的选址只能在拿到 id 之后做（makeBrowser 同款手法）。resume
  复用同一个 sessionId，恢复后仍指回自己那份仓。
- **删除会话时顺手删它的影子仓**（`rmSync force`）：purge 前从 store 拿 workspace，
  按名字试删——项目会话的共享仓名字里没有 sessionId，不会被误删。

## 残留边界（接受）

- B 对**早已存在的共享文件**的改动仍会被 A 的回退波及（那些文件在 A 的仓里是
  tracked 的）。这一半靠 PACKAGE_NUDGE 的通名警示压概率（别叫 report.md、同名
  先读再写）；根治需要按文件归属会话的写账，成本不匹配当前风险。
- 每会话一份仓 = 同一批文件多份 blob。Default 里都是小文件，接受；删除会话时
  仓一起删，不会无限积累。归档不删仓（归档可恢复，恢复后还要能回退）。

## 被否掉的路

- **回退时按「本会话 turn diff 涉及的路径」过滤**：bash 写的文件无法归属到会话，
  过滤名单天然不全——看着修好了，漏的正是最难查的。
- **全部工作区都按会话拆**：项目大仓的磁盘代价换不来收益（串扰概率低 + git
  用户理解共享语义）。
