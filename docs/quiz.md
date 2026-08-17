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

### 5. diff 预览的时间锚点（第十五课）
审批卡弹出和预览构造之间有异步间隙——`world.fs.read` 完成之前文件可能被别的东西改掉,diff 显示的"旧内容"就不是 write_file 真正执行时覆盖的内容。这算 bug 吗?要消除间隙得把预览挪到哪一层、代价是什么?提示:审批悬停期间(人犹豫的几十秒)文件同样可能被改——预览的"真"到底该锚在哪个时刻。

### 6. 直播碎片与交错顺序（第十六课）
bash 输出碎片不落盘的理由是"tool_result 已含完整输出,碎片可推导"。但 stdout 和 stderr 的**到达交错顺序**(哪句警告插在哪两行输出之间)在 tool_result 里丢了——它分两个字段各自存。这算不算"日志推不出的新信息"?对照 reasoning 落盘的理由("模型产出的新信息必须落盘"),说说为什么这里可以不落。如果哪天要求回放"终端当时怎么滚动",该改哪个事件、加什么字段、代价是什么?

### 7. 三个运行时偏好,三种锁策略(第十七课)
approvalMode 随时可切(auto→ask 是踩刹车);thinking 挡 turn 进行中(要重建 adapter);maxSteps 也随时可切(loop 每圈现读)。三个都是"运行时偏好,不落日志",锁策略却三样。说出各自的依据——什么性质决定一个偏好能不能在 turn 中途改?再想一层:如果哪天 thinking 也想 turn 中途切,技术上要改什么、语义上会踩什么坑(提示:同一个 turn 里前半段有思考后半段没有,回放时你能解释吗)?

### 8. 草稿的诚实成本(第十八课)
新会话 composer 的模型下拉初值是"上个会话的模型,没有就目录第一款"——但主进程的真实默认是 `OTTER_MODEL` 环境变量,渲染层根本不知道它。两种方案:①总是显式传 model(选了这个:下拉显示什么就落地什么,代价是与 env 默认不同时开局多一条 model_changed 事件);②用户没碰下拉就不传(零事件噪音,代价是下拉显示的型号可能不是实际会用的——UI 说谎)。为什么"UI 说谎"比"多一条事件"更贵?再想一层:第三条路是让 pickWorkspace 或 boot 把主进程默认模型带给欢迎页,它消除了两个代价,为什么这课还是没选它(提示:多一个跨进程接口面 vs 一条无害事件,哪个是长期债)?

### 9. 最近工作区 = 会话投影的代价(第十八课续)
工作区浮窗的"最近列表"是 listSessions 的投影(按 workspace 去重),零新增持久化。代价:把某文件夹的所有会话删光,它就从最近列表彻底消失——哪怕你昨天还天天用它。这是 bug 还是 feature?对比"单独存一份 recent-workspaces 列表"(VS Code 的做法):各自的失效模式是什么,什么时候投影方案会撑不住?

## 已答

### /rename 幽灵会话守卫（第十三课）
问:删掉 rename handler 里 `store.load(sessionId).length === 0` 守卫,对不存在的 sessionId 执行 /rename 会怎样?
答:`session_renamed` 照样落盘,该"会话"日志里只有这一条、没有 seq 0 的 session_created。`sessions()` 把它投影成 workspace 为 null 的幽灵会话——有标题、没围栏、没内容。守卫防的不是崩溃,是防投影层长出无中生有的会话:垃圾进日志,垃圾永久进投影。

### resolve-denied vs reject-AbortError（第十课）
问:中断时审批门为什么 resolve 成 denied 而不是 reject AbortError?
答:走既有 denied 管线会落 approval_decision + tool_result(denied),无悬空调用;reject 会跳过 onDecision、造悬空调用、把 ADR-0005 自愈层当地板用。审批门上的中断是"答案已知的决定",是数据不是异常;模型调用那条线上没有可落盘的事实,所以那里才用 reject。
