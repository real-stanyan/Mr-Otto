# ADR-0354：智能体语音的活人感——模型在段首写括注情绪，界面剥掉、日志留着，TTS 带 emotion 与韵律，pitch 恒 0

> 原为 ADR-0352。与 origin/main 上先合的两篇（长按消息派智能体 / 共享车道）撞号，按 ADR-0074 在合并前改到 0354（#1515）。

- 状态：已接受
- 日期：2026-10-04
- 关联：#1515；ADR-0271（TTS 走 edge——本篇在它的 `voice_setting` 上多三格）、ADR-0266（按空行拆气泡——情绪挂在段上）、ADR-0277（按句出声——句沿用段的情绪）、ADR-0288（通话卡——也剥记号）、ADR-0332（预合成缓存——键带情绪）；`~/Github/ai-podcast`（`data/refs/delivery_recipe.json` / `src/tts/prosody.ts` / `src/tts/minimax.ts` / `src/tts/normalize.ts`）
- 设计稿：`docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md`

## 背景

维护者原话：「现在 otto app 里的智能体语音太生硬了，没有活人感。我们之前做过 ai 播客的语音活人感调教，去借鉴过来。」

此刻（#1163）：`speech-2.8-turbo`，`voice_setting` 只有 `voice_id / speed 1 / vol 1 / pitch 0`，没有 emotion；一句播完立刻下一句；提示词只说「短句口语先说结论」。播客那边从 32 期真人节目蒸馏出的东西（每句 emotion、emotion→speed/vol、句间停顿档位、口头连接词密度、AI 大写 / 年份逐位）一条都没用上。

## 决策

1. **情绪由模型自己标**：通话提示词给六个段首括注 `（笑）（惊）（叹）（气）（怕）（嫌）`，对到 MiniMax 的 happy / surprised / sad / angry / fearful / disgusted；平叙不写。否决了分类器（每句多一次模型调用，#1400 量过 1.3–3 秒，电话里等不起）和只调声学（「！」既是惊也是气）。
2. **记号落日志、不落界面**：`assistant_message.content` 原文带括注落盘，显示路径五处（桌面气泡 / 手机气泡 / 名册最后一句 / 通话卡全文 / 推送正文）各过一次 `stripEmotionTag`（推送正文走 `src/shared/replyNotify.ts` 存进 `lastText` 的那一格，runtime `pushReply` 把它发成 iOS 推送正文，剥完是空就什么都不存）；通话字幕走 `spokenText`，天然已剥。出声路径解出来进 `voice_setting.emotion`。只认段首、只认白名单——词表外的括注是模型说的话。剥完成空串的段在气泡处不画，整条回复只有记号时桌面不画气泡、手机不出行（69243808 / 9c59cd56）。否决了加事件字段（正文里的东西再抄一份是两份事实；退化成平读 = 今天的行为，不值一个协议位）。
3. **韵律跟着情绪走、pitch 永远 0**：高唤起 speed 1.12 / vol 1.12，低唤起 0.88 / 0.92（播客 recipe）。客户端算、edge 只校验范围。移调 = 换共振峰 = 换一个人，连接口都不回 pitch。
4. **`emotion_intensity` 是 edge 常量**（先 1.0）：它是「这个上游对这组音色的调法」，换上游换音色跟着变；播客 2.0 是克隆声上听出来的，系统预置音色真机听过再调，客户端不发版。
5. **emotion 被拒去掉重试一次**（同一个 hold）：turbo + 系统预置音色对 emotion 的接受度没验到（播客 key 欠费、本机无 Otto key），宁可这句平淡也别整句不出声；1002 / 1008 不重试。
6. **句间补真人停顿**：同一只 230ms、换说话人 460ms，扣掉等合成已经等掉的。设计稿写的是「换段 460」，落地改成「换说话人」：播放器手上有 agentId、没有段边界，而真人 p90 那一档本来就是话轮切换。停顿是真实时间，所以渲染层 `tests/renderer/voiceStore.test.ts` 里 aec 的两句连播用例要拨假钟才过得去（0951d5ae）。
7. **型号留 turbo、范围只通话**：hd 贵 + 慢，电话里延迟优先；试听与语音消息不碰。

## 代价

- 存量日志里的通话没有记号，重放还是平读。
- 模型在非通话会话里也可能写括注（历史会话里会出现）：显示路径都剥，人看不到，只是那几段当成正文落盘。
- 一段里句子沿用同一情绪，句级起伏做不到（播客也是按行标的）。
- `emotion_intensity` 的最终值、哪几档在哪个音色上生效，都要部署 edge 之后真机听（`scripts/tts-emotion-matrix.mjs` + `docs/voice-emotion-compat.md`）。
- `emotion` 被上游拒时去掉重试一次；被拒的那次首发不计费（MiniMax 参数错误不回 usage）。
