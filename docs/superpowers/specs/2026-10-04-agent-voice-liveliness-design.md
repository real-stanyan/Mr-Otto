# 智能体语音的活人感：模型自标情绪 → 投影剥掉 → TTS 带情绪与韵律

- 日期：2026-10-04
- Task：#1515
- 关联：ADR-0271（TTS 走 edge、`voice_setting` 的形状）/ ADR-0266（按空行拆气泡——情绪记号挂在「段」上）/ ADR-0277（按句出声——句沿用所在段的情绪）/ ADR-0288（通话卡全文——也要剥记号）/ ADR-0322（挑声音——音色不动）/ `~/Github/ai-podcast`（`data/refs/delivery_recipe.json`、`src/tts/prosody.ts`、`src/tts/minimax.ts`、`src/tts/normalize.ts`、`docs/voice-emotion-compat.md`）

## 维护者原话

> 现在 otto app 里的智能体语音太生硬了，没有活人感。我们之前做过 ai 播客的语音活人感调教，去借鉴过来。

会话内拍板三条：**情绪由模型自己标**（不走分类器、不只调声学）；**记号在界面上剥掉**（日志留着）；**型号留 turbo、范围只通话**（试听那一句、语音消息不碰）。

## 播客那边沉淀了什么（32 期真人小宇宙闲聊蒸馏，`delivery_recipe.json`）

| 层 | Otto 此刻（#1163） | 播客调出来的 |
|---|---|---|
| `voice_setting` | `speed 1 / vol 1 / pitch 0`，**无 emotion** | 每句一个 emotion（7 档）+ `emotion_intensity 2.0`（克隆声）；emotion→speed/vol 微映射：高唤起 1.12 / 1.12，低唤起 0.88 / 0.92；**pitch 恒 0 是身份红线**（移调 = 换共振峰 = 不像本人） |
| 文本 | 剥 Markdown 就送 | 归一化：`AI` 收口成大写（小写 `Ai` 会被念成「A」）、四位年份逐位读（「二零二六年」不是「两千零二十六年」） |
| 句间 | 一句播完立刻下一句 | 真人停顿中位 0.23s、p90 0.55s、>1s 占 1%：档位 quick 160 / normal 230 / think 340 / punch 460ms；**砍舞台腔长停顿** |
| 脚本 | 「短句口语先说结论」 | 短段率 48%（≤6 字）、提问率 12%、口头连接词密度（然后 / 就是 / 这个 / 其实）、带笑口头反应代替裸「哈哈哈」；一句话：**高效传递 = 死，受控低效 = 活** |
| 兼容 | — | hd + 自家四音色 × 7 emotion 28/28 接受；运行时仍留**emotion 被拒就去掉重试一次**的降级路 |
| 型号 | speech-2.8-turbo | speech-2.8-hd |

**一个没验的前提**：播客只验过 **hd + 自家四个音色**（两个克隆、两个英文预置）接受 emotion；Otto 用 **turbo + 国内站中文系统预置**（`agentVoice.ts` 的十二个 + 管理员那个）。2026-10-04 想用 ai-podcast 的 key 探一遍，回 `1008 insufficient balance`，本机也没有 Otto 的 MiniMax key（只在 Worker secret 里）。所以：降级路**必须**做；兼容矩阵留给部署 edge 之后真机补（§7）。

## 设计

### 1. 模型可见面：通话块里多三句（`src/session/deriveMessages.ts` `renderVoiceCallPrompt`）

只改通话进行中焊进 system 尾部的那一块；本地会话、非通话的云会话、外联、私密车道一字不动。现有的「你的回复会被读出来，像打电话：先说结论，一两句就停……」照留，后面接：

1. **情绪记号**：「每段开头可以写一个括注说这段的情绪：（笑）（惊）（叹）（气）（怕）（嫌），平叙就不写。别段段都写——真人大多数话是平的，起伏才显得出来。」
2. **像真人打电话**：「说话带口头连接（然后 / 其实 / 就是 / 我看看），能一两个字接住的就接住（行、对、嗐、好），该问就问一句，不用句句都是完整的汇报。」
3. 段长照 PLAIN_TALK 已有的「一段只说一件事」，不另加。

压在百字内。记号词表**只给这六个**：少给选项比多给准，模型写了词表外的括注不算情绪（§2）。

### 2. shared 一份纯逻辑（新 `src/shared/voiceProsody.ts`，三端共用、零 IO）

```ts
export type SpeechEmotion = "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised";
export const EMOTION_TAGS: Record<string, SpeechEmotion> = { 笑: "happy", 惊: "surprised", 叹: "sad", 气: "angry", 怕: "fearful", 嫌: "disgusted" };
/** 段首一个括注（全角 / 半角括号都认，只认白名单），回情绪 + 剥掉记号的正文；不是白名单 → emotion null、正文原样 */
export function parseEmotionTag(bubble: string): { emotion: SpeechEmotion | null; text: string };
/** 只剥不解——给显示用（四处渲染一个函数） */
export function stripEmotionTag(bubble: string): string;
/** 播客 recipe 的数值：高唤起（happy / surprised / angry）1.12 / 1.12；低唤起（sad / fearful）0.88 / 0.92；其余 1 / 1。pitch 永远 0，这个函数不回 pitch */
export function prosodyFor(emotion: SpeechEmotion | null): { speed: number; vol: number };
/** AI 大写、四位年份逐位（搬播客 normalize.ts，边界同） */
export function normalizeSpoken(text: string): string;
/** 句间 230 / 段间 460（真人 p50 / p90 四舍五入到档） */
export const GAP_MS = { sentence: 230, bubble: 460 } as const;
```

**不认的括注**：`（笑死）（无奈）` 这类词表外的照原样当正文，既不剥也不传情绪——剥词表外的括注就是在改模型说的话。只认**段首**：段中的「他（笑）说」是正文。

接进现有两条路：

- **出声**（`src/shared/voiceFeed.ts`）：`splitSpoken` 按段切句之前先 `parseEmotionTag`，这一段的每一句都沿用它的情绪；`Utterance` 多一格 `emotion: SpeechEmotion | null`。**已读判据不变**（原文相等）：单位字符串里把记号**重新拼回每一句的句首**（`（笑）我弄好了。` / `（笑）你看一眼。`），`spokenText` 剥记号 + `normalizeSpoken` 之后才是送合成的字节——这样同一句话带不带情绪是两个单位，手机 `createSpeakCache` 的键（#1420）也随之区分。`spokenUnits` 与 `take()` 的变换逐字相同那条对拍测试照留，加情绪维度。
- **显示**：`chatBubbles.splitBubbles` **不动**（它是切段判据，出声那条路要从它拿到带记号的段）；显示方各在拿到段之后过 `stripEmotionTag`，五处：桌面云会话气泡（`CloudSessionPage.tsx` 的 `AgentBubbles`，终态 + 流式预览同一处）、手机气泡（`src/shared/mobileChat.ts` 两处 `splitBubbles`）、侧栏最后一句（`src/shared/sessionLast.ts`）、通话卡全文（`src/shared/cloudTimeline.ts` `voiceCallCards` 的 `text`）、通话字幕（`VoicePlayer.state().text` 已是 `spokenText` 之后的，天然剥过，加一条断言钉住）。`speakerLeak.ts` 不碰（它判的是署名泄漏，记号不在它管的形状里）。

**日志一个字不动**：`assistant_message` 原文带括注落盘（模型说的话就是这样的），剥是投影（Hard rule：投影可从日志推导）。协议位不动：没有新事件、没有新字段。

### 3. 客户端 → edge 请求体（`src/shared/ttsClient.ts` / `voicePlayer.ts` / `voiceSession.ts` / `mobile/src/voice/voiceStore.ts`）

- `TtsClient.speak(text, voiceId, opts)`：`opts` 多一格 `emotion?: SpeechEmotion`。请求体从 `{model, text, voice_id}` 变成 `{model, text, voice_id, emotion?, speed, vol}`——`speed / vol` 由 `prosodyFor(emotion)` 算，客户端算而不是 edge 算，因为 edge 不该知道「叹气要慢一点」这种产品判断；edge 只校验范围。**不带 emotion 时 `speed 1 / vol 1`**，与今天 edge 缺省逐字节等价（老客户端只发三格，edge 照旧补 1）。
- `VoicePlayer.enqueue` 收 `emotion`，透传给 `speak`；**句间停顿**：一句 `onended` 之后、下一句开播之前补 `GAP_MS.sentence`，跨段补 `GAP_MS.bubble`，**扣掉已经等掉的**（下一段合成还没回来时本来就在等，停顿是「至少隔这么久」不是「再加这么久」）；`stop()` 也要掐掉等着的停顿（epoch 判据照旧）。
- 手机 `createSpeakCache` 的键加 emotion；试听 `speakPreview` 不带 emotion（范围外）。

### 4. edge（`services/edge/src/ttsUpstream.ts` / `llmGateway.ts` `serveTts`）

- `parseTtsRequest`：多收 `emotion`（只认那六个字符串 + `neutral`，别的 400）、`vol`（0.5–2，同 speed 那条的措辞）。**不带 = 不写**：请求体没有 emotion 时 `voice_setting` 逐字节同今天（`tests/edge/ttsUpstream.test.ts` 钉着老形状）。
- `ttsUpstreamBody`：emotion 在场 → 写 `voice_setting.emotion` + `voice_setting.emotion_intensity: TTS_EMOTION_INTENSITY`。强度是 edge 的常量不是客户端传的：它是「这个上游对这组音色的调法」，换上游 / 换音色它跟着变，客户端不该知道。**先 1.0**（系统预置音色没验过，播客的 2.0 是克隆声上听出来的），真机听过再调——改一个常量、部署 edge，客户端不发版。`neutral` 当成不带（播客结论：显式 neutral 浪费且部分音色报错）。
- `serveTts` 降级路（搬播客 `MinimaxTts.synthesize`）：上游回 HTTP 200 + `base_resp.status_code ≠ 0`、请求带 emotion、且 code **不是** 1002（RPM）/ 1008（欠费）→ **去掉 emotion 再打一次**，同一个 hold、同一个 requestId；第二次的结果就是结果。1002 / 1008 与 emotion 无关，重试救不了还白丢情绪；HTTP 非 200 / 连不上照旧 release + 502。`parseTtsReply` 回 `ok:false` 时要带 `code`（今天只带 message）才判得出来。重试一次就够：第二发没 emotion，不存在第三发。
- `/me` 不动：型号清单、价格都不变。

### 5. 否决的路

- **分类器打标**：每句多一次模型调用，#1400 量过最便宜那款 1.3–3 秒，电话里等不起；而且是第二个模型在猜第一个模型的语气。
- **只调声学不传情绪**（标点推情绪）：「！」既是惊也是气也是乐，推不出来；这条路的内容（韵律 / 归一化 / 停顿 / 提示词）全在本设计里，差的只是情绪那一格。
- **记号原样显示**：每条开头一个括注像演戏，挂断后还留在时间线里；维护者拍板剥。
- **情绪进事件字段**（`assistant_message.emotion`）：模型写在正文里的东西再抄进一个字段是两份事实；它只影响读不读得活，退化成「平读」= 今天的行为，不值一个协议位。
- **换 hd**：贵 + 慢，电话里延迟优先；turbo 上 emotion 听过再决定，是独立的后续。
- **动 pitch**：播客的身份红线原样成立；系统预置音色移调也是换一个人。
- **edge 算韵律**：产品判断不进网关，网关只校验范围（同 `speed` 今天的处置）。

### 6. 测试

- `tests/shared/voiceProsody.test.ts`：六个记号各解对、全角 / 半角、词表外不动、段中不认、`prosodyFor` 三档数值、`normalizeSpoken` 的边界（`SAID` 不碰、五位数字不碰）。
- `tests/shared/voiceFeed.test.ts`：带记号的段每一句都带情绪、单位字符串拼回记号、`spokenText` 剥干净、`spokenUnits` 与 `take()` 对拍加情绪维度、已读判据区分带不带情绪。
- `tests/shared/voicePlayer.test.ts`：emotion 透传、句间 / 段间停顿、停顿扣掉已等时长、`stop()` 掐掉停顿。
- `tests/shared/ttsClient.test.ts`：带 emotion 的请求体三格、不带时 `speed 1 / vol 1`。
- `tests/edge/ttsUpstream.test.ts`：老请求体字节不变、emotion 白名单、vol 范围、`neutral` 不写、`emotion_intensity` 常量、`parseTtsReply` 带 code。
- `tests/edge/llmGateway.test.ts`：降级只重试一次、1002 / 1008 不重试、重试仍是同一个 hold。
- 渲染：`tests/renderer/chatBubbles.test.ts` / `CloudAssistantBubbles.test.tsx` / `voiceCallCard.test.tsx`、`tests/shared/mobileChat.test.ts` / `sessionLast.test.ts` 各加一条「带记号的段显示出来没有括注」。
- `tests/session/deriveMessages.cloudSession.test.ts`：通话块里有六个记号词；非通话 / 本地 / 外联没有。

### 7. 真机验收（要维护者部署 edge）

1. 部署 edge（`services/edge/README.md` 五步）。
2. `.superpowers/voice-smoke.mjs` 加一轮：turbo × `agentVoice.ts` 十三个音色 × 7 emotion 各念「测」，记 `status_code` 进 `docs/voice-emotion-compat.md`（播客那张表同形）。不接受的组合由 §4 的降级路兜，表上记下来是为了知道哪几档在哪个音色上**从来没生效过**。
3. 开一场电话，人耳听三件事：括注有没有漏到气泡 / 字幕 / 通话卡里；带（笑）的一段听得出比平叙活；句间停顿不拖。听完决定 `TTS_EMOTION_INTENSITY` 1.0 还是往 2.0 拉。

### 8. 没做

hd 型号、克隆音色、流式 TTS、氛围音、试听带情绪、语音消息、情绪分布统计（播客审稿用的，电话里没有审稿这一步）。

### 9. 已知代价

- 存量日志里的通话没有记号，重放还是平读——append-only 补不回。
- 模型在非通话的云会话里也可能学会写括注（提示词只在通话块里说，但记忆 / 历史会话里会出现带括注的回复）：显示路径五处都剥，所以人看不到；只是那几段当成了正文落盘。
- 一段里句子沿用同一情绪，句级起伏做不到——播客也是按行（1–3 句）标的，够用。
- emotion_intensity 的最终值要听过才知道；1.0 是「不会更差」的起点。
