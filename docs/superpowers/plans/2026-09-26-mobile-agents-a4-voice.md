# 手机端「智能体」单栏 A4——语音（电话模式 / 通话卡 / 原生识别）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天页输入框空着时，右边那颗圆钮变「开电话」：点了拉这条聊天里的智能体进语音通话，输入框换成电话那一格（脸 / 声浪 / 计时 / 转文字 / 静音 / 挂断）；它们的回复一句一句读出来，人说的话本机识别、说完一句就发出去（人能插嘴）；挂断之后这一通折成时间线上一张卡（多久 + 聊的什么），点开是全文。

**Architecture:** 服务端一行不改：`call` 帧、`voice_call_changed`、`say{voice:true}`、edge `/llm/v1/speech` 都是 #1163 起就有的（ADR-0271 / 0273 / 0288），手机只做第二个客户端。判据全在 `src/shared/`（进 vitest）：桌面渲染层与主进程的七份语音纯逻辑挪进 shared（桌面改 import、行为不变），新写一层**一台设备上的语音编排** `voiceSession.ts`（加入 / 离开、读谁的话、半双工与插嘴、说完发出去、断线收口——语义逐条照桌面 store 的语音那一段）与电话那一格的判据 `mobileCall.ts`。识别与放音是一个**自写的 Expo 本地模块** `mobile/modules/otto-speech/`（Swift，照搬桌面 `native/MrOttoSpeech`：识别 + 断句 + 回声消除 + 同一个音频引擎放音），所以通话只在开发版（`npx expo run:ios`）里有，Expo Go 里不画电话钮。RN 那一侧只剩接线与样子。

**Tech Stack:** Expo SDK 57 / RN 0.86 / react-native-svg 15.15 / expo-file-system 57（新 `File` / `Directory` / `Paths` API）/ Expo Modules API（Swift 5.9）/ SFSpeechRecognizer + AVAudioEngine；vitest。**本片不新增任何 npm 依赖、没有 migration、不碰 `services/`、不进协议位、不用部署。**

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（本片对应 §5.7 语音、§5.3「A4 起空着变『开电话』」、§4 底部抽屉、§6 状态与降级、§8 A4 一行、§10 偏离清单、§11 维护者拍板）。执行者先读这几节再动手。Demo 在分支 `claude/auto-mobile-app-redesign-0a1e2f` 的 `.demo/mobile-agents-redesign.html`（`voiceBar` / `openVoice` / `closeVoice` / `callCard` / `openCallPanel` 那几段，CSS 在「语音」「电话模式」两节），**实现以 spec §10 为准**。桌面那一半的来龙去脉：ADR-0271（团队语音通话）/ 0273（本机识别 helper）/ 0277（回声消除与插嘴）/ 0280（放音走 helper 的引擎）/ 0288（通话折成卡）/ 0306（断线时语音怎么收口）。

**维护者 2026-09-26 拍板（本片的三个前提）：**
1. 识别**自写 iOS 原生模块**（照搬桌面 MrOttoSpeech），要开发版；不用社区库 expo-speech-recognition，也不先只做「听」。
2. **「说话的声音」可选另开一片**：本片音色照桌面按 agent_id 派生（`agentVoiceId`），不加列、不跑库，智能体设置里那一格本片不画。
3. **锁屏 / 切到后台 = 这台停听**，通话本身还在；回到这一页那一格写「通话还开着」+「接着听」。不开后台音频模式。

## Global Constraints

- 工作目录：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6`（分支 `claude/mobile-a4-voice-d174e6`，从 origin/main `9fa5d724` 开）。**你改的每一个路径都必须在这个目录下；绝不碰主 checkout `/Users/stanyan/Github/Mr_Otto`**（那是别的 lane 共用的只读副本）。每条 shell 命令自带 `cd <这个目录> &&`，别依赖上一条留下的 cwd。
- **绝不用 `git stash`（任何形式）**：stash 栈是所有 worktree 共享的。RED 靠「先写测试、跑出失败、再实现」。不许 `--no-verify`。
- 手机端（`mobile/src/`、`mobile/App.tsx`、`mobile/index.ts`）在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session` 文件（`tests/architecture.test.ts` 第 8 条会红）。`mobile/modules/otto-speech/` 算 `mobile/` 自己的目录，从 `mobile/src/` 用相对路径 import 它是允许的。类型 `SessionEvent` 等从 `src/session/events.js` 取（在白名单里）。
- **两端共用的纯逻辑写进 `src/shared/`，不抄第二份**（spec §2）。手机端不进 vitest、只跑 tsc，所以凡是「判断」都放 shared 并带测试；RN 组件里只剩接线与样式。`src/shared/` 不许 import 任何 node builtin / electron（`tests/architecture.test.ts` 会红）。
- **本片不新增 npm 依赖、没有 migration、不碰 `services/`、不进协议位。** 新增的原生代码只有 `mobile/modules/otto-speech/`（Expo 本地模块，Swift 5.9）。`mobile/ios/` 是 `expo prebuild` 生成的，已经在 `mobile/.gitignore` 里（`/ios`），**绝不提交**。
- **不碰桌面的 `native/MrOttoSpeech/`**：改它要重编 helper，重编要维护者重新点一次 macOS 的 TCC 授权。手机那份照抄，`tests/mobile/ottoSpeech.test.ts` 对拍。
- 搬家（Task 1 / 2）**只挪不改断言**：桌面行为一个字不变，既有用例原样搬走；新加的用例只加不删。桌面改 import，**不留转发壳**（spec §9 的规矩：两条路径指向同一份代码，下一个人分不清哪条是正路）。
- 设计令牌逐值取自 `mobile/src/theme.ts`（本片加一个 `voice`，demo 的 `--voice`）；尺寸逐值取自 demo（`.voicebar` / `.vline` / `.wave` / `.vb` / `.callcard` / `.callpanel`）。界面文案不出现「水獭」，也不出现「主场」「云会话」这类内部名。
- 状态与降级（spec §6）：还没查到 ≠ 没有 / 读不到 ≠ 空 / 说不清就不画钮（#722）。这台打不了电话（没有原生模块 / 订阅没查到 / 没订阅 / 网关不供语音）就不画电话钮，输入框右边照旧是那颗灰的发送钮。失败那句话留在出事的那一屏上。
- 每一段动效都要有「减弱动态效果」下的样子（`useReduceMotion()`）：按下的缩放退成变暗；声浪不走包络、只跟能量；减弱不是取消。
- TypeScript strict；根另开 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（shared 代码根与手机两边都要过）。可选字段不许显式赋 `undefined`，用 `...(x === undefined ? {} : { k: x })`；手机端组件的可选 prop 同样用展开写法传。
- 源码里要 NUL 字符一律 `String.fromCharCode(0)`（本片用不到，别引进来）；测试里要 emoji 一律写 `\u{1F600}` 这种转义，不直接贴字形。
- 门禁 `npm test`（根 tsc + mobile tsc + vitest）。这个 worktree 的根 `node_modules` 是指向主 checkout 的软链、`mobile/node_modules` 是本地安装——**都不要动**。跑门禁：`npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`。**判据只认 `GATE_EXIT`**（`.superpowers/` 被 git 忽略）。单跑一个测试文件：`npx vitest run <路径>`；只跑手机 tsc：`npm --prefix mobile run typecheck`。
- 提交：小步提交，中文 message 写清「为什么」，末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。`git add` 只加这个任务自己的文件（逐路径，不用 `-A` / `.`；`git mv` 过的文件已经在暂存区）。**这个会话的 shell 会拒绝 heredoc 与 `$(…)` 当参数**：把 message 用编辑工具写进 `.superpowers/commit-msg.txt`，再 `git commit -F .superpowers/commit-msg.txt`；message 内容照计划原文。
- 代码块照原样写进文件；用编辑工具按「把 A 换成 B」改文件时，先 `grep -n` / 读源文件那几行，照源文件的真实缩进做锚点。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/voiceFeed.ts` | 挪（原 `src/renderer/src/lib/voiceCall.ts`） | 语音钮画不画、读之前剥什么、按句切、流式里哪几句写完了、终态补读、插嘴 |
| `src/shared/voiceMic.ts` | 挪（原 `src/renderer/src/lib/voiceMic.ts`）+ 改 | 麦克风状态机、半双工、插嘴门槛、开麦词表；授权那句按平台说（Task 3） |
| `src/shared/voicePlayer.ts` | 挪一半（原 `src/renderer/src/lib/voicePlayer.ts` 的队列） | 串行放音队列 + 预取；`createAudio` 必填 |
| `src/renderer/src/lib/webAudio.ts` | 挪另一半 | 桌面那条缺省的 Web Audio 放音 |
| `src/shared/helperAudio.ts` | 挪（原 `src/renderer/src/lib/helperAudio.ts`）+ 补测试 | 一段字节交给「别人的音频引擎」放，回执叫醒那一段 |
| `src/shared/speechEvent.ts` | 新（从 `src/main/speechBridge.ts` 抽出） | 识别那一侧吐的一条事件 → `SpeechEvent`（验形） |
| `src/shared/ttsRoute.ts` | 挪（原 `src/main/modelRoute.ts` 的语音那段）+ 新 `ttsHostedOf` | 语音合成走不走得通、四种 blocked 的人话 |
| `src/shared/billingView.ts` | 改 | 新增 `resetClockText`（原 modelRoute 的 `fmtReset`） |
| `src/shared/ttsClient.ts` | 挪（原 `src/main/teamVoice.ts`，改名 `createTtsClient`） | 合成一段语音：拿 JWT 打 edge `/llm/v1/speech` |
| `src/shared/voiceSession.ts` | 新 | 一台设备上的语音编排（桌面 store 语音那一段的语义，手机用） |
| `src/shared/mobileCall.ts` | 新 | 电话钮画不画、电话那一格画什么、脸、声浪、「聊的什么」、为什么接不了 |
| `src/shared/mobileChat.ts` | 改 | 时间线多一种行：通话卡（`call`）；流式那一段可以按名单藏起来 |
| `mobile/modules/otto-speech/` | 新 | Expo 本地模块：`index.ts`（JS 绑定）+ `ios/`（Swift：模块定义、识别、放音、事件、断句、能量门） |
| `mobile/app.json` | 改 | Info.plist 两句授权说明（麦克风 / 语音识别） |
| `mobile/src/cloud/chatStore.ts` | 改 | 给语音那一层的四个钩子 + `sayVoice` / `setVoiceCall` / `chatEvents` |
| `mobile/src/voice/voiceStore.ts` | 新 | 接线：原生模块 / TTS 网关 / 聊天连接 / 前后台 / 订阅快照 |
| `mobile/src/theme.ts` | 改 | 令牌 `voice` |
| `mobile/src/chrome/VoiceGlyphs.tsx` | 新 | 声浪 / 麦克风 / 键盘 / 挂断四枚图标（demo 的路径） |
| `mobile/src/voice/CallBar.tsx` | 新 | 电话那一格（受控）：live / idle 两种样子 |
| `mobile/src/voice/CallCardRow.tsx` / `CallSheet.tsx` | 新 | 时间线上那张通话卡 / 点开的那一扇 |
| `mobile/src/chat/Composer.tsx` / `ChatRows.tsx` / `ChatScreen.tsx` | 改 | 电话钮、通话卡那一行、接线 |
| `tests/mobile/ottoSpeech.test.ts` | 新 | 原生模块与桌面 helper 对拍（断句 / 能量门逐字、事件字段、JS↔Swift 函数表、授权说明） |
| `docs/adr/0320-*.md` / spec §5.7 / §8 / §10 / §11 / `AGENTS.md` / `mobile/README.md` | 新 / 改 | 收尾文档 |

任务顺序：1、2 是搬家（桌面行为不变），3 是编排，4 是电话那一格的判据与通话卡，5 是原生模块（要编译一次），6 接线，7 画界面，8 收尾（文档、门禁、开发版冒烟、PR）。

**不在本片**：挑声音（`workspace_agents` 加一列 + ADR，维护者 2026-09-26 定另开一片）；A5（账号与那台电脑）；桌面 store 的语音编排改用 `voiceSession`（它多一扇 #1281 的「扣住 / 合并」窗，源码里还钉着 `utteranceHoldWiring` 那几条断言——Task 8 另开 issue）；名册上画「这条聊天通话还开着」（通话状态不在清单表里，要 runtime 投影一列，另开）。

---

### Task 1: 渲染层的四份语音纯逻辑挪进 shared

手机要用同一份：读哪几句、怎么切句（`voiceCall.ts`）、麦克风状态机（`voiceMic.ts`）、串行放音队列（`voicePlayer.ts` 的前一半）、把字节交给别人的音频引擎放（`helperAudio.ts`）。**只挪不改断言**，桌面改 import。两处不是纯搬：`src/shared/voiceCall.ts` 已经存在（那是通话名单的投影），所以渲染层那份改名 `voiceFeed.ts`；`voicePlayer.ts` 拆两半，队列进 shared 且 `createAudio` 改成必填（缺省值只能是某一端的实现——Web Audio——放进 shared 就把那一端的 API 带进了另一端），Web Audio 那一半留在渲染层叫 `webAudio.ts`。`helperAudio.ts` 原来一条测试都没有，进 shared 要补上。

**Files:**
- Move: `src/renderer/src/lib/voiceCall.ts` → `src/shared/voiceFeed.ts`
- Move: `src/renderer/src/lib/voiceMic.ts` → `src/shared/voiceMic.ts`
- Move + split: `src/renderer/src/lib/voicePlayer.ts` → `src/shared/voicePlayer.ts`（队列）+ Create `src/renderer/src/lib/webAudio.ts`（Web Audio）
- Move: `src/renderer/src/lib/helperAudio.ts` → `src/shared/helperAudio.ts`
- Modify: `src/renderer/src/store.ts:106-109`、`src/renderer/src/components/CloudSessionPage.tsx:101`
- Move tests: `tests/renderer/voiceCall.test.ts` → `tests/shared/voiceFeed.test.ts`；`tests/renderer/voiceMic.test.ts` → `tests/shared/voiceMic.test.ts`；`tests/renderer/voicePlayer.test.ts` → `tests/shared/voicePlayer.test.ts` + Create `tests/renderer/webAudio.test.ts`
- Modify tests（只改 import 路径）: `tests/renderer/voiceCallView.test.ts`、`tests/renderer/voiceCallOverlay.test.tsx`、`tests/renderer/voiceCallBar.test.tsx`
- Create: `tests/shared/helperAudio.test.ts`

**Interfaces:**
- Consumes: 无（搬家）。
- Produces（后面的任务用这些路径）：
  - `src/shared/voiceFeed.ts`：`voiceCallAvailable(billing: BillingSnapshotView | null): boolean`、`spokenText`、`splitSpoken`、`interface Utterance { agentId: string; text: string }`、`interface VoiceFeedState`、`EMPTY_VOICE_FEED`、`markInterrupted(state, agentId)`、`feedDelta(state, participants: ReadonlySet<string>, agentId, text): { state; out: Utterance[] }`、`feedEvent(state, participants, listenSinceSeq: number, e: SessionEvent): { state; out: Utterance[] }`
  - `src/shared/voiceMic.ts`：`type MicStatus`、`interface MicState`、`MIC_OFF`、`SPEECH_LOCALE`、`applySpeechEvent(state, ev)`、`micShouldPause(p)`、`speechTokens`、`isSelfEcho`、`BARGE_IN_MIN_TOKENS`、`bargeInOn(partial, playing, spoken, active?)`、`SPEECH_HINTS_MAX`、`SPEECH_HINTS_DEV`、`speechHints(ws: WorkspaceSnapshot | null): string[]`
  - `src/shared/voicePlayer.ts`：`interface VoicePlayerState { speaking: string | null; queued: number; error: string | null; text: string | null }`、`interface PlayerAudio { play(): Promise<void>; pause(): void; onended: (() => void) | null; onerror: ((message?: string) => void) | null }`、`interface VoicePlayerDeps { speak; createAudio: (bytes: Uint8Array) => PlayerAudio; onChange }`（`createAudio` 必填）、`class VoicePlayer { state(); pendingAgentIds(); enqueue(u: { agentId; text; voiceId }); stop() }`
  - `src/renderer/src/lib/webAudio.ts`：`AudioContextLike`、`AudioBufferSourceNodeLike`、`webAudioPlayback(bytes, getCtx)`、`defaultCreateAudio(bytes)`
  - `src/shared/helperAudio.ts`：`interface HelperAudioBridge { play(bytes: Uint8Array): Promise<{ id: string } | { error: string }>; stop(): Promise<void> }`、`createHelperAudio(bytes, bridge): PlayerAudio`、`helperAudioEvent(ev: SpeechEvent): boolean`、`resetHelperAudio(): void`

- [ ] **Step 1: 搬文件（git mv 保住历史）**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git mv src/renderer/src/lib/voiceCall.ts src/shared/voiceFeed.ts && git mv src/renderer/src/lib/voiceMic.ts src/shared/voiceMic.ts && git mv src/renderer/src/lib/voicePlayer.ts src/shared/voicePlayer.ts && git mv src/renderer/src/lib/helperAudio.ts src/shared/helperAudio.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git mv tests/renderer/voiceCall.test.ts tests/shared/voiceFeed.test.ts && git mv tests/renderer/voiceMic.test.ts tests/shared/voiceMic.test.ts && git mv tests/renderer/voicePlayer.test.ts tests/shared/voicePlayer.test.ts
```

- [ ] **Step 2: 改四个搬过去的源文件里的 import 路径与头注第一行**

`src/shared/voiceFeed.ts`：
- 第 1 行 `// voiceCall（渲染层）—— 语音通话的纯逻辑（#1163）：语音钮画不画、一段文字读出来之前` 换成 `// voiceFeed —— 语音通话的纯逻辑（#1163；#1356 A4 从渲染层挪进 shared，桌面与手机 import 同一份）：语音钮画不画、一段文字读出来之前`
- `import { splitBubbles } from "../../../shared/chatBubbles.js";` → `import { splitBubbles } from "./chatBubbles.js";`
- `import type { BillingSnapshotView } from "../../../shared/shellBridge.js";` → `import type { BillingSnapshotView } from "./shellBridge.js";`
- `import type { SessionEvent } from "../../../session/events.js";` → `import type { SessionEvent } from "../session/events.js";`

`src/shared/voiceMic.ts`：
- 第 1 行 `// voiceMic —— 群语音里「人说话」那一半的渲染层纯逻辑（#1176，ADR-0273）：helper 的事件` 换成 `// voiceMic —— 群语音里「人说话」那一半的纯逻辑（#1176，ADR-0273；#1356 A4 从渲染层挪进 shared，手机端用同一份）：helper 的事件`
- `import type { SpeechEvent } from "../../../shared/shellBridge.js";` → `import type { SpeechEvent } from "./shellBridge.js";`
- `import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";` → `import type { WorkspaceSnapshot } from "./workspaces.js";`

`src/shared/helperAudio.ts`：
- 第 1 行 `// helperAudio —— 一段 TTS 字节交给语音 helper 播（#1201）。` 换成 `// helperAudio —— 一段 TTS 字节交给「别人的音频引擎」播（#1201；#1356 A4 挪进 shared：桌面是语音 helper，手机是原生模块）。`
- 头注里 `// 零 DOM；IPC 经 window.otter（硬规则：渲染层只走 ShellBridge）。` 换成 `// 零 DOM、零 IPC：真正交出去的那一下在注入的 bridge 里（桌面经 window.otter，手机经原生模块）。`
- `import type { PlayerAudio } from "./voicePlayer.js";` 不动（同目录）。
- `import type { SpeechEvent } from "../../../shared/shellBridge.js";` → `import type { SpeechEvent } from "./shellBridge.js";`

- [ ] **Step 3: 把 `src/shared/voicePlayer.ts` 的 Web Audio 那一半剪到新文件 `src/renderer/src/lib/webAudio.ts`**

从 `src/shared/voicePlayer.ts` 里**原样剪走**这一段：从 `/** AudioContext 用到的子集。经工厂注入：jsdom 里没有它，真机上惰性造一个共享的 */` 那一行起，到 `export function defaultCreateAudio(bytes: Uint8Array): PlayerAudio {` 那个函数的结尾 `}` 为止（含 `AudioContextLike`、`AudioBufferSourceNodeLike`、`webAudioPlayback`、`sharedCtx` / `sharedAudioContext`、`defaultCreateAudio`）。新建 `src/renderer/src/lib/webAudio.ts`，内容 = 下面这个头 + 剪下来的那一段原样粘在它后面：

```ts
// webAudio —— 桌面渲染层那条缺省的放音路：一段字节 → Web Audio（#1170）。VoicePlayer 的队列在
// src/shared/voicePlayer.ts（#1356 A4 挪进 shared，桌面与手机共用），这里只剩桌面专属的那一半。
//
// **为什么是 Web Audio 不是 `<audio src=blob:…>`**（#1170）：真机上 blob URL 被渲染层的 CSP
// 挡掉（`default-src 'self'`，没有 media-src），每段都是「这段音频播不出来」。Web Audio
// 解码的是内存里的字节，没有 URL，CSP 管不着；也不用 revoke blob。不放宽 CSP——那是安全
// 边界，为一段自己生成的音频开 `media-src blob:` 不是必要的。

import type { PlayerAudio } from "../../../shared/voicePlayer.js";
```

然后改 `src/shared/voicePlayer.ts` 剩下的部分：

把整个头注（第一行 `// voicePlayer —— 语音通话的串行播放队列（#1163）。` 起、到 `import type { VoiceSpeakResult }` 之前的所有注释行）换成：

```ts
// voicePlayer —— 语音通话的串行播放队列（#1163；#1356 A4 从渲染层挪进 shared，桌面与手机共用）。
//
// 群语音里一次只一只说话：队列全局串行（不按 agent 分），先到先播。合成一段要打一次
// 网关（真机 3 秒上下），所以**预取下一段**：播着第 n 段时第 n+1 段的合成已经在路上，
// 段与段之间不留空白。合成失败（没订阅 / 额度用完 / 网关抖）记成 error 跳过这段接着播
// 下一段——一段读不出来不该把整场通话卡死。
//
// 这个文件不碰任何放音 API：合成（speak）与「字节 → 能播的东西」（createAudio）都经 deps 注入，
// **createAudio 必填**——桌面给 Web Audio（src/renderer/src/lib/webAudio.ts）或语音 helper
// （helperAudio.ts），手机给原生模块。不给缺省值：缺省值只能是某一端的实现，放进 shared 就把
// 那一端的 API 带进了另一端。
```

`import type { VoiceSpeakResult } from "../../../shared/shellBridge.js";` → `import type { VoiceSpeakResult } from "./shellBridge.js";`

`VoicePlayerDeps` 里那一格：

```ts
  /** 字节 → 能播的东西。缺省：Web Audio（webAudioPlayback + 一个共享的 AudioContext） */
  createAudio?: (bytes: Uint8Array) => PlayerAudio;
```

换成：

```ts
  /** 字节 → 能播的东西。必填（见文件头）：桌面给 Web Audio 或语音 helper，手机给原生模块 */
  createAudio: (bytes: Uint8Array) => PlayerAudio;
```

构造函数里 `this.createAudio = deps.createAudio ?? defaultCreateAudio;` 换成 `this.createAudio = deps.createAudio;`。

- [ ] **Step 4: 改桌面的 import**

`src/renderer/src/store.ts` 第 106–109 行这四行：

```ts
import { EMPTY_VOICE_FEED, feedDelta, feedEvent, markInterrupted, type VoiceFeedState } from "./lib/voiceCall.js";
import { applySpeechEvent, bargeInOn, MIC_OFF, micShouldPause, SPEECH_LOCALE, speechHints, type MicState } from "./lib/voiceMic.js";
import { defaultCreateAudio, VoicePlayer } from "./lib/voicePlayer.js";
import { createHelperAudio, helperAudioEvent } from "./lib/helperAudio.js";
```

换成：

```ts
import { EMPTY_VOICE_FEED, feedDelta, feedEvent, markInterrupted, type VoiceFeedState } from "../../shared/voiceFeed.js";
import { applySpeechEvent, bargeInOn, MIC_OFF, micShouldPause, SPEECH_LOCALE, speechHints, type MicState } from "../../shared/voiceMic.js";
import { VoicePlayer } from "../../shared/voicePlayer.js";
import { defaultCreateAudio } from "./lib/webAudio.js";
import { createHelperAudio, helperAudioEvent } from "../../shared/helperAudio.js";
```

`src/renderer/src/components/CloudSessionPage.tsx` 第 101 行 `import { voiceCallAvailable } from "../lib/voiceCall.js";` → `import { voiceCallAvailable } from "../../../shared/voiceFeed.js";`

- [ ] **Step 5: 改测试的 import 路径，把 Web Audio 那一段测试拆出去**

`tests/shared/voiceFeed.test.ts`：`} from "../../src/renderer/src/lib/voiceCall.js";` → `} from "../../src/shared/voiceFeed.js";`；第 1 行注释 `// 渲染层语音引擎的纯逻辑（#1163）：语音钮画不画、一段文字读出来之前剥什么、` → `// 语音引擎的纯逻辑（#1163；#1356 A4 挪进 shared）：语音钮画不画、一段文字读出来之前剥什么、`。

`tests/shared/voiceMic.test.ts`：`from "../../src/renderer/src/lib/voiceMic.js";` → `from "../../src/shared/voiceMic.js";`

`tests/shared/voicePlayer.test.ts`：`import { VoicePlayer, type PlayerAudio, type VoicePlayerState } from "../../src/renderer/src/lib/voicePlayer.js";` → `import { VoicePlayer, type PlayerAudio, type VoicePlayerState } from "../../src/shared/voicePlayer.js";`。再把从 `// ── 默认播放适配走 Web Audio（#1170）` 那一行起到文件末尾的整段**剪走**，新建 `tests/renderer/webAudio.test.ts`：第一行 `import { describe, expect, it, vi } from "vitest";`，空一行，再粘剪下来的那一段，并把其中 `import { webAudioPlayback } from "../../src/renderer/src/lib/voicePlayer.js";` 改成 `import { webAudioPlayback } from "../../src/renderer/src/lib/webAudio.js";`。粘完跑一次 `npx vitest run tests/renderer/webAudio.test.ts`：若 tsc / vitest 报 `vi` 没用到之类，只删 import 里没用到的名字，用例一条不改。

`tests/renderer/voiceCallView.test.ts`、`tests/renderer/voiceCallOverlay.test.tsx`、`tests/renderer/voiceCallBar.test.tsx`：`import { MIC_OFF } from "../../src/renderer/src/lib/voiceMic.js";` → `import { MIC_OFF } from "../../src/shared/voiceMic.js";`

- [ ] **Step 6: 给 helperAudio 补测试**

Create `tests/shared/helperAudio.test.ts`：

```ts
// helperAudio（#1201；#1356 A4 挪进 shared）：一段字节交给「别人的音频引擎」放——桌面是语音 helper，
// 手机是原生模块。play() 拿到 id 就算起播；放完 / 放不了由事件回来叫醒那一段；停掉之后迟到的回执
// 仍然归放音（回 true，不交给麦克风那一侧），但不再叫醒谁。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelperAudio, helperAudioEvent, resetHelperAudio, type HelperAudioBridge } from "../../src/shared/helperAudio.js";

afterEach(() => resetHelperAudio());

function bridge(result: { id: string } | { error: string } = { id: "p1" }) {
  const handed: Uint8Array[] = [];
  let stops = 0;
  const b: HelperAudioBridge = {
    async play(bytes) {
      handed.push(bytes);
      return result;
    },
    async stop() {
      stops += 1;
    },
  };
  return { b, handed, stops: () => stops };
}

describe("helperAudio", () => {
  it("play 把字节交出去；played 回执叫醒 onended（回 true = 这条归放音）", async () => {
    const { b, handed } = bridge();
    const a = createHelperAudio(new Uint8Array([7]), b);
    const ended = vi.fn();
    a.onended = ended;
    await a.play();
    expect(handed).toEqual([new Uint8Array([7])]);
    expect(helperAudioEvent({ type: "played", id: "p1" })).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("playError 叫醒 onerror，带原文", async () => {
    const { b } = bridge();
    const a = createHelperAudio(new Uint8Array([1]), b);
    const err = vi.fn();
    a.onerror = err;
    await a.play();
    expect(helperAudioEvent({ type: "playError", id: "p1", message: "音频解不开" })).toBe(true);
    expect(err).toHaveBeenCalledWith("音频解不开");
  });

  it("停掉：叫一次 stop；迟到的回执仍归放音，但不再叫醒谁", async () => {
    const { b, stops } = bridge();
    const a = createHelperAudio(new Uint8Array([1]), b);
    const ended = vi.fn();
    a.onended = ended;
    await a.play();
    a.pause();
    expect(stops()).toBe(1);
    expect(helperAudioEvent({ type: "played", id: "p1" })).toBe(true);
    expect(ended).not.toHaveBeenCalled();
  });

  it("交不出去（error）→ play() 抛，调用方当这段放音失败", async () => {
    const { b } = bridge({ error: "没有语音模块" });
    await expect(createHelperAudio(new Uint8Array([1]), b).play()).rejects.toThrow("没有语音模块");
  });

  it("别的事件一律回 false（交还给麦克风那一侧）", () => {
    expect(helperAudioEvent({ type: "partial", text: "你好" })).toBe(false);
    expect(helperAudioEvent({ type: "listening", on: true })).toBe(false);
  });
});
```

- [ ] **Step 7: 跑受影响的测试与两边的 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/voiceFeed.test.ts tests/shared/voiceMic.test.ts tests/shared/voicePlayer.test.ts tests/shared/helperAudio.test.ts tests/renderer/webAudio.test.ts tests/renderer/voiceStore.test.ts tests/renderer/voiceCallView.test.ts tests/renderer/voiceCallOverlay.test.tsx tests/renderer/voiceCallBar.test.tsx tests/renderer/utteranceHoldWiring.test.ts tests/architecture.test.ts`
Expected: 全部 PASS（用例数与搬之前一样，外加 helperAudio 的 5 条）。

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx tsc --noEmit -p . 2>&1 | head -20`
Expected: 无输出。

- [ ] **Step 8: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add src/renderer/src/lib/webAudio.ts src/renderer/src/store.ts src/renderer/src/components/CloudSessionPage.tsx src/shared/voiceFeed.ts src/shared/voiceMic.ts src/shared/voicePlayer.ts src/shared/helperAudio.ts tests/shared/voiceFeed.test.ts tests/shared/voiceMic.test.ts tests/shared/voicePlayer.test.ts tests/shared/helperAudio.test.ts tests/renderer/webAudio.test.ts tests/renderer/voiceCallView.test.ts tests/renderer/voiceCallOverlay.test.tsx tests/renderer/voiceCallBar.test.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message（写进 `.superpowers/commit-msg.txt`）：

```
refactor(shared): 语音的四份纯逻辑从渲染层挪进 shared（#1356 A4）

手机端的电话要用同一份：读哪几句、怎么切句、麦克风状态机、串行放音队列、
把字节交给别人的音频引擎放。只挪不改断言，桌面行为不变：
- voiceCall.ts 改名 voiceFeed.ts（shared 里已经有一个 voiceCall.ts，那是通话名单的投影）；
- voicePlayer 拆两半：队列进 shared，createAudio 改成必填（缺省值只能是某一端的实现），
  Web Audio 那一半留在渲染层，叫 webAudio.ts；
- helperAudio 挪进 shared 并补上测试（原来一条都没有）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 2: 主进程的三份语音纯逻辑挪进 shared

手机端要：验原生模块吐来的事件（桌面在 `speechBridge.ts` 的 `decodeSpeechEvent` 里验 helper 那一行 JSON，验形那半抽出来两端共用）、判语音合成走不走得通（`modelRoute.ts` 的 `ttsBlocked` / `routeTts`）、打网关合成一段（`teamVoice.ts`）。**只挪不改断言**。`fmtReset`（额度窗口几点恢复）在 `modelRoute.ts` 里还有两处别的用法，挪进 `billingView.ts` 叫 `resetClockText`，`modelRoute` 改调它。

**Files:**
- Create: `src/shared/speechEvent.ts`；Modify: `src/main/speechBridge.ts`
- Create: `src/shared/ttsRoute.ts`；Modify: `src/main/modelRoute.ts`、`src/shared/billingView.ts`
- Move: `src/main/teamVoice.ts` → `src/shared/ttsClient.ts`；Modify: `src/main/index.ts`
- Test: Create `tests/shared/speechEvent.test.ts`、`tests/shared/ttsRoute.test.ts`；Move `tests/main/teamVoice.test.ts` → `tests/shared/ttsClient.test.ts`；Modify `tests/main/modelRoute.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `src/shared/speechEvent.ts`：`speechEventOf(o: unknown): SpeechEvent | null`
  - `src/shared/billingView.ts`：`resetClockText(ms: number): string`
  - `src/shared/ttsRoute.ts`：`interface TtsRouteInput { hosted?: { subscribed: boolean; exhausted: boolean; resetAt?: number; ttsModels: string[] }; hostedBaseUrl?: string; hostedToken?: string }`、`type TtsRoute`、`ttsBlocked(hosted: TtsRouteInput["hosted"]): string | null`、`routeTts(input: TtsRouteInput): TtsRoute`、`ttsHostedOf(billing: BillingSnapshotView | null): TtsRouteInput["hosted"]`
  - `src/shared/ttsClient.ts`：`interface TtsQuotaPort { ttsInput(): TtsRouteInput["hosted"]; noteHeaders(h: Headers): void; noteExhausted(info: { window?: "5h" | "week"; resetAt?: number }): void }`、`interface TtsClientDeps { quota: TtsQuotaPort; edgeBaseUrl: () => string; accessToken: () => Promise<string | null>; fetchImpl?: typeof fetch }`、`interface TtsClient { speak(text: string, voiceId: string): Promise<VoiceSpeakResult> }`、`createTtsClient(deps: TtsClientDeps): TtsClient`

- [ ] **Step 1: 写 speechEventOf 的测试（RED）**

Create `tests/shared/speechEvent.test.ts`：

```ts
// speechEventOf（#1176；#1356 A4 抽进 shared）：识别那一侧吐的一条事件 → SpeechEvent。桌面 helper 一行
// JSON（speechBridge 先 JSON.parse）与手机原生模块递来的对象走同一份验形；形状不对一律 null。
import { describe, expect, it } from "vitest";
import { speechEventOf } from "../../src/shared/speechEvent.js";

describe("speechEventOf", () => {
  it("status：两道授权必须是认得的四档之一；onDevice / locale / aec 缺席或类型不对 → null 那一格", () => {
    expect(speechEventOf({ type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: false })).toEqual({
      type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: false,
    });
    expect(speechEventOf({ type: "status", speech: "authorized", mic: "authorized" })).toEqual({
      type: "status", speech: "authorized", mic: "authorized", onDevice: null, locale: null, aec: null,
    });
    expect(speechEventOf({ type: "status", speech: "maybe", mic: "authorized" })).toBeNull();
  });
  it("partial / final 要 text；level 要有限的数；played 要 id；playError 要 id + message", () => {
    expect(speechEventOf({ type: "final", text: "帮我看下" })).toEqual({ type: "final", text: "帮我看下" });
    expect(speechEventOf({ type: "partial" })).toBeNull();
    expect(speechEventOf({ type: "level", value: 0.4, active: true })).toEqual({ type: "level", value: 0.4, active: true });
    expect(speechEventOf({ type: "level", value: Number.NaN })).toBeNull();
    expect(speechEventOf({ type: "played", id: "v1" })).toEqual({ type: "played", id: "v1" });
    expect(speechEventOf({ type: "played" })).toBeNull();
    expect(speechEventOf({ type: "playError", id: "v1", message: "音频解不开" })).toEqual({ type: "playError", id: "v1", message: "音频解不开" });
    expect(speechEventOf({ type: "playError", id: "v1" })).toBeNull();
  });
  it("不认得的 type、null、原始值 → null", () => {
    expect(speechEventOf({ type: "teleport" })).toBeNull();
    expect(speechEventOf(null)).toBeNull();
    expect(speechEventOf("final")).toBeNull();
    expect(speechEventOf(42)).toBeNull();
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/speechEvent.test.ts`
Expected: FAIL（`Cannot find module ... speechEvent.js`）

- [ ] **Step 2: 抽出 speechEventOf**

Create `src/shared/speechEvent.ts`：

```ts
// speechEvent —— 识别那一侧吐出来的一条事件 → SpeechEvent（#1176；#1356 A4 从主进程抽进 shared）。
//
// 两个来源、一份判据：桌面的 Swift helper 一行一条 JSON（主进程 speechBridge 先 JSON.parse），
// 手机的原生模块直接递一个对象（Expo 的 sendEvent）。形状不对一律 null——坏事件只可能是两边的
// 协议漂了，放进来只会让麦克风那一格画出一个对不上的状态。

import type { SpeechAuth, SpeechEvent } from "./shellBridge.js";

const AUTH: ReadonlySet<string> = new Set<SpeechAuth>(["authorized", "denied", "restricted", "notDetermined"]);
const isAuth = (v: unknown): v is SpeechAuth => typeof v === "string" && AUTH.has(v);

export function speechEventOf(o: unknown): SpeechEvent | null {
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  switch (e.type) {
    case "status":
      if (!isAuth(e.speech) || !isAuth(e.mic)) return null;
      return {
        type: "status",
        speech: e.speech,
        mic: e.mic,
        onDevice: typeof e.onDevice === "boolean" ? e.onDevice : null,
        locale: typeof e.locale === "string" ? e.locale : null,
        aec: typeof e.aec === "boolean" ? e.aec : null,
      };
    case "listening":
      return typeof e.on === "boolean" ? { type: "listening", on: e.on } : null;
    case "paused":
      return { type: "paused" };
    case "resumed":
      return { type: "resumed" };
    case "partial":
    case "final":
      return typeof e.text === "string" ? { type: e.type, text: e.text } : null;
    case "level":
      return typeof e.value === "number" && Number.isFinite(e.value)
        ? { type: "level", value: e.value, active: e.active === true }
        : null;
    case "played":
      return typeof e.id === "string" ? { type: "played", id: e.id } : null;
    case "playError":
      return typeof e.id === "string" && typeof e.message === "string" ? { type: "playError", id: e.id, message: e.message } : null;
    case "error":
      return typeof e.message === "string" ? { type: "error", message: e.message } : null;
    default:
      return null;
  }
}
```

改 `src/main/speechBridge.ts`：
- `import type { SpeechAuth, SpeechEvent } from "../shared/shellBridge.js";` → `import type { SpeechEvent } from "../shared/shellBridge.js";` 并在它下面加一行 `import { speechEventOf } from "../shared/speechEvent.js";`
- 删掉 `const AUTH: ReadonlySet<string> = …` 与 `const isAuth = …` 那两行。
- `decodeSpeechEvent` 整个函数换成：

```ts
/** helper 吐的一行 → 事件；形状不对一律 null（stderr 不走这条管子，坏行只可能是协议漂了）。
    验形那半在 shared（speechEventOf，手机原生模块递来的对象走同一份） */
export function decodeSpeechEvent(line: string): SpeechEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  return speechEventOf(o);
}
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/speechEvent.test.ts tests/main/speechBridge.test.ts`
Expected: PASS

- [ ] **Step 3: 挪 ttsBlocked / routeTts，加 ttsHostedOf（先写测试）**

Create `tests/shared/ttsRoute.test.ts`。它的 `describe("routeTts", …)` 那一整块**原样**从 `tests/main/modelRoute.test.ts` 剪过来（从 `// ── 语音那条路（#1163）` 那段注释起，到 `describe("routeTts"` 那一块结束的 `});` 为止，一个字都不改），放在下面这个文件头之后、`ttsHostedOf` 那一块之前：

```ts
// ttsRoute（#1163；#1356 A4 从主进程挪进 shared）：语音合成走不走得通、四种 blocked 各说各的话；
// 手机端用的 ttsHostedOf 把一份订阅快照翻成 routeTts 要的那一格。
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import { routeTts, ttsBlocked, ttsHostedOf } from "../../src/shared/ttsRoute.js";

// （这里粘从 tests/main/modelRoute.test.ts 剪过来的 routeTts 那一块）

describe("ttsHostedOf（#1356 A4，手机端）", () => {
  const me = (over: Partial<BillingMe> = {}): BillingMe => ({
    plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
    models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
  });
  const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 0, exhausted: null });

  it("还没查到（null / me 为 null）→ undefined（ttsBlocked 据此说要订阅，调用方此时本来就不画钮）", () => {
    expect(ttsHostedOf(null)).toBeUndefined();
    expect(ttsHostedOf(snap(null))).toBeUndefined();
    expect(ttsBlocked(ttsHostedOf(null))).toContain("订阅");
  });
  it("订阅活跃：subscribed、exhausted 恒为 false（额度用完由网关的 429 当场说）、清单原样", () => {
    expect(ttsHostedOf(snap(me()))).toEqual({ subscribed: true, exhausted: false, ttsModels: ["speech-2.8-turbo"] });
    expect(ttsBlocked(ttsHostedOf(snap(me())))).toBeNull();
  });
  it("past_due / 没订阅 → subscribed false；网关不供语音 → 说不供，不说没订阅", () => {
    expect(ttsHostedOf(snap(me({ status: "past_due" })))?.subscribed).toBe(false);
    expect(ttsHostedOf(snap(me({ status: "none", plan: null })))?.subscribed).toBe(false);
    const blocked = ttsBlocked(ttsHostedOf(snap(me({ ttsModels: [] }))));
    expect(blocked).toContain("语音");
    expect(blocked).not.toContain("没有订阅");
  });
});
```

剪完之后把 `tests/main/modelRoute.test.ts` 第 2 行 `import { routeImage, routeModel, routeTts } from "../../src/main/modelRoute.js";` 改成 `import { routeImage, routeModel } from "../../src/main/modelRoute.js";`。

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/ttsRoute.test.ts`
Expected: FAIL（`Cannot find module ... ttsRoute.js`）

- [ ] **Step 4: 实现 ttsRoute 与 resetClockText，改 modelRoute**

在 `src/shared/billingView.ts` 末尾加：

```ts
/** 额度窗口几点恢复，按本地时间报「HH:MM」（#1356 A4 从主进程 modelRoute 的 fmtReset 挪来：
    模型路由 / 出图 / 语音三句 blocked 共用，语音那句手机端也要） */
export function resetClockText(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
```

Create `src/shared/ttsRoute.ts`：先写下面这个头与 import；然后把 `src/main/modelRoute.ts` 里语音那一段（从 `// ── 语音那条路（#1163）` 那段注释起，到 `export function routeTts` 那个函数的结尾 `}` 为止：`TtsRouteInput`、`TtsRoute`、`ttsBlocked`、`routeTts`）**原样剪过来**粘在 import 之后，其中 `fmtReset(` 一律换成 `resetClockText(`；最后在文件末尾加 `ttsHostedOf`：

```ts
// ttsRoute —— 语音合成走不走得通（#1163；#1356 A4 从主进程 modelRoute.ts 挪进 shared，手机端用同一份）。
import { resetClockText } from "./billingView.js";
import type { BillingSnapshotView } from "./shellBridge.js";

// （这里粘从 modelRoute.ts 剪过来的语音那一段，fmtReset → resetClockText）

/** 一份订阅快照 → routeTts 要的那一格（#1356 A4，手机端用）。手机没有桌面 hostedQuota 那份实时额度账，
    额度用完由网关的 429 当场说出口，所以 `exhausted` 恒为 false；还没查到（null / me 为 null）→ undefined */
export function ttsHostedOf(billing: BillingSnapshotView | null): TtsRouteInput["hosted"] {
  const me = billing?.me;
  if (!me) return undefined;
  return { subscribed: me.status === "active" && me.plan !== null, exhausted: false, ttsModels: me.ttsModels };
}
```

改 `src/main/modelRoute.ts`：删掉 `const fmtReset = (ms: number): string =>` 那两行；在 import 区加一行 `import { resetClockText } from "../shared/billingView.js";`；剩下两处 `fmtReset(` 换成 `resetClockText(`；语音那一段已经剪走。

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/ttsRoute.test.ts tests/main/modelRoute.test.ts`
Expected: PASS

- [ ] **Step 5: 挪 teamVoice → ttsClient**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git mv src/main/teamVoice.ts src/shared/ttsClient.ts && git mv tests/main/teamVoice.test.ts tests/shared/ttsClient.test.ts
```

把 `src/shared/ttsClient.ts` 整个换成（函数体与原来逐行相同，只改名字、头注与 import）：

```ts
// ttsClient —— 合成一段语音（#1163 桌面主进程那一半；#1356 A4 挪进 shared，手机端用同一份）。
//
// 路是「客户端 → edge 网关 `/llm/v1/speech` → MiniMax」（同 generate_image 那条路，ADR-0257）：
// 官方 key 只在 Worker secret 里，客户端一个字节都拿不到；钱走**听的人**自己的订阅额度（自己的 JWT），
// 所以 hold/settle/usage_event 整套现成。
//
// 判据全挂在 routeTts 上（ttsRoute.ts）：没订阅 / 额度用完 / 网关不供语音 / 拿不到 JWT —— 这四种一个
// 字节都不发，各自一句人话。额度头与 chat 那条路同一份纪律：成功就 noteHeaders，429 quota_exhausted
// 就 noteExhausted——桌面接 hostedQuota（界面上那枚环跟着动），手机没有那份账，两个口接空。

import { BILLING_HEADERS, parseBillingError } from "./billing.js";
import type { VoiceSpeakResult } from "./shellBridge.js";
import { TTS_HEADERS } from "./tts.js";
import { routeTts, type TtsRouteInput } from "./ttsRoute.js";

/** 额度那三个口：桌面是 hostedQuota（结构上就是它），手机是一份订阅快照 + 两个空口 */
export interface TtsQuotaPort {
  ttsInput(): TtsRouteInput["hosted"];
  noteHeaders(h: Headers): void;
  noteExhausted(info: { window?: "5h" | "week"; resetAt?: number }): void;
}

export interface TtsClientDeps {
  quota: TtsQuotaPort;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface TtsClient {
  speak(text: string, voiceId: string): Promise<VoiceSpeakResult>;
}

const numberHeader = (h: Headers, name: string): number | null => {
  const raw = h.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function createTtsClient(deps: TtsClientDeps): TtsClient {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async speak(text, voiceId) {
      const token = await deps.accessToken();
      const route = routeTts({
        hosted: deps.quota.ttsInput(),
        hostedBaseUrl: `${deps.edgeBaseUrl()}/llm/v1`,
        ...(token ? { hostedToken: token } : {}),
      });
      if (route.kind === "blocked") return { ok: false, message: route.reason };
      let res: Response;
      try {
        res = await doFetch(route.url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: route.model, text, voice_id: voiceId }),
        });
      } catch (err) {
        return { ok: false, message: `连不上订阅网关：${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const e = parseBillingError(res.status, payload);
        if (e?.code === "quota_exhausted") {
          deps.quota.noteExhausted({ ...(e.window ? { window: e.window } : {}), ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}) });
        }
        return { ok: false, message: e?.message ?? `语音合成失败（HTTP ${res.status}）` };
      }
      deps.quota.noteHeaders(res.headers);
      const audio = new Uint8Array(await res.arrayBuffer());
      return {
        ok: true,
        audio,
        costMicro: numberHeader(res.headers, BILLING_HEADERS.cost) ?? 0,
        audioMs: numberHeader(res.headers, TTS_HEADERS.audioMs),
      };
    },
  };
}
```

**注意**：粘之前先 `diff` 一眼原 `teamVoice.ts` 的函数体（`git show HEAD:src/main/teamVoice.ts`），若原文与上面这段有出入（比如多一个分支），以原文为准、只改名字——这一步是搬家，不是重写。

改 `src/main/index.ts`：`import { createTeamVoice } from "./teamVoice.js";` → `import { createTtsClient } from "../shared/ttsClient.js";`；`const teamVoice = createTeamVoice(hostedDeps);` → `const teamVoice = createTtsClient(hostedDeps);`

改 `tests/shared/ttsClient.test.ts`：第 1 行注释 `// teamVoice（#1163）：主进程替渲染层合成一段语音——拿 JWT 打网关的 /llm/v1/speech，` → `// ttsClient（#1163；#1356 A4 挪进 shared）：替调用方合成一段语音——拿 JWT 打网关的 /llm/v1/speech，`；`import { createTeamVoice } from "../../src/main/teamVoice.js";` → `import { createTtsClient } from "../../src/shared/ttsClient.js";`；文件里 `createTeamVoice(` 一律换成 `createTtsClient(`。用例一条不改。

- [ ] **Step 6: 跑受影响的测试与 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/speechEvent.test.ts tests/shared/ttsRoute.test.ts tests/shared/ttsClient.test.ts tests/main/modelRoute.test.ts tests/main/speechBridge.test.ts tests/architecture.test.ts && npx tsc --noEmit -p . 2>&1 | head -20`
Expected: 全部 PASS；tsc 无输出。

- [ ] **Step 7: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add src/shared/speechEvent.ts src/main/speechBridge.ts src/shared/ttsRoute.ts src/shared/billingView.ts src/main/modelRoute.ts src/shared/ttsClient.ts src/main/index.ts tests/shared/speechEvent.test.ts tests/shared/ttsRoute.test.ts tests/shared/ttsClient.test.ts tests/main/modelRoute.test.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
refactor(shared): 识别事件的验形、语音合成的路由与客户端挪进 shared（#1356 A4）

手机端的原生模块递来的事件、打网关合成一段语音、判这台能不能说话，与桌面是同一份判据：
- speechEventOf：从 speechBridge.decodeSpeechEvent 抽出验形那一半，
  桌面 helper 的一行 JSON 与手机原生模块的对象走同一份；
- ttsRoute：ttsBlocked / routeTts 从 modelRoute 挪来，外加手机用的 ttsHostedOf
  （订阅快照 → routeTts 要的那一格）；fmtReset 挪进 billingView 叫 resetClockText，
  modelRoute 另外两处改调它；
- ttsClient：原 main/teamVoice.ts，改名 createTtsClient，额度那三个口改成注入的端口
  （桌面接 hostedQuota，结构上就是它）。
只挪不改断言，桌面行为不变。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 3: 一台设备上的语音编排 `voiceSession`

手机端不进 vitest，而语音这一层是整条链上最容易出安静错的（断线、迟到的事件、半双工的开关、插嘴）。所以编排写进 shared、用假端口测：加入 / 离开、读谁的话（通话名单里那几只、加入之后落下来的）、半双工与插嘴、一句说完发出去、云端断线的收口。语义逐条照桌面 store 的语音那一段（`src/renderer/src/store.ts` 的 `joinVoiceCall` / `leaveVoiceCall` / `setVoiceMic` / `speechOnEvent` / `voiceOnEvent` / `voiceOnDelta` / `voiceOnCloudState`，#1163 / #1176 / #1184 / #1289），差别三处写在文件头。另有一处小改：`voiceMic.applySpeechEvent` 那句「没权限」按平台说（手机不能指「系统设置 → 隐私与安全性」）。

**Files:**
- Modify: `src/shared/voiceMic.ts`（`permissionHelp` → 导出的 `PermissionHelp` + 两句）
- Create: `src/shared/voiceSession.ts`
- Test: Modify `tests/shared/voiceMic.test.ts`（加一块）；Create `tests/shared/voiceSession.test.ts`

**Interfaces:**
- Consumes（Task 1 / 2）：`voiceFeed`（`EMPTY_VOICE_FEED` / `feedDelta` / `feedEvent` / `markInterrupted` / `Utterance` / `VoiceFeedState`）、`voiceMic`（`applySpeechEvent` / `bargeInOn` / `MIC_OFF` / `micShouldPause` / `MicState`）、`voicePlayer`（`VoicePlayer` / `PlayerAudio`）、`voiceCall.voiceCallOf`、`agentVoice.agentVoiceId(agentId, roster)`。
- Produces:
  - `src/shared/voiceMic.ts`：`type PermissionHelp = (which: "麦克风" | "语音识别") => string`、`MAC_PERMISSION_HELP: PermissionHelp`、`IOS_PERMISSION_HELP: PermissionHelp`、`applySpeechEvent(state: MicState, ev: SpeechEvent, help?: PermissionHelp)`（缺省 = `MAC_PERMISSION_HELP`）
  - `src/shared/voiceSession.ts`：
    - `type VoiceRoomState = "connecting" | "ready" | "gone" | "denied"`
    - `interface VoiceListen { sessionId: string; sinceSeq: number; speaking: string | null; queued: number; text: string | null; error: string | null; mic: MicState }`
    - `interface VoiceMicPort { start(hints: string[]): void; stop(): void; pause(): void; resume(): void }`
    - `interface VoiceSessionDeps { speak(text: string, voiceId: string): Promise<VoiceSpeakResult>; createAudio(bytes: Uint8Array): PlayerAudio; mic: VoiceMicPort; say(text: string): Promise<CloudAck>; events(sessionId: string): readonly SessionEvent[] | null; roster(): readonly string[]; hints(): string[]; permissionHelp: PermissionHelp; onChange(listen: VoiceListen | null): void }`
    - `interface VoiceSession { state(): VoiceListen | null; join(sessionId: string): void; leave(): void; setMic(on: boolean): void; onEvent(e: SessionEvent): void; onDelta(d: CloudSessionDelta): void; onSpeech(ev: SpeechEvent): void; onRoomState(sessionId: string, prev: VoiceRoomState, next: VoiceRoomState): void }`
    - `createVoiceSession(deps: VoiceSessionDeps): VoiceSession`

- [ ] **Step 1: 授权那句的测试（RED）**

在 `tests/shared/voiceMic.test.ts` 末尾加（并把文件顶上那行 `import { … } from "../../src/shared/voiceMic.js";` 的名字表里补上 `IOS_PERMISSION_HELP, MAC_PERMISSION_HELP`）：

```ts
describe("applySpeechEvent：没权限那句按平台说（#1356 A4）", () => {
  const denied = { type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: null } as const;
  it("缺省是桌面那句（macOS 的系统设置 → 隐私与安全性）", () => {
    expect(applySpeechEvent(MIC_OFF, denied).state.error).toBe(MAC_PERMISSION_HELP("麦克风"));
    expect(MAC_PERMISSION_HELP("麦克风")).toContain("隐私与安全性");
  });
  it("手机给 IOS_PERMISSION_HELP：指 iPhone 的「设置」→ Mr Otto，不提 Electron", () => {
    const r = applySpeechEvent(MIC_OFF, denied, IOS_PERMISSION_HELP);
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toBe(IOS_PERMISSION_HELP("麦克风"));
    expect(r.state.error).toContain("iPhone");
    expect(r.state.error).not.toContain("Electron");
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/voiceMic.test.ts`
Expected: FAIL（`MAC_PERMISSION_HELP` 不存在）

- [ ] **Step 2: 改 voiceMic**

`src/shared/voiceMic.ts` 里：

```ts
function permissionHelp(which: "麦克风" | "语音识别"): string {
  return `没有「${which}」权限：系统设置 → 隐私与安全性 → ${which}，勾上 Mr Otto（开发时是 Electron / MrOttoSpeech），然后重新开麦。`;
}

/** 一条 helper 事件进来。`final` 在场 = 这一句说完了，调用方拿去发；空串不交出 */
export function applySpeechEvent(state: MicState, ev: SpeechEvent): { state: MicState; final?: string } {
```

换成：

```ts
/** 没权限那句话怎么说：去哪儿打开因平台而异（#1356 A4）。判据（哪一道没过、之后的 error 不盖掉它）只有一份 */
export type PermissionHelp = (which: "麦克风" | "语音识别") => string;

export const MAC_PERMISSION_HELP: PermissionHelp = (which) =>
  `没有「${which}」权限：系统设置 → 隐私与安全性 → ${which}，勾上 Mr Otto（开发时是 Electron / MrOttoSpeech），然后重新开麦。`;

export const IOS_PERMISSION_HELP: PermissionHelp = (which) =>
  `没有「${which}」权限：打开 iPhone 的「设置」→ Mr Otto，把「${which}」打开，然后点一下麦克风。`;

/** 一条 helper 事件进来。`final` 在场 = 这一句说完了，调用方拿去发；空串不交出。
    `help` 缺省是桌面那句（macOS 的系统设置），手机给 IOS_PERMISSION_HELP */
export function applySpeechEvent(state: MicState, ev: SpeechEvent, help: PermissionHelp = MAC_PERMISSION_HELP): { state: MicState; final?: string } {
```

同一个函数里 `error: permissionHelp(denied)` → `error: help(denied)`。

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/voiceMic.test.ts`
Expected: PASS

- [ ] **Step 3: voiceSession 的测试（RED）**

Create `tests/shared/voiceSession.test.ts`：

```ts
// voiceSession（#1356 A4）：一台设备上的语音编排。语义逐条照桌面 store 的语音那一段
// （tests/renderer/voiceStore.test.ts 钉的是桌面那一份），这里用假端口钉手机用的这一份。
import { describe, expect, it } from "vitest";
import { agentVoiceId } from "../../src/shared/agentVoice.js";
import type { CloudAck, SpeechEvent, VoiceSpeakResult } from "../../src/shared/shellBridge.js";
import { IOS_PERMISSION_HELP } from "../../src/shared/voiceMic.js";
import type { PlayerAudio } from "../../src/shared/voicePlayer.js";
import { createVoiceSession, type VoiceListen, type VoiceSessionDeps } from "../../src/shared/voiceSession.js";
import type { SessionEvent } from "../../src/session/events.js";

const S = "s1";
const at = (seq: number) => ({ sessionId: S, ts: 1000 + seq, seq });
const callOn = (seq: number, ids: string[]): SessionEvent =>
  ({ ...at(seq), type: "voice_call_changed", participants: ids.map((agentId) => ({ agentId, name: agentId })), byUid: "u1", ignorable: true }) as SessionEvent;
const reply = (seq: number, agentId: string, content: string): SessionEvent =>
  ({ ...at(seq), type: "assistant_message", content, model: "m", agentId }) as SessionEvent;
const ended = (seq: number, agentId: string): SessionEvent =>
  ({ ...at(seq), type: "turn_ended", outcome: "completed", agentId }) as SessionEvent;

interface FakeAudio extends PlayerAudio { end(): void }

function harness(o: { events?: SessionEvent[]; say?: (text: string) => CloudAck } = {}) {
  let events: SessionEvent[] = o.events ?? [callOn(1, ["a"])];
  const mic: string[] = [];
  const spoke: { text: string; voiceId: string }[] = [];
  const said: string[] = [];
  const audios: FakeAudio[] = [];
  const changes: (VoiceListen | null)[] = [];
  const deps: VoiceSessionDeps = {
    speak: async (text, voiceId): Promise<VoiceSpeakResult> => {
      spoke.push({ text, voiceId });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
    },
    createAudio: () => {
      const a: FakeAudio = { onended: null, onerror: null, async play() {}, pause() {}, end() { a.onended?.(); } };
      audios.push(a);
      return a;
    },
    mic: {
      start: (hints) => mic.push(`start:${hints.join(",")}`),
      stop: () => mic.push("stop"),
      pause: () => mic.push("pause"),
      resume: () => mic.push("resume"),
    },
    say: async (text) => {
      said.push(text);
      return o.say ? o.say(text) : { ok: true };
    },
    events: (sessionId) => (sessionId === S ? events : null),
    roster: () => ["a", "b"],
    hints: () => ["开发"],
    permissionHelp: IOS_PERMISSION_HELP,
    onChange: (v) => changes.push(v),
  };
  const v = createVoiceSession(deps);
  const push = (e: SessionEvent): void => {
    events = [...events, e];
    v.onEvent(e);
  };
  return { v, mic, spoke, said, audios, changes, push };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const listening: SpeechEvent = { type: "listening", on: true };
const status = (aec: boolean | null): SpeechEvent => ({ type: "status", speech: "authorized", mic: "authorized", onDevice: true, locale: "zh-CN", aec });

describe("voiceSession", () => {
  it("加入：sinceSeq = 此刻的日志尾、开麦（带词表）、mic 在 starting；原生报 listening → listening", () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "旧话。")] });
    h.v.join(S);
    expect(h.v.state()?.sinceSeq).toBe(2);
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
    h.v.onSpeech(listening);
    expect(h.v.state()?.mic.status).toBe("listening");
    expect(h.changes.at(-1)?.mic.status).toBe("listening");
  });

  it("加入之后通话里那只的回复读出来，音色按 agentId 派生；加入之前的不读；通话外的不读", async () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "旧话。")] });
    h.v.join(S);
    h.push(reply(3, "a", "新的一句。"));
    h.push(reply(4, "b", "我不在通话里。"));
    await flush();
    expect(h.spoke).toEqual([{ text: "新的一句。", voiceId: agentVoiceId("a", ["a", "b"]) }]);
  });

  it("流式：写完的句先出声，终态只补没读过的", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onDelta({ sessionId: S, agentId: "a", kind: "content", text: "第一句。第二" });
    await flush();
    expect(h.spoke.map((s) => s.text)).toEqual(["第一句。"]);
    h.audios[0]!.end();
    h.push(reply(2, "a", "第一句。第二句。"));
    await flush();
    expect(h.spoke.map((s) => s.text)).toEqual(["第一句。", "第二句。"]);
  });

  it("推理碎片（reasoning）不读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onDelta({ sessionId: S, agentId: "a", kind: "reasoning", text: "我想想。" });
    await flush();
    expect(h.spoke).toEqual([]);
  });

  it("通话结束（空名单落下来）→ 停麦、停放音、离开（state 为 null）", () => {
    const h = harness();
    h.v.join(S);
    h.push({ ...at(2), type: "voice_call_changed", participants: [], byUid: "u1", ignorable: true } as SessionEvent);
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.changes.at(-1)).toBeNull();
  });

  it("半双工：没有回声消除时它一开口就闭麦，说完再开", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(status(false));
    h.v.onSpeech(listening);
    h.push(reply(2, "a", "你好。"));
    await flush();
    expect(h.mic).toEqual(["start:开发", "pause"]);
    h.audios[0]!.end();
    await flush();
    expect(h.mic).toEqual(["start:开发", "pause", "resume"]);
  });

  it("有回声消除：它说话时不闭麦；人插嘴（够长）→ 停放音，这只这一轮剩下的不读；下一轮照读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(status(true));
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "level", value: 0.5, active: true });
    h.push(reply(2, "a", "第一句。第二句。"));
    await flush();
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.speaking).toBe("a");
    h.v.onSpeech({ type: "partial", text: "等一下我有个问题" });
    await flush();
    expect(h.v.state()?.speaking).toBeNull();
    h.push(reply(3, "a", "第三句。"));
    h.push(ended(4, "a"));
    h.push(reply(5, "a", "新一轮。"));
    await flush();
    const texts = h.spoke.map((s) => s.text);
    expect(texts).not.toContain("第三句。");
    expect(texts.at(-1)).toBe("新一轮。");
  });

  it("一句说完（final）→ 发出去；发不出去那句话写进 mic.error", async () => {
    const h = harness({ say: () => ({ ok: false, message: "说得太快了，歇一下" }) });
    h.v.join(S);
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "final", text: " 帮我看一下 " });
    await flush();
    expect(h.said).toEqual(["帮我看一下"]);
    expect(h.v.state()?.mic.error).toBe("说得太快了，歇一下");
  });

  it("关麦 → stop、状态 off，之后迟到的事件不再动状态；开麦 → 再 start", () => {
    const h = harness();
    h.v.join(S);
    h.v.setMic(false);
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.v.state()?.mic.status).toBe("off");
    h.v.onSpeech({ type: "partial", text: "迟到的" });
    expect(h.v.state()?.mic.transcript).toBe("");
    h.v.setMic(true);
    expect(h.mic).toEqual(["start:开发", "stop", "start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("没权限：说手机那句（iPhone 的设置），之后的 error 不盖掉它", () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech({ type: "status", speech: "authorized", mic: "denied", onDevice: null, locale: null, aec: null });
    h.v.onSpeech({ type: "error", message: "没有「麦克风」权限" });
    expect(h.v.state()?.mic.status).toBe("denied");
    expect(h.v.state()?.mic.error).toBe(IOS_PERMISSION_HELP("麦克风"));
  });

  it("房间 gone：停麦、mic 归 off 但留着那句错误，通话保留；回到 ready 麦自己开回来", () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "error", message: "识别中断，正在重试" });
    h.v.onRoomState(S, "ready", "gone");
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.v.state()?.mic.status).toBe("off");
    expect(h.v.state()?.mic.error).toBe("识别中断，正在重试");
    expect(h.v.state()).not.toBeNull();
    h.v.onRoomState(S, "gone", "connecting");
    h.v.onRoomState(S, "connecting", "ready");
    expect(h.mic).toEqual(["start:开发", "stop", "start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("断线之前人自己关着麦 → 回到 ready 一个字都不动（他表达过意志）", () => {
    const h = harness();
    h.v.join(S);
    h.v.setMic(false);
    h.v.onRoomState(S, "ready", "gone");
    h.v.onRoomState(S, "gone", "ready");
    expect(h.mic).toEqual(["start:开发", "stop"]);
  });

  it("denied 是终态：整段收掉", () => {
    const h = harness();
    h.v.join(S);
    h.v.onRoomState(S, "ready", "denied");
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
  });

  it("别条会话的推送不碰这条；同一个状态再推一遍什么都不做", () => {
    const h = harness();
    h.v.join(S);
    h.v.onRoomState("other", "ready", "gone");
    h.v.onRoomState(S, "ready", "ready");
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("离开：停麦、停放音、state 为 null；之后落下来的回复不再读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.leave();
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
    h.push(reply(2, "a", "还读吗。"));
    await flush();
    expect(h.spoke).toEqual([]);
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/voiceSession.test.ts`
Expected: FAIL（`Cannot find module ... voiceSession.js`）

- [ ] **Step 4: 实现 voiceSession**

Create `src/shared/voiceSession.ts`：

```ts
// voiceSession —— 语音通话在一台设备上的编排（#1356 A4，ADR-0320）：加入 / 离开、谁的回复读出来、
// 麦克风开关与半双工、一句说完发出去、人插嘴、云端断线时怎么收口。纯逻辑 + 注入的端口，进 vitest；
// 手机端的 mobile/src/voice/voiceStore.ts 只接线（原生模块、TTS 网关、聊天那条连接）。
//
// 判据全是桌面同一份（voiceFeed / voiceMic / voicePlayer / voiceCall / agentVoice）；这里是把它们串起来
// 的那一层，语义逐条照桌面 store 的语音那一段（#1163 / #1176 / #1184 / #1289），差别三处：
// ① 没有「扣住 / 合并」那扇窗（#1281 的决策模型断句，走主进程的 IPC，桌面专属）——一句说完就发；
// ② 没有「静音 = 本机不播」：手机上那颗静音是关麦（spec §5.7 / demo），这一层只有 setMic；
// ③ 放音走哪条路由注入的 createAudio 决定（手机一律交给原生模块自己的音频引擎，ADR-0280），这一层不知道。
// 桌面 store 的语音编排还没改用这一份（多一扇 ① 那扇窗，源码里还钉着 utteranceHoldWiring 那几条断言），
// 两份编排并存是已知代价，见 ADR-0320。

import type { SessionEvent } from "../session/events.js";
import { agentVoiceId } from "./agentVoice.js";
import type { CloudAck, CloudSessionDelta, SpeechEvent, VoiceSpeakResult } from "./shellBridge.js";
import { voiceCallOf } from "./voiceCall.js";
import { EMPTY_VOICE_FEED, feedDelta, feedEvent, markInterrupted, type Utterance, type VoiceFeedState } from "./voiceFeed.js";
import { applySpeechEvent, bargeInOn, MIC_OFF, micShouldPause, type MicState, type PermissionHelp } from "./voiceMic.js";
import { VoicePlayer, type PlayerAudio } from "./voicePlayer.js";

export type VoiceRoomState = "connecting" | "ready" | "gone" | "denied";

/** 这台此刻在听的那一场。null = 没在听（没加入 / 通话结束 / 离开了这一页 / 切到了后台） */
export interface VoiceListen {
  sessionId: string;
  /** 加入那一刻的日志尾：只读之后落下来的话，历史不念 */
  sinceSeq: number;
  /** 此刻在说话的 agent（放音队列报的） */
  speaking: string | null;
  queued: number;
  /** 此刻在读的那句原文（「转文字」那一行、插嘴的回声兜底都要它）；静默时 null */
  text: string | null;
  /** 最近一段合成 / 放音失败的那句话（routeTts 的四种 blocked 或网关信封） */
  error: string | null;
  mic: MicState;
}

/** 麦克风那一半：开 / 关 / 半双工暂停 / 恢复。结果不从返回值来，一律走 onSpeech（识别结果是自己冒出来的） */
export interface VoiceMicPort {
  start(hints: string[]): void;
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface VoiceSessionDeps {
  speak(text: string, voiceId: string): Promise<VoiceSpeakResult>;
  createAudio(bytes: Uint8Array): PlayerAudio;
  mic: VoiceMicPort;
  /** 一句说完了：发出去（不 @、走派活，带 voice 记号由调用方负责） */
  say(text: string): Promise<CloudAck>;
  /** 那条会话此刻的日志（按 seq 升序）；不是此刻开着的那一条就回 null */
  events(sessionId: string): readonly SessionEvent[] | null;
  /** 名册顺序：音色派生要它解撞（同一只两台设备同一个声音） */
  roster(): readonly string[];
  /** 开麦时喂给识别器的词表 */
  hints(): string[];
  permissionHelp: PermissionHelp;
  onChange(listen: VoiceListen | null): void;
}

export interface VoiceSession {
  state(): VoiceListen | null;
  join(sessionId: string): void;
  leave(): void;
  setMic(on: boolean): void;
  onEvent(e: SessionEvent): void;
  onDelta(d: CloudSessionDelta): void;
  onSpeech(ev: SpeechEvent): void;
  onRoomState(sessionId: string, prev: VoiceRoomState, next: VoiceRoomState): void;
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  let listen: VoiceListen | null = null;
  let feed: VoiceFeedState = EMPTY_VOICE_FEED;
  let micStarted = false;
  let micPaused = false;
  /** 云端断了那一刻麦是开着的吗（#1289）：gone 会自愈，断线期间停的麦要有人开回来；
      人自己碰过麦克风开关、或整段离开语音，一律清掉（他表达过意志，压过自动恢复） */
  let micWantedAfterReconnect = false;

  const set = (next: VoiceListen | null): void => {
    listen = next;
    deps.onChange(next);
  };
  const patch = (p: Partial<VoiceListen>): void => {
    if (listen !== null) set({ ...listen, ...p });
  };

  const startMic = (): void => {
    micStarted = true;
    micPaused = false;
    deps.mic.start(deps.hints());
  };
  const stopMic = (): void => {
    if (!micStarted) return;
    micStarted = false;
    micPaused = false;
    deps.mic.stop();
  };
  /** 半双工：放音队列每动一次来问一遍该不该闭麦，只在跨过那条线时发命令。回声消除开着永远不闭 */
  const micSync = (): void => {
    if (!micStarted || listen === null) return;
    const want = micShouldPause({ speaking: listen.speaking, queued: listen.queued, aec: listen.mic.aec });
    if (want === micPaused) return;
    micPaused = want;
    if (want) deps.mic.pause();
    else deps.mic.resume();
  };

  const player = new VoicePlayer({
    speak: (text, voiceId) => deps.speak(text, voiceId),
    createAudio: (bytes) => deps.createAudio(bytes),
    onChange: (p) => {
      if (listen === null) return;
      patch({ speaking: p.speaking, queued: p.queued, error: p.error, text: p.text });
      micSync();
    },
  });

  /** 整段离开语音。停麦排在停放音前面：player.stop() 会同步回调 onChange → micSync，麦先停掉它就短路，
      不会先补一次 resume 再紧跟一次 stop（桌面 stopVoice 同一条，#1281） */
  const stopAll = (): void => {
    stopMic();
    player.stop();
    feed = EMPTY_VOICE_FEED;
    micWantedAfterReconnect = false;
  };

  const participantsOf = (sessionId: string): Set<string> | null => {
    const call = voiceCallOf(deps.events(sessionId) ?? []);
    return call === null ? null : new Set(call.participants.map((p) => p.agentId));
  };

  const enqueue = (out: readonly Utterance[]): void => {
    const roster = deps.roster();
    for (const u of out) player.enqueue({ ...u, voiceId: agentVoiceId(u.agentId, roster) });
  };

  const noteMicError = (sessionId: string, message: string): void => {
    if (listen !== null && listen.sessionId === sessionId) patch({ mic: { ...listen.mic, error: message } });
  };

  return {
    state: () => listen,

    join(sessionId) {
      stopAll();
      const events = deps.events(sessionId) ?? [];
      const last = events.at(-1);
      set({
        sessionId, sinceSeq: last === undefined ? -1 : last.seq,
        speaking: null, queued: 0, text: null, error: null,
        mic: { ...MIC_OFF, status: "starting" },
      });
      // 常开麦（#1176）：进通话就开
      startMic();
    },

    leave() {
      stopAll();
      if (listen !== null) set(null);
    },

    setMic(on) {
      if (listen === null) return;
      micWantedAfterReconnect = false;
      if (on) {
        patch({ mic: { ...MIC_OFF, status: "starting" } });
        startMic();
      } else {
        stopMic();
        patch({ mic: MIC_OFF });
      }
    },

    onEvent(e) {
      if (listen === null || e.sessionId !== listen.sessionId) return;
      const participants = participantsOf(listen.sessionId);
      if (participants === null) {
        // 通话结束（这条或更早那条空名单）：判据是日志里的名单，不是「我按了挂断」
        stopAll();
        set(null);
        return;
      }
      const r = feedEvent(feed, participants, listen.sinceSeq, e);
      feed = r.state;
      enqueue(r.out);
    },

    onDelta(d) {
      if (listen === null || d.sessionId !== listen.sessionId || d.kind !== "content") return;
      const participants = participantsOf(listen.sessionId);
      if (participants === null) return;
      const r = feedDelta(feed, participants, d.agentId, d.text);
      feed = r.state;
      enqueue(r.out);
    },

    onSpeech(ev) {
      // 放音的回执归 helperAudio（调用方先转过去）；走到这里的不会是它，保险起见不碰
      if (ev.type === "played" || ev.type === "playError") return;
      const v = listen;
      // 关着麦时原生那边迟到的事件不再动状态（stop 之后它还会吐一条 listening:false）
      if (v === null || v.mic.status === "off") return;
      const r = applySpeechEvent(v.mic, ev, deps.permissionHelp);
      if (r.state !== v.mic) patch({ mic: r.state });
      // 插嘴（#1184）：它在说 / 排着要说时人开口够长 → 停放音，这几只这一轮剩下的话不读
      if (ev.type === "partial" && (v.speaking !== null || v.queued > 0)) {
        if (bargeInOn(ev.text, { speaking: v.speaking, queued: v.queued }, player.state().text ?? "", v.mic.active)) {
          for (const id of new Set([...(v.speaking !== null ? [v.speaking] : []), ...player.pendingAgentIds()])) {
            feed = markInterrupted(feed, id);
          }
          player.stop();
        }
      }
      if (r.final === undefined) return;
      const sessionId = v.sessionId;
      void deps.say(r.final).then(
        (ack) => {
          if (!ack.ok) noteMicError(sessionId, ack.message);
        },
        (err: unknown) => noteMicError(sessionId, err instanceof Error ? err.message : String(err)),
      );
    },

    onRoomState(sessionId, prev, next) {
      if (prev === next || listen === null || listen.sessionId !== sessionId) return;
      if (next === "denied") {
        // 终态：房间被拒，通话没有回来的路
        stopAll();
        set(null);
        return;
      }
      if (next === "gone") {
        // **不是**通话结束：gone 会自愈。停麦（没有地方可发），但通话与放音都留着——
        // TTS 走 edge 网关，不经这条断掉的连接，队列里那几句是真的
        micWantedAfterReconnect = micStarted;
        stopMic();
        patch({ mic: { ...MIC_OFF, error: listen.mic.error } });
        return;
      }
      if (next === "ready" && micWantedAfterReconnect) {
        micWantedAfterReconnect = false;
        patch({ mic: { ...MIC_OFF, status: "starting" } });
        startMic();
      }
    },
  };
}
```

- [ ] **Step 5: 跑测试**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/voiceSession.test.ts tests/shared/voiceMic.test.ts tests/architecture.test.ts && npx tsc --noEmit -p . 2>&1 | head -20`
Expected: 全部 PASS；tsc 无输出。

若「有回声消除……插嘴」那条红在 `speaking` 上：先确认 `status(true)` 之后 `mic.aec` 是 `true`（`applySpeechEvent` 的 status 分支会写它），再看 `player.state()` 是不是已经起播（`await flush()` 次数不够就加一次 `await flush()`，**只能加 flush、不能改断言**）。

- [ ] **Step 6: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add src/shared/voiceMic.ts src/shared/voiceSession.ts tests/shared/voiceMic.test.ts tests/shared/voiceSession.test.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
feat(shared): 语音通话在一台设备上的编排 voiceSession（#1356 A4）

手机端不进 vitest，而语音这一层是整条链上最容易出安静错的——断线、迟到的事件、
半双工的开关、插嘴。所以编排写进 shared、用假端口钉住：加入 / 离开、读谁的话、
半双工与插嘴、一句说完发出去、云端 gone 停麦留通话 / ready 把麦开回来 / denied 整段收掉。
语义逐条照桌面 store 的语音那一段，差别三处写在文件头（没有扣住窗、静音 = 关麦、
放音走哪条路由注入决定）。桌面 store 还没改用这一份，两份编排并存是已知代价（ADR-0320）。

顺带：applySpeechEvent 那句「没权限」按平台说——手机不能指 macOS 的系统设置。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 4: 电话那一格的判据与通话卡（shared `mobileCall.ts` + `mobileChat.ts`）

电话钮画不画、那一格此刻画什么、左边那张脸是谁什么样、声浪画谁的、为什么接不了、通话卡的「聊的什么」——都是判断，写进 shared。时间线多一种行：一场通话折成的那张卡（`voiceCallCards`，桌面同一份，ADR-0288），卡在开场那条名单事件的位置，通话里说的话与通话里那几只的回复都折进卡里。通话开着时，通话里那几只正在写的那一段（流式碎片）不画——它落下来就折进卡里，画了会一闪而过。

**Files:**
- Create: `src/shared/mobileCall.ts`
- Modify: `src/shared/mobileChat.ts`、`mobile/src/chat/ChatRows.tsx`（只给 `call` 占一个位，见 Step 4 第 6 条）
- Test: Create `tests/shared/mobileCall.test.ts`；Modify `tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes：`ttsBlocked` / `ttsHostedOf`（Task 2 的 `src/shared/ttsRoute.ts`）；`VoiceCallCard` / `voiceCallCards`（`src/shared/cloudTimeline.ts`，已有）；`OpenTurn`（`src/shared/turnLedger.ts`，已有）；`VoiceCallState`（`src/shared/voiceCall.ts`，已有）。
- Produces:
  - `src/shared/mobileCall.ts`：
    - `phoneOffered(o: { voiceUsable: boolean; ready: boolean; agentIds: readonly string[]; call: VoiceCallState | null }): boolean`
    - `type CallBarMode = "none" | "live" | "idle"`；`callBarMode(o: { call: VoiceCallState | null; listeningHere: boolean }): CallBarMode`
    - `interface CallFace { agentId: string; state: "speaking" | "composing" | "queued" | "listening" }`；`callFace(o: { call: VoiceCallState; speaking: string | null; open: readonly OpenTurn[] }): CallFace | null`
    - `type WaveMode = "off" | "me" | "agent" | "quiet"`；`waveMode(o: { micOn: boolean; micActive: boolean; agentSpeaking: boolean }): WaveMode`；`waveBarHeight(mode: WaveMode, level: number, t: number, i: number): number`
    - `CALL_TOPIC_MAX = 24`；`callTopicText(card: VoiceCallCard): string | null`
    - `joinBlockedText(o: { native: boolean; ready: boolean; billing: BillingSnapshotView | null }): string | null`
  - `src/shared/mobileChat.ts`：`ChatRow` 多一种 `{ kind: "call"; key: string; ts: number; card: VoiceCallCard; topic: string | null }`；`liveRows` 的参数多一格可选 `hide?: ReadonlySet<string>`

- [ ] **Step 1: mobileCall 的测试（RED）**

Create `tests/shared/mobileCall.test.ts`：

```ts
// mobileCall（#1356 A4，spec §5.7）：手机聊天页「电话」那一格的判据。
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import type { VoiceCallCard, VoiceCallCardLine } from "../../src/shared/cloudTimeline.js";
import {
  CALL_TOPIC_MAX, callBarMode, callFace, callTopicText, joinBlockedText, phoneOffered, waveBarHeight, waveMode,
} from "../../src/shared/mobileCall.js";
import type { OpenTurn } from "../../src/shared/turnLedger.js";
import type { VoiceCallState } from "../../src/shared/voiceCall.js";

const CALL: VoiceCallState = { participants: [{ agentId: "a", name: "开发" }, { agentId: "b", name: "运维" }], sinceSeq: 3, sinceTs: 1000 };
const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
});
const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 0, exhausted: null });
const line = (o: Partial<VoiceCallCardLine>): VoiceCallCardLine => ({
  seq: 1, parts: null, label: "开发", avatar: null, offsetMs: 0, text: "", mine: false, ...o,
});
const card = (lines: VoiceCallCardLine[]): VoiceCallCard => ({ seq: 1, sinceTs: 0, endedTs: null, utterances: lines.length, parties: [], lines });

describe("phoneOffered：输入框空着时那颗是不是「开电话」", () => {
  const ok = { voiceUsable: true, ready: true, agentIds: ["a"], call: null };
  it("这台打得了、房间 ready、有智能体、还没有通话 → 是", () => {
    expect(phoneOffered(ok)).toBe(true);
  });
  it("任何一条不成立 → 退回灰的发送钮", () => {
    expect(phoneOffered({ ...ok, voiceUsable: false })).toBe(false);
    expect(phoneOffered({ ...ok, ready: false })).toBe(false);
    expect(phoneOffered({ ...ok, agentIds: [] })).toBe(false);
    expect(phoneOffered({ ...ok, call: CALL })).toBe(false);
  });
});

describe("callBarMode", () => {
  it("没有通话 = 输入框；这台在听 = live；通话开着而这台没在听 = idle", () => {
    expect(callBarMode({ call: null, listeningHere: true })).toBe("none");
    expect(callBarMode({ call: CALL, listeningHere: true })).toBe("live");
    expect(callBarMode({ call: CALL, listeningHere: false })).toBe("idle");
  });
});

describe("callFace：电话那一格左边那张脸", () => {
  const open = (agentId: string, state: OpenTurn["state"]): OpenTurn => ({ seq: 9, fromUid: "me", agentId, state });
  it("谁在说画谁", () => {
    expect(callFace({ call: CALL, speaking: "b", open: [] })).toEqual({ agentId: "b", state: "speaking" });
  });
  it("名单外那只在说不算；没人说时画欠着回答的那只（在跑 = 在想、还没轮到 = 排队）", () => {
    expect(callFace({ call: CALL, speaking: "x", open: [open("b", "running")] })).toEqual({ agentId: "b", state: "composing" });
    expect(callFace({ call: CALL, speaking: null, open: [open("a", "queued")] })).toEqual({ agentId: "a", state: "queued" });
  });
  it("都没有 → 通话里第一只，在听", () => {
    expect(callFace({ call: CALL, speaking: null, open: [open("x", "running")] })).toEqual({ agentId: "a", state: "listening" });
  });
});

describe("声浪", () => {
  it("waveMode：它在说排第一；关着麦是 off；人在说是 me；都没说是 quiet", () => {
    expect(waveMode({ micOn: true, micActive: true, agentSpeaking: true })).toBe("agent");
    expect(waveMode({ micOn: false, micActive: false, agentSpeaking: true })).toBe("agent");
    expect(waveMode({ micOn: false, micActive: false, agentSpeaking: false })).toBe("off");
    expect(waveMode({ micOn: true, micActive: true, agentSpeaking: false })).toBe("me");
    expect(waveMode({ micOn: true, micActive: false, agentSpeaking: false })).toBe("quiet");
  });
  it("waveBarHeight：off 恒为 3；其余落在 4–26（那一格 30 高）；能量为 0 / NaN 时人在说那档贴底", () => {
    expect(waveBarHeight("off", 1, 3, 5)).toBe(3);
    for (const mode of ["me", "agent", "quiet"] as const) {
      for (let i = 0; i < 22; i++) {
        for (const t of [0, 0.37, 1.2, 9.9]) {
          const h = waveBarHeight(mode, 1.7, t, i);
          expect(h).toBeGreaterThanOrEqual(4);
          expect(h).toBeLessThanOrEqual(26);
        }
      }
    }
    expect(waveBarHeight("me", 0, 1.2, 4)).toBe(4);
    expect(waveBarHeight("me", Number.NaN, 1.2, 4)).toBe(4);
  });
});

describe("callTopicText：通话卡第二行「聊的什么」", () => {
  it("我说的第一句；名单变更那几行不算", () => {
    const c = card([
      line({ seq: 1, parts: [{ kind: "text", text: "Stan 把「运维」拉进了通话" }] }),
      line({ seq: 2, text: "你好，我是开发。" }),
      line({ seq: 3, text: "帮我查下部署\n顺便看下日志", mine: true }),
    ]);
    expect(callTopicText(c)).toBe("帮我查下部署");
  });
  it("我一句没说 → 它说的第一句；都没有 → null", () => {
    expect(callTopicText(card([line({ text: "  你好，我是开发。 " })]))).toBe("你好，我是开发。");
    expect(callTopicText(card([]))).toBeNull();
    expect(callTopicText(card([line({ parts: [{ kind: "text", text: "结束了语音通话" }] })]))).toBeNull();
  });
  it("超长按码点截断加「…」，不劈开代理对", () => {
    const long = "\u{1F600}".repeat(30);
    const out = callTopicText(card([line({ text: long, mine: true })]));
    expect([...(out ?? "")]).toHaveLength(CALL_TOPIC_MAX + 1);
    expect(out?.endsWith("…")).toBe(true);
    expect(out?.startsWith("\u{1F600}")).toBe(true);
  });
});

describe("joinBlockedText：这台为什么接不了", () => {
  const ok = { native: true, ready: true, billing: snap(me()) };
  it("接得了 → null", () => {
    expect(joinBlockedText(ok)).toBeNull();
  });
  it("没有原生模块（Expo Go）→ 说要开发版", () => {
    expect(joinBlockedText({ ...ok, native: false })).toContain("开发版");
  });
  it("房间没 ready / 订阅还没查到 → 说在等（不说没订阅）", () => {
    expect(joinBlockedText({ ...ok, ready: false })).toContain("连上");
    const pending = joinBlockedText({ ...ok, billing: null });
    expect(pending).toContain("查订阅");
    expect(pending).not.toContain("订阅 Pro");
  });
  it("没订阅 → 手机那句（不指「设置 → 订阅」，手机上没有那一页）；网关不供语音 → 说不供", () => {
    const none = joinBlockedText({ ...ok, billing: snap(me({ status: "none", plan: null })) });
    expect(none).toBe("订阅 Pro 或 Max 之后才打得了电话。");
    const noTts = joinBlockedText({ ...ok, billing: snap(me({ ttsModels: [] })) });
    expect(noTts).toContain("语音");
    expect(noTts).not.toContain("订阅 Pro");
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/mobileCall.test.ts`
Expected: FAIL（`Cannot find module ... mobileCall.js`）

- [ ] **Step 2: 实现 mobileCall**

Create `src/shared/mobileCall.ts`：

```ts
// mobileCall —— 手机聊天页「电话」那一格的判据（#1356 A4，spec §5.7）。纯逻辑，ChatScreen / CallBar 只画。

import type { VoiceCallCard } from "./cloudTimeline.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import type { OpenTurn } from "./turnLedger.js";
import { ttsBlocked, ttsHostedOf } from "./ttsRoute.js";
import type { VoiceCallState } from "./voiceCall.js";

/** 输入框空着时右边那颗是不是「开电话」（spec §5.3 一物两用）：这台打得了电话、房间 ready、这条聊天里
    有智能体、还没有通话。任何一条不成立都退回那颗灰的发送钮——说不清就不画（#722）。私聊草稿（第一句还
    没发、还没有会话）里 ready 天然不成立：电话要一条会话才打得了 */
export function phoneOffered(o: { voiceUsable: boolean; ready: boolean; agentIds: readonly string[]; call: VoiceCallState | null }): boolean {
  return o.voiceUsable && o.ready && o.agentIds.length > 0 && o.call === null;
}

export type CallBarMode = "none" | "live" | "idle";

/** 输入框那一格此刻画什么：没有通话 = 输入框；通话开着且这台在听 = 电话那一格（live）；通话开着而这台
    没在听（锁过屏、从名册回来、通话是另一台设备开的）= 「通话还开着」那一格（idle）。判据是日志里的
    通话名单（voiceCallOf），不是「我刚按了」 */
export function callBarMode(o: { call: VoiceCallState | null; listeningHere: boolean }): CallBarMode {
  if (o.call === null) return "none";
  return o.listeningHere ? "live" : "idle";
}

export interface CallFace {
  agentId: string;
  state: "speaking" | "composing" | "queued" | "listening";
}

/** 电话那一格左边那张脸：谁在说画谁（在说）；没人说时画欠着回答的那只（在跑 = 在想、还没轮到 = 排队）；
    都没有画通话里第一只（在听）。只认通话名单里的——名单外那只在干什么，这一格不管 */
export function callFace(o: { call: VoiceCallState; speaking: string | null; open: readonly OpenTurn[] }): CallFace | null {
  const ids = o.call.participants.map((p) => p.agentId);
  if (o.speaking !== null && ids.includes(o.speaking)) return { agentId: o.speaking, state: "speaking" };
  const owed = o.open.find((t) => ids.includes(t.agentId));
  if (owed !== undefined) return { agentId: owed.agentId, state: owed.state === "running" ? "composing" : "queued" };
  const first = ids[0];
  return first === undefined ? null : { agentId: first, state: "listening" };
}

export type WaveMode = "off" | "me" | "agent" | "quiet";

/** 声浪画谁的：它在说排第一（没有回声消除时它的声音会漏进麦克风，按能量画会把它说的画成你说的）；
    关着麦 = 一条灰线；人在说 = 按麦克风能量；都没说 = 一口轻气（不是停住——停住读作坏了） */
export function waveMode(o: { micOn: boolean; micActive: boolean; agentSpeaking: boolean }): WaveMode {
  if (o.agentSpeaking) return "agent";
  if (!o.micOn) return "off";
  return o.micActive ? "me" : "quiet";
}

/** 声浪第 i 根此刻多高（点，那一格 30 高，上限 26）。它在说那档是 demo 那条三正弦包络——这边量不到它的
    音量，画的是「有话在说」不是音量；人在说按麦克风能量缩放同一条包络；关着麦恒为 3 */
export function waveBarHeight(mode: WaveMode, level: number, t: number, i: number): number {
  if (mode === "off") return 3;
  const n = Math.abs(Math.sin(t * 6 + i * 0.55)) * Math.abs(Math.sin(t * 2.1 + i * 0.21)) * Math.abs(Math.sin(t * 0.9 + i * 0.07));
  if (mode === "agent") return 4 + n * 22;
  if (mode === "quiet") return 4 + n * 3;
  const l = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return 4 + l * 22 * (0.45 + 0.55 * n);
}

/** 通话卡第二行「聊的什么」最多几个字 */
export const CALL_TOPIC_MAX = 24;

/** 「聊的什么」：我说的第一句；我一句没说就是它说的第一句；都没有 = null（不画那一行）。取第一行、折叠
    空白，超长按码点截断加「…」（不劈开代理对）。demo 那一行是写死的话题，真数据里没有话题这一格 */
export function callTopicText(card: VoiceCallCard): string | null {
  const said = card.lines.filter((l) => l.parts === null && l.text.trim() !== "");
  const pick = said.find((l) => l.mine) ?? said[0];
  if (pick === undefined) return null;
  const firstLine = pick.text.trim().split("\n")[0] ?? "";
  const one = firstLine.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length <= CALL_TOPIC_MAX ? one : `${chars.slice(0, CALL_TOPIC_MAX).join("")}…`;
}

/** 这台此刻为什么接不了（「通话还开着」那一格里「接着听」换成这一句）。null = 接得了。
    没订阅那句不照抄桌面（桌面那句指「设置 → 订阅」，手机上 A5 之前没有那一页）；额度用完 / 网关不供语音
    两句照 ttsBlocked 说 */
export function joinBlockedText(o: { native: boolean; ready: boolean; billing: BillingSnapshotView | null }): string | null {
  if (!o.native) return "这个版本的 app 听不了电话：要装带语音的开发版（Expo Go 不带语音识别）。";
  if (!o.ready) return "正在连上这条聊天…";
  if (o.billing === null) return "正在查订阅…";
  const hosted = ttsHostedOf(o.billing);
  if (hosted === undefined || !hosted.subscribed) return "订阅 Pro 或 Max 之后才打得了电话。";
  return ttsBlocked(hosted);
}
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/mobileCall.test.ts`
Expected: PASS

- [ ] **Step 3: 时间线的通话卡与藏流式那一段（先写测试）**

在 `tests/shared/mobileChat.test.ts` 末尾加：

```ts
describe("通话卡（#1356 A4，spec §5.7 / ADR-0288）", () => {
  const A = "a_000000000001";
  it("一场通话折成一张卡：卡在开场那条的位置，通话里说的话与它的回复不单独成行；第二行是我说的第一句", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 开电话之前", fromUid: "me", mentions: [] }),
        e({ type: "voice_call_changed", participants: [{ agentId: A, name: "开发" }], byUid: "me", ignorable: true }),
        e({ type: "user_message", content: "[Stan]: 帮我查下部署", fromUid: "me", voice: true }),
        e({ type: "assistant_message", content: "查好了，都是绿的。", model: "m", agentId: A }),
        e({ type: "voice_call_changed", participants: [], byUid: "me", ignorable: true }),
        e({ type: "user_message", content: "[Stan]: 挂了之后打的字", fromUid: "me", mentions: [] }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "mine", "call", "mine"]);
    const call = rows[2];
    expect(call).toMatchObject({ kind: "call", key: "call-1", topic: "帮我查下部署" });
    if (call?.kind !== "call") return;
    expect(call.card.utterances).toBe(2);
    expect(call.card.endedTs).toBe(DAY);
  });

  it("还开着的通话：卡照样画在开场的位置、endedTs 为 null", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "voice_call_changed", participants: [{ agentId: A, name: "开发" }], byUid: "me", ignorable: true }),
        e({ type: "assistant_message", content: "你好，我是开发。", model: "m", agentId: A }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["day", "call"]);
    const call = rows[1];
    if (call?.kind !== "call") throw new Error("第二行应是通话卡");
    expect(call.card.endedTs).toBeNull();
    expect(call.topic).toBe("你好，我是开发。");
  });

  it("通话开着时，通话里那几只正在写的那一段不画（hide）——落下来就折进卡里，画了会一闪而过", () => {
    const rows = liveRows({ streaming: { a_000000000001: "正在说", a_000000000002: "别的" }, ws: WS, now: DAY, hide: new Set(["a_000000000001"]) });
    expect(rows.map((r) => r.key)).toEqual(["live-a_000000000002"]);
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/mobileChat.test.ts`
Expected: FAIL（没有 `call` 那一行；`hide` 不认）

- [ ] **Step 4: 改 mobileChat**

`src/shared/mobileChat.ts`：

1. 从 `./cloudTimeline.js` 的那条 import 里补上 `voiceCallCards` 与 `type VoiceCallCard`（先 `grep -n 'cloudTimeline.js' src/shared/mobileChat.ts` 看那一行现在的名字表，往里加，别重复）；再加一行 `import { callTopicText } from "./mobileCall.js";`。

2. `ChatRow` 联合类型最后一格 `| { kind: "roster"; key: string; ts: number; parts: RosterLinePart[] };` 换成：

```ts
  | { kind: "roster"; key: string; ts: number; parts: RosterLinePart[] }
  /** 一场语音通话折成的那张卡（A4，ADR-0288）：卡在开场那条名单事件的位置；通话里说的话与通话里那几只的回复
      都折进卡里，不单独成行。`topic` = 卡的第二行「聊的什么」，null = 不画那一行 */
  | { kind: "call"; key: string; ts: number; card: VoiceCallCard; topic: string | null };
```

3. `rowOf` 的 `default:` 分支注释里 `// 通话卡（A4）、压缩与其余内务：手机端不画——压缩是上下文系统自己的事（聊天里那条线不断）` 换成 `// 压缩与其余内务：手机端不画——压缩是上下文系统自己的事（聊天里那条线不断）。通话卡（A4）要跨事件，在 chatRows 的循环里判`。

4. `chatRows` 里：

```ts
  const items: ItemRow[] = [];
  let prevRoster: ChatRosterChangedEvent | null = null;
  for (const e of o.events) {
    if (e.type === "chat_roster_changed") {
```

换成：

```ts
  const items: ItemRow[] = [];
  let prevRoster: ChatRosterChangedEvent | null = null;
  // 通话卡（A4）：哪几条折进卡里要跨事件才答得出（voiceCallCards，桌面同一份），同名单那一行一样在循环外算
  const calls = voiceCallCards(o.events, o.ws, o.selfUid);
  for (const e of o.events) {
    const card = calls.cards.get(e.seq);
    if (card !== undefined) {
      items.push({ kind: "call", key: `call-${e.seq}`, ts: e.ts, card, topic: callTopicText(card) });
      continue;
    }
    if (calls.folded.has(e.seq)) continue;
    if (e.type === "chat_roster_changed") {
```

5. `liveRows`：

```ts
export function liveRows(o: { streaming: Readonly<Record<string, string>>; ws: WorkspaceSnapshot; now: number }): ChatRow[] {
  const out: ChatRow[] = [];
  for (const [agentId, text] of Object.entries(o.streaming)) {
```

换成：

```ts
export function liveRows(o: { streaming: Readonly<Record<string, string>>; ws: WorkspaceSnapshot; now: number; hide?: ReadonlySet<string> }): ChatRow[] {
  const out: ChatRow[] = [];
  for (const [agentId, text] of Object.entries(o.streaming)) {
    // 通话开着时通话里那几只的那一段不画（A4）：落下来就折进通话卡，画了会一闪而过；它在说的话看电话那一格的「转文字」
    if (o.hide?.has(agentId) === true) continue;
```

并在 `liveRows` 的文档注释末尾补一句：`` `hide` = 此刻通话里的那几只（A4）。``

6. `mobile/src/chat/ChatRows.tsx` 的 `ChatRowView` 有一道穷尽检查（`default: { const unhandled: never = row; … }`），`ChatRow` 多了 `call` 它就红——这正是那道检查存在的理由。本任务先在 `default:` 那一格**之前**占一个位，Task 7 换成真的卡：

```tsx
    case "call":
      // A4 Task 7 画这张卡（CallCardRow）；这一格先占位，穷尽检查才不红
      return null;
```

- [ ] **Step 5: 跑测试与两边 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/shared/mobileChat.test.ts tests/shared/mobileCall.test.ts && npx tsc --noEmit -p . 2>&1 | head -20 && npm --prefix mobile run typecheck 2>&1 | tail -20`
Expected: PASS；根 tsc 与手机 tsc 都无报错。

- [ ] **Step 6: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add src/shared/mobileCall.ts src/shared/mobileChat.ts tests/shared/mobileCall.test.ts tests/shared/mobileChat.test.ts mobile/src/chat/ChatRows.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
feat(shared): 手机聊天页电话那一格的判据与通话卡（#1356 A4）

电话钮画不画（这台打得了、房间 ready、有智能体、还没有通话）、那一格此刻画输入框 / 电话 /
「通话还开着」、左边那张脸是谁（谁在说画谁，没人说画欠着回答的那只）、声浪画谁的
（它在说排第一——没有回声消除时它的声音会漏进麦克风）、这台为什么接不了（开发版 / 连接 /
订阅；没订阅那句不指桌面的「设置 → 订阅」）、通话卡的「聊的什么」（我说的第一句）。
时间线多一种行：一场通话折成一张卡（voiceCallCards，桌面同一份）；通话开着时通话里那几只
正在写的那一段不画——落下来就折进卡里，画了会一闪而过。
ChatRows 的穷尽检查先给 call 占一个位（return null），画卡在后面那一片。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 5: 语音原生模块 `otto-speech`（Expo 本地模块，Swift）

照搬桌面 `native/MrOttoSpeech`：SFSpeechRecognizer + AVAudioEngine、每句收口换新 request、断句 Endpointer、能量门 LevelGate、VPIO 回声消除（开得了就不半双工）、放音挂在识别那同一个引擎上（ADR-0280）。桌面那边是吃 stdin 的子进程，这里是 Expo 模块：命令是 `AsyncFunction`，事件一律走 `onSpeech`。**纯逻辑那两份 Swift 逐字抄**（`Level.swift` 整份、`Endpointer.swift` 从「一句是不是像说完了」那段注释起到末尾），测试对拍；iOS 多出来的五件事写在 `Recognizer.swift` 头注。Swift 不进门禁，所以这一片的「绿」有两道：vitest 的对拍 + 一次 `xcodebuild` 编译成功。

**Files:**
- Create: `mobile/modules/otto-speech/expo-module.config.json`、`mobile/modules/otto-speech/index.ts`
- Create: `mobile/modules/otto-speech/ios/OttoSpeech.podspec`、`OttoSpeechModule.swift`、`Recognizer.swift`、`Playback.swift`、`Event.swift`
- Create（照抄，不手写）: `mobile/modules/otto-speech/ios/Level.swift`、`mobile/modules/otto-speech/ios/Endpointer.swift`
- Modify: `mobile/app.json`
- Test: Create `tests/mobile/ottoSpeech.test.ts`

**Interfaces:**
- Consumes: 无（事件形状对齐 `src/shared/shellBridge.ts` 的 `SpeechEvent`，JS 那侧由 Task 6 用 `speechEventOf` 验）。
- Produces（`mobile/modules/otto-speech/index.ts`）：`export const OttoSpeech: OttoSpeechModule | null`，其中
  - `start(locale: string, hints: string[]): Promise<void>` / `stop()` / `pause()` / `resume()` / `status()` / `play(id: string, uri: string)` / `stopPlay()`（全部 `Promise<void>`）
  - `addListener("onSpeech", (raw: Record<string, unknown>) => void): EventSubscription`
  - 事件（`raw.type`）：`status` / `listening` / `paused` / `resumed` / `partial` / `final` / `level` / `played` / `playError` / `error`，字段同桌面 helper。

- [ ] **Step 1: 对拍测试（RED）**

Create `tests/mobile/ottoSpeech.test.ts`：

```ts
// 手机端语音原生模块（#1356 A4，ADR-0320）与桌面 MrOttoSpeech 对拍。Swift 不进门禁（这里没有 iOS 工具链），
// 于是「照搬桌面」这句话由这里钉住：断句与能量门逐字相同、事件字段表相同、JS 声明的函数与 Swift 注册的
// 函数一一对上、Info.plist 的两句授权说明在。改了桌面那两份纯逻辑而手机不跟（或反过来），这里红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const DESKTOP = "native/MrOttoSpeech/Sources/MrOttoSpeech";
const MOBILE = "mobile/modules/otto-speech";

/** `struct Event` 那一块里声明的字段名（排序后） */
function eventFields(src: string): string[] {
  const start = src.indexOf("struct Event");
  const end = src.indexOf("\n}", start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*(?:let|var) (\w+):/gm)].map((m) => m[1]!).filter((n) => n !== "dictionary").sort();
}

describe("otto-speech 原生模块与桌面 MrOttoSpeech 对拍", () => {
  it("能量门 Level.swift 逐字相同", () => {
    expect(read(`${MOBILE}/ios/Level.swift`)).toBe(read(`${DESKTOP}/Level.swift`));
  });

  it("断句（utteranceLooksFinished + Endpointer）从那段注释起到末尾逐字相同", () => {
    const marker = "/// 一句是不是像说完了";
    const desktop = read(`${DESKTOP}/Protocol.swift`);
    const mobile = read(`${MOBILE}/ios/Endpointer.swift`);
    expect(desktop.includes(marker)).toBe(true);
    expect(mobile.includes(marker)).toBe(true);
    expect(mobile.slice(mobile.indexOf(marker))).toBe(desktop.slice(desktop.indexOf(marker)));
  });

  it("事件字段表相同（JS 那侧用同一个 speechEventOf 验）", () => {
    const mobile = eventFields(read(`${MOBILE}/ios/Event.swift`));
    expect(mobile).toEqual(eventFields(read(`${DESKTOP}/Protocol.swift`)));
    expect(mobile).toContain("aec");
  });

  it("JS 声明的每个函数都在 Swift 里注册了，反过来也是；模块名与事件名两边同一个", () => {
    const swift = read(`${MOBILE}/ios/OttoSpeechModule.swift`);
    const js = read(`${MOBILE}/index.ts`);
    const native = [...swift.matchAll(/AsyncFunction\("(\w+)"\)/g)].map((m) => m[1]!).sort();
    const declared = [...js.matchAll(/^\s+(\w+)\([^)]*\): Promise<void>;/gm)].map((m) => m[1]!).sort();
    expect(native).toEqual(["pause", "play", "resume", "start", "status", "stop", "stopPlay"]);
    expect(declared).toEqual(native);
    expect(swift).toContain('Name("OttoSpeech")');
    expect(swift).toContain('Events("onSpeech")');
    expect(swift).toContain('sendEvent("onSpeech"');
    expect(js).toContain('requireOptionalNativeModule<OttoSpeechModule>("OttoSpeech")');
    expect(js).toContain("onSpeech:");
  });

  it("expo-module.config.json 指到 OttoSpeechModule；app.json 带麦克风与语音识别两句授权说明", () => {
    const cfg = JSON.parse(read(`${MOBILE}/expo-module.config.json`)) as { platforms?: string[]; apple?: { modules?: string[] } };
    expect(cfg.platforms).toEqual(["apple"]);
    expect(cfg.apple?.modules).toEqual(["OttoSpeechModule"]);
    expect(read(`${MOBILE}/ios/OttoSpeechModule.swift`)).toContain("public class OttoSpeechModule: Module");
    const app = JSON.parse(read("mobile/app.json")) as { expo: { ios?: { infoPlist?: Record<string, string> } } };
    const plist = app.expo.ios?.infoPlist ?? {};
    expect(plist.NSMicrophoneUsageDescription ?? "").not.toBe("");
    expect(plist.NSSpeechRecognitionUsageDescription ?? "").not.toBe("");
  });
});
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/mobile/ottoSpeech.test.ts`
Expected: FAIL（`ENOENT … mobile/modules/otto-speech/ios/Level.swift`）

- [ ] **Step 2: 照抄两份纯逻辑（不许手写）**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && mkdir -p mobile/modules/otto-speech/ios && cp native/MrOttoSpeech/Sources/MrOttoSpeech/Level.swift mobile/modules/otto-speech/ios/Level.swift
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && printf '%s\n' 'import Foundation' '' '// 断句（#1356 A4，ADR-0320）：从桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Protocol.swift 逐字抄来——' '// 从「一句是不是像说完了」那段注释起到文件末尾。tests/mobile/ottoSpeech.test.ts 对拍两份，改一边另一边不跟就红。' '' > mobile/modules/otto-speech/ios/Endpointer.swift
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && sed -n '/^\/\/\/ 一句是不是像说完了/,$p' native/MrOttoSpeech/Sources/MrOttoSpeech/Protocol.swift >> mobile/modules/otto-speech/ios/Endpointer.swift
```

检查：`head -8 mobile/modules/otto-speech/ios/Endpointer.swift` 头五行是 `import Foundation`、空行、两行注释、空行，第六行起是 `/// 一句是不是像说完了…`；`grep -c 'struct Endpointer' mobile/modules/otto-speech/ios/Endpointer.swift` 为 1。

- [ ] **Step 3: 模块配置、podspec、JS 绑定**

Create `mobile/modules/otto-speech/expo-module.config.json`：

```json
{
  "platforms": ["apple"],
  "apple": {
    "modules": ["OttoSpeechModule"]
  }
}
```

Create `mobile/modules/otto-speech/ios/OttoSpeech.podspec`：

```ruby
# 手机端语音通话的原生一半（#1356 A4，ADR-0320）：Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoSpeech'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: speech recognition, endpointing, echo cancellation and playback'
  s.description    = 'The desktop native/MrOttoSpeech helper ported as an Expo module (#1356 A4, ADR-0320).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Speech'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
```

Create `mobile/modules/otto-speech/index.ts`：

```ts
// 手机端语音通话的原生模块（#1356 A4，ADR-0320）的 JS 一侧：识别 + 断句 + 回声消除 + 放音，Swift 在 ios/。
//
// **Expo Go 里没有它**（它不在 Expo Go 的二进制里，要 `npx expo run:ios` 出的开发版）：
// requireOptionalNativeModule 回 null，调用方据此不画电话钮，app 其余部分照常跑——不用 requireNativeModule，
// 那个在 Expo Go 里一 import 就抛，整个 app 起不来。
//
// 命令都只说「交给原生那边了」，结果一律从 onSpeech 事件回来：识别结果是自己冒出来的，没有哪条命令在等它。
// 事件字段与桌面 helper 那一行 JSON 相同，交给 shared 的 speechEventOf 验。
import { NativeModule, requireOptionalNativeModule } from "expo";

type OttoSpeechEvents = {
  onSpeech: (raw: Record<string, unknown>) => void;
};

declare class OttoSpeechModule extends NativeModule<OttoSpeechEvents> {
  /** 开麦：先问两道授权（语音识别 → 麦克风），都过了才起引擎 */
  start(locale: string, hints: string[]): Promise<void>;
  stop(): Promise<void>;
  /** 半双工：它在说时闭麦（不停引擎——放音也挂在它上面） */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** 让它报一条 status（两道授权 + 能不能本机识别 + 回声消除开没开） */
  status(): Promise<void>;
  /** 放一段（file:// URI）；放完 / 放不了由 played / playError 事件回来 */
  play(id: string, uri: string): Promise<void>;
  stopPlay(): Promise<void>;
}

export const OttoSpeech: OttoSpeechModule | null = requireOptionalNativeModule<OttoSpeechModule>("OttoSpeech");
```

- [ ] **Step 4: Swift——事件与模块定义**

Create `mobile/modules/otto-speech/ios/Event.swift`：

```swift
import Foundation

// 事件（#1356 A4，ADR-0320）：与桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Protocol.swift 的 Event
// 同名同字段（tests/mobile/ottoSpeech.test.ts 对拍字段表）——桌面那边编码成一行 JSON，这里交给 Expo 的
// sendEvent 当字典；JS 那侧用同一个 speechEventOf 验。缺席的字段不放进字典（等于桌面 JSON 里没有那个键）。
struct Event {
  /// status / listening / paused / resumed / partial / final / level / played / playError / error
  let type: String
  var text: String?
  var message: String?
  /// status：语音识别授权（authorized / denied / restricted / notDetermined）
  var speech: String?
  /// status：麦克风授权（同上四档）
  var mic: String?
  /// status：这个语言在这台设备上能不能本机识别
  var onDevice: Bool?
  var locale: String?
  /// status：系统回声消除开没开（nil = 还没开过麦）
  var aec: Bool?
  /// listening：开 / 关
  var on: Bool?
  /// level：麦克风此刻的能量（0..1）
  var value: Double?
  /// level：能量门判「有人在说话」
  var active: Bool?
  /// played / playError：哪一段
  var id: String?

  var dictionary: [String: Any?] {
    var d: [String: Any?] = ["type": type]
    if let text { d["text"] = text }
    if let message { d["message"] = message }
    if let speech { d["speech"] = speech }
    if let mic { d["mic"] = mic }
    if let onDevice { d["onDevice"] = onDevice }
    if let locale { d["locale"] = locale }
    if let aec { d["aec"] = aec }
    if let on { d["on"] = on }
    if let value { d["value"] = value }
    if let active { d["active"] = active }
    if let id { d["id"] = id }
    return d
  }
}
```

Create `mobile/modules/otto-speech/ios/OttoSpeechModule.swift`：

```swift
import ExpoModulesCore

// 手机端语音通话的原生一半（#1356 A4，ADR-0320）：识别 + 断句 + 回声消除 + 放音，照搬桌面
// native/MrOttoSpeech（ADR-0273 / 0277 / 0280）。桌面那边是一个吃 stdin 的子进程，这里是 Expo 模块：
// 命令是 AsyncFunction（一律在主线程上跑——Recognizer 的状态只在主线程上动），事件一律走 onSpeech
// （不是请求-响应：识别结果是自己冒出来的，没有哪一条命令在等它）。
public class OttoSpeechModule: Module {
  private lazy var recognizer: Recognizer = Recognizer { [weak self] event in
    self?.sendEvent("onSpeech", event.dictionary)
  }

  public func definition() -> ModuleDefinition {
    Name("OttoSpeech")

    Events("onSpeech")

    AsyncFunction("start") { (locale: String, hints: [String]) in
      self.recognizer.start(locale: locale, hints: hints)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.recognizer.stop()
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      self.recognizer.pause()
    }.runOnQueue(.main)

    AsyncFunction("resume") {
      self.recognizer.resume()
    }.runOnQueue(.main)

    AsyncFunction("status") {
      self.recognizer.emitStatus()
    }.runOnQueue(.main)

    AsyncFunction("play") { (id: String, uri: String) in
      self.recognizer.play(id: id, uri: uri)
    }.runOnQueue(.main)

    AsyncFunction("stopPlay") {
      self.recognizer.stopPlay()
    }.runOnQueue(.main)

    OnDestroy {
      let recognizer = self.recognizer
      DispatchQueue.main.async { recognizer.shutdown() }
    }
  }
}
```

- [ ] **Step 5: Swift——放音**

Create `mobile/modules/otto-speech/ios/Playback.swift`：

```swift
import AVFoundation
import Foundation

// 放音（#1356 A4，ADR-0320）：桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Playback.swift 的 iOS 版——
// agent 的 TTS 字节由 JS 落成缓存目录里的一个文件，这里用识别那**同一个** AVAudioEngine 的 AVAudioPlayerNode
// 放：不被回声消除压低，还是回声消除的远端参考信号（ADR-0280）。
// 与桌面的差别两处：路径收 expo-file-system 给的 file:// URI；多一个 interrupt——系统把声音拿走（来电 /
// 耳机拔了）时节点停了、完成回调不会来，手上那段要报 playError，不然 JS 那边的放音队列会一直等下去。
// 一次只放一段（JS 那边的队列本来就串行）；每段换格式就重连一次节点（mp3 的采样率不定）。stop 之后迟到的
// 完成回调用 generation 认账。所有状态在主线程上动。
final class Playback {
  private let engine: AVAudioEngine
  private let node = AVAudioPlayerNode()
  private var attached = false
  private var connectedFormat: AVAudioFormat?
  private var generation = 0
  private var currentId: String?
  private let emit: (Event) -> Void

  init(engine: AVAudioEngine, emit: @escaping (Event) -> Void) {
    self.engine = engine
    self.emit = emit
  }

  var isPlaying: Bool { currentId != nil }

  /// `ensureRunning`：节点接好之后再起引擎——一个节点都没有的 engine 起不来（桌面探针撞过）
  func play(id: String, uri: String, ensureRunning: () throws -> Void) {
    stop()
    let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      emit(Event(type: "playError", message: "音频解不开：\(error.localizedDescription)", id: id))
      return
    }
    if !attached {
      engine.attach(node)
      attached = true
    }
    let format = file.processingFormat
    if connectedFormat == nil || connectedFormat! != format {
      if connectedFormat != nil { engine.disconnectNodeOutput(node) }
      engine.connect(node, to: engine.mainMixerNode, format: format)
      connectedFormat = format
    }
    do {
      try ensureRunning()
    } catch {
      emit(Event(type: "playError", message: "音频引擎起不来：\(error.localizedDescription)", id: id))
      return
    }
    generation += 1
    let gen = generation
    currentId = id
    node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.generation == gen else { return }
        self.currentId = nil
        self.emit(Event(type: "played", id: id))
      }
    }
    node.play()
  }

  /// 停手上这段（不发 played：停是 JS 自己要的，它知道）
  func stop() {
    guard currentId != nil else { return }
    generation += 1
    currentId = nil
    node.stop()
  }

  /// 系统把声音拿走了：节点已经停了、完成回调不会来——手上那段报 playError
  func interrupt(message: String) {
    guard let id = currentId else { return }
    generation += 1
    currentId = nil
    node.stop()
    emit(Event(type: "playError", message: message, id: id))
  }
}
```

- [ ] **Step 6: Swift——识别**

Create `mobile/modules/otto-speech/ios/Recognizer.swift`：

```swift
import AVFoundation
import Foundation
import Speech

// 识别会话（#1356 A4，ADR-0320）：桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Recognizer.swift 的 iOS 版。
// 逐段对应桌面那份（理由写在那份的头注与 ADR-0273 / 0277 / 0280：AVAudioEngine 的输入 tap 喂识别 request、
// 每句收口换新 request、没人说话 50 秒换一次、能量门喂断句、半双工 pause/resume 不停引擎、回声消除开得了
// 就不半双工、放音挂在同一个引擎上）。iOS 多出来的五处：
// ① 起引擎之前配 AVAudioSession（playAndRecord、默认走扬声器、允许蓝牙 A2DP 放音）并激活；听与放都停了
//    再交还（notifyOthersOnDeactivation：别的 app 的音乐接着放）；
// ② 来电 / Siri 打断、耳机插拔（引擎配置变了）会让引擎停下而不回调：当成一次中断说出口——停听、手上那段
//    放音报 playError（不报的话 JS 那边的放音队列会一直等一个永远不来的 played）。起引擎（尤其刚开完回声
//    消除）自己也可能触发一次「配置变了」，起来之后 1 秒内的那一条不算；
// ③ 回声消除的 ducking 配置是 iOS 17 起才有的 API；
// ④ 放音收 expo-file-system 给的 file:// URI（Playback.swift）；
// ⑤ 起完引擎再报一次 status：aec 要开完回声消除才知道（桌面那份只在开引擎之前报，第一次开麦时 aec 还是 nil）。
// **所有状态都在主线程上动**（识别回调与音频 tap 各在自己的线程上，一律 hop 到 main）。

private func speechAuthName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "notDetermined"
  }
}

private func micAuthName(_ s: AVAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "notDetermined"
  }
}

private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

final class Recognizer {
  private let emit: (Event) -> Void
  private let engine = AVAudioEngine()
  /// 放音（与识别共用 engine：不被回声消除压低，还是回声参考，ADR-0280）
  private lazy var playback = Playback(engine: engine) { [weak self] e in
    self?.emit(e)
    if e.type == "played" || e.type == "playError" { self?.deactivateIfIdle() }
  }
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var endpointer = Endpointer()
  private var gate = LevelGate()
  private var timer: Timer?
  private var running = false
  private var paused = false
  private var generation = 0
  private var requestStartedAt: Double = 0
  private var locale = "zh-CN"
  /// 上下文词表（start 给的），每个 request 都带
  private var hints: [String] = []
  /// 回声消除开没开；nil = 还没开过麦
  private var aec: Bool? = nil
  private var lastLevelEmitAt: Double = 0
  /// level 事件的节流（毫秒）：音频块几十块一秒，界面画声浪 10 帧一秒够了
  private let levelEveryMs: Double = 100
  /// 没人说话时多久换一次 request（毫秒）：攒着的音频有上限
  private let idleRestartMs: Double = 50_000
  /// 引擎最近一次起来的时刻，与「配置变了」那条通知对账（头注 ②）
  private var engineStartedAt: Double = 0
  private let settleMs: Double = 1000
  private var observers: [NSObjectProtocol] = []

  init(emit: @escaping (Event) -> Void) {
    self.emit = emit
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
      self?.interrupted("被系统打断了（来电 / Siri），点一下麦克风再开")
    })
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      guard let self, nowMs() - self.engineStartedAt > self.settleMs else { return }
      self.interrupted("声音设备变了（耳机 / 蓝牙），点一下麦克风再开")
    })
  }

  func status() -> Event {
    Event(
      type: "status",
      speech: speechAuthName(SFSpeechRecognizer.authorizationStatus()),
      mic: micAuthName(AVCaptureDevice.authorizationStatus(for: .audio)),
      onDevice: recognizer?.supportsOnDeviceRecognition,
      locale: locale,
      aec: aec)
  }

  func emitStatus() {
    emit(status())
  }

  func start(locale: String, hints: [String]) {
    if running {
      emit(Event(type: "listening", on: true))
      return
    }
    self.locale = locale
    self.hints = hints
    endpointer = Endpointer()
    gate = LevelGate()
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
      emit(Event(type: "error", message: "这台设备不支持识别「\(locale)」"))
      return
    }
    recognizer = r
    // 两道授权按顺序问：先语音识别再麦克风；任何一道没过都把 status 发出去，JS 据它说人话（去哪儿打开）
    SFSpeechRecognizer.requestAuthorization { [weak self] s in
      DispatchQueue.main.async {
        guard let self else { return }
        guard s == .authorized else {
          self.emit(self.status())
          self.emit(Event(type: "error", message: "没有「语音识别」权限"))
          return
        }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          DispatchQueue.main.async {
            guard ok else {
              self.emit(self.status())
              self.emit(Event(type: "error", message: "没有「麦克风」权限"))
              return
            }
            self.emit(self.status())
            self.beginAudio()
          }
        }
      }
    }
  }

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    try session.setActive(true)
  }

  /// 听与放都停了：停引擎、把音频交还给系统（别的 app 的音乐接着放）
  private func deactivateIfIdle() {
    guard !running, !playback.isPlaying else { return }
    if engine.isRunning { engine.stop() }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func ensureEngine() throws {
    guard !engine.isRunning else { return }
    engine.prepare()
    try engine.start()
    engineStartedAt = nowMs()
  }

  private func ensurePlaybackEngine() throws {
    guard !engine.isRunning else { return }
    try activateSession()
    try ensureEngine()
  }

  private func beginAudio() {
    guard !running else { return }
    do {
      try activateSession()
    } catch {
      emit(Event(type: "error", message: "麦克风打不开：\(error.localizedDescription)"))
      return
    }
    let input = engine.inputNode
    // 系统回声消除（ADR-0277）。开不了不算错——status.aec=false，JS 退回半双工
    do {
      if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
      aec = true
    } catch {
      aec = false
    }
    if aec == true, #available(iOS 17.0, *) {
      input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      emit(Event(type: "error", message: "没有可用的麦克风"))
      deactivateIfIdle()
      return
    }
    // 开着回声消除时输出格式可能是多声道，识别器吃不下：只取第 0 声道折成 mono（桌面同一条）
    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false) else {
      emit(Event(type: "error", message: "麦克风格式不支持（\(format.sampleRate) Hz）"))
      deactivateIfIdle()
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      // 音频线程。paused / request 是主线程改的，这里只读——最坏多喂一两块，无害
      guard let self, let src = buffer.floatChannelData else { return }
      let n = Int(buffer.frameLength)
      guard n > 0 else { return }
      // 能量：第 0 声道的 RMS。paused 时也算——声浪照画，只是不喂识别器
      var sum: Float = 0
      for i in 0..<n { sum += src[0][i] * src[0][i] }
      let rms = (sum / Float(n)).squareRoot()
      DispatchQueue.main.async { self.onLevel(rms: rms) }
      guard !self.paused, let req = self.request else { return }
      if buffer.format.channelCount > 1, let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) {
        out.frameLength = buffer.frameLength
        memcpy(out.floatChannelData![0], src[0], n * MemoryLayout<Float>.size)
        req.append(out)
      } else {
        req.append(buffer)
      }
    }
    do {
      try ensureEngine()
    } catch {
      input.removeTap(onBus: 0)
      emit(Event(type: "error", message: "麦克风打不开：\(error.localizedDescription)"))
      deactivateIfIdle()
      return
    }
    running = true
    paused = false
    emit(Event(type: "listening", on: true))
    // 头注 ⑤：aec 这时才知道
    emit(status())
    newRequest()
    // 100ms 一跳：断句的粒度——completeMs 700 之上再加的等待不该超过一跳
    let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  /// 换一个新的识别 request（旧 task 作废：generation 前进，迟到的回调认不了账）
  private func newRequest() {
    guard running, !paused, let recognizer else { return }
    generation += 1
    let gen = generation
    task?.cancel()
    request?.endAudio()
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    req.addsPunctuation = true
    if !hints.isEmpty { req.contextualStrings = hints }
    request = req
    requestStartedAt = nowMs()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(gen: gen, result: result, error: error) }
    }
  }

  private func handle(gen: Int, result: SFSpeechRecognitionResult?, error: Error?) {
    guard gen == generation, running, !paused else { return }
    if let result {
      if endpointer.feed(result.bestTranscription.formattedString, now: nowMs()) {
        emit(Event(type: "partial", text: endpointer.text))
      }
      if result.isFinal {
        if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
        newRequest()
      }
      return
    }
    if let error {
      // 识别器自己断了（服务端模式的 1 分钟上限、内部错误…）：手上那半句先收口，稍后重开——
      // 不把一次抖动翻成「识别坏了」。cancel 自己引起的错误走不到这里（generation 已经前进）
      if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
      emit(Event(type: "error", message: "识别中断：\(error.localizedDescription)，正在重试"))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        guard let self, self.generation == gen else { return }
        self.newRequest()
      }
    }
  }

  /// 一块音频的能量到了（主线程）：过门 → 喂断句 → 节流着发给界面
  private func onLevel(rms: Float) {
    guard running else { return }
    let now = nowMs()
    let r = gate.feed(rms: rms, now: now)
    if !paused { endpointer.feedLevel(active: r.active, now: now) }
    if now - lastLevelEmitAt >= levelEveryMs {
      lastLevelEmitAt = now
      emit(Event(type: "level", value: (r.level * 100).rounded() / 100, active: r.active))
    }
  }

  private func tick() {
    guard running, !paused else { return }
    let now = nowMs()
    if let text = endpointer.tick(now: now) {
      emit(Event(type: "final", text: text))
      newRequest()
      return
    }
    if endpointer.text.isEmpty, now - requestStartedAt > idleRestartMs {
      newRequest()
    }
  }

  func pause() {
    guard running, !paused else { return }
    paused = true
    generation += 1
    task?.cancel()
    request?.endAudio()
    task = nil
    request = nil
    if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
    emit(Event(type: "paused"))
  }

  func resume() {
    guard running, paused else { return }
    paused = false
    newRequest()
    emit(Event(type: "resumed"))
  }

  func stop() {
    guard running else { return }
    running = false
    paused = false
    timer?.invalidate()
    timer = nil
    generation += 1
    task?.cancel()
    request?.endAudio()
    task = nil
    request = nil
    endpointer = Endpointer()  // 手上那半句作废（离开 / 挂断）
    engine.inputNode.removeTap(onBus: 0)
    emit(Event(type: "listening", on: false))
    // 正在放它的话就先不停引擎（放音也挂在它上面），放完那一刻再停
    deactivateIfIdle()
  }

  func play(id: String, uri: String) {
    playback.play(id: id, uri: uri) { try self.ensurePlaybackEngine() }
  }

  func stopPlay() {
    playback.stop()
    deactivateIfIdle()
  }

  /// 系统把声音拿走了（头注 ②）：手上那段放音报 playError；在听的话先说一句为什么、再停听
  private func interrupted(_ message: String) {
    playback.interrupt(message: message)
    guard running else {
      deactivateIfIdle()
      return
    }
    emit(Event(type: "error", message: message))
    stop()
  }

  /// 模块被销毁（JS 那侧重载）：停听、停放、退订通知
  func shutdown() {
    stop()
    stopPlay()
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
  }
}
```

- [ ] **Step 7: app.json 的两句授权说明**

`mobile/app.json` 里：

```json
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.stanyan.mrotto.mobile"
    },
```

换成：

```json
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.stanyan.mrotto.mobile",
      "infoPlist": {
        "NSMicrophoneUsageDescription": "语音通话时要用麦克风听你说话。",
        "NSSpeechRecognitionUsageDescription": "语音通话时把你说的话转成文字，发给智能体。"
      }
    },
```

再把 `expo-camera` 那一格插件配置：

```json
      [
        "expo-camera",
        {
          "cameraPermissionText": "扫描电脑上的配对二维码时要用一下相机。"
        }
      ],
```

换成（同一句麦克风说明写进它的 `microphonePermission`：这个插件会往 Info.plist 写自己那句麦克风说明，写明了就不会被它的缺省英文盖掉）：

```json
      [
        "expo-camera",
        {
          "cameraPermissionText": "扫描电脑上的配对二维码时要用一下相机。",
          "microphonePermission": "语音通话时要用麦克风听你说话。"
        }
      ],
```

- [ ] **Step 8: 对拍测试转绿 + 手机 tsc**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npx vitest run tests/mobile/ottoSpeech.test.ts && npm --prefix mobile run typecheck 2>&1 | tail -20`
Expected: vitest PASS；手机 tsc 无报错（`index.ts` 能过类型检查）。

- [ ] **Step 9: 编译一次开发版（证明 Swift 编得过）**

这一步要 10–20 分钟（第一次 `pod install` 要下载，Xcode 要编整个 RN）。**派发这个任务的人可以替实现者在后台跑，把错误原样交回来**；实现者自己跑也行。命令（在 `mobile/` 里，`LANG` 是 CocoaPods 要的 UTF-8）：

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6/mobile && CI=1 EXPO_NO_TELEMETRY=1 LANG=en_US.UTF-8 npx expo prebuild --platform ios > ../.superpowers/prebuild.log 2>&1; echo "PREBUILD_EXIT=$?"
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6/mobile && ls ios | grep -E "xcworkspace|Podfile"
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6/mobile && grep -c OttoSpeech ios/Podfile.lock
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6/mobile && xcodebuild -workspace ios/MrOtto.xcworkspace -scheme MrOtto -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build > ../.superpowers/xcodebuild.log 2>&1; echo "XCB_EXIT=$?"
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && grep -E "BUILD SUCCEEDED|BUILD FAILED|error:" .superpowers/xcodebuild.log | head -30
```

Expected: `PREBUILD_EXIT=0`；`ls` 看得到 `MrOtto.xcworkspace`（名字不同就用 `ls ios` 看到的那个替换两处 `MrOtto`）；`Podfile.lock` 里有 `OttoSpeech`（autolinking 认到了本地模块；为 0 就是 `expo-module.config.json` 或目录位置不对）；`XCB_EXIT=0` 且日志里有 `** BUILD SUCCEEDED **`。

编译错误只许改 `mobile/modules/otto-speech/ios/` 下**手写的那四个** Swift 文件（`OttoSpeechModule.swift` / `Recognizer.swift` / `Playback.swift` / `Event.swift`）；`Level.swift` 与 `Endpointer.swift` 是照抄的，不许改（改了对拍会红；若它们本身在 iOS 上编不过，停下来报告，不要改）。改完回到 Step 8 再跑一遍对拍。

跑完 `git status --short`：`mobile/ios/` 不应出现（被 `.gitignore` 挡住）；若 `prebuild` 顺手改了 `mobile/app.json` / `mobile/package.json` 里 Step 7 之外的东西，用 `git diff mobile/app.json mobile/package.json` 看清楚，把不是本任务的改动还原（`git checkout -p` 逐块选）。

- [ ] **Step 10: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add mobile/modules/otto-speech/expo-module.config.json mobile/modules/otto-speech/index.ts mobile/modules/otto-speech/ios/OttoSpeech.podspec mobile/modules/otto-speech/ios/OttoSpeechModule.swift mobile/modules/otto-speech/ios/Recognizer.swift mobile/modules/otto-speech/ios/Playback.swift mobile/modules/otto-speech/ios/Event.swift mobile/modules/otto-speech/ios/Level.swift mobile/modules/otto-speech/ios/Endpointer.swift mobile/app.json tests/mobile/ottoSpeech.test.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
feat(mobile): 语音原生模块 otto-speech——照搬桌面 MrOttoSpeech 的 Expo 本地模块（#1356 A4）

Expo Go 不带语音识别，识别一定要一个原生模块（维护者 2026-09-26：自写，不用社区库）。
照搬桌面 native/MrOttoSpeech：SFSpeechRecognizer + AVAudioEngine、每句收口换新 request、
断句 Endpointer、能量门 LevelGate、VPIO 回声消除（开得了就不半双工、人能插嘴）、
放音挂在识别那同一个引擎上（不被压低、是回声参考，ADR-0280）——桌面在真机上踩过的
自激回声 / ducking / 边想边说被切碎一次带过来。

Level.swift 与 Endpointer.swift 逐字抄，tests/mobile/ottoSpeech.test.ts 对拍（外加事件字段表、
JS↔Swift 函数表、Info.plist 两句授权说明）；不共用源文件是因为 CocoaPods 收不到 pod 目录外的
源文件，而改桌面 helper 要重编、重编要人重新点 TCC。iOS 多出来的五件事写在 Recognizer.swift
头注（AVAudioSession、打断要说出口、iOS 17 的 ducking API、file:// URI、起完引擎再报一次 status）。
开发版编译过一次（xcodebuild BUILD SUCCEEDED）；Swift 不进门禁。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 6: 手机端接线——`voiceStore` 与聊天连接的钩子

编排在 shared（Task 3），这里只把它接到四样东西上：原生模块（识别 + 放音）、TTS 网关（`createTtsClient`）、聊天那条连接（`chatStore` 给四个钩子 + 发话 / 改名单）、App 前后台。订阅快照（电话钮画不画要知道「订阅活跃 + 网关供语音」）进聊天页拉一次、拉失败留着上一次的。

**Files:**
- Modify: `mobile/src/cloud/chatStore.ts`
- Create: `mobile/src/voice/voiceStore.ts`

**Interfaces:**
- Consumes：`createVoiceSession` / `VoiceListen` / `VoiceMicPort`（Task 3）、`createTtsClient`（Task 2）、`ttsHostedOf`（Task 2）、`speechEventOf`（Task 2）、`createHelperAudio` / `helperAudioEvent` / `HelperAudioBridge`（Task 1）、`voiceCallAvailable`（Task 1）、`IOS_PERMISSION_HELP` / `SPEECH_LOCALE` / `speechHints`（Task 1 / 3）、`OttoSpeech`（Task 5）、`fetchBilling`（`mobile/src/home/billing.ts`，已有）、`homeSnapshot`（`mobile/src/home/homeStore.ts`，已有）。
- Produces：
  - `mobile/src/cloud/chatStore.ts`：`interface ChatActivity { event(e: SessionEvent): void; delta(d: CloudSessionDelta): void; room(sessionId: string, prev: ChatSession["state"], next: ChatSession["state"]): void; closed(): void }`、`setChatActivity(a: ChatActivity | null): void`、`chatEvents(sessionId: string): readonly SessionEvent[] | null`、`sayVoice(text: string): Promise<CloudAck>`、`setVoiceCall(agentIds: string[]): Promise<CloudAck>`
  - `mobile/src/voice/voiceStore.ts`：`interface VoiceStoreState { listen: VoiceListen | null; billing: BillingSnapshotView | null }`、`useVoice(): VoiceStoreState`、`nativeSpeech: boolean`、`voiceUsable(s: VoiceStoreState): boolean`、`refreshVoiceBilling(): Promise<void>`、`startCall(sessionId: string, agentIds: string[]): Promise<CloudAck>`、`hangUp(): Promise<CloudAck>`、`joinCall(sessionId: string): void`、`setMic(on: boolean): void`

- [ ] **Step 1: chatStore 的钩子与两个动作**

`mobile/src/cloud/chatStore.ts`：

1. 文件头注末尾（`// · **代数**：…` 那一段之后）加一段：

```ts
// · **给语音那一层的钩子**（A4）：事件落进来、流式碎片、房间状态翻转、离开这一页——语音的编排
//   （shared 的 voiceSession）要知道这四件事；这里不认识语音，只在 store 改完之后通知一声。
```

2. `import type { CloudAck, CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";` 不动（已经有这三个名字）。

3. 在 `const store = createStore<ChatStoreState>(EMPTY);` 那一行之后加：

```ts
/** 语音那一层要知道的四件事（A4）。只在 store 改完之后调（它会回头读 chatEvents） */
export interface ChatActivity {
  event(e: SessionEvent): void;
  delta(d: CloudSessionDelta): void;
  room(sessionId: string, prev: ChatSession["state"], next: ChatSession["state"]): void;
  closed(): void;
}
let activity: ChatActivity | null = null;

export function setChatActivity(a: ChatActivity | null): void {
  activity = a;
}

/** 语音那一层读日志用（非 hook）：不是这一条就当没有 */
export function chatEvents(sessionId: string): readonly SessionEvent[] | null {
  const s = store.get().session;
  return s !== null && s.sessionId === sessionId ? s.events : null;
}
```

4. `onEvent` 里 `store.set({ session: { ...s.session, events }, ...(streaming !== s.streaming ? { streaming } : {}) });` 之后加一行 `activity?.event(event);`

5. `onDelta` 整个换成：

```ts
function onDelta(d: CloudSessionDelta): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== d.sessionId) return;
  const streaming = applyCloudDelta(s.streaming, d);
  if (streaming !== s.streaming) store.set({ streaming });
  activity?.delta(d);
}
```

6. `onStatus` 整个换成：

```ts
function onStatus(status: CloudSessionStatus): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== status.sessionId) return;
  const prev = s.session.state;
  const session: ChatSession = { ...s.session, ...applyCloudStatus(s.session, status) };
  store.set({ session, ...(status.notice === undefined ? {} : { notice: status.notice }) });
  if (prev !== session.state) activity?.room(session.sessionId, prev, session.state);
  if (session.state === "ready") void flushPendingFirst(session.sessionId);
}
```

7. 在 `export function stopTurn(` 之前加：

```ts
/** 通话里说完的一句（A4）：不 @（走派活）、带 voice 记号——转写出来的正文与手打的一个字节都不差，
    「这句是说出来的」只有麦克风这一侧知道（协议 19，#1233），时间线据它把一通电话折成一张卡 */
export function sayVoice(text: string): Promise<CloudAck> {
  return cloudClient.say(text, false, [], [], true);
}

/** 改这条聊天的通话名单（A4）：空 = 挂断。回执只答「收没收下」，通话栏画的是随后落下来的那条事件 */
export function setVoiceCall(agentIds: string[]): Promise<CloudAck> {
  return cloudClient.call(agentIds);
}
```

8. `closeChat` 整个换成：

```ts
/** 离开这一页：先让语音那一层收口（停麦停放音——通话本身还在），再断连接、清状态 */
export function closeChat(): void {
  activity?.closed();
  gen += 1;
  void cloudClient.leave();
  store.set(EMPTY);
}
```

- [ ] **Step 2: voiceStore**

Create `mobile/src/voice/voiceStore.ts`：

```ts
// 语音通话在手机上的接线（#1356 A4，spec §5.7，ADR-0320）：编排在 shared 的 voiceSession（进 vitest），
// 这里只把它接到四样东西上——原生模块（识别 + 放音）、TTS 网关（createTtsClient）、聊天那条连接
// （chatStore 的钩子 + sayVoice / setVoiceCall）、App 前后台。
//
// · 原生模块只在开发版里有（Expo Go 里 OttoSpeech 为 null）：没有它就没有电话钮，别的照常。
// · 放音：一段字节先落成缓存目录里的一个文件（原生放音器只收路径），交给原生模块用识别那同一个
//   音频引擎放（ADR-0280：不被回声消除压低、是回声参考）；放完 / 放不了 / 停掉就删。
// · 订阅快照：电话钮画不画要知道「订阅活跃 + 网关供语音」。进聊天页拉一次，拉失败留着上一次的
//   （拿不到 ≠ 没订阅）；还没拉到时不画钮（说不清就不画）。
// · 切到后台 = 这台停听（停麦停放音），通话本身还在——回来那一格写「通话还开着」+「接着听」
//   （维护者 2026-09-26）。只认 background：下拉控制中心 / 来一条通知横幅是 inactive，那不是人离开了。
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
import { createHelperAudio, helperAudioEvent, type HelperAudioBridge } from "../../../src/shared/helperAudio.js";
import type { BillingSnapshotView, CloudAck } from "../../../src/shared/shellBridge.js";
import { speechEventOf } from "../../../src/shared/speechEvent.js";
import { createTtsClient } from "../../../src/shared/ttsClient.js";
import { ttsHostedOf } from "../../../src/shared/ttsRoute.js";
import { voiceCallAvailable } from "../../../src/shared/voiceFeed.js";
import { IOS_PERMISSION_HELP, SPEECH_LOCALE, speechHints } from "../../../src/shared/voiceMic.js";
import { createVoiceSession, type VoiceListen, type VoiceMicPort } from "../../../src/shared/voiceSession.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import { chatEvents, sayVoice, setChatActivity, setVoiceCall } from "../cloud/chatStore.js";
import { createStore } from "../externalStore.js";
import { fetchBilling } from "../home/billing.js";
import { homeSnapshot } from "../home/homeStore.js";
import { supabase } from "../supabase.js";

export interface VoiceStoreState {
  /** 这台在听的那一场；null = 没在听 */
  listen: VoiceListen | null;
  /** 电话钮要的订阅快照；null = 还没查到（不画钮） */
  billing: BillingSnapshotView | null;
}

const store = createStore<VoiceStoreState>({ listen: null, billing: null });

export function useVoice(): VoiceStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 这个 app 里有没有语音原生模块（开发版有、Expo Go 没有） */
export const nativeSpeech = OttoSpeech !== null;

/** 这台此刻打不打得了电话：有原生模块 + 订阅活跃 + 网关供语音 */
export function voiceUsable(s: VoiceStoreState): boolean {
  return nativeSpeech && voiceCallAvailable(s.billing);
}

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 home/billing.ts）
const EDGE_BASE = edgeBaseUrl({} as never);
const accessToken = async (): Promise<string | null> =>
  (await supabase.auth.getSession()).data.session?.access_token ?? null;

const tts = createTtsClient({
  // 手机没有桌面 hostedQuota 那份实时额度账：额度用完由网关的 429 当场说出口，两个记账口接空
  quota: { ttsInput: () => ttsHostedOf(store.get().billing), noteHeaders: () => {}, noteExhausted: () => {} },
  edgeBaseUrl: () => EDGE_BASE,
  accessToken,
});

const audioDir = new Directory(Paths.cache, "otto-voice");
const files = new Map<string, File>();
let audioSeq = 0;

function dropFile(id: string): void {
  const f = files.get(id);
  if (f === undefined) return;
  files.delete(id);
  try {
    f.delete();
  } catch {
    // 已经不在了（缓存被系统清过）：没什么要收拾的
  }
}

const nativeAudio: HelperAudioBridge = {
  async play(bytes) {
    if (OttoSpeech === null) return { error: "这个版本的 app 里没有语音模块" };
    const id = `v${++audioSeq}`;
    try {
      if (!audioDir.exists) audioDir.create({ idempotent: true, intermediates: true });
      const f = new File(audioDir, `${id}.mp3`);
      f.create({ overwrite: true });
      f.write(bytes);
      files.set(id, f);
      await OttoSpeech.play(id, f.uri);
      return { id };
    } catch (err) {
      dropFile(id);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  async stop() {
    await OttoSpeech?.stopPlay();
    for (const id of [...files.keys()]) dropFile(id);
  },
};

const mic: VoiceMicPort = {
  start: (hints) => void OttoSpeech?.start(SPEECH_LOCALE, hints),
  stop: () => void OttoSpeech?.stop(),
  pause: () => void OttoSpeech?.pause(),
  resume: () => void OttoSpeech?.resume(),
};

const session = createVoiceSession({
  speak: (text, voiceId) => tts.speak(text, voiceId),
  createAudio: (bytes) => createHelperAudio(bytes, nativeAudio),
  mic,
  say: (text) => sayVoice(text),
  events: (sessionId) => chatEvents(sessionId),
  // 音色按名册顺序解撞（agentVoiceIds）：同一只在桌面与手机上是同一个声音
  roster: () => homeSnapshot().home?.agents.map((a) => a.agentId) ?? [],
  hints: () => speechHints(homeSnapshot().home),
  permissionHelp: IOS_PERMISSION_HELP,
  onChange: (listen) => store.set({ listen }),
});

OttoSpeech?.addListener("onSpeech", (raw) => {
  const ev = speechEventOf(raw);
  if (ev === null) return;
  // 放音的回执：先删文件，再叫醒那一段（helperAudio 的登记）；这两种不是麦克风的事
  if (ev.type === "played" || ev.type === "playError") dropFile(ev.id);
  if (helperAudioEvent(ev)) return;
  session.onSpeech(ev);
});

setChatActivity({
  event: (e) => session.onEvent(e),
  delta: (d) => session.onDelta(d),
  room: (sessionId, prev, next) => session.onRoomState(sessionId, prev, next),
  closed: () => session.leave(),
});

AppState.addEventListener("change", (s) => {
  if (s === "background") session.leave();
});

/** 进聊天页拉一次订阅快照。拉失败留着上一次的（拿不到 ≠ 没订阅） */
export async function refreshVoiceBilling(): Promise<void> {
  const b = await fetchBilling();
  if (b !== null) store.set({ billing: b });
}

/** 开电话：改名单（call 帧）→ 回执 ok 之后这台开始听（发起的人自动加入，同桌面）。
    runtime 先广播那条 voice_call_changed 再回执，所以加入那一刻日志里已经有这场通话 */
export async function startCall(sessionId: string, agentIds: string[]): Promise<CloudAck> {
  const r = await setVoiceCall(agentIds);
  if (r.ok) session.join(sessionId);
  return r;
}

/** 挂断 = 空名单（主场里只有你一个人，不二次确认）。电话那一格收起看的是随后落下来的那条事件 */
export function hangUp(): Promise<CloudAck> {
  return setVoiceCall([]);
}

/** 「接着听」：通话还开着，这台重新开始听（只读之后落下来的话） */
export function joinCall(sessionId: string): void {
  session.join(sessionId);
}

/** 静音 = 关麦（spec §5.7 / demo）；再点一下开回来 */
export function setMic(on: boolean): void {
  session.setMic(on);
}
```

- [ ] **Step 3: 手机 tsc + 门禁里相关的几条**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npm --prefix mobile run typecheck 2>&1 | tail -20; npx vitest run tests/architecture.test.ts`
Expected: 手机 tsc 无报错；architecture PASS（`mobile/src/voice/voiceStore.ts` 在自身之外只 import 了 `src/shared/**` 与 `mobile/modules/**`）。

若 `File.write` / `Directory.create` 的签名对不上：以 `mobile/node_modules/expo-file-system/build/internal/NativeFileSystem.types.d.ts` 与 `File.types.d.ts` / `Directory.types.d.ts` 为准改调用写法，意思不变（建目录幂等、建文件覆盖、写字节）。

- [ ] **Step 4: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add mobile/src/cloud/chatStore.ts mobile/src/voice/voiceStore.ts
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
feat(mobile): 语音通话接线——原生模块、TTS 网关、聊天连接、前后台（#1356 A4）

编排在 shared 的 voiceSession，这里只接线：
- chatStore 给语音那一层四个钩子（事件落进来 / 流式碎片 / 房间状态翻转 / 离开这一页）
  与两个动作（sayVoice：不 @、带 voice 记号；setVoiceCall：改通话名单，空 = 挂断），
  它自己不认识语音；
- voiceStore：原生模块的事件过 speechEventOf，放音回执交给 helperAudio，其余交给编排；
  TTS 走 createTtsClient（手机没有实时额度账，两个记账口接空）；一段字节落成缓存文件交给
  原生模块用识别那同一个引擎放，放完就删；进聊天页拉一次订阅快照、拉失败留着上一次的；
  切到后台 = 这台停听，通话本身还在（维护者 2026-09-26）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 7: 电话模式替换输入框、通话折成卡（界面）

样子逐值取自 demo：电话那一格 `.voicebar`（一行：脸 69×56 盒子 | 22 根 3 宽的声浪、间隔 2、那一格 30 高 | 计时 14/600 等宽数字弱色；底下一排：62×46 圆角 18 的钮，挂断 76 宽实底红）；通话卡 `.callcard`（卡底、圆角 18、上下 13 左右 15；一行「声浪图标 17 + 语音聊天 16/600 + 右边时长 14 弱色」，第二行 14.5 弱色）；点开是 A1 那副 70% 的底部抽屉（不盖住头上那颗药丸）。

**Files:**
- Modify: `mobile/src/theme.ts`（令牌 `voice`）
- Create: `mobile/src/chrome/VoiceGlyphs.tsx`、`mobile/src/voice/CallBar.tsx`、`mobile/src/voice/CallCardRow.tsx`、`mobile/src/voice/CallSheet.tsx`
- Modify: `mobile/src/chat/Composer.tsx`、`mobile/src/chat/ChatRows.tsx`、`mobile/src/chat/ChatScreen.tsx`

**Interfaces:**
- Consumes：`mobileCall` 的 `callBarMode` / `callFace` / `joinBlockedText` / `phoneOffered` / `waveMode` / `waveBarHeight` / `WaveMode`（Task 4）；`mobileChat` 的 `call` 行与 `liveRows({ hide })`（Task 4）；`voiceStore` 的 `useVoice` / `voiceUsable` / `nativeSpeech` / `refreshVoiceBilling` / `startCall` / `hangUp` / `joinCall` / `setMic`（Task 6）；`callDurationText` / `callOffsetText` / `VoiceCallCard` / `VoiceCallCardLine`（`src/shared/cloudTimeline.ts`，已有）；`voiceCallOf`（`src/shared/voiceCall.ts`）；`openTurns`（`src/shared/turnLedger.ts`）。
- Produces：`CallBar(props: CallBarProps)`、`CallCardRow({ card, topic, onPress })`、`CallSheet({ visible, card, onClose, onExited })`、`WaveGlyph` / `MicGlyph` / `KeyboardGlyph` / `HangUpGlyph`；`Composer` 多一个可选 prop `phone?: { onCall: () => void; busy: boolean }`；`ChatRowView` 多一个可选 prop `onOpenCall?: (seq: number) => void`。

- [ ] **Step 1: 令牌与图标**

`mobile/src/theme.ts`：`Palette` 接口里 `scrim: string;` 那一格（连同它上面那行注释）之后加：

```ts
  /** 通话那一格的声浪色（demo 的 --voice；两套配色同一个值——它是通话的记号，不跟深浅走） */
  voice: string;
```

`light` 与 `dark` 两个对象里各在 `scrim: …,` 之后加一行 `voice: "#2F94A6",`。

Create `mobile/src/chrome/VoiceGlyphs.tsx`：

```tsx
// 电话那一格的四枚图标（#1356 A4）：路径逐字取自 demo 的图标表（wave / mic / kbd / hang），24×24 的描边
// 图标，用 react-native-svg 画——别的 Glyph 是用 View 拼的，这几枚的曲线拼不出来。
import Svg, { Path } from "react-native-svg";

function Stroke({ d, color, size, weight }: { d: string; color: string; size: number; weight: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** 声浪：「开电话」那颗钮、通话卡的记号 */
export function WaveGlyph({ color, size = 20, weight = 2 }: { color: string; size?: number; weight?: number }) {
  return <Stroke d="M2 12h3l2-7 3 14 3-10 2 5h7" color={color} size={size} weight={weight} />;
}

/** 麦克风：静音那颗 */
export function MicGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return <Stroke d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" color={color} size={size} weight={2} />;
}

/** 键盘：转文字那颗 */
export function KeyboardGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return <Stroke d="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10" color={color} size={size} weight={2} />;
}

/** 听筒：挂断那颗 */
export function HangUpGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Stroke
      d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"
      color={color}
      size={size}
      weight={2.2}
    />
  );
}
```

- [ ] **Step 2: 电话那一格 `CallBar`**

Create `mobile/src/voice/CallBar.tsx`：

```tsx
// 电话模式（#1356 A4，spec §5.7）：替换输入框，不是浮在上面——通话时那一格本来就不打字，把输入框留在
// 下面只会让人以为还能打；也不做全屏——它在把活干完，时间线要接着看（demo 里维护者定的三件事）。
//
// 受控组件：进来的是这一刻的事实，出去的是几个动作；接线在 ChatScreen（同 A3 的 NewGroupForm，冒烟时
// 拿假数据把每个样子摆出来）。两种样子：
// · live（这台在听）：脸 | 声浪 | 计时；底下三颗：转文字 / 静音（= 关麦）/ 挂断。
// · idle（通话还开着、这台没在听——锁过屏、从名册回来）：「通话还开着」| 计时；底下两颗：
//   接着听（这台听不了时换成一句为什么）/ 挂断。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callOffsetText } from "../../../src/shared/cloudTimeline.js";
import { waveBarHeight, type WaveMode } from "../../../src/shared/mobileCall.js";
import { HangUpGlyph, KeyboardGlyph, MicGlyph } from "../chrome/VoiceGlyphs.js";
import { PRESS_SPRING, type as t, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

const BARS = 22;

export interface CallBarProps {
  mode: "live" | "idle";
  /** 左边那张脸（ChatScreen 画好：状态由它算）；null = 不画 */
  face: ReactNode;
  /** 这一场通话第一条名单事件的时刻（计时从这儿起） */
  sinceTs: number;
  wave: WaveMode;
  /** 麦克风能量 0..1 */
  level: number;
  micOn: boolean;
  captionsOn: boolean;
  /** 「转文字」那一行：它此刻在说的那句 / 你正在说的那句 */
  captions: { agent: string | null; me: string | null };
  /** idle 时：这台为什么听不了；null = 听得了 */
  joinBlocked: string | null;
  /** 开电话 / 挂断正在路上：挂断与接着听按不动 */
  busy: boolean;
  onToggleCaptions: () => void;
  onToggleMic: () => void;
  onHangUp: () => void;
  onJoin: () => void;
}

/** 计时：一秒一跳，作用域圈在这一格里（整页不跟着每秒重画） */
function CallTimer({ sinceTs }: { sinceTs: number }) {
  const { c } = usePalette();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Text accessibilityLabel={`通话 ${callOffsetText(now - sinceTs)}`} style={{ fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"], color: c.mutedForeground }}>
      {callOffsetText(now - sinceTs)}
    </Text>
  );
}

/** 声浪：22 根竖条，90ms 一跳（demo 的 transition 90ms linear）。关着麦是一条灰线；
    减弱动态效果时不走包络（t 钉在 0）、只跟能量 */
function Wave({ mode, level }: { mode: WaveMode; level: number }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const born = useRef(Date.now()).current;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (mode === "off" || reduce) return;
    const id = setInterval(() => setTick((n) => n + 1), 90);
    return () => clearInterval(id);
  }, [mode, reduce]);
  const time = reduce ? 0 : (Date.now() - born) / 1000;
  const color = mode === "off" ? withAlpha(c.mutedForeground, 0.5) : c.voice;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ flex: 1, minWidth: 0, height: 30, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 }}
    >
      {Array.from({ length: BARS }, (_, i) => (
        <View key={i} style={{ width: 3, borderRadius: 2, height: waveBarHeight(mode, level, time, i), backgroundColor: color }} />
      ))}
    </View>
  );
}

function CallButton({ label, tone, width = 62, onPress, disabled = false, selected, children }: {
  label: string;
  /** plain：次级底；on：点缀的警示底（静音着）；end：实底红（挂断）；go：主色（接着听） */
  tone: "plain" | "on" | "end" | "go";
  width?: number;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const bg = tone === "end" ? c.destructive : tone === "go" ? c.primary : tone === "on" ? withAlpha(c.warn, 0.26) : withAlpha(c.foreground, 0.1);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => to(0.94)}
      onPressOut={() => to(1)}
      style={({ pressed }) => [disabled ? { opacity: 0.4 } : reduce && pressed ? { opacity: 0.7 } : null]}
    >
      <Animated.View style={{ width, height: 46, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: bg, transform: [{ scale }] }}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

function Captions({ agent, me }: { agent: string | null; me: string | null }) {
  const { c } = usePalette();
  return (
    <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 8, gap: 2 }}>
      {agent === null && me === null ? <Text style={{ ...t.footnote, color: c.mutedForeground }}>这会儿没人说话。</Text> : null}
      {agent !== null ? <Text numberOfLines={2} style={{ ...t.footnote, color: c.mutedForeground }}>{agent}</Text> : null}
      {me !== null ? <Text numberOfLines={1} style={{ ...t.footnote, color: c.foreground }}>{`你：${me}`}</Text> : null}
    </View>
  );
}

export function CallBar(p: CallBarProps) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const frame = { gap: 10, paddingHorizontal: 12, paddingTop: 9, paddingBottom: Math.max(insets.bottom, 12) };
  // 脸那一格按脸的真实尺寸给盒子（69×56，demo：不给底、不裁、不圈边）
  const faceBox = p.face === null ? null : <View style={{ width: 69, height: 56, alignItems: "center", justifyContent: "center" }}>{p.face}</View>;
  if (p.mode === "idle") {
    return (
      <View style={frame}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 6 }}>
          {faceBox}
          <Text style={{ ...t.callout, color: c.foreground, flex: 1 }}>通话还开着</Text>
          <CallTimer sinceTs={p.sinceTs} />
        </View>
        {p.joinBlocked !== null ? <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 8 }}>{p.joinBlocked}</Text> : null}
        <View style={{ flexDirection: "row", gap: 9, justifyContent: "center" }}>
          {p.joinBlocked === null ? (
            <CallButton label="接着听" tone="go" width={124} onPress={p.onJoin} disabled={p.busy}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: c.primaryForeground }}>接着听</Text>
            </CallButton>
          ) : null}
          <CallButton label="挂断" tone="end" width={76} onPress={p.onHangUp} disabled={p.busy}>
            <HangUpGlyph color={c.destructiveForeground} />
          </CallButton>
        </View>
      </View>
    );
  }
  return (
    <View style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 6 }}>
        {faceBox}
        <Wave mode={p.wave} level={p.level} />
        <CallTimer sinceTs={p.sinceTs} />
      </View>
      {p.captionsOn ? <Captions agent={p.captions.agent} me={p.captions.me} /> : null}
      <View style={{ flexDirection: "row", gap: 9, justifyContent: "center" }}>
        <CallButton label="转文字" tone="plain" selected={p.captionsOn} onPress={p.onToggleCaptions}>
          <KeyboardGlyph color={c.foreground} />
        </CallButton>
        <CallButton label={p.micOn ? "静音" : "取消静音"} tone={p.micOn ? "plain" : "on"} selected={!p.micOn} onPress={p.onToggleMic}>
          <MicGlyph color={p.micOn ? c.foreground : c.warn} />
        </CallButton>
        <CallButton label="挂断" tone="end" width={76} onPress={p.onHangUp} disabled={p.busy}>
          <HangUpGlyph color={c.destructiveForeground} />
        </CallButton>
      </View>
    </View>
  );
}
```

- [ ] **Step 3: 通话卡与点开的那一扇**

Create `mobile/src/voice/CallCardRow.tsx`：

```tsx
// 一场通话折成的那张卡（#1356 A4，spec §5.7，ADR-0288）：收起时只报「多久」和「聊的什么」，点开是全文。
// 不报「几句话」（demo：那是干活的量，读者据此做不了任何事，同 ADR-0250 的理由）。还开着写「通话中」、
// 不走表——电话那一格已经有一只表。
import { useRef } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { callDurationText, type VoiceCallCard } from "../../../src/shared/cloudTimeline.js";
import { WaveGlyph } from "../chrome/VoiceGlyphs.js";
import { PRESS_SPRING, usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export function callCardDuration(card: VoiceCallCard): string {
  return card.endedTs === null ? "通话中" : callDurationText(card.endedTs - card.sinceTs);
}

export function CallCardRow({ card, topic, onPress }: { card: VoiceCallCard; topic: string | null; onPress: () => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const duration = callCardDuration(card);
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`语音聊天，${duration}${topic === null ? "" : `，${topic}`}`}
        accessibilityHint="点开看这通电话的全文"
        onPress={onPress}
        onPressIn={() => to(0.985)}
        onPressOut={() => to(1)}
        style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
      >
        <Animated.View style={{ backgroundColor: c.card, borderRadius: 18, paddingVertical: 13, paddingHorizontal: 15, transform: [{ scale }] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <WaveGlyph color={c.foreground} size={17} weight={2.2} />
            <Text style={{ fontSize: 16, fontWeight: "600", letterSpacing: -0.15, color: c.foreground }}>语音聊天</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 14, color: c.mutedForeground, fontVariant: ["tabular-nums"] }}>{duration}</Text>
          </View>
          {topic !== null ? (
            <Text numberOfLines={1} style={{ fontSize: 14.5, color: c.mutedForeground, marginTop: 3 }}>{topic}</Text>
          ) : null}
        </Animated.View>
      </Pressable>
    </View>
  );
}
```

Create `mobile/src/voice/CallSheet.tsx`：

```tsx
// 通话卡点开的那一扇（#1356 A4，spec §5.7）：从下面滑上来、不盖住头上那颗药丸（A1 那副 70% 的底部抽屉）。
// 一句一行：我说的靠右、上面一行「第几分几秒」；它说的靠左、上面一行「名字 · 第几分几秒」；
// 名单变更那几行居中只写字（不带脸）。抽屉底色是 card，所以它说的那句用 background 做底才分得开。
import { ScrollView, Text, View } from "react-native";
import { callOffsetText, type VoiceCallCard, type VoiceCallCardLine } from "../../../src/shared/cloudTimeline.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { callCardDuration } from "./CallCardRow.js";

function CallLine({ line }: { line: VoiceCallCardLine }) {
  const { c } = usePalette();
  if (line.parts !== null) {
    return <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{line.parts.map((p) => p.text).join("")}</Text>;
  }
  const at = callOffsetText(line.offsetMs);
  if (line.mine) {
    return (
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text style={{ fontSize: 12, color: c.mutedForeground, marginRight: 4, fontVariant: ["tabular-nums"] }}>{at}</Text>
        <View style={{ maxWidth: "85%", backgroundColor: withAlpha(c.foreground, 0.12), borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 }}>
          <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.foreground }}>{line.text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "flex-start", gap: 3 }}>
      <Text style={{ fontSize: 12, color: c.mutedForeground, marginLeft: 4, fontVariant: ["tabular-nums"] }}>{`${line.label} · ${at}`}</Text>
      <View style={{ maxWidth: "90%", backgroundColor: c.background, borderRadius: 20, paddingVertical: 11, paddingHorizontal: 15 }}>
        <Text selectable style={{ fontSize: 16, lineHeight: 23, color: c.foreground }}>{line.text}</Text>
      </View>
    </View>
  );
}

export function CallSheet({ visible, card, onClose, onExited }: {
  visible: boolean;
  /** 点开的那一张；抽屉退场放完之前调用方不清它（onExited 才清），正文不会在退场时一下子空掉 */
  card: VoiceCallCard | null;
  onClose: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  const title = card === null ? "语音聊天" : `语音聊天 · ${callCardDuration(card)}`;
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose} onExited={onExited}>
      <ScrollView contentContainerStyle={{ padding: space.md, gap: 10 }}>
        {card === null ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>这通电话已经不在了。</Text>
        ) : card.lines.length === 0 ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>这通电话里没人说话。</Text>
        ) : (
          card.lines.map((l) => <CallLine key={l.seq} line={l} />)
        )}
      </ScrollView>
    </BottomSheet>
  );
}
```

- [ ] **Step 4: 输入框右边那颗一物两用**

`mobile/src/chat/Composer.tsx`：

1. 头注第一行里 `空着时` 那半句 `// 是一颗灰的发送钮（A4 起空着变「开电话」，一物两用）。没有型号选择器、没有上下文环。` 换成 `// 是一颗灰的发送钮；这台打得了电话时（A4）空着变「开电话」，一物两用。没有型号选择器、没有上下文环。`

2. `import { Animated, Pressable, TextInput, View } from "react-native";` → `import { Animated, Easing, Pressable, TextInput, View } from "react-native";`；在 `import { SendGlyph } from "../chrome/Glyphs.js";` 之后加 `import { WaveGlyph } from "../chrome/VoiceGlyphs.js";`

3. 函数签名：

```tsx
export function Composer({ placeholder, canSend, sessionId, onSend, ref }: {
```

换成：

```tsx
export function Composer({ placeholder, canSend, sessionId, onSend, phone, ref }: {
```

并在 props 类型里 `onSend: (text: string) => Promise<boolean>;` 那一格之后加：

```tsx
  /** 输入框空着时右边那颗变「开电话」（A4，spec §5.3 一物两用）；缺席 = 这台打不了电话，照旧是那颗灰的发送钮。
      `busy`：电话正在打出去，这颗按不动 */
  phone?: { onCall: () => void; busy: boolean };
```

4. `const live = draft.trim() !== "" && canSend && !sending;` 之后加：

```tsx
  const calling = phone !== undefined && draft.trim() === "";
  const enabled = calling ? !(phone?.busy ?? false) : live;
  // 「开电话」⇄「发出去」换那一下：160ms 淡入 + 从 .7 放大（减弱动态效果时只淡入）
  const swap = useRef(new Animated.Value(1)).current;
  const lastCalling = useRef(calling);
  useEffect(() => {
    if (lastCalling.current === calling) return;
    lastCalling.current = calling;
    swap.setValue(0);
    Animated.timing(swap, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [calling, swap]);
```

5. 右边那颗 `Pressable` 与它里面的 `Animated.View` 整段（从 `<Pressable` 到对应的 `</Pressable>`）换成：

```tsx
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={calling ? "开电话" : "发送"}
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={() => {
          if (calling) phone?.onCall();
          else void submit();
        }}
        onPressIn={() => pressTo(0.93)}
        onPressOut={() => pressTo(1)}
        style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
      >
        <Animated.View
          style={{
            width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
            backgroundColor: calling || live ? c.primary : withAlpha(c.foreground, 0.07),
            opacity: calling && !enabled ? 0.5 : 1,
            transform: [{ scale: sendScale }],
          }}
        >
          <Animated.View style={{ opacity: swap, transform: reduce ? [] : [{ scale: swap.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }}>
            {calling ? <WaveGlyph color={c.primaryForeground} /> : <SendGlyph color={live ? c.primaryForeground : c.mutedForeground} />}
          </Animated.View>
        </Animated.View>
      </Pressable>
```

- [ ] **Step 5: 时间线画通话卡**

`mobile/src/chat/ChatRows.tsx`：

1. 头注末尾加一行：`// A4：一场语音通话折成的那张卡（\`call\`），点开由调用方开抽屉（onOpenCall）。`
2. 在 `import { Face } from "../face/Face.js";` 之后加 `import { CallCardRow } from "../voice/CallCardRow.js";`
3. `export function ChatRowView({ row, ws }: { row: ChatRow; ws: WorkspaceSnapshot }) {` 换成 `export function ChatRowView({ row, ws, onOpenCall }: { row: ChatRow; ws: WorkspaceSnapshot; onOpenCall?: (seq: number) => void }) {`
4. Task 4 占的那一格：

```tsx
    case "call":
      // A4 Task 7 画这张卡（CallCardRow）；这一格先占位，穷尽检查才不红
      return null;
```

换成：

```tsx
    case "call":
      return <CallCardRow card={row.card} topic={row.topic} onPress={() => onOpenCall?.(row.card.seq)} />;
```

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npm --prefix mobile run typecheck`
Expected: 手机 tsc 全绿。

- [ ] **Step 6: 聊天页接线**

`mobile/src/chat/ChatScreen.tsx`：

1. 头注末尾加一段：

```ts
// · 语音（A4，spec §5.7）：输入框空着时右边那颗变「开电话」（这台打得了电话、房间 ready、有智能体、还没通话）；
//   通话开着时输入框换成电话那一格（CallBar：这台在听 = live，没在听 = 「通话还开着」+「接着听」）；
//   挂断之后这一通在时间线上折成一张卡，点开是一扇底部抽屉放全文。通话开着时通话里那几只正在写的那一段
//   不画（落下来就折进卡里）。私聊拉那一只、群拉整个群；挂断不二次确认（主场里只有你一个人）。
```

2. import 区加（按字母序插进现有的几段里）：

```ts
import { callBarMode, callFace, joinBlockedText, phoneOffered, waveMode } from "../../../src/shared/mobileCall.js";
import { voiceCallOf } from "../../../src/shared/voiceCall.js";
import { CallBar } from "../voice/CallBar.js";
import { CallSheet } from "../voice/CallSheet.js";
import { hangUp, joinCall, nativeSpeech, refreshVoiceBilling, setMic, startCall, useVoice, voiceUsable } from "../voice/voiceStore.js";
```

3. 在 `const pendingMention = useRef<string | null>(null);` 之后加：

```tsx
  const voice = useVoice();
  /** 开电话 / 挂断正在路上 */
  const [callBusy, setCallBusy] = useState(false);
  /** 「转文字」那一行开着没有（这一页自己的事，不进 store） */
  const [captionsOn, setCaptionsOn] = useState(false);
  /** 点开的那张通话卡（按开场那条的 seq 认）与抽屉开没开；退场放完才清 seq，正文不会在退场时空掉 */
  const [openCallSeq, setOpenCallSeq] = useState<number | null>(null);
  const [callSheetOpen, setCallSheetOpen] = useState(false);
  // 电话钮要知道订阅活跃 + 网关供语音：进这一页拉一次（拉失败留着上一次的）
  useEffect(() => {
    void refreshVoiceBilling();
  }, []);
```

4. `const rows = useMemo(…)` 那一行之前加：

```tsx
  const call = useMemo(() => voiceCallOf(events), [events]);
  /** 通话开着时通话里那几只（它们正在写的那一段不画） */
  const inCall = useMemo(() => (call === null ? null : new Set(call.participants.map((p) => p.agentId))), [call]);
```

5. `const live = useMemo(() => (ws !== null ? liveRows({ streaming: chat.streaming, ws, now: Date.now() }) : []), [ws, chat.streaming]);` 换成：

```tsx
  const live = useMemo(
    () => (ws !== null ? liveRows({ streaming: chat.streaming, ws, now: Date.now(), ...(inCall === null ? {} : { hide: inCall }) }) : []),
    [ws, chat.streaming, inCall],
  );
```

6. `const stop = async (seq: number): Promise<void> => {` 那一段之后加：

```tsx
  const usable = voiceUsable(voice);
  const listen = voice.listen !== null && session !== null && voice.listen.sessionId === session.sessionId ? voice.listen : null;
  const barMode = callBarMode({ call, listeningHere: listen !== null });
  const offerPhone = phoneOffered({ voiceUsable: usable, ready, agentIds, call });

  const onStartCall = async (): Promise<void> => {
    if (session === null || agentIds.length === 0) return;
    setCallBusy(true);
    // 私聊拉那一只；群拉整个群（spec §5.7；通话中不增减人）
    const r = await startCall(session.sessionId, dmAgent !== null ? [dmAgent] : agentIds);
    setCallBusy(false);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定电话打出去没有", tone: "muted" } : { text: r.message, tone: "error" });
  };
  const onHangUp = async (): Promise<void> => {
    setCallBusy(true);
    const r = await hangUp();
    setCallBusy(false);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定挂断没有", tone: "muted" } : { text: r.message, tone: "error" });
  };

  const openCallCard = useMemo(() => {
    if (openCallSeq === null) return null;
    for (const r of rows) if (r.kind === "call" && r.card.seq === openCallSeq) return r.card;
    return null;
  }, [rows, openCallSeq]);
```

7. `renderItem` 里 `<ChatRowView row={item.row} ws={ws} />` 换成：

```tsx
                  <ChatRowView
                    row={item.row}
                    ws={ws}
                    onOpenCall={(seq) => {
                      setOpenCallSeq(seq);
                      setCallSheetOpen(true);
                    }}
                  />
```

8. 底下那一栏提示（`{pageNote ? …}` 那一行之后）加两行：

```tsx
          {listen?.error ? <Line tone="error">{listen.error}</Line> : null}
          {listen?.mic.error ? <Line tone="error">{listen.mic.error}</Line> : null}
```

9. 把「@ 谁」那一块与 `<Composer … />` 这两块（从 `{canMention ? (` 起，到 `<Composer` 那个元素的 `/>` 为止）整段换成：

```tsx
        {barMode !== "none" && call !== null && ws !== null && session !== null ? (
          (() => {
            const face = callFace({ call, speaking: listen?.speaking ?? null, open: openTurns(events) });
            const micOn = listen !== null && listen.mic.status !== "off";
            return (
              <CallBar
                mode={barMode}
                face={face === null ? null : <Face slot={agentFaceSlot(ws, face.agentId)} tier="m" state={face.state} phase={facePhase(face.agentId)} />}
                sinceTs={call.sinceTs}
                wave={waveMode({ micOn, micActive: listen?.mic.active ?? false, agentSpeaking: listen !== null && listen.speaking !== null })}
                level={listen?.mic.level ?? 0}
                micOn={micOn}
                captionsOn={captionsOn}
                captions={{ agent: listen?.text ?? null, me: listen !== null && listen.mic.transcript !== "" ? listen.mic.transcript : null }}
                joinBlocked={joinBlockedText({ native: nativeSpeech, ready, billing: voice.billing })}
                busy={callBusy}
                onToggleCaptions={() => setCaptionsOn((v) => !v)}
                onToggleMic={() => setMic(!micOn)}
                onHangUp={() => void onHangUp()}
                onJoin={() => joinCall(session.sessionId)}
              />
            );
          })()
        ) : (
          <>
            {canMention ? (
              <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 8 }}>
                <MentionChip onPress={() => setMentioning(true)} />
              </View>
            ) : null}
            <Composer
              ref={composer}
              placeholder={roleAnchor !== null ? "说一句它是干什么的…" : kind === "dm" ? `跟「${title}」说…` : "说给这一组听…"}
              canSend={canSend}
              sessionId={session?.sessionId ?? null}
              onSend={onSend}
              {...(offerPhone ? { phone: { onCall: () => void onStartCall(), busy: callBusy } } : {})}
            />
          </>
        )}
```

（粘之前 `grep -n 'canMention ? (' mobile/src/chat/ChatScreen.tsx` 与 `grep -n '<Composer' mobile/src/chat/ChatScreen.tsx` 对一下原文——原文里「@ 谁」那一块与 Composer 的写法以文件为准，换成上面这段时里面的 props 保持原样。）

10. `{ws !== null ? (<MentionSheet … />) : null}` 那一块之后（外层 `View` 结束之前）加：

```tsx
      <CallSheet
        visible={callSheetOpen}
        card={openCallCard}
        onClose={() => setCallSheetOpen(false)}
        onExited={() => setOpenCallSeq(null)}
      />
```

- [ ] **Step 7: 手机 tsc + 门禁**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`
Expected: `GATE_EXIT=0`。

- [ ] **Step 8: 提交**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add mobile/src/theme.ts mobile/src/chrome/VoiceGlyphs.tsx mobile/src/voice/CallBar.tsx mobile/src/voice/CallCardRow.tsx mobile/src/voice/CallSheet.tsx mobile/src/chat/Composer.tsx mobile/src/chat/ChatRows.tsx mobile/src/chat/ChatScreen.tsx
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
feat(mobile): 电话模式替换输入框、通话折成卡（#1356 A4）

输入框空着时右边那颗变「开电话」（这台打得了电话、房间 ready、有智能体、还没通话；
否则照旧是那颗灰的发送钮）：私聊拉那一只、群拉整个群。通话开着时输入框换成电话那一格——
这台在听：脸（谁在说画谁）| 声浪 | 计时，底下转文字 / 静音（= 关麦）/ 挂断；这台没在听
（锁过屏、从名册回来）：「通话还开着」+「接着听」（听不了时换成一句为什么）/ 挂断。
挂断不二次确认：主场里只有你一个人。一通电话在时间线上折成一张卡（多久 + 我说的第一句），
点开是 A1 那副底部抽屉放全文；通话开着时通话里那几只正在写的那一段不画——落下来就折进卡里。
样子逐值取自 demo（.voicebar / .vb / .callcard / .callpanel），加一个令牌 voice。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 8: 收尾——ADR、spec、索引、手机 README、门禁、开发版冒烟、PR

**Files:**
- Create: `docs/adr/0320-手机端语音通话-自写Expo原生模块照搬MrOttoSpeech-编排进shared.md`
- Modify: `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§5.7、§8 A4 一行、§10 追加第 57–72 条、§11 追加第 6–8 条）
- Modify: `AGENTS.md`（新一行索引 + 两行既有索引里的路径）
- Modify: `mobile/README.md`（「语音要开发版」一节）

- [ ] **Step 1: ADR-0320**

合并前先 `git fetch origin && git ls-tree --name-only origin/main docs/adr/ | tail -3`：若 0320 已经被别的 PR 占了，改成 `max + 1`、文件顶上加一行 `原为 ADR-0320`，并改掉本 PR 里所有 `ADR-0320` 的引用（项目 ADR-0074）。

Create `docs/adr/0320-手机端语音通话-自写Expo原生模块照搬MrOttoSpeech-编排进shared.md`：

```markdown
# ADR-0320：手机端语音通话——自写 Expo 原生模块照搬 MrOttoSpeech，编排进 shared

- 日期：2026-09-26
- 状态：已采纳
- 关联：#1356（A4）；spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §5.7 / §10 第 57–72 条 / §11 第 6–8 条；ADR-0271（团队语音通话）/ 0273（本机识别 helper）/ 0277（回声消除与插嘴）/ 0280（放音走 helper 的引擎）/ 0288（通话折成卡）/ 0306（断线时语音怎么收口）/ 0293（手机端依赖跟消费方一起进）

## 背景

手机「智能体」单栏的电话模式（spec §5.7）：输入框空着时那颗圆钮变「开电话」，通话中输入框换成电话那一格（脸 / 声浪 / 计时 / 转文字 / 静音 / 挂断），挂断折成一张卡。服务端那一半早就在（`call` 帧、`voice_call_changed`、`say{voice:true}`、edge `/llm/v1/speech`，ADR-0271 / 0288），手机缺三样：人说话那一半（识别）、它说话那一半（放音）、把两者串起来的编排。Expo Go 不带语音识别——识别一定要一个原生模块，也就一定要开发版。

## 决定

1. **识别与放音写成一个 Expo 本地模块**（`mobile/modules/otto-speech/`，Swift 5.9），照搬桌面 `native/MrOttoSpeech`（维护者 2026-09-26 在三条路里选的这条）：SFSpeechRecognizer + AVAudioEngine、每句收口换新 request、断句 Endpointer、能量门 LevelGate、VPIO 回声消除（开得了就不半双工、人能插嘴）、放音挂在同一个引擎的播放节点上。桌面在真机上踩过的坑（自激回声 #1176、ducking #1201、边想边说被切碎 #1196）一次带过来。iOS 多出来的五件事写在 `Recognizer.swift` 头注：配 AVAudioSession、来电 / 耳机插拔打断要说出口（不然放音队列等一个永远不来的 played）、ducking 配置是 iOS 17 的 API、放音收 file:// URI、起完引擎再报一次 status（aec 要开完回声消除才知道——桌面那份只在开引擎之前报，第一次开麦时 aec 还是 nil，另开 issue）。
2. **纯逻辑那两份 Swift 逐字抄、用断言对拍**（`Level.swift` 整份、`Endpointer.swift` 从「一句是不是像说完了」那段注释起到末尾，`tests/mobile/ottoSpeech.test.ts`），事件字段表、JS 声明的函数与 Swift 注册的函数、Info.plist 的两句授权说明也对拍。不共用源文件：CocoaPods 的本地 pod 收不到 pod 目录外的源文件，而改桌面 helper 的文件结构要重编它、重编要人重新点一次 TCC 授权。
3. **放音不引 expo-audio**（spec §5.7 原文写的是它）：两个库各自配 AVAudioSession，只能半双工、听筒 / 扬声器路由要自己兜；放音走识别那个引擎是 ADR-0280 已经在桌面验过的形状。一段 TTS 字节先落成缓存目录里的文件（expo-file-system），放完 / 放不了 / 停掉就删。
4. **编排进 shared**（`src/shared/voiceSession.ts`，进 vitest）：加入 / 离开、谁的回复读出来（通话名单里那几只、加入之后落下来的）、半双工与插嘴、一句说完发出去、云端断线的收口（gone 停麦但通话保留、ready 回来把麦开回来、人碰过麦克风就不自动开、denied 整段收掉）——语义逐条照桌面 store 的语音那一段。为此桌面渲染层的四份纯逻辑（voiceFeed / voiceMic / voicePlayer 的队列 / helperAudio）与主进程的三份（speechEventOf / ttsRoute / ttsClient）挪进 shared，桌面改 import、行为不变。**桌面 store 还没改用 voiceSession**：它多一扇「扣住 / 合并」的窗（#1281 的决策模型断句，走主进程 IPC），源码里还钉着 utteranceHoldWiring 那几条断言；两份编排并存是已知代价，另开 issue。
5. **锁屏 / 切后台 = 这台停听**（维护者 2026-09-26）：停麦停放音，通话本身还在（日志事实）；回到这一页，那一格写「通话还开着」+「接着听」。不开后台音频模式。离开聊天页同样只是停听（与桌面离开云会话同一条）。
6. **Expo Go 里没有电话**：`requireOptionalNativeModule` 回 null，电话钮不画，其余照常——开发版（`npx expo run:ios`）才有。
7. **声音按 agent_id 派生**（桌面同一份 `agentVoiceId`），挑声音另开一片（维护者 2026-09-26）。

## 否决

- **社区库 expo-speech-recognition + expo-audio**：决定 3 的理由；且识别、断句、回声消除、放音四件事分在两个库里，桌面那套判据（断句两条时钟、能量门、插嘴门槛）要么抄不过去、要么在 JS 里重写一遍。
- **A4 只做「听」、识别另开一片**：电话模式里没有麦克风，半个电话。
- **服务端识别**（录音上传 edge 转写）：Expo Go 里跑得动，但要新开一条带计费的网关路由、一家新的数据处理方，人说的每一句都出门；本机识别免费、不出门（ADR-0273 同一条）。
- **手机端的编排只写在 RN 那一侧**：手机端不进 vitest，而这一层是整条链上最容易出安静错的（断线、迟到的事件、半双工的开关）。

## 已知代价

1. 通话只在开发版里有；开发版要本机 Xcode + CocoaPods 构建（第一次十几分钟），真机要维护者的签名。
2. Swift 不进门禁：编译与行为只在模拟器 / 真机上验（xcodebuild 一次 + 开发版冒烟）。
3. 两份编排并存（决定 4），另开 issue 收成一份。
4. 名册上看不出哪条聊天的通话还开着（通话状态不在清单表里，要 runtime 投影一列）。
5. 模拟器上回声消除多半开不了 → 半双工；插嘴只能在真机上验。
6. 来电 / 耳机插拔之后要人自己再点一下麦克风（不自动恢复）。
7. 真机一次没跑过；登录后的流程（真打一通电话）agent 验不了。
```

- [ ] **Step 2: spec 的四处**

`docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`：

1. `### 5.7 语音（A4，另开 plan）` → `### 5.7 语音（A4）`；该节正文末尾加一句：`实现以 §10 第 57–72 条为准（plan：\`docs/superpowers/plans/2026-09-26-mobile-agents-a4-voice.md\`，ADR-0320）。`
2. §8 表格 A4 那一行的交付格 `另开 plan` → `一个 PR（不跑库、不部署；通话只在开发版里有）`。
3. §10 末尾那行 `（写 plan / 实现期间的偏离追加在这里。）` **之前**追加：

```markdown
57. **识别用自写的 Expo 本地模块**（`mobile/modules/otto-speech/`，Swift，照搬桌面 MrOttoSpeech），不是社区库——维护者 2026-09-26 拍板；因此通话只在开发版（`npx expo run:ios`）里有，Expo Go 里不画电话钮（`requireOptionalNativeModule` 回 null）。见 ADR-0320。
58. **放音也走这个原生模块**（识别那同一个 AVAudioEngine 的播放节点，ADR-0280 同一条理由：不被回声消除压低、是回声参考），**不引 expo-audio**（§5.7 原文写的是它）：两个库各改各的 AVAudioSession 只能半双工。
59. **「静音」= 关麦**（demo 那颗是麦克风图标），不是桌面那种「本机不播」；手机上没有「只看不听」。
60. **声音按 agent_id 派生**（桌面同一份 `agentVoiceId`），「说话的声音」那一格与挑声音另开一片（维护者 2026-09-26）。
61. **锁屏 / 切到后台 = 这台停听**（停麦停放音），通话本身还在；回到这一页那一格写「通话还开着」+「接着听」（维护者 2026-09-26）。不开后台音频模式。
62. **离开聊天页（回名册）同样只是停听**，不挂断——与桌面离开云会话同一条（通话是日志事实）；名册上看不出哪条聊天的通话还开着，要点进去才知道。
63. **挂断不二次确认**：主场里只有你一个人（桌面那颗「结束通话 = 全组」要确认，是因为团队里别人也在听）。
64. **电话钮只在这条线已经建好、房间 ready 时出现**：私聊草稿（第一句还没发）里没有电话——电话要一条会话才打得了。
65. **私聊拉那一只、群拉整个群**（名单里每一只）；通话中不能增减人（桌面的「加人」弹层手机没做）。
66. **通话开着时，通话里那几只正在写的那一段不画进时间线**（落下来就折进通话卡，画了会一闪而过）；它在说的话看电话那一格的「转文字」。
67. **通话卡**：收起时写「语音聊天」+ 时长（桌面同一份 `callDurationText`，不是 demo 的 mm:ss；还开着写「通话中」、不走表——电话那一格已经有一只表）+ 第二行「聊的什么」= 我说的第一句（我一句没说就是它说的第一句，≤24 字；demo 那行是写死的话题，真数据里没有话题这一格）。点开是 70% 的底部抽屉（A1 那副骨架），一句一行：我说的靠右、它说的靠左带「名字 · 第几分几秒」，名单变更那几行居中只写字（不带脸）。
68. **电话那一格的脸**：谁在说画谁（在说）、没人说时画欠着回答的那只（在想 / 排队）、都没有画通话里第一只（在听）；不另写状态词。
69. **声浪**：它在说是一段合成的包络（这边量不到它的音量，画的是「有话在说」）、人在说按麦克风能量、关着麦是一条灰线；它在说排第一（没有回声消除时它的声音会漏进麦克风）。
70. **「转文字」那一行**：它此刻在说的那句 + 「你：…」你正在说的那句；都没有写「这会儿没人说话。」。
71. **说完一句就发出去**：没有桌面那扇「扣住 / 合并」的窗（#1281 的决策模型断句，走主进程 IPC，桌面专属）。
72. **这台听不了时「接着听」换成一句为什么**（开发版 / 连接 / 订阅 / 网关不供语音）；没订阅那句说「订阅 Pro 或 Max 之后才打得了电话。」（桌面那句指「设置 → 订阅」，手机上没有那一页）。
```

4. §11 末尾（第 5 条之后）追加：

```markdown
6. A4 的识别**自写 iOS 原生模块**（照搬桌面 MrOttoSpeech，要开发版），不用社区库、也不先只做「听」（2026-09-26）。
7. **「说话的声音」可选另开一片**：A4 照桌面按 agent_id 派生，不加列（2026-09-26）。
8. **锁屏 / 切到后台 = 这台停听**，通话本身还在，回来「接着听」；不开后台音频模式（2026-09-26）。
```

- [ ] **Step 3: AGENTS.md 索引**

1. 既有两行里的路径跟着搬家改（L2 索引改动）：
   - 含 `src/main/teamVoice.ts` / `src/renderer/src/lib/voiceCall.ts` + `voicePlayer.ts` 的那一行（`grep -n 'src/main/teamVoice.ts' AGENTS.md`）：`` `src/main/teamVoice.ts` `` → `` `src/shared/ttsClient.ts` / `src/shared/ttsRoute.ts` ``；`` `src/renderer/src/lib/voiceCall.ts` + `voicePlayer.ts` `` → `` `src/shared/voiceFeed.ts` + `voicePlayer.ts` ``。
   - 含 `src/renderer/src/lib/voiceMic.ts` 的那一行：`` `src/renderer/src/lib/voiceMic.ts` `` → `` `src/shared/voiceMic.ts` ``。
   只改这几个路径字面量，那两行的正文一个字不动。
2. 在 A3 那一行（`grep -n 'mobile/src/group/' AGENTS.md`）之后插一行：

```markdown
- `mobile/modules/otto-speech/` / `src/shared/voiceSession.ts` / `src/shared/mobileCall.ts` / `mobile/src/voice/` — **手机端「智能体」单栏 A4：语音通话**（#1356，spec §5.7，ADR-0320）。输入框空着时右边那颗变「开电话」（这台打得了电话、房间 ready、有智能体、还没通话），通话中输入框换成电话那一格（这台在听：脸 / 声浪 / 计时 / 转文字 / 静音 = 关麦 / 挂断；没在听：「通话还开着」+「接着听」），挂断折成时间线上一张卡（多久 + 我说的第一句，`voiceCallCards` 桌面同一份），点开是底部抽屉放全文。识别与放音是**自写的 Expo 本地模块**（Swift，照搬桌面 `native/MrOttoSpeech`：识别 + 断句 + VPIO 回声消除 + 同一个引擎放音，维护者 2026-09-26 拍板），所以**通话只在开发版（`npx expo run:ios`）里有**，Expo Go 里不画电话钮；`Level.swift` / `Endpointer.swift` 逐字抄、`tests/mobile/ottoSpeech.test.ts` 对拍（不共用源文件：CocoaPods 收不到 pod 目录外的源文件，改桌面 helper 要重编、重编要人重新点 TCC），放音不引 expo-audio。编排写进 shared 的 `voiceSession`（进 vitest；语义逐条照桌面 store 的语音那一段，差别三处：没有 #1281 的扣住窗、静音 = 关麦、放音路由由注入决定），为此桌面渲染层四份 + 主进程三份语音纯逻辑挪进 shared（`voiceFeed` / `voiceMic` / `voicePlayer` / `helperAudio` / `speechEvent` / `ttsRoute` / `ttsClient`），桌面行为不变；**桌面 store 还没改用 voiceSession，两份编排并存是已知代价**。锁屏 / 切后台 = 这台停听、通话还在（维护者 2026-09-26）；声音按 agent_id 派生，挑声音另开一片。**服务端一行没改、不进协议位、不用部署**。真机一次没跑过
```

- [ ] **Step 4: 手机 README**

`mobile/README.md`：在 `## 跑起来` 那一节末尾（下一个 `## ` 标题之前）加：

```markdown
### 语音通话要开发版（A4）

语音识别不在 Expo Go 里，通话用的是本仓自己的原生模块 `modules/otto-speech/`（Swift，照搬桌面 `native/MrOttoSpeech`，ADR-0320）。
**Expo Go 里 app 照常跑，只是没有电话钮**；要打电话得装开发版：

    cd mobile
    npx expo run:ios            # 第一次：prebuild 出 ios/ + pod install + 编译，十几分钟

`ios/` 是生成的（`.gitignore` 里），不提交；改了 `modules/otto-speech/ios/` 下的 Swift 要重跑这一句。
真机要在 Xcode 里给 `ios/MrOtto.xcworkspace` 配上自己的签名。模拟器用 Mac 的麦克风（第一次会问 macOS 的麦克风权限），
模拟器上回声消除多半开不了，会退回半双工（它说话时闭麦）——插嘴只能在真机上验。
```

并在 `## 结构` 那一节的目录清单里（照那一节原有的写法）补一行 `modules/otto-speech/` —— 语音原生模块（识别 + 断句 + 回声消除 + 放音，Swift）。

- [ ] **Step 5: 门禁**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`
Expected: `GATE_EXIT=0`（`tests/docs/adrNumbers.test.ts` 会查 ADR 编号唯一且不跳号）。

- [ ] **Step 6: 提交文档**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git add "docs/adr/0320-手机端语音通话-自写Expo原生模块照搬MrOttoSpeech-编排进shared.md" docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md AGENTS.md mobile/README.md
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git commit -F .superpowers/commit-msg.txt
```

commit message：

```
docs: A4 的 ADR-0320、spec §10 / §11、索引与手机 README（#1356 A4）

ADR-0320 记下手机端语音的七条决定（自写原生模块照搬 MrOttoSpeech、纯逻辑逐字抄对拍、
放音不引 expo-audio、编排进 shared 而桌面 store 暂不跟、锁屏停听、Expo Go 没有电话、
声音派生）与否决的四条；spec §10 追加第 57–72 条偏离、§11 追加维护者 2026-09-26 的三条；
AGENTS.md 加 A4 那一行索引，并把两行既有索引里搬了家的路径改对；手机 README 写清
通话要开发版、怎么出开发版。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

- [ ] **Step 7: 开发版冒烟（派发的人做；不提交任何东西）**

目的：原生模块真的装进 app、真的出事件、真的放得出声；电话那一格与通话卡在模拟器上长得对。登录后的流程（真打一通）agent 验不了，列进 PR 的「没跑」。

1. 起开发版（后台，日志落 `.superpowers/run-ios.log`）：`cd mobile && CI=1 EXPO_NO_TELEMETRY=1 LANG=en_US.UTF-8 npx expo run:ios --device <iPhone 17 Pro 的 UDID>`（UDID 用 `xcrun simctl list devices booted` 看；别碰别的会话开着的模拟器）。等日志里出现 `Build Succeeded` 与 Metro 的 `iOS Bundled`。
2. 临时根组件（不提交）：`mobile/index.ts` 里 `registerRootComponent(App)` 换成 `registerRootComponent(true ? VoiceHarness : App)`（`import { VoiceHarness } from "./src/dev/VoiceHarness";`），`mobile/src/dev/VoiceHarness.tsx` 摆三块：
   - **原生模块**：一行写 `OttoSpeech === null ? "没有原生模块" : "有"`；四颗钮 `status` / `开麦`（`OttoSpeech.start("zh-CN", ["开发"])`）/ `关麦` / `放一段`（`File.downloadFileAsync("http://127.0.0.1:8765/probe.m4a", new Directory(Paths.cache), { idempotent: true })` 之后 `OttoSpeech.play("probe", file.uri)`）；一列事件日志（`addListener("onSpeech", …)` 收到的每一条 `JSON.stringify` 出来，最新在上）。
   - **电话那一格**：`<CallBar>` 用假数据摆 live（wave 分别切 agent / me / off，captionsOn 开）与 idle（joinBlocked 为 null 与「这个版本的 app 听不了电话…」两种）。
   - **通话卡**：`<CallCardRow>` 摆一张 ended（带 topic）一张还开着（topic 为 null），点一下开 `<CallSheet>`，里面三行（名单变更 / 我说的 / 它说的）。
   包一层 `SafeAreaProvider`。
3. Mac 这边备一段音频并起一个静态服务：`say -v Tingting -o .superpowers/probe.aiff "你好，这是一段放音测试"`，`afconvert -f m4af -d aac .superpowers/probe.aiff .superpowers/probe.m4a`，`python3 -m http.server 8765 --directory .superpowers`（后台）。
4. 在模拟器里逐项验：
   - 原生模块那一行写「有」；点 `status` → 日志出一条 `status`（speech / mic 四档之一）。
   - 点 `开麦` → 模拟器弹两道授权（语音识别、麦克风），点允许 → 日志依次有 `status`、`listening on:true`、第二条 `status`（这一条的 `aec` 是 true 或 false，不是缺席）；Mac 上 `say -v Tingting "帮我看一下部署"` → 日志出 `partial` 若干 + 一条 `final`；同时 `level` 在跳。若 macOS 弹出「Simulator 想用麦克风」的系统对话框，那是 Mac 的隐私设置：**停下来请维护者点**，不要替他点。
   - 点 `关麦` → `listening on:false`。
   - 点 `放一段` → 听得见（或至少日志里约 2 秒后出 `played id:"probe"`）；再点一次、放到一半点 `关麦` 不影响放音。
   - 电话那一格：live 三颗钮（静音那颗关着时是警示底、麦克风图标变色）、声浪三种样子（off 是一条灰线）、计时在走；idle 两种（能听 / 不能听）；浅色 / 深色各看一眼（`xcrun simctl ui <udid> appearance dark|light`，看完还原）。
   - 通话卡：还开着写「通话中」、没有第二行；ended 写时长 + 我说的那句；点开抽屉从下往上、不盖住顶上那一截，三种行各自的样子。
5. 收拾：`git checkout -- mobile/index.ts`、删掉 `mobile/src/dev/VoiceHarness.tsx`、停掉 http 服务与 Metro、`git status --short` 干净（`mobile/ios/` 不出现）。冒烟结果写进 PR 正文。

- [ ] **Step 8: 推送、开 PR**

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git fetch origin && git log --oneline origin/main -3
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4-voice-d174e6 && git push -u origin claude/mobile-a4-voice-d174e6
```

合并前再核一次：origin/main 上 ADR 编号有没有被占（Step 1）、有没有别的 PR 动了 `src/shared/mobileChat.ts` / `mobile/src/chat/ChatScreen.tsx`（有就先合进来再跑门禁）。PR 正文写进 `.superpowers/pr-body.md`（`gh pr create --title "…" --body-file .superpowers/pr-body.md`），照 A3 那份的格式：做了什么 / 测试 / 部署（**不用**：服务端一行没改、没有 migration、不进协议位；手机要重新出一次开发版，Expo Go 里没有电话）/ 验证（门禁数字、xcodebuild、模拟器冒烟逐项）/ 没跑（要登录：真打一通电话——私聊开电话 → 它先开口打招呼 → 说一句它接着答 → 插嘴 → 静音 → 锁屏回来「接着听」→ 挂断看卡、点开看全文；群里开电话；真机上的回声消除与扬声器 / 蓝牙路由）/ 另开的。**不关 #1356**（A5 还没做，挑声音另开）。PR body 末尾一行 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

另开的 issue（PR 开出来之后开，编号写回 PR 正文）：
1. 桌面 helper 第一次开麦报的 status 里 aec 还是 null（`native/MrOttoSpeech/Sources/MrOttoSpeech/Recognizer.swift`：status 在 `beginAudio()` 开回声消除之前就发了，之后不再发），于是每次启动 app 的第一通电话走半双工、人插不了嘴——修法同手机那份（起完引擎再报一次 status），要重编 helper、重新点 TCC。
2. 桌面 store 的语音编排改用 `src/shared/voiceSession.ts`（要先把 #1281 的扣住窗搬进编排、重写 `utteranceHoldWiring` 那几条读源码的断言）。
3. 手机端挑声音（`workspace_agents` 加一列可空、null 照旧派生，ADR；桌面跟着读这一列）——维护者 2026-09-26 定的另开一片。
```
