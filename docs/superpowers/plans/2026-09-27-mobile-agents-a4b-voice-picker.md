# 手机端「智能体」单栏 A4b——挑声音 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能体设置里多一行「说话的声音」：点开是一张「自动」+ 六档的表，点一行就换成它并念一句它自己的话；存在 `workspace_agents.voice`，桌面与手机的电话都照这一格读声音。

**Architecture:** 判据全在 `src/shared/`（进 vitest）：音色目录与「挑过的先占」（`agentVoice.ts`）、表的每一行 / 念哪一句 / 什么时候不念（新 `agentVoicePicker.ts`）、读写（`supabaseWorkspacesApi.ts` 单独一条容错读 + update 带 `voice`，`agentAdmin.updateAgentChecked` 校验，`agentSettingsForm.ts` 多一格）。播放那一侧只改名册的形状：shared 的 `voiceSession` 与桌面 store 的名册带上各自挑过的那一格。手机端：`RowGlyph` 多一枚声浪、`voiceStore` 导出试听两个口、新 `VoicePickerSheet`、设置页挂一行。**runtime 与 edge 一行不改、不进协议位**；migration 0042 一条（合并后等维护者点头再跑）。

**Tech Stack:** Expo SDK 57 / RN 0.86 / react-native-svg / 自写原生模块 OttoSpeech（A4，放音，只在开发版里有）/ expo-file-system（A4 已在用）/ vitest。**本片不新增任何 npm 依赖。**

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`——本片对应 §5.7 末尾「挑声音（A4b）」那一段、§10 第 93–99 条、§11 第 9 条、§12 第 8 条。执行者先读这几节再动手。原型：`.demo/mobile-agents-redesign.html` 的 `SCREENS.botSettings`（「说话的声音」那一行）与 `SHEETS.voicePick`（六档那张表）；决定这一片那份多方向 demo 不进仓库。**实现以本 plan 与 spec §10 为准。**

**维护者拍板（2026-09-27，全按推荐）：** 存在库里一列、桌面照读不给挑、表是「自动」+ 六档、点一行 = 换成它 + 念一句、六档用默认对应；以及：库里存我们自己的键不存 MiniMax 的音色 id、挑完回设置页按「存」才落库（同换形象）、挑过的先占而没挑过的派生时让开、试听念它自己的一句且走订阅额度（表开着时同一句只合成一次）、不能念的时候不画试听只管挑。

**开工前验过的事实（2026-09-27，读源码 + 真打了一次网关）：**

| 要用的 | 在哪 | 结论 |
|---|---|---|
| 派生算法与 12 个音色 | `src/shared/agentVoice.ts` | `agentVoiceIds(roster: string[])`；六档对的六个音色**都在**这 12 个里 |
| 13 段样音 | dev 号经 `POST /llm/v1/speech` 各念同一句（`speech-2.8-turbo`，79 字符一段，共 1027 字符） | 13 个 id 全部 200；音高 98–271 Hz、每秒 3.2–4.9 字（ffmpeg 解码量的） |
| 放音不开麦 | `mobile/modules/otto-speech/ios/Recognizer.swift` 的 `play` → `ensurePlaybackEngine` | 自己激活会话、起引擎，**不需要**先 `start()`，也就不碰麦克风授权 |
| 手机上的 TTS 与放音 | `mobile/src/voice/voiceStore.ts` 的 `tts`（`createTtsClient`）与 `nativeAudio`（`HelperAudioBridge`） | 试听直接复用：`tts.speak` 回 `VoiceSpeakResult`，`createHelperAudio(bytes, nativeAudio)` 放 |
| 读名册 | `src/shared/supabaseWorkspacesApi.ts` 的 `fetchWorkspace` | 容错读的先例：`fetchWorkspaceKind` / `fetchSandboxApproval` 各单独一条 |
| 改一只 | `src/shared/agentAdmin.ts` 的 `updateAgentChecked` | `avatarSlot` 不过 `validateAgentPatch`、单独归一——`voice` 照这个 |
| 库比客户端旧 | `src/shared/workspaceError.ts` 的 `isSchemaBehind` | 42703 / 42P01 / PGRST204 |

## Global Constraints

- 工作目录：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf`（分支 `claude/mobile-a4b-voice-picker-f65baf`，从 origin/main `f28125ed` 开）。**你改的每一个路径都必须在这个目录下；绝不碰主 checkout `/Users/stanyan/Github/Mr_Otto`**（那是别的 lane 共用的只读副本）。每条 shell 命令自带 `cd <这个目录> &&`，别依赖上一条留下的 cwd。
- **绝不用 `git stash`（任何形式）**：stash 栈是所有 worktree 共享的。RED 靠「先写测试、跑出失败、再实现」。不许 `--no-verify`。
- 手机端（`mobile/src/`、`mobile/App.tsx`、`mobile/index.ts`）在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session` 文件（`tests/architecture.test.ts` 第 8 条会红）。第三方包照常 import。
- **两端共用的纯逻辑写进 `src/shared/`，不抄第二份**（spec §2）。手机端不进 vitest、只跑 tsc，所以凡是「判断」都放 shared 并带测试；RN 组件里只剩接线与样式。`src/shared/` 不许 import 任何 node builtin / electron / react-native。
- **本片不新增 npm 依赖、不碰 `services/`、不进协议位。migration 只有 0042 一条，agent 不跑它**（生产库动作等维护者明说）。
- **界面文案逐字照本 plan**，不出现「水獭」，也不出现「主场」「云会话」「团队」「工作区」这类内部名。**中文里的全角标点（「」，。：；、→）逐字照抄，不许换成半角**；拿不准的字符宁可去源文件里复制，也别凭印象敲。
- 状态与降级（spec §6）：**还没查到 ≠ 没有**（订阅快照 `billing === null` 时不说「要订阅」）/ **读不到 ≠ 空**（声音那一列读不到 = 全按派生，名册照常）/ **说不清就不画钮**（念不了就不念，也不画一颗点了没声音的钮）。
- 动效只有表里行首那一格：等合成时一明一暗、在念时三根条跳（`Animated`，走原生驱动）；**「减弱动态效果」时不闪不跳**（静止的样子）。
- TypeScript strict；根另开 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（shared 与手机两边都要过）。**可选字段 / 可选 prop 不许显式传 `undefined`**，一律 `{...(x === undefined ? {} : { voice: x })}` 这种展开写法。
- 门禁 `npm test`（根 tsc + mobile tsc + vitest）。这个 worktree 的根 `node_modules` 是指向主 checkout 的软链、`mobile/node_modules` 是本地安装——**都不要动**。跑门禁：`npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`。**判据只认 `GATE_EXIT`**（`.superpowers/` 被 git 忽略）。单跑测试：`npx vitest run <路径>`；只跑根 tsc：`npx tsc --noEmit`；只跑手机 tsc：`npm --prefix mobile run typecheck`。**本地时间 00:00–01:59 之间 `tests/renderer/agentChatPage.test.tsx` 有一条存量用例必红（#1373）**，那个钟点跑门禁前面加 `TZ=UTC`。
- 提交：小步提交，中文 message 写清「为什么」，末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。`git add` 只加这个任务自己的文件（逐路径，不用 `-A` / `.`）。**这个会话的 shell 会拒绝 heredoc 与 `$(…)` 当参数**：把 message 用编辑工具写进 `.superpowers/commit-msg.txt`（写之前先用读文件的工具读一遍它，它可能已经存在），**等写完再**单独跑 `git commit -F .superpowers/commit-msg.txt`；message 内容照计划原文。
- 代码块照原样写进文件；用编辑工具按「把 A 换成 B」改文件时，先 `grep -n` / 读源文件那几行，照源文件的真实缩进做锚点。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/agentVoice.ts` | 改（整份换） | 12 个音色的派生池、六档（键 → 音色）、键的形状、「挑过的先占」的派生 |
| `supabase/migrations/0042_workspace_agents_voice.sql` | 新 | `workspace_agents.voice text` + 形状约束 |
| `src/shared/workspaces.ts` | 改 | `WorkspaceAgentRow.voice?`、快照带上它、`normalizeVoiceKey` |
| `src/shared/supabaseWorkspacesApi.ts` | 改 | `fetchAgentVoices`（单独一条容错读）并进快照；`updateAgentRow` 收 `voice` |
| `src/shared/agentAdmin.ts` | 改 | `AgentPatchInput.voice`、写之前认键、库没升级时说人话 |
| `src/shared/agentSettingsForm.ts` | 改 | 表单多一格 `voice`，换了才写 |
| `src/shared/voiceSession.ts` | 改 | `roster()` 带上各自挑过的那一格 |
| `src/renderer/src/store.ts` | 改 | 桌面电话的名册改带 voice（`rosterIdsOf` → `rosterOf`） |
| `src/shared/agentVoicePicker.ts` | 新 | 表的每一行、设置页那一行写什么、试听念哪一句、什么时候不念、页脚 |
| `mobile/src/chrome/RowGlyphs.tsx` | 改 | 多一枚 `wave` |
| `mobile/src/voice/voiceStore.ts` | 改 | 名册带 voice；导出 `speakPreview` / `playPreview` |
| `mobile/src/agent/VoicePickerSheet.tsx` | 新 | 挑声音那张表 + 试听 |
| `mobile/src/agent/AgentSettingsScreen.tsx` | 改 | 「说话的声音」那一行 + 表 |
| `mobile/src/ui.tsx` | 改 | `Row` 的 `chevron` 注释：拉起一张选择表也算「下一层」 |
| `docs/adr/0322-*.md`、`AGENTS.md`、`mobile/README.md` | 新 / 改 | ADR、索引一行、手机 README |

---

### Task 1: 音色目录与「挑过的先占」（`src/shared/agentVoice.ts`）

**Files:**
- Modify: `src/shared/agentVoice.ts`（整份换成下面的内容）
- Test: `tests/shared/agentVoice.test.ts`（在文件末尾追加；import 行改成下面那样）

**Interfaces:**
- Consumes: 无（`ADMIN_AGENT_ID` 来自 `./workspaceAgents.js`，`fnv1a` 来自 `./fnv1a.js`，都是现成的）
- Produces（后面的任务要用，名字与类型照抄）:
  - `interface AgentVoiceChoice { key: string; label: string; hint: string; voiceId: string }`
  - `const AGENT_VOICE_CHOICES: readonly AgentVoiceChoice[]`（六档，顺序 qing / wen / chen / gan / shao / bo）
  - `const VOICE_KEY_RE: RegExp`（`/^[a-z]{1,16}$/`）
  - `function voiceChoiceOf(key: string | null | undefined): AgentVoiceChoice | null`
  - `interface VoiceRosterEntry { agentId: string; voice?: string }`
  - `type VoiceRoster = readonly (string | VoiceRosterEntry)[]`
  - `function agentVoiceIds(roster: VoiceRoster): Map<string, string>`（旧的 `string[]` 调用照收）
  - `function agentVoiceId(agentId: string, roster: VoiceRoster): string`
  - `AGENT_VOICES` / `ADMIN_VOICE_ID` / `AgentVoice` 原样保留

- [ ] **Step 1: 写失败的测试**

`tests/shared/agentVoice.test.ts` 的 import 行换成：

```ts
import {
  ADMIN_VOICE_ID, AGENT_VOICES, AGENT_VOICE_CHOICES, VOICE_KEY_RE, agentVoiceId, agentVoiceIds, voiceChoiceOf,
} from "../../src/shared/agentVoice.js";
```

文件末尾追加：

```ts
describe("AGENT_VOICE_CHOICES（#1372，#1356 A4b）", () => {
  it("六档，键唯一且合 0042 的形状；每档的音色都在派生池里（挑过的才占得了位）", () => {
    expect(AGENT_VOICE_CHOICES.map((c) => c.key)).toEqual(["qing", "wen", "chen", "gan", "shao", "bo"]);
    for (const c of AGENT_VOICE_CHOICES) {
      expect(VOICE_KEY_RE.test(c.key)).toBe(true);
      expect(AGENT_VOICES.some((v) => v.id === c.voiceId)).toBe(true);
    }
    expect(new Set(AGENT_VOICE_CHOICES.map((c) => c.voiceId)).size).toBe(AGENT_VOICE_CHOICES.length);
  });

  it("对应钉死（维护者 2026-09-27 定的默认对应；改这张表 = 改所有挑过这一档的智能体的声音）", () => {
    expect(Object.fromEntries(AGENT_VOICE_CHOICES.map((c) => [c.key, c.voiceId]))).toEqual({
      qing: "Chinese (Mandarin)_Warm_Bestie",
      wen: "female-chengshu",
      chen: "Chinese (Mandarin)_Gentleman",
      gan: "male-qn-jingying",
      shao: "male-qn-daxuesheng",
      bo: "Chinese (Mandarin)_Radio_Host",
    });
    expect(AGENT_VOICE_CHOICES.map((c) => c.label)).toEqual(["清亮", "温和", "沉稳", "干脆", "少年", "播音"]);
  });

  it("voiceChoiceOf：null / 缺席 / 认不出的键（旧客户端读到新键）都回 null", () => {
    expect(voiceChoiceOf("gan")?.label).toBe("干脆");
    expect(voiceChoiceOf(null)).toBeNull();
    expect(voiceChoiceOf(undefined)).toBeNull();
    expect(voiceChoiceOf("zzz")).toBeNull();
  });
});

describe("agentVoiceIds：挑过的先占（#1372）", () => {
  it("挑过的用它挑的那一档；管理员挑了也照它挑的", () => {
    const ids = agentVoiceIds([{ agentId: "admin", voice: "bo" }, { agentId: "a_1", voice: "gan" }]);
    expect(ids.get("admin")).toBe(voiceChoiceOf("bo")!.voiceId);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
  });

  it("只有 id 的旧写法与「没挑过」的条目同义；认不出的键当没挑过", () => {
    expect([...agentVoiceIds(["admin", "a_1", "a_2"])]).toEqual([
      ...agentVoiceIds([{ agentId: "admin" }, { agentId: "a_1" }, { agentId: "a_2", voice: "zzz" }]),
    ]);
  });

  it("没挑过的派生时让开挑过的：它的天然位被别人挑走了，就往后挪到别的音色上", () => {
    // 找一只天然位恰好落在六档之一上的 id，再让另一只把那一档挑走
    const id = Array.from({ length: 500 }, (_, i) => `x_${i}`).find((x) =>
      AGENT_VOICE_CHOICES.some((c) => c.voiceId === agentVoiceId(x, [x])))!;
    const natural = AGENT_VOICE_CHOICES.find((c) => c.voiceId === agentVoiceId(id, [id]))!;
    const ids = agentVoiceIds([{ agentId: "y_1", voice: natural.key }, id]);
    expect(ids.get("y_1")).toBe(natural.voiceId);
    expect(ids.get(id)).not.toBe(natural.voiceId);
    expect(AGENT_VOICES.some((v) => v.id === ids.get(id))).toBe(true);
  });

  it("两只挑了同一档：两只都照挑的（人自己负责）", () => {
    const ids = agentVoiceIds([{ agentId: "a_1", voice: "gan" }, { agentId: "a_2", voice: "gan" }]);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
    expect(ids.get("a_2")).toBe(voiceChoiceOf("gan")!.voiceId);
  });

  it("名单里重复出现的 id 只认第一次", () => {
    const ids = agentVoiceIds([{ agentId: "a_1", voice: "gan" }, { agentId: "a_1", voice: "bo" }]);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/agentVoice.test.ts`
Expected: FAIL（`AGENT_VOICE_CHOICES` / `voiceChoiceOf` / `VOICE_KEY_RE` 不存在）

- [ ] **Step 3: 实现——`src/shared/agentVoice.ts` 整份换成**

```ts
// agentVoice —— 智能体用哪个 MiniMax 音色（#1163）。纯逻辑零 IO，三端共用。
//
// 缺省按 agent_id 派生（维护者 2026-09-09 拍板：音色自动派生），理由与头像那次（agentAvatarSlot.ts）
// 一样：存量智能体立刻有声音，不用等谁去设置页挑。#1372（#1356 A4b，2026-09-27）起**可以挑**：
// `workspace_agents.voice` 存一个我们自己的键（`AGENT_VOICE_CHOICES` 那六档之一），null / 缺席 /
// 认不出的键都照旧派生——同 #1007 给头像加的 avatar_slot。**存键不存 MiniMax 的音色 id**：换一档
// 背后的音色只改这张表，不用跑库；DB 约束也只管形状（VOICE_KEY_RE），不写死这六个。
//
// 判据要稳：群语音里靠声音分人，同一只在两台机器、两次刷新上必须是同一个声音——所以从
// agent_id（改名不变的键）哈希，不从名字、不从名单下标。名单**顺序**只用来解撞（服务端按
// created_at 升序给，先来的先占，后来的撞上就往后挪一格）。**挑过的先占**：它们的声音是人定的，
// 派生的让开（spec §10 第 96 条）。代价同头像：一只被删、或者别人挑走了它正在用的那一档之后，
// 曾因撞它挪位的那只会换一次声音；接受。
//
// 音色表是人手维护的、会过时（MiniMax `get_voice` 接口现查得到全部 303 个系统音色，
// 2026-09-09 取的这十二个都是标准普通话、男女交错、语气各异）。id 写错的后果是
// MiniMax 回非零 status_code → 网关 502 → 通话栏一行红字，不会静默变成别的声音。

import { ADMIN_AGENT_ID } from "./workspaceAgents.js";
import { fnv1a } from "./fnv1a.js";

export interface AgentVoice {
  /** MiniMax 系统音色 id（`voice_setting.voice_id`） */
  id: string;
  /** 官方中文名 */
  label: string;
}

/** 轮换池：男女交错，让相邻派生到的两只听起来不像同一个人 */
export const AGENT_VOICES: readonly AgentVoice[] = [
  { id: "Chinese (Mandarin)_Gentleman", label: "温润男声" },
  { id: "Chinese (Mandarin)_Warm_Bestie", label: "温暖闺蜜" },
  { id: "male-qn-jingying", label: "精英青年" },
  { id: "female-yujie", label: "御姐" },
  { id: "Chinese (Mandarin)_Radio_Host", label: "电台男主播" },
  { id: "Chinese (Mandarin)_Sweet_Lady", label: "甜美女声" },
  { id: "Chinese (Mandarin)_Unrestrained_Young_Man", label: "不羁青年" },
  { id: "Chinese (Mandarin)_Gentle_Senior", label: "温柔学姐" },
  { id: "male-qn-daxuesheng", label: "青年大学生" },
  { id: "Chinese (Mandarin)_Crisp_Girl", label: "清脆少女" },
  { id: "Chinese (Mandarin)_Lyrical_Voice", label: "抒情男声" },
  { id: "female-chengshu", label: "成熟女性" },
];

/** 种子管理员没挑过时固定这一个（沉稳高管）：每个团队都有它，固定一个声音让「管理员」
    跨团队听得出来——同 ADMIN_AVATAR_SLOT 的理由。不进轮换池，别的智能体派不到它，也不进六档 */
export const ADMIN_VOICE_ID = "Chinese (Mandarin)_Reliable_Executive";

/** 能挑的一档：`key` 存进 `workspace_agents.voice`；`voiceId` 必须在 AGENT_VOICES 里——挑过的要在
    派生池里占位，派生的才让得开（测试钉着） */
export interface AgentVoiceChoice {
  key: string;
  label: string;
  hint: string;
  voiceId: string;
}

/** 六档（名字与描述照 #1321 的 demo）对到派生池里的哪一个：维护者 2026-09-27 定用默认对应——
    13 个候选各念同一句话量出来的（同一句 98–271 Hz、每秒 3.2–4.9 字）：「干脆」给最快的那个，
    「少年」给男声里最高的那个，「沉稳」给低音、且不抢管理员固定的那一个（spec §10 第 94 条） */
export const AGENT_VOICE_CHOICES: readonly AgentVoiceChoice[] = [
  { key: "qing", label: "清亮", hint: "语速偏快，句尾上扬", voiceId: "Chinese (Mandarin)_Warm_Bestie" },
  { key: "wen", label: "温和", hint: "慢一点，话尾收得稳", voiceId: "female-chengshu" },
  { key: "chen", label: "沉稳", hint: "低音多，适合长段汇报", voiceId: "Chinese (Mandarin)_Gentleman" },
  { key: "gan", label: "干脆", hint: "短句、不拖音", voiceId: "male-qn-jingying" },
  { key: "shao", label: "少年", hint: "偏亮偏年轻", voiceId: "male-qn-daxuesheng" },
  { key: "bo", label: "播音", hint: "字正腔圆，念数字清楚", voiceId: "Chinese (Mandarin)_Radio_Host" },
];

/** `workspace_agents.voice` 的形状（0042 的 CHECK 同一条）：小写字母 1–16 个 */
export const VOICE_KEY_RE = /^[a-z]{1,16}$/;

/** 键 → 那一档；null / 缺席 / 认不出（旧客户端读到新版才有的键）都回 null = 没挑过 */
export function voiceChoiceOf(key: string | null | undefined): AgentVoiceChoice | null {
  if (typeof key !== "string") return null;
  return AGENT_VOICE_CHOICES.find((c) => c.key === key) ?? null;
}

/** 名册里的一只：id + 它存下来的那一格（缺席 = 没挑过）。WorkspaceAgentRow 结构上就是它 */
export interface VoiceRosterEntry {
  agentId: string;
  voice?: string;
}

/** 名册：只有 id 的旧写法照收（= 谁都没挑过） */
export type VoiceRoster = readonly (string | VoiceRosterEntry)[];

const entryOf = (e: string | VoiceRosterEntry): VoiceRosterEntry => (typeof e === "string" ? { agentId: e } : e);

function preferredIndex(agentId: string): number {
  return fnv1a(agentId) % AGENT_VOICES.length;
}

/**
 * 整份名单 → agentId → 音色 id。先放挑过的（它们在池子里占位）；再按名单顺序派没挑过的：
 * 管理员固定，其余天然位空着就占，被占了顺着往后找第一个空位；全满（名单超过池子）退回天然位——
 * 重复不可避免时，至少每只自己还是稳定的。名单里重复出现的 id 只认第一次。
 */
export function agentVoiceIds(roster: VoiceRoster): Map<string, string> {
  const entries = roster.map(entryOf);
  const out = new Map<string, string>();
  const taken = new Set<number>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.agentId)) continue;
    seen.add(e.agentId);
    const choice = voiceChoiceOf(e.voice);
    if (choice === null) continue;
    out.set(e.agentId, choice.voiceId);
    const idx = AGENT_VOICES.findIndex((v) => v.id === choice.voiceId);
    if (idx >= 0) taken.add(idx);
  }
  for (const { agentId } of entries) {
    if (out.has(agentId)) continue;
    if (agentId === ADMIN_AGENT_ID) {
      out.set(agentId, ADMIN_VOICE_ID);
      continue;
    }
    let idx = preferredIndex(agentId);
    if (taken.size < AGENT_VOICES.length) {
      while (taken.has(idx)) idx = (idx + 1) % AGENT_VOICES.length;
    }
    taken.add(idx);
    out.set(agentId, AGENT_VOICES[idx]!.id);
  }
  return out;
}

/** 一只智能体的音色。不在名单里的 id（名单刚变过 / 旧日志里的智能体）也答得出：
    按它自己的天然位派，不解撞——这一刻没有名单可解 */
export function agentVoiceId(agentId: string, roster: VoiceRoster): string {
  const hit = agentVoiceIds(roster).get(agentId);
  if (hit !== undefined) return hit;
  if (agentId === ADMIN_AGENT_ID) return ADMIN_VOICE_ID;
  return AGENT_VOICES[preferredIndex(agentId)]!.id;
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/agentVoice.test.ts tests/shared/voiceSession.test.ts tests/renderer/voiceStore.test.ts && npx tsc --noEmit`
Expected: 全过（旧用例一条不改照样过：没挑过的名单派出来的结果与改动前逐个相同）

- [ ] **Step 5: 提交**

message（写进 `.superpowers/commit-msg.txt`）：

```
feat(shared): 音色可以挑——六档对到派生池里的六个，挑过的先占（#1356 A4b）

#1372：每只智能体的声音原来只按 agent_id 派生。这一片让人从六档里挑一个，
库里存的是我们自己的键（qing / wen / chen / gan / shao / bo），对到哪个 MiniMax
音色写在 AGENT_VOICE_CHOICES 里——换音色只改这张表、不用跑库。

派生改成两遍：先放挑过的（在池子里占位），再按名单顺序派没挑过的、撞了往后挪——
同一场电话里不撞声音。只有 id 的旧名单照收，派出来的结果与改动前逐个相同。
六档对应是维护者 2026-09-27 定的默认：13 个候选各念同一句话量出来的音高与语速。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add src/shared/agentVoice.ts tests/shared/agentVoice.test.ts
```
然后单独一条：`cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git commit -F .superpowers/commit-msg.txt`

---

### Task 2: 库与读写——0042、快照多一格、存得进去

**Files:**
- Create: `supabase/migrations/0042_workspace_agents_voice.sql`
- Modify: `src/shared/workspaces.ts`（`WorkspaceAgentRow`、`assembleSnapshot` 的 agents 参数与映射、新 `normalizeVoiceKey`）
- Modify: `src/shared/supabaseWorkspacesApi.ts`（新 `fetchAgentVoices`、`fetchWorkspace` 并进去、`updateAgentRow` 的 patch 类型）
- Modify: `src/shared/agentAdmin.ts`（`AgentPatchInput.voice`、`AgentUpdateDeps` 的 patch 类型、`UNKNOWN_VOICE` / `VOICE_NOT_READY`、`updateAgentChecked`）
- Modify: `src/shared/agentSettingsForm.ts`（`AgentForm.voice`、`agentFormOf`、`AgentFormPatch.voice`、`agentFormPatch`）
- Test: `tests/shared/workspaces.test.ts`、`tests/shared/supabaseWorkspacesApi.voices.test.ts`（新）、`tests/shared/agentAdmin.test.ts`、`tests/shared/agentSettingsForm.test.ts`

**Interfaces:**
- Consumes（Task 1）: `VOICE_KEY_RE`、`voiceChoiceOf` 自 `src/shared/agentVoice.js`
- Produces:
  - `WorkspaceAgentRow.voice?: string`（缺席 = 没挑过）
  - `normalizeVoiceKey(v: unknown): string | null`（`src/shared/workspaces.ts`）
  - `fetchAgentVoices(client: SupabaseClient, workspaceId: string): Promise<Map<string, string>>`
  - `updateAgentRow(..., patch: { ...; voice?: string | null })`
  - `AgentPatchInput.voice?: string | null`；`UNKNOWN_VOICE`、`VOICE_NOT_READY`（`src/shared/agentAdmin.ts` 导出）
  - `AgentForm.voice: string | null`；`AgentFormPatch.voice?: string | null`

- [ ] **Step 1: 写失败的测试**

(a) `tests/shared/workspaces.test.ts`：import 行加 `normalizeVoiceKey`（`import { assembleSnapshot, isHomeWorkspace, normalizeVoiceKey } from "../../src/shared/workspaces.js";`），在 `describe("assembleSnapshot", …)` 里 avatar_slot 那条用例后面加：

```ts
  it("voice（#1372）：形状合格的键原样带出（认不出的新键也留着，派生那一侧再当没挑过）；缺席 / null / 脏值就不带这一格", () => {
    const agentRow = (voice: unknown) => ({
      agent_id: "a1", name: "运营", description: "", instructions: "",
      models: [], tools: [], created_by: "u2", updated_at: "1970-01-01T00:00:00.000Z",
      voice,
    });
    const agentOf = (v: unknown) => assembleSnapshot(WS, [], [], [], [agentRow(v)], () => null).agents[0]!;
    expect(agentOf("gan").voice).toBe("gan");
    expect(agentOf("newkey").voice).toBe("newkey");
    expect("voice" in agentOf(undefined)).toBe(false);   // 0042 还没跑：列读不到与「没挑过」同义
    expect("voice" in agentOf(null)).toBe(false);
    expect("voice" in agentOf("GAN")).toBe(false);
    expect("voice" in agentOf(3)).toBe(false);
  });
```

文件末尾追加：

```ts
describe("normalizeVoiceKey（#1372）", () => {
  it("只收 0042 那条约束认的形状：小写字母 1–16 个", () => {
    expect(normalizeVoiceKey("bo")).toBe("bo");
    expect(normalizeVoiceKey("")).toBeNull();
    expect(normalizeVoiceKey("a".repeat(17))).toBeNull();
    expect(normalizeVoiceKey("b o")).toBeNull();
    expect(normalizeVoiceKey(null)).toBeNull();
  });
});
```

(b) 新文件 `tests/shared/supabaseWorkspacesApi.voices.test.ts`：

```ts
// fetchAgentVoices 与 updateAgentRow 的 voice 那一格（#1372，#1356 A4b）。这一层薄到本来不单测
// （见 supabaseWorkspacesApi.cloudSessions.test.ts 文件头），例外的理由：「读不到回空表」是 0042 没跑时
// 名册照常的唯一保证——它坏掉的样子是整个名册读不出来；「voice 原样进 update」是挑了存得下来的唯一保证。

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgentVoices, updateAgentRow } from "../../src/shared/supabaseWorkspacesApi.js";

type Call = { op: string; arg: unknown };

function fakeClient(calls: Call[], result: { data: unknown; error: { message: string; code?: string } | null }): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push({ op: "select", arg: cols }); return builder; },
    update: (row: unknown) => { calls.push({ op: "update", arg: row }); return builder; },
    eq: (col: string, v: unknown) => { calls.push({ op: "eq", arg: `${col}=${String(v)}` }); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(result).then(res, rej),
  };
  return { from: (t: string) => { calls.push({ op: "from", arg: t }); return builder; } } as unknown as SupabaseClient;
}

describe("fetchAgentVoices", () => {
  it("只读 agent_id,voice 两列、按团队过滤；只收字符串", async () => {
    const calls: Call[] = [];
    const m = await fetchAgentVoices(fakeClient(calls, {
      data: [{ agent_id: "a1", voice: "gan" }, { agent_id: "a2", voice: null }, { agent_id: "a3", voice: 7 }],
      error: null,
    }), "w1");
    expect([...m]).toEqual([["a1", "gan"]]);
    expect(calls).toEqual([
      { op: "from", arg: "workspace_agents" },
      { op: "select", arg: "agent_id,voice" },
      { op: "eq", arg: "workspace_id=w1" },
    ]);
  });

  it("这一列还不在（0042 没跑，42703）或查询抖了：回空表，不抛", async () => {
    const m = await fetchAgentVoices(fakeClient([], {
      data: null, error: { message: "column workspace_agents.voice does not exist", code: "42703" },
    }), "w1");
    expect(m.size).toBe(0);
  });
});

describe("updateAgentRow 的 voice", () => {
  const ok = { data: [{ agent_id: "a1" }], error: null };
  const updated = (calls: Call[]) => calls.find((c) => c.op === "update")!.arg as Record<string, unknown>;

  it("给了就原样写 voice 那一列；null = 清回按 agent_id 派生", async () => {
    const calls: Call[] = [];
    await updateAgentRow(fakeClient(calls, ok), "w1", "a1", { voice: "gan" });
    expect(updated(calls)).toMatchObject({ voice: "gan" });
    const calls2: Call[] = [];
    await updateAgentRow(fakeClient(calls2, ok), "w1", "a1", { voice: null });
    expect(updated(calls2)).toMatchObject({ voice: null });
  });

  it("没给就不带这个键（只改名字的那次不许碰声音）", async () => {
    const calls: Call[] = [];
    await updateAgentRow(fakeClient(calls, ok), "w1", "a1", { name: "开发" });
    expect("voice" in updated(calls)).toBe(false);
  });
});
```

(c) `tests/shared/agentAdmin.test.ts`：import 那一行的花括号里加上 `UNKNOWN_VOICE, VOICE_NOT_READY,`；在 `describe("updateAgentChecked", …)` 里追加：

```ts
  it("声音（#1372）：认得的键 / null 原样递下去；认不出的键当场拒、不打网络", async () => {
    const deps = updateDeps([]);
    await updateAgentChecked(deps, client, "w", "a1", { voice: "gan" });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { voice: "gan" });
    await updateAgentChecked(deps, client, "w", "a1", { voice: null });
    expect(deps.updateAgentRow).toHaveBeenLastCalledWith(client, "w", "a1", { voice: null });
    const deps2 = updateDeps([]);
    await expect(updateAgentChecked(deps2, client, "w", "a1", { voice: "zzz" })).rejects.toThrow(UNKNOWN_VOICE);
    expect(deps2.updateAgentRow).not.toHaveBeenCalled();
    expect(deps2.listAgentNames).not.toHaveBeenCalled();
  });

  it("库还没跑 0042（42703）且这次带了声音：说「服务端还没升级」；没带声音的同一个错误原样抛", async () => {
    const behind = Object.assign(new Error('column "voice" of relation "workspace_agents" does not exist'), { code: "42703" });
    const deps = updateDeps([]);
    deps.updateAgentRow.mockRejectedValueOnce(behind);
    await expect(updateAgentChecked(deps, client, "w", "a1", { voice: "gan" })).rejects.toThrow(VOICE_NOT_READY);
    deps.updateAgentRow.mockRejectedValueOnce(behind);
    await expect(updateAgentChecked(deps, client, "w", "a1", { description: "管店铺" })).rejects.toBe(behind);
  });
```

(d) `tests/shared/agentSettingsForm.test.ts`：在 `describe("agentFormPatch", …)` 里追加：

```ts
  it("声音（#1372）：换了才写；换回「自动」写 null；没挑过的表单里是 null", () => {
    expect(agentFormOf(A).voice).toBeNull();
    expect(agentFormPatch(A, { ...agentFormOf(A), voice: "gan" })).toEqual({ voice: "gan" });
    const B: WorkspaceAgentRow = { ...A, voice: "gan" };
    expect(agentFormOf(B).voice).toBe("gan");
    expect(agentFormPatch(B, agentFormOf(B))).toBeNull();
    expect(agentFormPatch(B, { ...agentFormOf(B), voice: null })).toEqual({ voice: null });
  });
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/workspaces.test.ts tests/shared/supabaseWorkspacesApi.voices.test.ts tests/shared/agentAdmin.test.ts tests/shared/agentSettingsForm.test.ts`
Expected: FAIL（`normalizeVoiceKey` / `fetchAgentVoices` / `UNKNOWN_VOICE` / `VOICE_NOT_READY` 不存在，`voice` 不在表单与快照里）

- [ ] **Step 3: 实现**

(a) 新文件 `supabase/migrations/0042_workspace_agents_voice.sql`：

```sql
-- 0042_workspace_agents_voice.sql —— 每只智能体可以挑「说话的声音」（#1372，#1356 A4b）。幂等。
-- 与 0027 同一约定：Supabase SQL editor / Management API 手动执行一次（生产库动作等维护者明说）。
-- **读是单独一条容错查询**（src/shared/supabaseWorkspacesApi.ts 的 fetchAgentVoices），所以先合代码后跑库
-- 也行：这一列不在时一格都读不到 = 全部按 agent_id 派生，名册照常；手机上挑了按「存」会被库拒，
-- 界面说「服务端还没升级」（agentAdmin.ts 的 VOICE_NOT_READY）。
--
-- 存的是我们自己的键（qing / wen / chen / gan / shao / bo），不是 MiniMax 的音色 id：换一档背后的音色
-- 只改 src/shared/agentVoice.ts 那张表，不用再跑库。约束只管形状，不写死这六个（同 0027 不写死 13 张
-- 头像）：旧客户端读到新键当没挑过，由客户端兜。null = 没挑过 = 照旧按 agent_id 派生，存量行一行不改。

alter table public.workspace_agents
  add column if not exists voice text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workspace_agents_voice_shape'
       and conrelid = 'public.workspace_agents'::regclass
  ) then
    alter table public.workspace_agents
      add constraint workspace_agents_voice_shape
      check (voice is null or voice ~ '^[a-z]{1,16}$');
  end if;
end $$;

comment on column public.workspace_agents.voice is
  '说话的声音：我们自己的键（src/shared/agentVoice.ts 的 AGENT_VOICE_CHOICES）。null = 没挑过，按 agent_id 派生。#1372';
```

(b) `src/shared/workspaces.ts`：

- 文件顶部 import 区加一行：`import { VOICE_KEY_RE } from "./agentVoice.js";`
- `WorkspaceAgentRow` 里 `avatarSlot: number | null;` 那一格（连同它的注释）**之后**加：

```ts
  /** 说话的声音（`workspace_agents.voice`，#1372）：`AGENT_VOICE_CHOICES` 的一个键。**缺席 = 没挑过**
      = 按 agentId 派生——这一列读不到（0042 还没跑）、脏值、没挑过三者处置相同，所以不像 avatarSlot
      那样必填 null（必填要改几十处测试夹具，换不来任何行为差别）。形状合格的陌生键（新版才有的档）
      原样留着，派生那一侧（voiceChoiceOf）再当没挑过 */
  voice?: string;
```

- `assembleSnapshot` 的 `agents` 参数类型那一行的 `avatar_slot?: unknown;` 后面加 `voice?: unknown;`
- `assembleSnapshot` 返回对象里的 `agents: agents.map((a) => { … }),` 整段换成：

```ts
    agents: agents.map((a) => {
      const created = a.created_at === undefined ? Number.NaN : Date.parse(a.created_at);
      const voice = normalizeVoiceKey(a.voice);
      return {
        agentId: a.agent_id,
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        models: normalizeStringArray(a.models),
        tools: normalizeAgentTools(a.tools),
        createdBy: a.created_by,
        updatedTs: toEpochMs(a.updated_at),
        avatarSlot: normalizeAvatarSlot(a.avatar_slot),
        ...(Number.isNaN(created) ? {} : { createdTs: created }),
        ...(voice === null ? {} : { voice }),
      };
    }),
```
- `normalizeAvatarSlot` 后面加：

```ts
/** `voice` 那一格 → 键或 null。**列不存在（0042 还没跑）与「没挑过」在这里同义**：都回 null，都走派生
    （同 normalizeAvatarSlot）。只认 0042 约束的形状；认不认得这个键不在这里判——新版才有的档由派生
    那一侧（voiceChoiceOf）当没挑过，快照里原样留着，免得旧客户端存一次就把它冲掉 */
export function normalizeVoiceKey(v: unknown): string | null {
  return typeof v === "string" && VOICE_KEY_RE.test(v) ? v : null;
}
```

(c) `src/shared/supabaseWorkspacesApi.ts`：

- `fetchWorkspace` 里 `const profiles = await fetchProfiles(...)` 那一行**之前**加：`const voices = await fetchAgentVoices(client, id);`
- 同一个函数最后那行 `return assembleSnapshot({ ...ws, sandbox_approval: sandboxApproval, kind }, members, connectors, sessions, agents, (uid) => profiles.get(uid) ?? null);` 里的 `agents` 换成 `agents.map((a) => (voices.has(a.agent_id) ? { ...a, voice: voices.get(a.agent_id) } : a))`
- `fetchWorkspaceKind` 那个函数之后加：

```ts
/** 每只挑过的「说话的声音」（`workspace_agents.voice`，#1372）。**单独一条、容错**，理由与
    `fetchWorkspaceKind` 逐字相同：拼进主 select 的话，0042 没跑时 PostgREST 对不存在的列回 42703，
    整个名册一个字都读不出来。读不到回空表——全部按 agent_id 派生，那正是没挑过的样子 */
export async function fetchAgentVoices(client: SupabaseClient, workspaceId: string): Promise<Map<string, string>> {
  const res = await client.from("workspace_agents").select("agent_id,voice").eq("workspace_id", workspaceId);
  const out = new Map<string, string>();
  if (res.error || !Array.isArray(res.data)) return out;
  for (const r of res.data as { agent_id?: unknown; voice?: unknown }[]) {
    if (typeof r.agent_id === "string" && typeof r.voice === "string") out.set(r.agent_id, r.voice);
  }
  return out;
}
```

- `updateAgentRow` 的 `patch` 类型里 `tools?: AgentToolAllow[]; avatarSlot?: number | null;` 改成 `tools?: AgentToolAllow[]; avatarSlot?: number | null; voice?: string | null;`；函数体里那两行注释（「avatarSlot 是驼峰…」）下面加一行注释：`// voice 与列同名，原样跟着 rest 进去：省略 = 不动这一格，null = 清回派生（#1372）`

(d) `src/shared/agentAdmin.ts`：

- import 区加：`import { voiceChoiceOf } from "./agentVoice.js";` 与 `import { isSchemaBehind } from "./workspaceError.js";`（按字母序放进现有 import 堆里）
- `AgentPatchInput` 里 `avatarSlot?: number | null;` 后面加：

```ts
  /** 说话的声音（#1372）：`AGENT_VOICE_CHOICES` 的一个键，null = 清回按 agentId 派生，省略 = 这次没碰。
      同 avatarSlot 不过 `validateAgentPatch`，在 updateAgentChecked 里单独认 */
  voice?: string | null;
```

- 接口顶上那段 `ADMIN_CANNOT_DELETE` 常量后面加：

```ts
/** 挑了一个这一版不认得的声音（客户端不该发得出来——表里只有那六档） */
export const UNKNOWN_VOICE = "没有这个声音";

/** 库还没跑 0042 时带着声音按「存」：说清是服务端的事、怎么先把别的存下来（spec §10 第 99 条） */
export const VOICE_NOT_READY = "说话的声音还存不进去：服务端还没升级。把声音换回原来的，别的改动就能存了。";
```

- `AgentUpdateDeps.updateAgentRow` 的 patch 类型里 `tools?: AgentToolAllow[]; avatarSlot?: number | null;` 改成 `tools?: AgentToolAllow[]; avatarSlot?: number | null; voice?: string | null;`
- `updateAgentChecked` 整个函数换成：

```ts
export async function updateAgentChecked(
  deps: AgentUpdateDeps,
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
  patch: AgentPatchInput,
): Promise<void> {
  const clean = validateAgentPatch(patch);
  const threat = scanCreateAgentThreat(clean);
  if (threat) throw new Error(`${threat}，拒绝保存`);
  // 声音在打网络之前认：认不出的键当场拒（表里只有那六档，发得出来就是客户端错了）
  if (patch.voice !== undefined && patch.voice !== null && voiceChoiceOf(patch.voice) === null) {
    throw new Error(UNKNOWN_VOICE);
  }
  // 名单只在真的改名时查——不改名时那是一次白打的网络往返
  if (clean.name !== undefined) await assertAgentNameFree(deps, client, workspaceId, clean.name, agentId);
  try {
    await deps.updateAgentRow(client, workspaceId, agentId, {
      ...clean,
      ...(patch.avatarSlot === undefined ? {} : { avatarSlot: normalizeAvatarSlot(patch.avatarSlot) }),
      ...(patch.voice === undefined ? {} : { voice: patch.voice }),
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
    // 只在这次带了声音时这么说：没带声音也撞上缺列，那是别的列的事，原样抛
    if (patch.voice !== undefined && isSchemaBehind(e)) throw new Error(VOICE_NOT_READY);
    throw e;
  }
}
```

(e) `src/shared/agentSettingsForm.ts`：

- `AgentForm` 里 `avatarSlot: number | null;` 后面加：

```ts
  /** 表单此刻的声音选择（`AGENT_VOICE_CHOICES` 的键）；null = 自动（按 agentId 派生） */
  voice: string | null;
```

- `agentFormOf` 的返回改成：`return { name: a.name, description: a.description, instructions: a.instructions, avatarSlot: a.avatarSlot, voice: a.voice ?? null };`
- `AgentFormPatch` 改成：`export type AgentFormPatch = { name?: string; description?: string; instructions?: string; avatarSlot?: number | null; voice?: string | null };`
- `agentFormPatch` 里 `if (f.avatarSlot !== a.avatarSlot) p.avatarSlot = f.avatarSlot;` 后面加：`if (f.voice !== (a.voice ?? null)) p.voice = f.voice;`；函数的文档注释末尾补半句：「声音同理，换了才写」

- [ ] **Step 4: 跑，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/workspaces.test.ts tests/shared/supabaseWorkspacesApi.voices.test.ts tests/shared/agentAdmin.test.ts tests/shared/agentSettingsForm.test.ts tests/docs/migrationNumbers.test.ts && npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 全过

- [ ] **Step 5: 提交**

message：

```
feat(shared): 声音存得进库、读得回来——0042、单独一条容错读、存之前认键（#1356 A4b）

workspace_agents 加一列 voice（可空，只约束形状）。读是单独一条查询 fetchAgentVoices，
不拼进主 select：0042 没跑时一格都读不到 = 全按 agent_id 派生，名册照常（同 kind /
sandbox_approval 那两条的教训：拼进去的话整个名册一个字都读不出来）。

写走 updateAgentChecked：认不出的键在打网络之前拒；库还没升级（42703）且这次带了声音时
说「服务端还没升级」，告诉人怎么先把别的存下来。表单多一格 voice，换了才写，同头像。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add supabase/migrations/0042_workspace_agents_voice.sql src/shared/workspaces.ts src/shared/supabaseWorkspacesApi.ts src/shared/agentAdmin.ts src/shared/agentSettingsForm.ts tests/shared/workspaces.test.ts tests/shared/supabaseWorkspacesApi.voices.test.ts tests/shared/agentAdmin.test.ts tests/shared/agentSettingsForm.test.ts
```
然后单独一条 `git commit -F .superpowers/commit-msg.txt`（同 Task 1）。

---

### Task 3: 电话照这一格读声音（shared `voiceSession` / 手机 `voiceStore` / 桌面 store）

**Files:**
- Modify: `src/shared/voiceSession.ts`（`VoiceSessionDeps.roster` 的类型）
- Modify: `mobile/src/voice/voiceStore.ts`（`createVoiceSession` 那一处的 `roster`）
- Modify: `src/renderer/src/store.ts`（`rosterIdsOf` → `rosterOf`，两处调用）
- Test: `tests/shared/voiceSession.test.ts`、`tests/renderer/voiceStore.test.ts`

**Interfaces:**
- Consumes（Task 1）: `type VoiceRoster`、`voiceChoiceOf`、`agentVoiceId(agentId, roster: VoiceRoster)`；（Task 2）`WorkspaceAgentRow.voice?: string`
- Produces: `VoiceSessionDeps.roster(): VoiceRoster`

- [ ] **Step 1: 写失败的测试**

(a) `tests/shared/voiceSession.test.ts`：

- `import { agentVoiceId } from "../../src/shared/agentVoice.js";` 换成 `import { agentVoiceId, voiceChoiceOf, type VoiceRoster } from "../../src/shared/agentVoice.js";`
- `function harness(o: { events?: SessionEvent[]; say?: (text: string) => CloudAck } = {})` 的参数类型里加 `roster?: VoiceRoster;`
- deps 里 `roster: () => ["a", "b"],` 换成 `roster: () => o.roster ?? ["a", "b"],`
- 在「加入之后通话里那只的回复读出来，音色按 agentId 派生…」那条用例后面加：

```ts
  it("挑过声音的（#1372）照它挑的那一档读", async () => {
    const h = harness({ events: [callOn(1, ["a"])], roster: [{ agentId: "a", voice: "bo" }, "b"] });
    h.v.join(S);
    h.push(reply(2, "a", "我挑了播音。"));
    await flush();
    expect(h.spoke).toEqual([{ text: "我挑了播音。", voiceId: voiceChoiceOf("bo")!.voiceId }]);
  });
```

(b) `tests/renderer/voiceStore.test.ts`：`import { agentVoiceId } from "../../src/shared/agentVoice.js";` 换成 `import { agentVoiceId, voiceChoiceOf } from "../../src/shared/agentVoice.js";`；在第一条用例（「加入 → 之后名单里那只的回复按段送去合成…」）后面加：

```ts
  it("挑过声音的那只（#1372）照它挑的那一档读", async () => {
    useChat.setState({ workspaceGroups: [{ ...ws, agents: [ws.agents[0]!, { ...ws.agents[1]!, voice: "bo" }] }] });
    const st = useChat.getState();
    st.joinVoiceCall();
    st.voiceOnEvent(said("a_1", 2, "我挑了播音"));
    await flush();
    expect(spoken[0]!.voiceId).toBe(voiceChoiceOf("bo")!.voiceId);
  });
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/voiceSession.test.ts tests/renderer/voiceStore.test.ts`
Expected: 新加的两条 FAIL（读出来的还是派生的那个音色；voiceSession 那条可能先在 tsc 层面报 roster 类型不对——vitest 不查类型，照样会跑到断言上失败）

- [ ] **Step 3: 实现**

(a) `src/shared/voiceSession.ts`：

- `import { agentVoiceId } from "./agentVoice.js";` 换成 `import { agentVoiceId, type VoiceRoster } from "./agentVoice.js";`
- `VoiceSessionDeps` 里

```ts
  /** 名册顺序：音色派生要它解撞（同一只两台设备同一个声音） */
  roster(): readonly string[];
```

换成

```ts
  /** 名册（顺序 + 各自挑过的那一格）：音色派生要它解撞、挑过的先占（#1372；同一只两台设备同一个声音） */
  roster(): VoiceRoster;
```

（`enqueue` 里 `agentVoiceId(u.agentId, roster)` 一个字不用改。）

(b) `mobile/src/voice/voiceStore.ts`：`createVoiceSession({...})` 里那两行

```ts
  // 音色按名册顺序解撞（agentVoiceIds）：同一只在桌面与手机上是同一个声音
  roster: () => homeSnapshot().home?.agents.map((a) => a.agentId) ?? [],
```

换成

```ts
  // 音色按名册顺序解撞、挑过的先占（agentVoiceIds，#1372）：同一只在桌面与手机上是同一个声音
  roster: () => homeSnapshot().home?.agents ?? [],
```

(c) `src/renderer/src/store.ts`：

- 把

```ts
function rosterIdsOf(s: ChatState, workspaceId: string): string[] {
  return s.workspaceGroups.find((w) => w.id === workspaceId)?.agents.map((a) => a.agentId) ?? [];
}
```

换成

```ts
/** 这个团队的名册（顺序 + 各自挑过的声音，#1372）：音色派生按它解撞、挑过的先占 */
function rosterOf(s: ChatState, workspaceId: string): readonly WorkspaceAgentRow[] {
  return s.workspaceGroups.find((w) => w.id === workspaceId)?.agents ?? [];
}
```

- `voiceOnEvent` 与 `voiceOnDelta` 里各一处 `const roster = rosterIdsOf(s, cs.workspaceId);` 换成 `const roster = rosterOf(s, cs.workspaceId);`
- 先 `grep -n "WorkspaceAgentRow" src/renderer/src/store.ts`：已经 import 了就不动；没有的话在 import `../../shared/workspaces.js` 的那一行里加 `type WorkspaceAgentRow`（没有那一行就新加 `import type { WorkspaceAgentRow } from "../../shared/workspaces.js";`，放在其余 `../../shared/` 的 import 旁边）
- `grep -n "rosterIdsOf" src/renderer/src/store.ts` 确认一处都不剩

- [ ] **Step 4: 跑，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/voiceSession.test.ts tests/renderer/voiceStore.test.ts && npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 全过

- [ ] **Step 5: 提交**

message：

```
feat(voice): 电话照「说话的声音」那一格读——桌面与手机同一份名册（#1356 A4b）

两端的语音编排都用 agentVoiceId(id, 名册) 定声音，名册原来只有 id。现在带上各自
挑过的那一格：shared voiceSession 的 roster() 收 VoiceRoster，手机直接给快照里的
agents，桌面 rosterIdsOf 换成 rosterOf。同一只在两台设备上仍是同一个声音——判据
只有 agentVoice.ts 那一份。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add src/shared/voiceSession.ts mobile/src/voice/voiceStore.ts src/renderer/src/store.ts tests/shared/voiceSession.test.ts tests/renderer/voiceStore.test.ts
```
然后单独一条 `git commit -F .superpowers/commit-msg.txt`。

---

### Task 4: 挑声音那张表的判据（`src/shared/agentVoicePicker.ts`）

**Files:**
- Create: `src/shared/agentVoicePicker.ts`
- Test: `tests/shared/agentVoicePicker.test.ts`（新）

**Interfaces:**
- Consumes（Task 1）: `AGENT_VOICE_CHOICES`、`agentVoiceId`、`agentVoiceIds`、`voiceChoiceOf`、`type VoiceRosterEntry`；现成的 `ttsBlocked` / `ttsHostedOf`（`./ttsRoute.js`）、`ADMIN_AGENT_ID`（`./workspaceAgents.js`）、`type BillingSnapshotView`（`./shellBridge.js`）
- Produces（Task 5 用）:
  - `const VOICE_AUTO = "auto"`
  - `interface VoicePickerRow { key: string; label: string; hint: string; checked: boolean; voiceId: string; also: string | null }`
  - `function voiceRowValue(voice: string | null): string`
  - `function voicePickerRows(o: { agentId: string; picked: string | null; agents: readonly { agentId: string; name: string; voice?: string }[] }): VoicePickerRow[]`
  - `const PREVIEW_ROLE_MAX = 24`；`function voicePreviewText(name: string, description: string): string`
  - `type VoicePreviewState = { can: true } | { can: false; note: string | null }`
  - `function voicePreviewState(o: { native: boolean; inCall: boolean; billing: BillingSnapshotView | null }): VoicePreviewState`
  - `const VOICE_PICKER_NOTE`、`const VOICE_PICKER_NOTE_QUIET`；`function voicePickerFooter(s: VoicePreviewState): string`
  - `function voicePreviewError(message: string): string`

- [ ] **Step 1: 写失败的测试——新文件 `tests/shared/agentVoicePicker.test.ts`**

```ts
// 挑声音那张表的判据（#1356 A4b，#1372，spec §10 第 95–98 条）：每一行、设置页那一行写什么、
// 试听念哪一句、什么时候不念。手机只画这些。
import { describe, expect, it } from "vitest";
import { ADMIN_VOICE_ID, AGENT_VOICE_CHOICES, agentVoiceId, voiceChoiceOf } from "../../src/shared/agentVoice.js";
import {
  VOICE_AUTO, VOICE_PICKER_NOTE, VOICE_PICKER_NOTE_QUIET, voicePickerFooter, voicePickerRows, voicePreviewError,
  voicePreviewState, voicePreviewText, voiceRowValue,
} from "../../src/shared/agentVoicePicker.js";
import type { BillingMe } from "../../src/shared/billing.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";

const agents = [
  { agentId: "admin", name: "管理员" },
  { agentId: "a_dev", name: "开发", voice: "gan" },
  { agentId: "a_ops", name: "运维" },
];

describe("voiceRowValue", () => {
  it("没挑过 / 认不出的键写「自动」，挑过的写那一档的名字", () => {
    expect(voiceRowValue(null)).toBe("自动");
    expect(voiceRowValue("zzz")).toBe("自动");
    expect(voiceRowValue("gan")).toBe("干脆");
  });
});

describe("voicePickerRows", () => {
  it("第一行是「自动」，后面六档按 AGENT_VOICE_CHOICES 的顺序；勾跟着表单此刻的选择", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: null, agents });
    expect(rows.map((r) => r.key)).toEqual([VOICE_AUTO, ...AGENT_VOICE_CHOICES.map((c) => c.key)]);
    expect(rows.map((r) => r.label)).toEqual(["自动", "清亮", "温和", "沉稳", "干脆", "少年", "播音"]);
    expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual([VOICE_AUTO]);
    const picked = voicePickerRows({ agentId: "a_ops", picked: "bo", agents });
    expect(picked.filter((r) => r.checked).map((r) => r.key)).toEqual(["bo"]);
  });

  it("认不出的键勾在「自动」上（当没挑过）", () => {
    expect(voicePickerRows({ agentId: "a_ops", picked: "zzz", agents }).filter((r) => r.checked).map((r) => r.key))
      .toEqual([VOICE_AUTO]);
  });

  it("每一档试听念它自己的音色；「自动」念它没挑时会派到的那一个（管理员是固定那一个）", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: "bo", agents });
    expect(rows.find((r) => r.key === "bo")!.voiceId).toBe(voiceChoiceOf("bo")!.voiceId);
    expect(rows[0]!.voiceId).toBe(
      agentVoiceId("a_ops", [{ agentId: "admin" }, { agentId: "a_dev", voice: "gan" }, { agentId: "a_ops" }]),
    );
    expect(voicePickerRows({ agentId: "admin", picked: "bo", agents })[0]!.voiceId).toBe(ADMIN_VOICE_ID);
  });

  it("别的哪几只此刻也是这个声音，写在那一行底下；自己不算，「自动」那一行不写", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: null, agents });
    expect(rows.find((r) => r.key === "gan")!.also).toBe("「开发」也是这个声音");
    expect(rows[0]!.also).toBeNull();
    const mine = voicePickerRows({ agentId: "a_dev", picked: "gan", agents });
    expect(mine.find((r) => r.key === "gan")!.also).toBeNull();
  });

  it("两只都挑了同一档：那一行写出另一只", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: "gan", agents });
    expect(rows.find((r) => r.key === "gan")!.also).toBe("「开发」也是这个声音");
  });

  it("「自动」那一行的副标题：管理员与别的智能体两种说法", () => {
    expect(voicePickerRows({ agentId: "a_ops", picked: null, agents })[0]!.hint)
      .toBe("没挑过就是它：按它自己派一个，和别的几只错开");
    expect(voicePickerRows({ agentId: "admin", picked: null, agents })[0]!.hint)
      .toBe("没挑过时用固定的那一个，到哪儿都听得出是它");
  });

  it("名册里还没有这一只（快照没刷回来）：照样答得出，排在最后", () => {
    const rows = voicePickerRows({ agentId: "a_new", picked: null, agents });
    expect(rows[0]!.voiceId).toBe(agentVoiceId("a_new", [...agents, { agentId: "a_new" }]));
  });
});

describe("voicePreviewText", () => {
  it("「我是{名字}，{职责第一句}。」：取第一句、去掉句尾标点、最多 24 个字", () => {
    expect(voicePreviewText("运维", "部署与监控")).toBe("我是运维，部署与监控。");
    expect(voicePreviewText(" 运维 ", "盯部署。出事先说！")).toBe("我是运维，盯部署。");
    expect(voicePreviewText("运维", "盯部署，")).toBe("我是运维，盯部署。");
    expect(voicePreviewText("运维", "字".repeat(30))).toBe(`我是运维，${"字".repeat(24)}。`);
  });

  it("职责空着就只报名字；名字也空着（正在改）就说一句通用的", () => {
    expect(voicePreviewText("运维", "  ")).toBe("我是运维。");
    expect(voicePreviewText("", "盯部署")).toBe("盯部署。");
    expect(voicePreviewText(" ", "")).toBe("开语音时我就用这个声音。");
  });
});

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
});
const snap = (m: BillingMe | null): BillingSnapshotView => ({ me: m, fetchedAt: 0, exhausted: null });

describe("voicePreviewState / voicePickerFooter", () => {
  it("念得了：有放音的本事、没在听电话、订阅开着且网关供语音", () => {
    const s = voicePreviewState({ native: true, inCall: false, billing: snap(me()) });
    expect(s).toEqual({ can: true });
    expect(voicePickerFooter(s)).toBe(VOICE_PICKER_NOTE);
    expect(VOICE_PICKER_NOTE).toBe("点一下就换成它，并念一句它自己的话。试听和打电话一样，用的是你的订阅额度。");
  });

  it("念不了的几种各说各的；订阅快照还没查到时不说「要订阅」（还没查到 ≠ 没有）", () => {
    expect(voicePreviewState({ native: false, inCall: false, billing: snap(me()) })).toEqual({
      can: false, note: "这个版本的 app 放不出声音（要装带语音的开发版）。挑了照样存，下次打电话就用它。",
    });
    expect(voicePreviewState({ native: true, inCall: true, billing: snap(me()) })).toEqual({
      can: false, note: "正在听电话，挂了再试听。挑了照样存。",
    });
    const checking = voicePreviewState({ native: true, inCall: false, billing: null });
    expect(checking).toEqual({ can: false, note: null });
    expect(voicePickerFooter(checking)).toBe(VOICE_PICKER_NOTE_QUIET);
    expect(VOICE_PICKER_NOTE_QUIET).toBe("点一下就换成它。");
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ status: "past_due" })) })).toEqual({
      can: false, note: "这个账号的订阅扣款没成功，试听念不了（「账号 → 订阅」）。挑了照样存。",
    });
    const noSub = { can: false, note: "试听要订阅 Pro 或 Max（「账号 → 订阅」），和打电话是同一条路。挑了照样存。" };
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(null) })).toEqual(noSub);
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ plan: null })) })).toEqual(noSub);
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ ttsModels: [] })) })).toEqual({
      can: false, note: "试听这一刻念不了：订阅网关暂时不供语音合成。挑了照样存。",
    });
    expect(voicePickerFooter({ can: false, note: "x" })).toBe("x");
  });
});

describe("voicePreviewError", () => {
  it("念不出来：原因原样带上、去掉句尾标点，后面说「挑了照样存」", () => {
    expect(voicePreviewError("网关超时。")).toBe("念不出来：网关超时。挑了照样存。");
    expect(voicePreviewError("  ")).toBe("念不出来。挑了照样存。");
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/agentVoicePicker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现——新文件 `src/shared/agentVoicePicker.ts`**

```ts
// agentVoicePicker —— 挑「说话的声音」那张表的判据（#1356 A4b，#1372，spec §10 第 95–98 条）。纯逻辑零 IO；
// 手机的 VoicePickerSheet 只画这些。哪天桌面也要这一格，同一份拿去用（维护者 2026-09-27 定桌面先只读）。
//
// 表是「自动」+ 六档：「自动」= 没挑过 = 按 agentId 派生；点一行就换成它并念一句它自己的话。
// 每一行底下写出别的哪几只此刻也是这个声音（同一场电话里撞声音由人自己决定）；试听那一句从表单此刻的
// 名字与职责来；念不了的时候说清为什么，挑照样能挑、能存。

import {
  AGENT_VOICE_CHOICES, agentVoiceId, agentVoiceIds, voiceChoiceOf, type VoiceRosterEntry,
} from "./agentVoice.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import { ttsBlocked, ttsHostedOf } from "./ttsRoute.js";
import { ADMIN_AGENT_ID } from "./workspaceAgents.js";

/** 表里「自动」那一行的键（不会与六档撞：那六个是拼音缩写） */
export const VOICE_AUTO = "auto";

const AUTO_HINT = "没挑过就是它：按它自己派一个，和别的几只错开";
const ADMIN_AUTO_HINT = "没挑过时用固定的那一个，到哪儿都听得出是它";

export interface VoicePickerRow {
  /** VOICE_AUTO 或那一档的键 */
  key: string;
  label: string;
  hint: string;
  /** 这一行此刻被勾着（表单此刻的选择） */
  checked: boolean;
  /** 试听这一行念的音色：一档就是它自己的；「自动」是这一只没挑时会派到的那一个 */
  voiceId: string;
  /** 「「开发」也是这个声音」；没有别的智能体是这个声音 → null（「自动」那一行恒为 null） */
  also: string | null;
}

/** 设置页那一行右边写什么：挑过的写那一档的名字，没挑过 / 认不出的键写「自动」 */
export function voiceRowValue(voice: string | null): string {
  return voiceChoiceOf(voice)?.label ?? "自动";
}

/**
 * 表的七行。`agents` 是名册（顺序 = 派生解撞的顺序），带各自**存下来**的那一格；这一只按表单此刻的
 * `picked` 算（还没存），所以「谁也是这个声音」说的是「照你此刻的选择，存下去之后」的样子。
 * 名册里还没有这一只（快照没刷回来）也答得出：它排在最后。
 */
export function voicePickerRows(o: {
  agentId: string;
  picked: string | null;
  agents: readonly { agentId: string; name: string; voice?: string }[];
}): VoicePickerRow[] {
  const entryOf = (agentId: string, voice: string | null | undefined): VoiceRosterEntry =>
    typeof voice === "string" ? { agentId, voice } : { agentId };
  const rosterWith = (voice: string | null): VoiceRosterEntry[] => {
    const rest = o.agents.map((a) => (a.agentId === o.agentId ? entryOf(o.agentId, voice) : entryOf(a.agentId, a.voice)));
    return o.agents.some((a) => a.agentId === o.agentId) ? rest : [...rest, entryOf(o.agentId, voice)];
  };
  const chosen = voiceChoiceOf(o.picked);
  const now = agentVoiceIds(rosterWith(chosen === null ? null : chosen.key));
  const others = o.agents.filter((a) => a.agentId !== o.agentId);
  const alsoOf = (voiceId: string): string | null => {
    const names = others.filter((a) => now.get(a.agentId) === voiceId).map((a) => `「${a.name}」`);
    return names.length === 0 ? null : `${names.join("")}也是这个声音`;
  };
  return [
    {
      key: VOICE_AUTO,
      label: "自动",
      hint: o.agentId === ADMIN_AGENT_ID ? ADMIN_AUTO_HINT : AUTO_HINT,
      checked: chosen === null,
      voiceId: agentVoiceId(o.agentId, rosterWith(null)),
      also: null,
    },
    ...AGENT_VOICE_CHOICES.map((c) => ({
      key: c.key,
      label: c.label,
      hint: c.hint,
      checked: chosen?.key === c.key,
      voiceId: c.voiceId,
      also: alsoOf(c.voiceId),
    })),
  ];
}

/** 试听那一句里职责最多几个字：一句的钱与等待都跟字数走 */
export const PREVIEW_ROLE_MAX = 24;

/** 试听念的那一句：「我是{名字}，{职责第一句}。」。名字与职责取表单此刻的样子（还没存也算）；
    职责只取第一行第一句、去掉句尾的逗号冒号、最多 PREVIEW_ROLE_MAX 个字 */
export function voicePreviewText(name: string, description: string): string {
  const who = name.trim();
  const firstLine = description.split(/\r?\n/)[0] ?? "";
  const firstSentence = (firstLine.split(/[。！？!?；;]/)[0] ?? "").trim().replace(/[，,、：:\s]+$/u, "");
  const role = [...firstSentence].slice(0, PREVIEW_ROLE_MAX).join("");
  if (who !== "" && role !== "") return `我是${who}，${role}。`;
  if (who !== "") return `我是${who}。`;
  if (role !== "") return `${role}。`;
  return "开语音时我就用这个声音。";
}

/** 这一刻念不念得了；念不了时页脚那一句（null = 订阅快照还没查到，不下结论） */
export type VoicePreviewState = { can: true } | { can: false; note: string | null };

const trimEnd = (s: string): string => s.trim().replace(/[。.！!？?\s]+$/u, "");

/** 顺序同 mobileCall.joinBlockedText：先看这台有没有放音的本事，再看此刻在不在听电话（同一个
    音频引擎），最后看订阅——扣款没成功不是没订阅（ADR-0240），两句分开说 */
export function voicePreviewState(o: {
  native: boolean;
  inCall: boolean;
  billing: BillingSnapshotView | null;
}): VoicePreviewState {
  if (!o.native) return { can: false, note: "这个版本的 app 放不出声音（要装带语音的开发版）。挑了照样存，下次打电话就用它。" };
  if (o.inCall) return { can: false, note: "正在听电话，挂了再试听。挑了照样存。" };
  if (o.billing === null) return { can: false, note: null };
  if (o.billing.me?.status === "past_due") {
    return { can: false, note: "这个账号的订阅扣款没成功，试听念不了（「账号 → 订阅」）。挑了照样存。" };
  }
  const hosted = ttsHostedOf(o.billing);
  if (hosted === undefined || !hosted.subscribed) {
    return { can: false, note: "试听要订阅 Pro 或 Max（「账号 → 订阅」），和打电话是同一条路。挑了照样存。" };
  }
  const blocked = ttsBlocked(hosted);
  if (blocked !== null) return { can: false, note: `试听这一刻念不了：${trimEnd(blocked)}。挑了照样存。` };
  return { can: true };
}

export const VOICE_PICKER_NOTE = "点一下就换成它，并念一句它自己的话。试听和打电话一样，用的是你的订阅额度。";
export const VOICE_PICKER_NOTE_QUIET = "点一下就换成它。";

/** 表底下那一句：念得了说规矩（含「用你的额度」），念不了说为什么，还没查到只说怎么挑 */
export function voicePickerFooter(s: VoicePreviewState): string {
  if (s.can) return VOICE_PICKER_NOTE;
  return s.note ?? VOICE_PICKER_NOTE_QUIET;
}

/** 念不出来（合成失败 / 放不出来）时那一行的红字 */
export function voicePreviewError(message: string): string {
  const m = trimEnd(message);
  return m === "" ? "念不出来。挑了照样存。" : `念不出来：${m}。挑了照样存。`;
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npx vitest run tests/shared/agentVoicePicker.test.ts && npx tsc --noEmit`
Expected: 全过

- [ ] **Step 5: 提交**

message：

```
feat(shared): 挑声音那张表的判据——七行、谁也是这个声音、念哪一句、什么时候不念（#1356 A4b）

「自动」+ 六档：「自动」念它没挑时会派到的那一个；每一档底下写出别的哪几只此刻
也是这个声音（照表单此刻的选择算，存下去之后的样子）。试听念「我是{名字}，{职责第一句}。」，
念不了的几种各说各的：没放音模块 / 正在听电话 / 扣款没成功 / 没订阅 / 网关不供语音；
订阅快照还没查到时不说「要订阅」——还没查到 ≠ 没有。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add src/shared/agentVoicePicker.ts tests/shared/agentVoicePicker.test.ts
```
然后单独一条 `git commit -F .superpowers/commit-msg.txt`。

---

### Task 5: 手机——设置页那一行、挑声音的表、试听

**Files:**
- Modify: `mobile/src/chrome/RowGlyphs.tsx`（多一枚 `wave`）
- Modify: `mobile/src/voice/voiceStore.ts`（导出 `speakPreview` / `playPreview`）
- Create: `mobile/src/agent/VoicePickerSheet.tsx`
- Modify: `mobile/src/agent/AgentSettingsScreen.tsx`
- Modify: `mobile/src/ui.tsx`（`Row` 的 `chevron` 注释一句）
- 没有 vitest（手机端只跑 tsc）；判据都已在 Task 4 的 shared 里

**Interfaces:**
- Consumes（Task 4）: `VOICE_AUTO`、`voicePickerRows`、`voicePickerFooter`、`voicePreviewError`、`voicePreviewState`、`voicePreviewText`、`voiceRowValue`；（Task 2）`AgentForm.voice`；现成的 `BottomSheet`（`../sheet/BottomSheet.js`，props `visible / title / onClose`）、`CheckGlyph`（`../chrome/Glyphs.js`）、`useReduceMotion`（`../ui.js`）、`useVoice` / `nativeSpeech` / `refreshVoiceBilling`（`../voice/voiceStore.js`）、`createHelperAudio`（`src/shared/helperAudio.js`）、`type VoiceSpeakResult`（`src/shared/shellBridge.js`）
- Produces:
  - `RowGlyphName` 多一个 `"wave"`
  - `speakPreview(text: string, voiceId: string): Promise<VoiceSpeakResult>`
  - `playPreview(bytes: Uint8Array, on: { start(): void; end(): void; fail(message: string): void }): () => void`
  - `VoicePickerSheet`（props 见下面代码）

- [ ] **Step 1: `mobile/src/chrome/RowGlyphs.tsx` 多一枚声浪**

- `export type RowGlyphName = "spark" | "chart" | "cloud" | "gear" | "folder" | "file" | "image" | "plug" | "book";` 末尾加 ` | "wave"`
- `PATHS` 里 `book: …,` 后面加一行：`  wave: "M2 12h3l2-7 3 14 3-10 2 5h7",`（路径逐字取自 demo 的图标表）

- [ ] **Step 2: `mobile/src/voice/voiceStore.ts` 导出试听两个口**

- import 区：`import type { BillingSnapshotView, CloudAck } from "../../../src/shared/shellBridge.js";` 改成 `import type { BillingSnapshotView, CloudAck, VoiceSpeakResult } from "../../../src/shared/shellBridge.js";`
- 文件末尾（`setMic` 之后）加：

```ts
/** 挑声音那张表的试听（#1372，spec §10 第 97 条）：合成走电话那同一个 TTS 客户端（同一笔额度、同一套
    报错），放音走同一个原生放音器；不经过通话那一套（它不在任何一场电话里）。这台正在听电话时表那边
    不调它（同一个音频引擎，voicePreviewState 的 inCall） */
export function speakPreview(text: string, voiceId: string): Promise<VoiceSpeakResult> {
  return tts.speak(text, voiceId);
}

/** 放一段试听，回一个「停」。一次只放一段：调用方换一行之前先调上一段的「停」。
    停的时候连原生那边一起停：起播的回执还没回来时 createHelperAudio 的 pause() 够不着原生那一段 */
export function playPreview(bytes: Uint8Array, on: { start(): void; end(): void; fail(message: string): void }): () => void {
  const audio = createHelperAudio(bytes, nativeAudio);
  audio.onended = () => on.end();
  audio.onerror = (message) => on.fail(message ?? "放不出来");
  audio.play().then(
    () => on.start(),
    (err: unknown) => on.fail(err instanceof Error ? err.message : String(err)),
  );
  return () => {
    audio.pause();
    void nativeAudio.stop();
  };
}
```

- [ ] **Step 3: 新文件 `mobile/src/agent/VoicePickerSheet.tsx`**

```tsx
// 挑说话的声音（#1356 A4b，#1372，spec §10 第 95–98 条）：「自动」+ 六档，点一行就换成它并念一句它自己的话；
// 再点正在念的那一行 = 停。判据全在 shared 的 agentVoicePicker.ts（每一行、页脚、念哪一句、什么时候不念），
// 这里只画与接试听。点一行只改表单那一格；写库在设置页按「存」（同「换个形象」）。
//
// 试听：同一句在这张表开着时只合成一次（按「音色 + 那一句」记，表收起就扔）；换一行、收起、离开设置页
// 都先停上一段。`turn` 作废还没回来的那一次合成——慢的旧请求后到时不许把它念出来，也不许改这一行的样子。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, View } from "react-native";
import {
  VOICE_AUTO, voicePickerFooter, voicePickerRows, voicePreviewError, voicePreviewState, voicePreviewText,
} from "../../../src/shared/agentVoicePicker.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { nativeSpeech, playPreview, refreshVoiceBilling, speakPreview, useVoice } from "../voice/voiceStore.js";

type Phase = "wait" | "play";

export function VoicePickerSheet(p: {
  visible: boolean;
  agentId: string;
  /** 表单此刻的名字与职责：试听念的那一句从它们来 */
  name: string;
  description: string;
  /** 表单此刻的选择；null = 自动 */
  picked: string | null;
  /** 名册（顺序 = 派生解撞的顺序），带各自存下来的那一格 */
  agents: readonly { agentId: string; name: string; voice?: string }[];
  onPick: (voice: string | null) => void;
  onClose: () => void;
}) {
  const { c } = usePalette();
  const voice = useVoice();
  const state = voicePreviewState({ native: nativeSpeech, inCall: voice.listen !== null, billing: voice.billing });
  const rows = voicePickerRows({ agentId: p.agentId, picked: p.picked, agents: p.agents });
  const [now, setNow] = useState<{ key: string; phase: Phase } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const cache = useRef(new Map<string, Uint8Array>());
  const stopPlay = useRef<(() => void) | null>(null);
  const turn = useRef(0);

  const stop = (): void => {
    turn.current++;
    stopPlay.current?.();
    stopPlay.current = null;
    setNow(null);
  };

  // 打开时拉一次订阅快照（页脚要知道念不念得了；拉失败留着上一次的）；收起 = 停、扔掉缓存、清掉红字
  useEffect(() => {
    if (p.visible) {
      void refreshVoiceBilling();
      return;
    }
    stop();
    setFailed(null);
    cache.current.clear();
  }, [p.visible]);

  // 离开设置页（整张卸载）时也停
  useEffect(
    () => () => {
      turn.current++;
      stopPlay.current?.();
      stopPlay.current = null;
    },
    [],
  );

  const preview = async (key: string, voiceId: string): Promise<void> => {
    const again = now?.key === key;
    stop();
    setFailed(null);
    if (again || !state.can) return; // 再点正在念 / 正在等的那一行 = 停；念不了就只换不念
    const mine = ++turn.current;
    setNow({ key, phase: "wait" });
    const text = voicePreviewText(p.name, p.description);
    const k = `${voiceId}\n${text}`;
    let audio = cache.current.get(k);
    if (audio === undefined) {
      const r = await speakPreview(text, voiceId);
      if (mine !== turn.current) return;
      if (!r.ok) {
        setNow(null);
        setFailed({ key, text: voicePreviewError(r.message) });
        return;
      }
      audio = r.audio;
      cache.current.set(k, audio);
    }
    stopPlay.current = playPreview(audio, {
      start: () => {
        if (mine === turn.current) setNow({ key, phase: "play" });
      },
      end: () => {
        if (mine !== turn.current) return;
        stopPlay.current = null;
        setNow(null);
      },
      fail: (message) => {
        if (mine !== turn.current) return;
        stopPlay.current = null;
        setNow(null);
        setFailed({ key, text: voicePreviewError(message) });
      },
    });
  };

  return (
    <BottomSheet visible={p.visible} title="说话的声音" onClose={p.onClose}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {rows.map((row) => {
          const phase = now?.key === row.key ? now.phase : null;
          const err = failed?.key === row.key ? failed.text : null;
          return (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityState={{ selected: row.checked }}
              accessibilityLabel={`${row.label}，${row.hint}`}
              onPress={() => {
                p.onPick(row.key === VOICE_AUTO ? null : row.key);
                void preview(row.key, row.voiceId);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 58,
                paddingHorizontal: 20,
                paddingVertical: 10,
                backgroundColor: pressed ? c.muted : "transparent",
              })}
            >
              <VoiceRowIcon phase={phase} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 16, color: c.foreground }}>{row.label}</Text>
                <Text
                  style={{ fontSize: 13, lineHeight: 18, marginTop: 1, color: err === null ? c.mutedForeground : c.destructive }}
                >
                  {err ?? row.hint}
                </Text>
                {row.also !== null && err === null ? (
                  <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, marginTop: 1, color: c.mutedForeground }}>
                    {row.also}
                  </Text>
                ) : null}
              </View>
              <View style={{ width: 20, alignItems: "center" }}>
                {row.checked ? <CheckGlyph color={c.brand} size={17} /> : null}
              </View>
            </Pressable>
          );
        })}
        <Text style={{ paddingHorizontal: 20, paddingTop: 10, fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>
          {voicePickerFooter(state)}
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

/** 行首那一格：平时是一枚声浪；等合成时一明一暗；在念时换成三根跳动的条（通话青）。
    「减弱动态效果」时不闪不跳——停在静止的那一帧 */
function VoiceRowIcon({ phase }: { phase: Phase | null }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  const bars = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    pulse.setValue(1);
    bars.forEach((b) => b.setValue(reduce ? 0.5 : 0));
    if (reduce || phase === null) return;
    const ease = Easing.inOut(Easing.ease);
    const loop =
      phase === "wait"
        ? Animated.loop(
            Animated.sequence([
              Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: ease, useNativeDriver: true }),
              Animated.timing(pulse, { toValue: 1, duration: 700, easing: ease, useNativeDriver: true }),
            ]),
          )
        : Animated.loop(
            Animated.stagger(
              140,
              bars.map((b) =>
                Animated.sequence([
                  Animated.timing(b, { toValue: 1, duration: 420, easing: ease, useNativeDriver: true }),
                  Animated.timing(b, { toValue: 0, duration: 420, easing: ease, useNativeDriver: true }),
                ]),
              ),
            ),
          );
    loop.start();
    return () => loop.stop();
  }, [phase, reduce, pulse, bars]);

  if (phase === "play") {
    return (
      <View
        style={{
          width: 29, height: 29, borderRadius: 8, backgroundColor: c.secondary,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2,
        }}
      >
        {bars.map((b, i) => (
          <Animated.View
            key={i}
            style={{
              width: 3, height: 15, borderRadius: 2, backgroundColor: c.voice,
              transform: [{ scaleY: b.interpolate({ inputRange: [0, 1], outputRange: [0.27, 1] }) }],
            }}
          />
        ))}
      </View>
    );
  }
  return (
    <Animated.View style={{ opacity: pulse }}>
      <RowGlyph name="wave" color={c.mutedForeground} />
    </Animated.View>
  );
}
```

- [ ] **Step 4: `mobile/src/agent/AgentSettingsScreen.tsx` 挂上那一行与那张表**

- 文件头注释第 4 行（「「存」挂在原生导航条右边…」）之后加一行：`// 「说话的声音」那一行（#1372，A4b）拉起一张表，点一行只改表单那一格，同「换个形象」按「存」才落库。`
- import 区：在 `import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "../../../src/shared/createAgentDraft.js";` 之前加 `import { voiceRowValue } from "../../../src/shared/agentVoicePicker.js";`；在 `import { HeaderTextButton } from "../chrome/HeaderTextButton.js";` 之后加 `import { RowGlyph } from "../chrome/RowGlyphs.js";`；在 `import { FacePickerSheet } from "./FacePickerSheet.js";` 之后加 `import { VoicePickerSheet } from "./VoicePickerSheet.js";`
- `const [picking, setPicking] = useState(false);` 之后加 `const [pickingVoice, setPickingVoice] = useState(false);`
- 「还有什么要交代的」那个 `</Labeled>` 与 `{error ? <Note tone="error">{error}</Note> : null}` 之间加：

```tsx
        <Group>
          <Row
            leading={<RowGlyph name="wave" />}
            label="说话的声音"
            detail="开语音时它用这把嗓子"
            value={voiceRowValue(form.voice)}
            chevron
            onPress={() => setPickingVoice(true)}
          />
        </Group>
```

- `<FacePickerSheet … />` 之后加：

```tsx
      <VoicePickerSheet
        visible={pickingVoice}
        agentId={agentId}
        name={form.name}
        description={form.description}
        picked={form.voice}
        agents={ws.agents}
        onPick={(voice) => setForm({ ...form, voice })}
        onClose={() => setPickingVoice(false)}
      />
```

- [ ] **Step 5: `mobile/src/ui.tsx` 的 `chevron` 注释**

`Row` 的 props 里

```ts
  /** 有下一层可去。只在真的会推进一屏时给 —— 它是个承诺 */
  chevron?: boolean;
```

换成

```ts
  /** 有下一层可去：推进一屏，或者拉起一张选择表（「说话的声音」那一行）。只在真的有下一层时给 —— 它是个承诺 */
  chevron?: boolean;
```

- [ ] **Step 6: 类型检查 + 门禁**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npm --prefix mobile run typecheck && npx vitest run tests/architecture.test.ts`
Expected: 全过（手机端只 import 了 `src/shared/**`）

然后全量门禁：`cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`
Expected: `GATE_EXIT=0`

- [ ] **Step 7: 提交**

message：

```
feat(mobile): 智能体设置里挑「说话的声音」——点一行就换成它并念一句（#1356 A4b）

设置页多一行「说话的声音」（右边写「自动」或那一档的名字），拉起一张「自动」+ 六档的表。
点一行只改表单那一格（按「存」才落库，同换形象），同时念一句它自己的话：合成走电话那同一个
TTS 客户端、放音走同一个原生放音器，表开着时同一句只合成一次；再点正在念的那一行 = 停，
换一行 / 收起 / 离开都先停上一段，慢的旧请求后到时作废。念不了（Expo Go、正在听电话、
订阅没开……）时只换不念，页脚说为什么；念不出来那一行红字说原因。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add mobile/src/chrome/RowGlyphs.tsx mobile/src/voice/voiceStore.ts mobile/src/agent/VoicePickerSheet.tsx mobile/src/agent/AgentSettingsScreen.tsx mobile/src/ui.tsx
```
然后单独一条 `git commit -F .superpowers/commit-msg.txt`。

---

### Task 6: 文档——ADR-0322、AGENTS.md 索引、手机 README

**Files:**
- Create: `docs/adr/0322-每只智能体可以挑说话的声音-库里存我们自己的键-挑过的先占.md`
- Modify: `AGENTS.md`（「Where to find things」里 A5 那一行之后加一行）
- Modify: `mobile/README.md`（A5 那一段之后加 A4b 一段）

**Interfaces:** 无（纯文档）。**ADR 号在合并时认领**（项目 ADR-0074）：先 `ls docs/adr | tail -3` 确认 0322 还没被占；被占了就用 `max + 1`，文件名、标题与下面两处引用一起改。

- [ ] **Step 1: 写 ADR**

新文件 `docs/adr/0322-每只智能体可以挑说话的声音-库里存我们自己的键-挑过的先占.md`：

```markdown
# ADR-0322：每只智能体可以挑「说话的声音」——库里存我们自己的键，挑过的先占

- 状态：已采纳（2026-09-27）
- 关联：#1372（#1356 A4b）；ADR-0271（团队语音通话，音色按 agent_id 派生）；ADR-0320（手机端语音通话）；#1007 / migration 0027（头像可自选，同一个形状的先例）
- spec：`docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §5.7、§10 第 93–99 条、§11 第 9 条

## 背景

ADR-0271 起每只智能体的声音按 agent_id 从 12 个 MiniMax 音色里派生，没有一格能改。#1321 的 demo 在智能体设置里画了「说话的声音」一行 + 六档的表（清亮 / 温和 / 沉稳 / 干脆 / 少年 / 播音），spec §5.7 把它留给「`workspace_agents` 加一列 + ADR」、六档对哪六个音色「届时定」；A4 落地时维护者定「挑声音另开一片」（spec §11 第 7 条）。2026-09-27 维护者看过多方向 demo（13 个候选各念同一句话的真样音）后全按推荐定。

## 决定

1. **存在库里**：`workspace_agents.voice text`（可空，migration 0042）。只存在本机会让同一只智能体在两台设备上两个声音——群语音里靠声音分人，这条判据两端只能有一份。
2. **存我们自己的键，不存 MiniMax 的音色 id**：`qing / wen / chen / gan / shao / bo`，对到哪个音色写在 `src/shared/agentVoice.ts` 的 `AGENT_VOICE_CHOICES`——换一档背后的音色只改这张表，不用跑库。DB 约束只管形状（`^[a-z]{1,16}$`），不写死这六个（同 0027 不写死 13 张头像）。null / 缺席 / 认不出的键 = 没挑过 = 照旧派生，存量一只都不换声音。
3. **六档对应**（维护者定用默认）：清亮 = 温暖闺蜜、温和 = 成熟女性、沉稳 = 温润男声、干脆 = 精英青年、少年 = 青年大学生、播音 = 电台男主播，六个都在派生池里。默认是拿 13 个候选各念同一句话、量音高与语速对的（同一句 98–271 Hz、每秒 3.2–4.9 字）。管理员没挑过时固定那一个（沉稳高管）不进六档。
4. **挑过的先占，没挑过的派生时让开**：`agentVoiceIds` 先放挑过的（在派生池里占位），再按名单顺序派没挑过的、撞了往后挪——同一场电话里不撞声音。两只都挑同一档由人负责，表里那一行写出「「开发」也是这个声音」。
5. **表是「自动」+ 六档，点一行 = 换成它 + 念一句它自己的话**（「我是{名字}，{职责第一句}。」）：iOS 挑铃声的手势；试听走 `/llm/v1/speech`、听的人付（同 ADR-0271），表开着时同一句只合成一次。念不了（没有原生模块、正在听电话、订阅没开 / 扣款没成功 / 网关不供语音）时只换不念，页脚说为什么。挑完回设置页，按「存」才落库（同换形象）。
6. **桌面照读、不给挑**（维护者定）：桌面群语音读这一格，要挑去手机。表的判据在 shared（`src/shared/agentVoicePicker.ts`），桌面哪天要，只差一层界面。
7. **读是单独一条容错查询**（`fetchAgentVoices`），不拼进主 select：0042 没跑时一格都读不到 = 全按派生，名册照常（同 `fetchWorkspaceKind` / `fetchSandboxApproval`，ADR-0223 部署顺序那条教训）。库还没升级时带着声音按「存」，说「服务端还没升级」（`VOICE_NOT_READY`），告诉人怎么先存别的。

## 否决

- **只存在本机**：两台设备两个声音。
- **存 MiniMax 的音色 id**：换音色要跑库，旧行指着的 id 还得迁移。
- **只有六档（派生池缩成这六个）**：存量每只换一次声音；六个比十二个容易撞。
- **十三个全列**：推翻 demo 已过的六档；名字是 MiniMax 的官方名（「御姐」「闺蜜」），不是在描述声音。
- **行尾 ▶ 单独试听**：每行多一颗钮、行尾挤；点哪个响哪个是 iOS 挑铃声的现成手势。
- **试听免费**（网关开一条不记账的路）：要一个新端点和一道防刷的闸，而一句不到 0.1 美分。
- **拼进主 select**：0042 没跑时整个名册读不出来。

## 代价

- 给 A 挑了一个声音后，恰好派到这个声音的 B 会换一次声音（同头像那条代价）。
- 每次读名册多一条查询（容错读的价钱，同 kind / sandbox_approval）。
- 六档的描述是 demo 的字，按量出来的音高 / 语速对过，「句尾上扬」这类没有逐个核实。
- 桌面不能挑。
- 要跑一次库（0042）；没跑时挑了存不进去。
- 真机一次没跑过（试听要开发版 + 登录）。

## 推翻前提

- MiniMax 下线其中某个音色：改 `AGENT_VOICE_CHOICES` 那一行，不用跑库。
- 桌面要能挑：`agentVoicePicker.ts` 现成，只差界面。
- 要让人上传或克隆声音：那不是这张表装得下的东西，另判。
```

- [ ] **Step 2: `AGENTS.md` 索引一行**

`grep -n "mobileAccount.ts" AGENTS.md` 找到 A5 那一行（以 `` - `src/shared/mobileAccount.ts` / `src/shared/mobileMachine.ts` `` 开头），在它**后面**另起一行加：

```markdown
- `src/shared/agentVoice.ts` 的 `AGENT_VOICE_CHOICES` / `src/shared/agentVoicePicker.ts` / `mobile/src/agent/VoicePickerSheet.tsx` / `supabase/migrations/0042_*.sql` — **每只智能体可以挑「说话的声音」**（#1356 A4b，#1372，ADR-0322）：`workspace_agents.voice` 存我们自己的键（六档），对到哪个 MiniMax 音色写在 shared 那张表里——换音色不用跑库；null / 认不出的键照旧按 agent_id 派生（存量不换声音）。**挑过的先占**，没挑过的派生时让开，同一场电话里不撞声音。读是单独一条容错查询（`fetchAgentVoices`，0042 没跑时全按派生、名册照常）。手机设置页一行 + 一张「自动」+ 六档的表，点一行就换成它并念一句它自己的话（走订阅额度，表开着时同一句只合成一次）；桌面照读、不给挑。**要跑 0042 才存得进去**；真机一次没跑过
```

- [ ] **Step 3: `mobile/README.md`**

三处，照原文改（先 `grep -n` 找到那几行）：

1. 第 5 行那一段里 `A5 做全了账号页（额度两扇窗、订阅、这周用了多少、它们共用的一台电脑、设置）与名册搜索的记忆那一半；` 之后插入：`A4b 让每只智能体可以挑说话的声音（智能体设置里那一行，库要跑 0042 才存得进去）；`
2. 目录清单里 `` - `src/agent/`：智能体设置 +「换个形象」与「新建智能体」两张抽屉（共用 `FaceWall.tsx` 那面脸墙） `` 那一行末尾加：`；「说话的声音」那张表（`VoicePickerSheet.tsx`，A4b）`
3. `### 语音通话要开发版（A4）` 那一节里 `**Expo Go 里 app 照常跑，只是没有电话钮**；要打电话得装开发版：` 这一行**之前**另起一行加：`挑「说话的声音」（A4b）的试听也走这个原生模块：Expo Go 里照样能挑、能存，只是点了不念。`

- [ ] **Step 4: 门禁**

Run: `cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && npm test > .superpowers/gate.log 2>&1; echo "GATE_EXIT=$?"; grep -E "Test Files|Tests  |error TS" .superpowers/gate.log`
Expected: `GATE_EXIT=0`（`tests/docs/adrNumbers.test.ts` 会查 0322 不撞号、不跳号）

- [ ] **Step 5: 提交**

message：

```
docs: ADR-0322 挑声音——库里存我们自己的键、挑过的先占；索引与手机 README 跟上（#1356 A4b）

把 2026-09-27 维护者全按推荐定的那几条落成 ADR：存在库里一列、存键不存 MiniMax 的 id、
六档的默认对应、挑过的先占、「自动」+ 六档与点一行就念、桌面照读不给挑、单独一条容错读。
否决的六条与代价写在里面。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
cd /Users/stanyan/Github/Mr_Otto/.claude/worktrees/mobile-a4b-voice-picker-f65baf && git add "docs/adr/0322-每只智能体可以挑说话的声音-库里存我们自己的键-挑过的先占.md" AGENTS.md mobile/README.md
```
然后单独一条 `git commit -F .superpowers/commit-msg.txt`。
