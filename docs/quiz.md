# 理解题存档（待一起复盘）

> 教学课程的理解题集中放这，攒够了一起看。答完一题就把它移到底部"已答"区。

## 待答

### 1. 审批模式与日志（审批课遗留）
`approvalMode`（ask/auto）现在是运行时偏好,不落日志。如果哪天决定"审批模式切换也要留痕",该加什么事件?`deriveMessages` 要不要理它——为什么?

### 2. 投影参数与精确重放（压缩课遗留）
`DEFAULT_COMPRESSION` 的值(keepRecentTurns: 2 等)住在代码里。今天改了这些值,昨天的会话重放时模型视野就和当时不一样了。要做到"精确重放当时模型看到了什么",这组参数得搬进哪里?代价是什么?

### 3. 标题子查询的位置无关性（第十二课）
`sessions()` 里 workspace 子查询敢写死 `seq = 0`(session_created 位置不变量),标题子查询却用 type 过滤 + ORDER BY。如果有人把标题子查询"优化"成 `seq = 1`,什么情况下会坏?

### 4. compact 的思考该不该落盘(第十四课)
compact 也是一次真实模型调用——开着 thinking 时,摘要那次调用同样会回 `reasoning_content`,而现在 `context_compacted` 事件没存它,直接扔了。这和"模型产出的新信息必须落盘"矛盾吗?想想 summary 和 reasoning 在 compact 语义里的地位差别,说说你会不会给 `context_compacted` 也加 reasoning 字段。

## 已答

### /rename 幽灵会话守卫（第十三课）
问:删掉 rename handler 里 `store.load(sessionId).length === 0` 守卫,对不存在的 sessionId 执行 /rename 会怎样?
答:`session_renamed` 照样落盘,该"会话"日志里只有这一条、没有 seq 0 的 session_created。`sessions()` 把它投影成 workspace 为 null 的幽灵会话——有标题、没围栏、没内容。守卫防的不是崩溃,是防投影层长出无中生有的会话:垃圾进日志,垃圾永久进投影。

### resolve-denied vs reject-AbortError（第十课）
问:中断时审批门为什么 resolve 成 denied 而不是 reject AbortError?
答:走既有 denied 管线会落 approval_decision + tool_result(denied),无悬空调用;reject 会跳过 onDecision、造悬空调用、把 ADR-0005 自愈层当地板用。审批门上的中断是"答案已知的决定",是数据不是异常;模型调用那条线上没有可落盘的事实,所以那里才用 reject。
