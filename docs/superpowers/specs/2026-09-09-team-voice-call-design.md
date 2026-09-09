# 团队语音通话（MiniMax speech-2.8-turbo）设计

- 日期：2026-09-09
- Task issue：#1163
- 需求原话（维护者）：「用 minimax speech 2.8 turbo 实现团队语音电话功能，参考微信群语音。在团队输入框里加一个语音按钮，点击可以选择拉谁进语音。agent 依然用自己的 llm 输出文本，minimax tts model 把文字转语音输出。」
- 维护者拍板的六条（2026-09-09 会话内）：① 音色自动派生；② **通话里只有通话成员参与**，活涉及通话外的 agent 时 agent 先问用户要不要拉 TA 进来，**用户口头同意就行**；③ 一段写完就开始合成；④ 三件线上动作（真库插行 / secret / 部署 edge）合并后由本班做；⑤ 用户自己 @ 了通话外的 agent → 自动拉进通话；⑥ 「结束通话」= 全组结束，「静音」= 本机不播。

## 1. 已验前提（真打过接口）

| 事实 | 数据 |
|---|---|
| 端点 | `POST https://api.minimaxi.com/v1/t2a_v2`，`Authorization: Bearer <key>`；给的 key 只在国内站有效（`api.minimax.io` 回 `2049 invalid api key`） |
| 非流式 | 41 字符 → 3.3s 返回 5.5s 音频；回包 `data.audio` 是 **hex**（mp3 90KB → hex 180KB） |
| 流式 | SSE `data:` 行；`status:1` 分片带 hex 音频，`status:2` 收尾带完整音频 + `extra_info` |
| 错误 | **HTTP 200 + `base_resp.status_code != 0`**（`status_msg` 是人话） |
| 计费 | `extra_info.usage_characters`：汉字算 2、其余（字母/标点/空格/换行）算 1。¥2.00 / 万字符（官网按量计费页，2026-09-09） |
| 音色 | `POST /v1/get_voice {voice_type:"system"}` 回 303 个；中文可用的如 `male-qn-jingying`、`female-yujie`、`Chinese (Mandarin)_Gentleman`… |

价的换算沿用 seed 0017 的口径（1 USD = 7.2 CNY）：¥2/万字符 = ¥200/百万字符 → **27,777,778 micro-USD / M 字符**，填进 `price_out_micro_per_m`；`price_in` / `price_cache` 填 0。一条 200 字的中文回复 ≈ 400 字符 ≈ ¥0.08。

## 2. 边界

做：
- 云会话（团队群聊）里的语音通话：拉哪几只 agent 进来、它们之后的回复被读出来、通话栏、结束/静音。
- TTS 走 edge 网关，官方 key 只在 Worker secret；计费进 `usage_event`；听的人付费。
- 通话是**团队共享事实**（事件日志里一条事件），派活 / 接力只在通话成员里进行；agent 可在用户口头同意后把人拉进通话。
- 一段写完就合成（流式预览按空行切段，完成的段立刻合成）。

不做（明写）：
- 用户语音输入（STT）、真人之间的语音、手机端、音色可选（第二步，列 0033 那条 migration 时再做）、流式 TTS（分片播放）、通话记录 / 录音。

## 3. 架构

```
桌面渲染层                     桌面主进程                edge Worker                MiniMax
─────────────                 ──────────               ───────────               ───────
语音钮/通话栏/播放器 ──IPC──▶ teamVoice.speak ──JWT──▶ /llm/v1/speech ──key──▶ /v1/t2a_v2
      ▲                                                  hold/settle              hex mp3
      │ assistant_message / delta（现有通道）               usage_event
      │
   cloudSessionClient ◀──cs 帧──▶ runtime（VPS）：voice_call_changed 事件、派活限制、invite_to_call
```

### 3.1 事件：`voice_call_changed`

```ts
interface VoiceCallChangedEvent extends SessionEventBase {
  type: "voice_call_changed";
  /** 此刻在通话里的 agent id；**空数组 = 通话结束** */
  participants: string[];
  /** 谁改的：人（uid）或 "system" */
  byUid: string;
  /** agent 用 invite_to_call 拉人时带上它自己 */
  byAgentId?: string;
  /** 模型不可见的注记（模型可见面是 deriveMessages 从它投影出来的 system 尾块）；
      旧版本跳过它只少一行时间线，不会复活残缺会话 */
  ignorable: true;
}
```

投影 `voiceCallOf(events)`（`src/shared/voiceCall.ts`，runtime 与渲染层共用）：最后一条 `voice_call_changed` 的 `participants`，空 = 没有通话，回 `{ participants, sinceSeq, sinceTs } | null`（`sinceSeq/sinceTs` = 这一场通话**第一条**非空事件，给通话栏的计时用）。

新事件类型的检查清单（按 `agent_relay` 的足迹逐一表态）：`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、`persistencePolicy`（durable——派活限制要从日志重放）、`deriveMessages`（下面 3.3）、`agentView.OTHER_AGENT_VERDICTS`（keep：每只都要读到名单）、`sessionPackage.PRIVACY_VERDICTS`（strip：控制面状态不是对话内容）、`contextEstimate.pendingAfter`（不计）、`cloudTimeline.ts` 一行系统旁白、`Timeline.tsx` 的 `EventRow` 标签、`cloudExport.ts` 无需改（它按类型透传）、三份测试名单（`persistencePolicy.test.ts` 的 DURABLE、`timelineLists.test.ts`、`cloudTimelineLabels.test.ts`）。

### 3.2 协议（16 → 17）

- `CsUp` 加 `{ t: "call"; participants: string[] }`：会话房帧，任何在籍成员都能发（同 say 的权限；不是 owner 专属——微信群语音谁都能拉人）。
- `CsDown` 加 `{ t: "call_result"; ok: boolean; message?: string }`。
- `decodeCsUp`：`participants` 必须是字符串数组，否则整帧拒。
- runtime `frameHandler` `case "call"`：`requireStillMember` → 令牌桶 `call`（`CALL_BUCKET`，形状同 stop：不起模型调用，但每次成功都往日志落一条）→ `session.setVoiceCall(uid, label, participants)` → `call_result`。
- `CloudSession.setVoiceCall(byUid, byLabel, participants)` 三态：`"ok"` / `"unknown_agent"`（名单里没有的 id，整帧拒不静默过滤——静默过滤就是 #722 那个撒谎的勾）/ `"unchanged"`（与当前名单相同，不落事件，回 ok）。归档的会话拒（`"archived"`）。
- 桌面 `cloudSessionClient.call(participants)` → `CloudAck`，`pendingCall` 同 `pendingStop`（15s 无回执 = `unknown`）。

### 3.3 模型可见面（deriveMessages，云会话）

`agent_briefed` 那条已经带 `roster`（别人的名字 + 职责）。主循环记住最近一条 brief 的 `name` + `roster`，以及最后一条 `voice_call_changed`；主循环结束后**若通话非空且是云会话**，往 system 尾部追一块（同 `workspaceMemoryPrompt` 的位置，最新一条胜出、不 `+=`）：

```
[语音通话进行中。通话里的成员：管理员、开发。不在通话里的：测试（跑测试）、运营（写文案）。
规则：只有通话里的成员参与这件事。如果这件事该由不在通话里的人做，先用一句话问用户要不要把 TA 拉进通话，
用户同意后再调用 invite_to_call 把 TA 拉进来、然后 @ TA；用户没同意就别替 TA 做、也别 @ TA。
你的回复会被读出来：短句、口语，代码只放围栏里。]
```

名字过 `promptSafe`（同 brief）。不在通话里的名单从 roster 里减去 participants；自己不在 roster 里所以用 brief 的 `name`。

### 3.4 runtime：派活 / 接力 / 工具

- `say()`：
  - 通话非空时，分类器的 `roster` 只给通话成员，`fallbackAgentId` = 通话成员里的第一只（管理员在通话里才是它）；`legacy`（mention:true 回落名单第一只）同样回落通话成员第一只。
  - 人亲手 @ 的 id 里有通话外的 → **先** append 一条 `voice_call_changed{participants ∪ 那几只, byUid: 发言人}`，再照常落开场白（拍板 ⑤）。
- `relayAfterTurn`：通话非空时，`targets` 过滤掉通话外的；每个被滤掉的落一条系统 `chat_message`：「「开发」@ 了不在通话里的「测试」——通话中只有通话成员接活，要拉 TA 进来可以答应「开发」的询问，或点通话栏的加人」。
- `invite_to_call` 工具（`services/runtime/src/inviteToCallTool.ts`）挂在**每只** agent 的 engine 上，`requiresApproval: false`（拍板 ②：口头同意就行；提示词负责「先问再调」的纪律），`exposure: "direct"`。参数 `{ name: string }`（名字不是 id——模型只见得到名字）。判据：没有通话 → 抛「现在没有语音通话」；名单里没这个名字 → 抛「团队里没有叫 X 的智能体」；已在通话里 → 回「X 已经在通话里了」不落事件；其余 append `voice_call_changed{participants ∪ X, byUid: currentInitiator ?? "system", byAgentId: 自己}`，回「已把 X 拉进通话，可以 @ TA 了」。
- 通话本身不影响 `openTurns` / 停止 / 归档：归档时不落「结束」事件（归档的会话不再有 turn，投影自然失效；`setVoiceCall` 对归档拒）。

### 3.5 edge：`/llm/v1/speech`

- `RouteKind` 加 `"tts"`；`upstreamPathFor("tts")` = `/t2a_v2`；`UPSTREAM_KEY_ENV.minimax = "MINIMAX_API_KEY"`。
- 请求体（客户端 → 网关）：`{ model: "speech-2.8-turbo", text, voice_id, speed? }`；网关 `serve()` 里按 `route.kind === "tts"` 分支到 `serveTts`：
  - 校验 `text` 非空且 `ttsUnits(text) ≤ TTS_MAX_UNITS`（2000，≈ 1000 汉字；一段气泡远小于它）、`voice_id` 是 ≤ 100 字的字符串、`speed` ∈ [0.5, 2]（缺省 1）。形状不对 400。
  - 预扣 = `costMicro({prompt:0, completion: ttsUnits(text), cached:0}, route)`——**不走** `estimateMicro`（那条按 body 字节和 max_tokens 估，对 TTS 没有意义）。
  - 上游体：`{ model: wireModel, text, stream: false, voice_setting: { voice_id, speed, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, bitrate: 64000, format: "mp3", channel: 1 } }`。
  - 回包解析（`services/edge/src/ttsUpstream.ts`，纯函数）：`base_resp.status_code !== 0` → **release + 502**（带 `status_msg`）；hex → bytes；usage = `extra_info.usage_characters`（缺席退回本地算的 units）；`audio_length` 带回。
  - 响应：`audio/mpeg` 字节 + 现有额度头 + `x-otto-cost-micro` + `x-otto-audio-ms` + `x-otto-tts-chars`。
- `ttsUnits(text)`（`src/shared/tts.ts`，三端共用）：逐字符，`\p{Script=Han}` 算 2，其余算 1——与 MiniMax 官方口径逐字对齐；真机对账：`你好，我是管理员。这条消息是语音通话的测试。` → 41。
- `/me` 加 `ttsModels`（`modelsForMe` 按 `kind === "tts"`，`meFromParts` 第八个参数加在末尾，`parseBillingMe` 缺席 = 空数组）。
- migration `0033_model_route_tts.sql`：check 加 `'tts'`，插 `speech-2.8-turbo@minimax`（`base_url = https://api.minimaxi.com/v1`，价见第 1 节，`default_max_tokens = 400` 只是名义值）。**先跑 migration 再部署 worker**（`parseRouteRows` 对认不出的 kind 按 chat——所以顺序反了也不会炸，只是 TTS 行会漏进对话选单？不会：`kind` 列已存在，只是值 check 拒插；插不进 = `ttsModels` 空 = 桌面不画语音钮）。

### 3.6 桌面主进程

- `hostedQuota.ttsInput()` → `{ subscribed, exhausted, resetAt?, ttsModels }`（与 imageInput 同源）。
- `modelRoute.ts`：`ttsBlocked(hosted)` / `routeTts({hosted, hostedBaseUrl, hostedToken})` → `{kind:"hosted", url: <base>/speech, model} | {kind:"blocked", reason}`，四种 blocked 分开措辞（没订阅 / 额度用完 / 网关不供语音 / 连不上网关），后两句**不许写成「你没订阅」**。
- `src/main/teamVoice.ts`：`createTeamVoice(deps).speak({text, voiceId})` → `VoiceSpeakResult = { ok: true; audio: Uint8Array; costMicro: number; audioMs: number } | { ok: false; message: string }`。成功 `quota.noteHeaders`；429 `quota_exhausted` → `noteExhausted`；错误信封过 `parseBillingError`。
- IPC `teamVoiceSpeak(text, voiceId)`；`workspaceCloudCall(participants)`。

### 3.7 渲染层

- **可用性**：`voiceCallAvailable(billing)`（`lib/voiceCall.ts`）= 订阅活跃且 `ttsModels` 非空；`null`（还没查到）与没订阅同一个答案 = 不画语音钮（同 `modelMenu` 对 `hosted` 的处置；#722 纪律）。通话栏**不看**这一格——通话是团队事实，没订阅的成员也看得见谁在通话里，只是「加入」那颗钮换成一句「语音要订阅」。
- **语音钮**（composer 左簇，@ 旁）：`Phone` 图标，点开 `VoicePickerPopover`——列全部 agent 勾选（默认全勾；已有通话时预勾当前成员），「开始语音」/「更新名单」发 `call` 帧。
- **通话栏**（`VoiceCallBar`，头部之下、滚动区之上）：`voiceCallOf(events)` 非空时出现。内容：参与者头像（`AgentAvatar`）一排，正在说话的那只外圈 `--brand` 呼吸环；计时（`sinceTs`）；钮：「加入」（本机开始播；发起人自动加入）/「静音」（本机不播、队列清空）/「加人」（同一个 popover）/「结束通话」（`call {participants: []}`，`useConfirm` 二次确认——它是全组动作）。TTS 报错（blocked 文案）画在栏下一行，不进共享 `actionError`。
- **播放**（`lib/voicePlayer.ts`，非纯）：一条队列、全局串行（一次只一只说话）、预取下一段（`teamVoiceSpeak` 在上一段播放时就发）；`Blob` → `URL.createObjectURL` → `new Audio()`，播完 `revokeObjectURL`。`stop()` 清队列 + 停当前。
- **喂队列**（`lib/voiceCall.ts` 的纯 reducer `voiceFeed(state, input)`）：
  - 输入 ① delta 帧（agentId, text 快照）：`splitBubbles(text)` 去掉最后一段（可能没写完），其余没读过的按序入队；
  - 输入 ② 终态 `assistant_message`：`splitBubbles(content)` 里没读过的入队，然后清这只 agent 的「已读段」；`turn_ended` 也清；
  - 只喂 `agentId ∈ participants && seq > listenSinceSeq`（加入那一刻的日志尾，历史不读）；`isAgentStep`（只跑工具没说话）跳过。
  - 每段先过 `spokenText()`：剥代码围栏（整段跳过——代码不念）、剥 Markdown 记号（`**`/`#`/列表前缀/链接只留文字）、剥 `[名字]:` 前缀；剥完为空跳过。
- **时间线**：`voice_call_changed` 画成 `AgentBriefedRow` 同款审计旁白，文案由 `callLineText(prev, e, ws)` 从前后两条名单的差集算：「Rick 开始了语音通话：管理员、开发」/「Rick 把测试拉进了通话」/「「开发」把测试拉进了通话」/「Rick 把运营移出了通话」/「Rick 结束了通话」。

### 3.8 音色派生（`src/shared/agentVoice.ts`）

`AGENT_VOICES`：十来个中文系统音色（男女交错、含描述），管理员固定 `Chinese (Mandarin)_Reliable_Executive`（沉稳高管），其余按 `agentId` FNV-1a 派生、按名单顺序解撞（照抄 `agentAvatarSlot` 的做法，同一份 FNV 实现搬进 shared 让两处共用）。

## 4. 钱与安全

- 谁付：**听的人**（自己的 JWT → 自己的额度）。否决「经 runtime 代扣 owner」：那是给任何成员开一条烧 owner 额度的口子，且中继单帧 256 KiB 装不下音频。
- key 只在 Worker secret（同 ADR-0257）。
- 网关校验 `text` 上限，令牌桶沿用 hold 的 `too_many_inflight`；`voice_id` 不做白名单（MiniMax 自己会拒不存在的 id 并回非零 status_code → 502，钱在 release 里退回）。
- 通话名单是日志事实：任何在籍成员可改；agent 只能加不能减（`invite_to_call` 只做并集）。

## 5. 测试

- `tests/shared/tts.test.ts`：`ttsUnits` 对账那条真机数据（41）；`tests/shared/voiceCall.test.ts`：投影 + `callLineText` + reducer；`tests/shared/agentVoice.test.ts`：稳定、解撞、管理员固定。
- `tests/edge/ttsUpstream.test.ts` + `llmGateway.test.ts`：门 / 路径 / 预扣按 units / hex→bytes / 非零 status_code 释放 + 502 / settle 用 usage_characters / 响应头。
- `tests/edge/billingQueries.test.ts`、`tests/shared/billing.test.ts`：`ttsModels`。
- `tests/main/modelRoute.test.ts`（`routeTts` 四种 blocked）、`hostedQuota.test.ts`（`ttsInput`）、`teamVoice.test.ts`（成功 / 402 / 429 记 exhausted / 连不上）。
- `tests/session/*`：三份名单、`deriveMessages.voiceCall.test.ts`（块的有无、最新一条胜出、名字过 promptSafe）。
- `tests/runtime/sessionService.test.ts`：派活只在通话成员里、@ 外人自动拉进、接力过滤 + 系统话、`invite_to_call` 四条判据、`setVoiceCall` 三态；`frameHandler.test.ts`：`call` 帧 + 桶 + 在籍；`tests/shared/remote/cloudSession.test.ts`：编解码。
- `tests/main/cloudSessionClient.test.ts`：`call()` 回执 / 超时 unknown。
- `tests/renderer/voiceCall*.test.ts(x)`：可用性、reducer、`spokenText`、通话栏渲染一遍（有通话画栏 / 说话那只带环 / 没订阅时「加入」换成一句话）。

## 6. 部署顺序（合并后，本班做）

1. Cloud 真库跑 `0033`（Management API，逐条发）。
2. `npx wrangler secret put MINIMAX_API_KEY`（在 `services/edge`）。
3. `npm run edge:deploy`。
4. `RUNTIME_SSH=… npm run runtime:deploy`（协议 17 是精确相等握手，不部署桌面连不上）。
5. `OTTO_PROFILE=dev` + Playwright 起 `out/` 真机验：开通话 → @ 一只 → 听到声音；@ 通话外的 → 自动拉进；结束通话 → 栏消失。

## 7. 已知代价

- 每段一次 HTTP 往返，首段约 3s 才出声（流式 TTS 留作后续）。
- 通话名单只有 agent，人类「谁在听」不落盘——多人会话里看不到别人有没有加入。
- 音色只有十来个，agent 超过这个数会重复（同头像 13 张的取舍）。
- `invite_to_call` 的「先问再调」只靠提示词；模型不问就拉的话，通话栏与时间线立刻可见，人可以移出。
- 通话期间归档不落「结束」事件；重开（没有这条路）不需要处理。
