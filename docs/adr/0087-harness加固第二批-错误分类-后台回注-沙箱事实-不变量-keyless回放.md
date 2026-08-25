# ADR-0087：harness 加固第二批——错误分类 / 后台回注 / 沙箱事实上报 / 不变量校验 / keyless 回放

- 状态：已接受
- 关联：issue #389；承接 ADR-0086「本轮明确不做」清单（dsh / hermes 对照研究）
- 先例：批量权衡 ADR 的形态沿用 ADR-0077 / 0079 / 0086

## 背景

ADR-0086 补齐了对照研究里的第一批六个缺口，把量级大的五件记档另议。本轮
就是那五件。每笔独立可回滚；测试各自钉住。

## 决定 1：错误分类引擎（errorClass，hermes error_classifier 对照）

「这个错是什么」此前三处各判各的：adapter 按状态码定重试集合（RETRYABLE_STATUS）、
visionBridge 用 `/API 429/` 正则从**错误文案**倒推限流、渲染层 modelError.ts
再解析一遍同一段文案。三张表互不知情——改一处文案格式另两处静默失灵，
网关限流的人话文案（无 "API 429" 字样）从来没被 visionBridge 认出来过。

收成一个出口（`src/model/errorClass.ts`）：**抛错的地方分类**（状态码还在手上，
不从字符串倒推），三类 `rate-limit / retryable / fatal`，标记贴属性不建子类
（markRetryable 同款理由：错误要跨 try 边界原样上抛）。

- **errorClass 与 retryable 正交**：class 是错误的种类，retryable 是
  种类 × 流位置的重试许可——首 token 后的瞬态错种类仍是 retryable 但不可
  重试（半条消息续不上）。visionBridge 看 class（关心"是不是限流"），
  adapter 重试环看 retryable（关心"重发安不安全"）。
- turn_ended 新增可选 `errorClass` 字段：error 存原文不动（落盘前不换人话，
  猜错了永远查不回去），分类作为**抛错那一刻的判定**独立补记。
- 行为刻意逐位保持：重试集合不变、408 仍 fatal（改重试语义是另一笔决定）、
  渲染层 humanizer 不动。
- 会推翻它的前提：接入非 HTTP 方言的 adapter（Claude 原生 API）后分类依据
  不再是状态码——届时分类函数按方言扩展，三类语义不变。

## 决定 2：后台任务完成回注（dsh completion re-injection 对照）

bash 加 `run_in_background`：立即返回任务 id，完成后结果以**新 turn** 注回。

- **不 mid-splice 是本决定的核心**：steer 那条"往跑着的 turn 里 append"的路
  技术上现成（一次 append 零 engine 改动），但 turn 中途改投影中段 = prefix
  cache 全废（ADR-0073 的教训——微压缩同处境时宁可丢结果）。turn 在跑就攒
  （pendingBg），正常收口后合并成一条注回；aborted 不排空——停止键的契约
  是"停"（分区分类同款立场）。
- **world 层 execDetached 是独立方法而不是 ExecOptions flag**：withAbortSignal
  把 turn 信号焊进每个 exec 调用，后台任务必须躲开那次注入——分开的方法让
  装饰器"透传不加签"成为显式决定而不是遗漏。LocalWorld 实现 30 分钟超时
  （无限 = 泄漏出走的进程）、不 detach 进程组（app 退出随主进程死——孤儿
  进程比丢结果糟）。
- **没接完成回调的装配（subagent）拒绝 run_in_background**（armed 现查）：
  结果必丢时拒绝，好过对模型撒谎说"会注回"。参数表也只在有登记口时才宣称
  这个参数（报用不了的参数与报用不了的工具同罪）。
- `background_task_completed` 事件（ignorable，log-only）：把「任务完成」与
  「回注开始」两个时刻分开记账；模型可见载体是回注 turn 的 user_message
  （"先落盘再喂模型"由 runTurn 既有路径满足），投影字节不可见。
- 接受的代价：回注消息在 UI 里以 user 气泡呈现（带 `[后台任务 bg-N 完成]`
  前缀自明）。专门的时间线卡片等真实使用反馈再议，不预埋。

## 决定 3：沙箱 enforcement 事实上报（ExecResult.sandbox，dsh 对照）

SandboxDeniedError（ADR-0083）管「整条命令被沙箱拒了」——抛错走升级环；
这笔补另一半：命令**跑完了**但过程中沙箱拦了部分操作/自身出了状况——
这是事实不是错误，随 `ExecResult.sandbox`（可选字段）回来，bash 把事实行
放在 clip 之外、stdout 之前（截断永远吃不掉它，BrowserReadResult.truncated
「摆到模型眼前」同款约定）。

- **「沙箱拦了」（denials）与「沙箱坏了」（failures）严格分开**：拦截是
  约束在工作，异常是约束可能已失效——模型该做的反应完全不同。
- enforcement `full / partial`：external 档全盘放行只守网络就是天然 partial。
- **判定责任钉在沙箱实现侧**（v2 SandboxWorld，确定性依据）——不做 stderr
  关键词启发式，issue #346 ④ 的既有立场不动；本决定只是把判定结果的
  **载体**定下来。
- v1 无生产者：sandbox 缺席时 bash 输出逐字节不变。交付形态 = 协议 + 测试
  （ADR-0083 同款）。

## 决定 4：运行时不变量校验（checkInvariants，dsh invariant registry 对照）

事件流的结构合法性此前全靠投影层静默自愈（healDanglingToolCalls / 孤儿
tool_result 过滤 / steer 重排）——自愈让系统能跑，但把写入方的 bug 藏进
「反正投影会修」的暗处。`src/session/invariants.ts` 把「流本来该长什么样」
写成纯函数断言：工具调用三方配对（声明/执行/结果）、toolCallId 唯一、
turn 不双收口。

- **resume 修复后跑、只告警不拦**：硬规则「旧日志永远可重放」优先于结构
  洁癖——违例是"写入方有 bug"的诊断线索，不是拒读理由（拒读那道门只属于
  assertReplayable 的版本兼容语义）。跑在 ADR-0005 悬空修复 + 崩溃合成收口
  **之后**：修复本身就是把不变量修回来的动作，先校验必然误报。
- 已知合法反例明文豁免：ts 乱序（修复事件盖修复时刻）、fork 双
  session_created、steer 多 user_message、修复尾巴（turn_ended 后的合成
  tool_result）、memory-nudge 孤儿收口（issue #186）。
- 会推翻它的前提：违例告警在真实日志上频繁出现且全是合法形态——说明断言
  写错了方向，删断言改注释，不加豁免堆。

## 决定 5：keyless 回放测试体系

探底结论：key 门**只在发送那一刻**（modelRoute blocked），启动/恢复/轨迹
投影全程不碰 key——keyless 回放今天就是通的。缺的不是功能是测试。

- 单元（keylessReplay.test.ts）：清 key 环境下 resume 装配 + buildTrajectory
  照常；发送失败给人话且落盘、失败历史照样可回放。
- e2e（keylessReplay.e2e.ts）：真 GUI 无 key 建会话 → 人话浮出 → 轨迹 tab
  渲染 → 渲染层零异常。显式清 DEEPSEEK_API_KEY（harness 继承 process.env，
  开发机可能真配着 key）。
- 明确不做（本轮）：不建 agent 的只读查看通道（readSessionEvents 的子会话
  围栏不动）。查看历史今天走 resume（会重建 agent、会跑崩溃修复追加）——
  「查看不该写日志」是真问题，但动它牵涉 ShellBridge 面和围栏语义，
  另开 issue 再议，不搭车。

## 本轮明确不做（对照清单里剩下的）

错误分类→自动 failover/降级（分类已就位，策略引擎等真实故障数据）、
PTC / code mode——各自够一个独立 issue。
