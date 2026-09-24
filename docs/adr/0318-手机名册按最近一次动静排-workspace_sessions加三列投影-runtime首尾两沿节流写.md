# ADR-0318：手机名册按最近一次动静排——workspace_sessions 加三列投影，runtime 首尾两沿节流写

- 日期：2026-09-24
- 状态：已采纳
- 关联：#1356（A1）；spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §5.2 / §7.1；ADR-0283（participants，同形）；ADR-0317（A0）

## 背景

手机名册把个人主场的智能体与群混在一起、按最近一次动静降序，每一行底下写最后一句（demo 定的，维护者 2026-09-23 逐屏点过）。`workspace_sessions` 没有这一格：`updated_at` 只在插入时写（没有触发器，runtime 的补丁也不带它），按它排就是按创建时间排。权威日志在 VPS 上，手机够不着——要先开一条会话房才读得到 backlog，而名册必须在一条会话都没开时就排得出来。

## 决定

1. `workspace_sessions` 加三列：`last_ts timestamptz`（可空）、`last_excerpt text not null default ''`、`last_from text not null default ''`（`agent:<agentId>` / `human:<uid>`）。migration 0040（编号合并时认领），幂等，**不回填、不加任何 update 策略**（写方只有 runtime 的 service key；给了客户端 update 就是让任何在籍成员伪造「某某刚说了一句」）。
2. **判据是 shared 纯函数** `lastOf`（`src/shared/sessionLast.ts`）：人打的话、agent 的答案、人的群聊发言算；接力 / 招呼开场白（fromUid 是点火的人，不是他此刻说的话）、engine 旁白（后台任务 / 护栏）、要了工具的中间步骤、系统发言不算。摘录 = 第一段非空文字（段的判据与气泡拆段同一条 `splitBubbles`）、折叠空白、≤120 字（按字符数）。
3. runtime 在 `notify` 里逐条推进，**首尾两沿节流**（`services/runtime/src/lastWriter.ts`）：距上一次**写**已满 3 秒就当场写（人刚说完的那句立刻顶上名册），否则只记下最后一句、到窗口末尾再写。窗口从上一次写算起，不从上一次 push 算起——否则一句接一句地说会把尾沿无限往后推。写失败只记一行日志（同 `cloudSessionMeta` 的纪律），下一句盖掉。
4. **读是单独一条容错查询** `fetchCloudLasts`：0040 没跑时 PostgREST 回 42703 → 空 Map，名册退回 `updated_at` → 智能体自己的 `created_at` 排，聊过的那一行第二行写职责（spec §10 第 9 条）。**不并进 `listCloudSessions`**：那条桌面也走，而桌面这一片不读这三列，没必要让它多打一条查询。

## 否决

- **手机开会话房读 backlog 自己算**：名册一墙十几条聊天就是十几条长连接，而名册是最常打开的那一页。
- **给 `updated_at` 挂触发器**：它同时被别的补丁写（标题、参与者），「最近动静」会被一次自动改名顶上去；也拿不到摘录。
- **只写尾沿**：人刚发完一句退回名册，那一行要等 3 秒才顶上去——而那正是人发完之后第一眼看的地方。
- **不节流**：群里接力、人连发几句时一秒几写，写的还是一格马上就会被下一句盖掉的投影。

## 已知代价

- 名册上的「最后一句」最多晚 3 秒（尾沿那一格）；runtime 重启时还在窗口里的那一句丢了（不播种），下一句盖掉。
- 这三列与日志可能短暂不一致（写失败不重试）；它们只用来排序与摘录，点进去看的是日志本身。
- **要先跑 0040、再部署 runtime 才生效**（#791）；部署之前手机名册按创建时间排、第二行写职责、右边不画时间。

## 同一片里的另外几件（不单开 ADR）

- 桌面云会话 store 的两条状态规则（事件按 seq 插位、状态推送哪几格照抄哪几格留着）与两句文案挪进 `src/shared/cloudSessionState.ts`；改 / 删智能体的编排挪进 `src/shared/agentAdmin.ts`。桌面改成调用、行为不变——spec §2「不抄第二份」、§3.2。
- 底部抽屉引入 `react-native-reanimated@4.5.1` / `react-native-gesture-handler@~2.32.0` / `react-native-worklets@0.10.1`（ADR-0293 决定 3；版本取 Expo SDK 57 的 bundledNativeModules，与 Expo Go 自带的原生那一半一致）。
- A1 的聊天页私聊、群聊通用：名册把群一起列出来，点进去先是基础版；群设置、@ 谁、名单变更那一行在 A3。
- 挑头像那面墙十张：cap 只借住在坑 2、没有自己的坑位，存进暂借格的人会在补齐旧 03 那天被悄悄换脸（ADR-0316 法理③）——维护者 2026-09-24 确认。
- 手势那层的两条公式（动量投影 `projectMomentum` / 越界阻尼 `rubberband`）从桌面 `src/renderer/src/lib/spring.ts` 挪进 `src/shared/gestureMath.ts`（桌面 re-export、测试原样搬到 `tests/shared/`），手机底部抽屉用同一份——spec §2「不抄第二份」。计划原稿的往上拉是「线性 0.2 倍再硬顶 24pt」，与它自己那句「越拉越拉不动，不是撞墙」相反；改成 `rubberband(dy, 24, 0.2)`：起手 0.2 倍、永远到不了 24pt。关不关看**落点**（位置 + 动量投影）过四分之一，或往下甩过 900pt/s——拖过一半又往回甩 = 不关（spec §4「带动量」）。
- `mobile/tsconfig.json` 给 `@supabase/supabase-js` 加一条 `paths`，指向**手机自己那份**：mobile/ 与仓库根各装了一份，`SupabaseClient` 带 protected 成员，TS 按「是不是同一处声明」判兼容，把手机建的客户端递给 shared 的函数就报 TS2345。指手机那份的理由是**真正跑的客户端实例在 `mobile/src/supabase.ts` 里建出**、shared 调的是它的方法；**不是** Metro 的解析顺序——Metro 先从发起 import 的文件逐级往上找，`nodeModulesPaths` 只是后备（这一条第一版写错过，提交 9e3a9fee 的信息里那句作废，以配置文件里的注释为准）。src/shared/ 哪天在运行时 import 这个包，这条要重新判。
- 聊天页发送钮的按压反馈照手机端既有惯例（`PRESS_SPRING` 弹簧缩到 0.93、关了动效退成变暗，同 `RoundButton` / `Button`），不是计划原稿的静态缩放——spec §4 沿用 2026-09-11 spec 的「按压反馈」。
