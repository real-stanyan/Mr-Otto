# ADR-0271：团队语音通话 —— 通话是日志里的团队事实，TTS 走 edge 网关，听的人付费

- 状态：已接受
- 日期：2026-09-09
- 关联：#1163；ADR-0257（出图走 edge、官方 key 不落地——本篇 TTS 那条路的先例）、ADR-0261（`model_route.kind`——本篇加第三种 `tts`）、ADR-0233（云会话统一走订阅额度）、ADR-0266（云会话按空行拆气泡——本篇「一段写完就出声」的切段函数）、ADR-0263（协议 16 的 delta 快照帧——本篇提前出声的数据源）、ADR-0270（派活——本篇把候选收窄到通话成员）、ADR-0223（接力——本篇按名单过滤）、ADR-0224（`create_agent`——`invite_to_call` 的先例，但不过审批门）、ADR-0229（头像派生——音色派生逐字同一套算法）、ADR-0256（`from_label` 快照——名单带名字快照同一条理由）
- 来源：维护者原话 ——「用 minimax speech 2.8 turbo 实现团队语音电话功能，参考微信群语音。在团队输入框里加一个语音按钮，点击可以选择拉谁进语音。agent 依然用自己的 llm 输出文本，minimax tts model 把文字转语音输出」；会话内拍板六条：音色自动派生 / **通话只有在通话里的 agent 才参与，活涉及通话外的 agent 时 agent 先问用户，用户口头同意就行** / 一段写完就开始合成 / 三件线上动作合并后由本班做 / 用户自己 @ 了通话外的 agent → 自动拉进 / 「结束通话」= 全组、「静音」= 本机
- 设计稿：`docs/superpowers/specs/2026-09-09-team-voice-call-design.md`

## 背景

团队云会话是群聊，agent 的回复是一张张纯文字气泡。维护者要的是微信群语音那种形态：
点一颗钮、挑几只 agent 进通话，之后它们说的话**读出来**——agent 照旧用自己的模型出文字，
MiniMax `speech-2.8-turbo` 把文字变成声音。

真打过接口之后的事实（ADR-0134 的规矩，不推只验）：国内站 `api.minimaxi.com/v1/t2a_v2`
（给的 key 在 `.io` 国际站回 `2049 invalid api key`）；非流式 41 字符 3.3 秒返回 5.5 秒音频，
回包里音频是 **hex**；错误是 **HTTP 200 + `base_resp.status_code≠0`**；计费单位
`extra_info.usage_characters`（汉字 2、其余 1），¥2 / 万字符。

## 决策

### 1. 通话是日志里的团队事实，不是本机偏好

第一版设计把通话当成「我这台想听谁」——纯渲染层状态，不进日志、不广播。维护者第二轮
拍板改了前提：**通话里只有通话成员参与**，派活（ADR-0270）与接力（ADR-0223）都要按名单
过滤。runtime 读不到本机状态，所以名单必须是日志里的东西。

落地是一种新事件 `voice_call_changed { participants: {agentId, name}[], byUid, byAgentId?,
ignorable }`，**空名单 = 通话结束**，投影 `voiceCallOf`（`src/shared/voiceCall.ts`）三端一份。
带名字快照是因为模型可见面（deriveMessages 的通话块）要说得出名字，而它手上只有
`agent_briefed` 的 roster（不带 id）；渲染层照旧按 id 现查，查不到才退回快照（同 ADR-0256
`from_label` 的取舍）。`ignorable`：旧版本跳过它只少一行时间线 + 少一块提示，不复活残缺会话。

新事件类型的检查清单八处各表态：durable（派活限制要从日志重放）、`agentView` keep（每只
都要读到名单）、`sessionPackage` strip（控制面状态不是对话内容）、`contextEstimate` 不计、
`Timeline.tsx` 不画（云页自己画一行旁白）、`deriveMessages` 投影成 system 尾块、两份测试名单。

否决了两条：**本机状态**（runtime 读不到 → 派活限制做不了）、**落 Supabase 一列**
（system 提示词要从它推导，「model-visible means logged」是硬规则）。

### 2. 模型可见面是 system 尾块，最新一条胜出

`deriveMessages` 记住最后一条通话事件与最近一条 brief 的 name + roster，主循环结束后往
system 尾部追一块：谁在通话里、谁不在（带职责）、规则（只有通话成员参与；该由通话外的人做
就先问用户，同意后调 `invite_to_call`，没同意别替 TA 做也别 @ TA）、回复会被读出来（短句、
口语、代码只放围栏）。同 `workspace_memory_loaded` 的纪律：**不 `+=`**（两条名单叠在
system 里模型读到两套口径），空名单块消失，本机会话（无 `cloud`）不注入。名字过 `promptSafe`。

### 3. 派活、接力、@ 三条路各自怎么按名单走

- **派活**：分类器的候选只给通话成员（`callRoster`），兜底也在通话成员里挑（管理员不在通话
  里时是通话第一只）；开局卡 `mention:true` 的回落同样落到通话第一只，不是名单第一只——
  「只有通话成员参与」对那条路也成立。
- **人亲手 @ 了通话外的**（拍板 ⑤）：**先落一条并集名单再落开场白**——人点名 = 要它参与；
  先落名单，这一轮跑起来时它已经在通话里（system 尾块读得到、它的回复会被读出来）。
- **agent 在回复里 @ 了通话外的**：这一棒不接，群里落一句系统话（`relayOutsideCallText`）。
  写那个 @ 的是模型，它该做的是先问用户；这一行是人看得见「它没照做」的唯一信号——与
  #1055 撤掉的那条不同（那条说的是 @ 了不存在的名字，外部表现与没 @ 同形）。
- **没有通话 = 全名单 = 改动前逐字相同**：`callRoster` 缺省就是 roster，`resolveTargets`
  的 `fallbackRoster` 缺省就是 roster。

### 4. `invite_to_call` 不过审批门

拍板原话「用户口头同意了就行」。第一版设计是审批卡即询问（卡上写「开发想把测试拉进通话：
理由」，批准即拉进）——被维护者改成口头同意。于是「先问再调」这条纪律写在提示词里，这把刀
只管四条判据（没有通话 / 名单里没这个名字 / 已经在通话里 / 拉进来），`requiresApproval: false`，
**每只 agent 都挂**（任何一只都可能撞上「该由通话外的人做」）。参数是**名字**不是 id（模型只
看得见名字）；`byUid` 是点火的那个人（同 `create_agent` 的 `created_by`，不给 agent 发伪 uid），
`byAgentId` 是它自己。模型不问就拉的话，通话栏与时间线立刻可见，人能从栏上移出。

### 5. TTS 走 edge 网关，官方 key 只在 Worker secret，听的人付费

同 ADR-0257 出图那条路的全部理由：key 写进桌面包等于无限花维护者的钱，「额度记在用户头上」
在客户端结构性做不到。新一扇门 `/llm/v1/speech`，路由行 `kind='tts'`（第三种，migration
0033），`upstreamPathFor` 按 kind 打 MiniMax 的 `/t2a_v2`。与 chat / image 的三处差别写在
`serveTts` 头注：钱按**字符数**不按 token（预扣 `ttsUnits(text) × price_out`，结算用上游报
的 `usage_characters`，¥2/万字符按 7.2 折成 27,777,778 micro-USD/M 字符填进
`price_out_micro_per_m`，现成的 `costMicro` 逐字符相等——同 0032 让 Seedream 按张退化的手法）、
请求体翻成 MiniMax 形状、**HTTP 200 + status_code≠0 是失败**（只看 HTTP 状态会把一次鉴权
失败当成功结算，再交一段空音频给桌面）。hex 在网关解成 `audio/mpeg` 字节（别让两倍体积再走
三跳）。`/me` 多一格 `ttsModels`（第三张清单，消费方与前两张互不相通）。

**谁付：听的人**。桌面主进程拿听者自己的 JWT 打网关（`teamVoice.speak`），钱记在他的额度上。
否决「经 runtime 代扣 owner」：那是给任何成员开一条烧 owner 额度的口子，且中继单帧 256 KiB
装不下音频。没订阅 / 还没查到 / 网关不供语音 → **不画语音钮**（同 `modelMenu` 对 hosted 的
处置，#722 纪律）；通话栏**不看**这一格——通话是团队事实，没订阅的成员也看得见谁在通话里，
只是「加入」换成一句话。四种 blocked 各一句人话（`ttsBlocked`），「网关不供语音」「连不上
网关」不许写成「你没订阅」（ADR-0248）。

### 6. 一段写完就出声

协议 16 的 delta 帧是**累计快照**（ADR-0263），按 ADR-0266 那把切段函数（`splitBubbles`）
切开，最后一段可能没写完不读，前面每完成一段立刻合成；终态 `assistant_message` 落下来补读
没读过的段，然后清这只的记号（`feedDelta` / `feedEvent`，纯函数）。已读判据是**原文相等**
（快照与终态出自同一份正文、同一把切段函数），不是下标。读出来之前剥代码围栏（整段）、
`[名字]: ` 前缀、Markdown 记号（`spokenText`）。播放全局串行（群里一次只一只说话）、预取下一段
藏网关那 3 秒；合成失败记 error 跳过这段，一段读不出来不卡整场通话。

### 7. 结束 = 全组，静音 = 本机；发起人自动加入

「结束通话」= 一条空名单事件（要二次确认，`useConfirm`）；「静音」只是我这台不播、队列清空，
静音期间的话记成已读、取消静音不补读。开一场的人自动加入；别的成员看见通话栏点「加入」
才开始听——「我在听」是本机状态（`store.voice`），不落盘不广播，换会话即清。人类「谁在听」
**不落盘**（多人会话里看不到别人有没有加入），是已知代价。

### 8. 音色自动派生

`agentVoiceIds` 逐字照 `agentAvatarSlots` 的算法（管理员固定沉稳高管、其余按 agent_id FNV
派生、按名单顺序解撞），FNV 抽到 `src/shared/fnv1a.ts` 两处共用。不加列：加列意味着一次要手动
跑的 migration + 表单多一格 + `create_agent` 多一个参数，而派生让存量 agent 立刻有声音；哪天要
让人自己挑（像 #1007 给头像加的 `avatar_slot`），加一列可空、null 照旧派生，函数不用动。

## 代价与已知未做

- 每段一次 HTTP 往返，首段约 3 秒才出声；流式 TTS（MiniMax 有 SSE 分片）没做。
- 人类「谁在听」不落盘；多人会话看不到别人有没有加入。
- 音色十二个，agent 超过这个数会重复（同头像 13 张的取舍）。
- `invite_to_call` 的「先问再调」只靠提示词。
- 通话期间归档不落「结束」事件（归档之后 `setVoiceCall` 拒；投影上通话名单仍非空但没有 turn 会跑）。
- 用户语音输入（STT）、真人之间语音、手机端：不做。
- **要跑 0033 + `wrangler secret put MINIMAX_API_KEY` + 部署 edge + 部署 runtime（协议 17
  精确相等握手）才生效**；真机一次没跑过。

## 推翻前提

- 「通话只有通话成员参与」哪天改成「通话只管谁出声」（第一版设计），事件类型留着、派活/接力
  那两处过滤撤掉即可，模型可见面那一块随之收成「谁在通话里」一句。
- MiniMax 计费口径变了（汉字不再算 2）或 `usage_characters` 不再回：`ttsUnits` 只影响预扣，
  结算按上游报的数；两边都变了才要动 0033 那一行的价。
- 维护者要审批卡即询问：`invite_to_call` 翻成 `requiresApproval: true` + `summarizeArgs` 一条
  文案，其余不动。
