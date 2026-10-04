# 智能体语音活人感 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通话里智能体的话读出来有起伏：模型在段首写一个括注情绪，界面剥掉、日志留着，TTS 带 `emotion` + 按情绪微调 speed/vol、句间补真人停顿、文本归一化，提示词加口头连接词。

**Architecture:** 一份 shared 纯逻辑 `voiceProsody.ts`（记号解析 / 韵律表 / 归一化 / 停顿档）；出声那条路（`voiceFeed` → `voicePlayer` → `ttsClient` → edge `ttsUpstream`）多带一格 `emotion`；显示那条路四处各过一遍 `stripEmotionTag`；edge 上游参数被拒时去掉 emotion 同一个 hold 内重试一次。事件日志、协议位一个字不动。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes` 开着：可选属性不能显式赋 `undefined`，用 `...(x ? { x } : {})`）、vitest（测试在 `tests/` 镜像 `src/`）、Cloudflare Worker（edge）、Electron IPC、Expo。

**Spec:** `docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md`（Task #1515）

## Global Constraints

- 事件日志 append-only，`assistant_message.content` 原文落盘（带括注）；剥是投影（Hard rule）。
- 渲染进程只经 `ShellBridge` 与后端通信；工具 / shared 不 import fs / child_process。
- `pitch` 永远 0；`emotion_intensity` 是 edge 常量（先 1.0）；`neutral` 当成不带 emotion。
- 不带 emotion 的请求体（客户端 → edge、edge → MiniMax）**逐字节同今天**。
- 门禁 `npm test`（`tsc --noEmit` + 手机端 tsc + vitest）。内循环用 `npx vitest run <file>`。
- commit message 写 why，结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 全部在当前 worktree / 分支 `claude/otto-agent-voice-naturalness-8a0d11` 上做，不 checkout 别的分支。
- 与 spec 的一处偏差（本计划定的）：句间停顿档位 `GAP_MS = { sentence: 230, speaker: 460 }`——「换说话人」代替「换段」做 460 那一档，因为播放器手上有 agentId、没有段边界；真人 p90 那一档本来就是「话轮切换」。
- 兼容矩阵脚本放 `scripts/tts-emotion-matrix.mjs`（spec 写的 `.superpowers/voice-smoke.mjs` 不在仓库里）。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/shared/voiceProsody.ts` | **新**：情绪括注解析 / 剥除、emotion→speed/vol、归一化、停顿档 | Task 1 |
| `src/shared/voiceFeed.ts` | 出声单位带 emotion；`spokenText` 剥记号 + 归一化 | Task 2 |
| `src/shared/voicePlayer.ts` | `speak` 第三参 emotion；句间停顿 | Task 3 |
| `src/shared/ttsClient.ts` | 请求体多 `emotion / speed / vol` | Task 4 |
| `src/shared/voiceSession.ts` / `shellBridge.ts` / `src/preload/index.ts` / `src/main/index.ts` / `src/renderer/src/store.ts` | 桌面把 emotion 从队列传到网关 | Task 5 |
| `src/shared/speakCache.ts` / `mobile/src/voice/voiceStore.ts` | 手机同一条路；缓存键带 emotion | Task 6 |
| `services/edge/src/ttsUpstream.ts` | 收 emotion / vol；写 `emotion_intensity`；回包带 code | Task 7 |
| `services/edge/src/llmGateway.ts` | emotion 被拒 → 去掉重试一次 | Task 8 |
| `src/renderer/src/components/CloudSessionPage.tsx` / `src/shared/mobileChat.ts` / `src/shared/sessionLast.ts` / `src/shared/cloudTimeline.ts` | 显示剥记号 | Task 9 |
| `src/session/deriveMessages.ts` | 通话块加三句 | Task 10 |
| `scripts/tts-emotion-matrix.mjs` / `docs/voice-emotion-compat.md` | 真机兼容矩阵（维护者跑） | Task 11 |
| `docs/adr/0355-*.md` / `docs/where-to-find-things.md` / `CONTEXT.md` | 决策 / 代码地图 / 词汇 | Task 12 |

---

### Task 1: `voiceProsody.ts` —— 记号 / 韵律 / 归一化 / 停顿档

**Files:**
- Create: `src/shared/voiceProsody.ts`
- Test: `tests/shared/voiceProsody.test.ts`

**Interfaces:**
- Produces:
  - `type SpeechEmotion = "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised"`
  - `SPEECH_EMOTIONS: readonly SpeechEmotion[]`
  - `parseEmotionTag(bubble: string): { emotion: SpeechEmotion | null; text: string }`
  - `stripEmotionTag(bubble: string): string`（一段）
  - `stripEmotionTags(content: string): string`（整条回复，每个段首各剥一次）
  - `emotionTagLiteral(e: SpeechEmotion): string`（`"（笑）"` 这种全角规范形）
  - `prosodyFor(emotion: SpeechEmotion | null): { speed: number; vol: number }`
  - `normalizeSpoken(text: string): string`
  - `GAP_MS: { readonly sentence: 230; readonly speaker: 460 }`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/voiceProsody.test.ts
// 情绪括注 / 韵律 / 归一化 / 停顿档的纯逻辑（#1515）。数值来自 ai-podcast 的 delivery_recipe.json
// （32 期真人节目蒸馏）；记号词表是维护者定的六个。
import { describe, expect, it } from "vitest";
import {
  GAP_MS, SPEECH_EMOTIONS, emotionTagLiteral, normalizeSpoken, parseEmotionTag, prosodyFor, stripEmotionTag, stripEmotionTags,
} from "../../src/shared/voiceProsody.js";

describe("parseEmotionTag：只认段首、只认白名单", () => {
  it("六个记号各对一档；全角 / 半角括号都认；记号后的空白一起剥", () => {
    expect(parseEmotionTag("（笑）我弄好了。")).toEqual({ emotion: "happy", text: "我弄好了。" });
    expect(parseEmotionTag("(惊) 这么快？")).toEqual({ emotion: "surprised", text: "这么快？" });
    expect(parseEmotionTag("（叹）没赶上。")).toEqual({ emotion: "sad", text: "没赶上。" });
    expect(parseEmotionTag("（气）又挂了。")).toEqual({ emotion: "angry", text: "又挂了。" });
    expect(parseEmotionTag("（怕）别删库。")).toEqual({ emotion: "fearful", text: "别删库。" });
    expect(parseEmotionTag("（嫌）这代码。")).toEqual({ emotion: "disgusted", text: "这代码。" });
  });
  it("词表外的括注是正文：不剥、不传情绪", () => {
    expect(parseEmotionTag("（笑死）我弄好了。")).toEqual({ emotion: null, text: "（笑死）我弄好了。" });
    expect(parseEmotionTag("（好）我去改。")).toEqual({ emotion: null, text: "（好）我去改。" });
  });
  it("段中的括注不认；没有括注原样回", () => {
    expect(parseEmotionTag("他（笑）说行。")).toEqual({ emotion: null, text: "他（笑）说行。" });
    expect(parseEmotionTag("我弄好了。")).toEqual({ emotion: null, text: "我弄好了。" });
  });
  it("段首空白之后的括注也认", () => {
    expect(parseEmotionTag("  （笑）行。")).toEqual({ emotion: "happy", text: "行。" });
  });
});

describe("stripEmotionTag / stripEmotionTags", () => {
  it("一段：剥掉段首记号；整条：每个段首各剥一次，段间空行原样保留", () => {
    expect(stripEmotionTag("（笑）行。")).toBe("行。");
    expect(stripEmotionTags("（笑）第一段。\n\n（叹）第二段。\n\n第三段。")).toBe("第一段。\n\n第二段。\n\n第三段。");
    expect(stripEmotionTags("（笑死）不是记号。\n\n他（笑）说。")).toBe("（笑死）不是记号。\n\n他（笑）说。");
  });
});

describe("emotionTagLiteral：规范形是全角", () => {
  it("六档各回一个全角括注，parse 回去是同一档", () => {
    for (const e of SPEECH_EMOTIONS) expect(parseEmotionTag(emotionTagLiteral(e) + "x").emotion).toBe(e);
    expect(emotionTagLiteral("happy")).toBe("（笑）");
  });
});

describe("prosodyFor：播客 recipe 的三档", () => {
  it("高唤起快 + 响；低唤起慢 + 轻；其余基准；没有 pitch 这一格", () => {
    expect(prosodyFor("happy")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("surprised")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("angry")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("sad")).toEqual({ speed: 0.88, vol: 0.92 });
    expect(prosodyFor("fearful")).toEqual({ speed: 0.88, vol: 0.92 });
    expect(prosodyFor("disgusted")).toEqual({ speed: 1, vol: 1 });
    expect(prosodyFor(null)).toEqual({ speed: 1, vol: 1 });
  });
});

describe("normalizeSpoken：搬播客 normalize.ts", () => {
  it("独立的 AI / Ai 收口成大写 AI；词内 ai、SAID 不碰", () => {
    expect(normalizeSpoken("Ai 行业和 ai 不一样，SAID 不动")).toBe("AI 行业和 ai 不一样，SAID 不动");
    expect(normalizeSpoken("OpenAI 的 AI")).toBe("OpenAI 的 AI");
  });
  it("四位年份逐位读；五位数字、没跟「年」的不碰", () => {
    expect(normalizeSpoken("2026年发布，2026 年再见")).toBe("二零二六年发布，二零二六年再见");
    expect(normalizeSpoken("编号 20261 年")).toBe("编号 20261 年");
    expect(normalizeSpoken("2026 版")).toBe("2026 版");
  });
});

describe("GAP_MS", () => {
  it("句间 230、换说话人 460（真人停顿 p50 / p90）", () => {
    expect(GAP_MS).toEqual({ sentence: 230, speaker: 460 });
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/voiceProsody.test.ts`
Expected: FAIL，`Cannot find module '../../src/shared/voiceProsody.js'`

- [ ] **Step 3: 写实现**

```ts
// src/shared/voiceProsody.ts
// voiceProsody —— 智能体说话的活人感那几件纯逻辑（#1515，ADR-0355）。三端共用、零 IO。
//
// 情绪从哪来：模型在段首写一个括注（（笑）（惊）（叹）（气）（怕）（嫌）），通话提示词只给这六个。
// 记号**落日志不落界面**：显示路径各剥一次（stripEmotionTag），出声路径解出来进 voice_setting.emotion。
// 只认段首、只认白名单：词表外的括注（（笑死））是模型说的话，剥它等于改它的话。
//
// 数值来自 ~/Github/ai-podcast 的 data/refs/delivery_recipe.json（32 期真人小宇宙闲聊蒸馏）：
// 高唤起（笑 / 惊 / 气）快一点响一点，低唤起（叹 / 怕）慢一点轻一点；真人停顿中位 0.23s、p90 0.55s。
// pitch 永远 0——移调 = 换共振峰 = 换一个人，这个文件连 pitch 这一格都不回。

export type SpeechEmotion = "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised";

export const SPEECH_EMOTIONS: readonly SpeechEmotion[] = ["happy", "sad", "angry", "fearful", "disgusted", "surprised"];

/** 括注里的字 → MiniMax 的 emotion。维护者定的六个；少给选项比多给准 */
export const EMOTION_TAGS: Readonly<Record<string, SpeechEmotion>> = {
  笑: "happy", 惊: "surprised", 叹: "sad", 气: "angry", 怕: "fearful", 嫌: "disgusted",
};

const LITERAL: Readonly<Record<SpeechEmotion, string>> = {
  happy: "（笑）", surprised: "（惊）", sad: "（叹）", angry: "（气）", fearful: "（怕）", disgusted: "（嫌）",
};

/** 段首：可选空白 + 全角或半角括号里 1–2 个非括号非空白字 + 可选空白 */
const TAG_AT_START = /^\s*[（(]([^()（）\s]{1,2})[）)][ \t]*/;

export function parseEmotionTag(bubble: string): { emotion: SpeechEmotion | null; text: string } {
  const m = TAG_AT_START.exec(bubble);
  if (m === null) return { emotion: null, text: bubble };
  const emotion = EMOTION_TAGS[m[1]!];
  if (emotion === undefined) return { emotion: null, text: bubble };
  return { emotion, text: bubble.slice(m[0].length) };
}

export function stripEmotionTag(bubble: string): string {
  return parseEmotionTag(bubble).text;
}

/** 整条回复：每个段首（开头、或空行之后）各剥一次；段间的空行一个字节不动 */
const TAG_AT_PARAGRAPH = /(^|\n[ \t]*\n)([ \t]*)[（(]([^()（）\s]{1,2})[）)][ \t]*/g;

export function stripEmotionTags(content: string): string {
  return content.replace(TAG_AT_PARAGRAPH, (whole, sep: string, indent: string, word: string) =>
    EMOTION_TAGS[word] === undefined ? whole : `${sep}${indent}`
  );
}

export function emotionTagLiteral(e: SpeechEmotion): string {
  return LITERAL[e];
}

const HIGH_AROUSAL = new Set<SpeechEmotion>(["happy", "surprised", "angry"]);
const LOW_AROUSAL = new Set<SpeechEmotion>(["sad", "fearful"]);

export function prosodyFor(emotion: SpeechEmotion | null): { speed: number; vol: number } {
  if (emotion !== null && HIGH_AROUSAL.has(emotion)) return { speed: 1.12, vol: 1.12 };
  if (emotion !== null && LOW_AROUSAL.has(emotion)) return { speed: 0.88, vol: 0.92 };
  return { speed: 1, vol: 1 };
}

// 归一化（搬 ai-podcast src/tts/normalize.ts）：MiniMax 把小写变体「Ai」念成「A」；四位年份默认念
// 「两千零二十六」，播报口径是逐位。只作用于送去合成的文本，显示不动。
const AI_TOKEN = /(?<![A-Za-z0-9])(?:AI|Ai)(?![A-Za-z0-9])/g;
const YEAR_TOKEN = /(?<!\d)(\d{4})(?!\d)\s*年/g;
const DIGIT_CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

export function normalizeSpoken(text: string): string {
  return text
    .replace(AI_TOKEN, "AI")
    .replace(YEAR_TOKEN, (_m, y: string) => `${Array.from(y, (d) => DIGIT_CN[Number(d)]!).join("")}年`);
}

/** 句间 / 换说话人之间至少隔这么久（毫秒）。真人 p50 / p90；>1s 的停顿真人只占 1%，不设更长的档 */
export const GAP_MS = { sentence: 230, speaker: 460 } as const;
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/voiceProsody.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add src/shared/voiceProsody.ts tests/shared/voiceProsody.test.ts
git commit -m "feat(shared): voiceProsody——段首情绪括注解析、emotion→speed/vol、TTS 归一化、停顿档（#1515）

数值搬 ai-podcast 从 32 期真人节目蒸馏出的 delivery_recipe.json；记号只认段首白名单六个，
词表外的括注是模型说的话，剥它等于改它的话。pitch 这一格连接口都不回：移调等于换人。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `voiceFeed.ts` —— 出声单位带 emotion

**Files:**
- Modify: `src/shared/voiceFeed.ts`（`spokenText`、`Utterance`、`splitSpoken`、`spokenUnits`、`take`）
- Test: `tests/shared/voiceFeed.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseEmotionTag / emotionTagLiteral / normalizeSpoken / SpeechEmotion`
- Produces:
  - `interface Utterance { agentId: string; text: string; emotion: SpeechEmotion | null }`
  - `interface SpokenUnit { text: string; emotion: SpeechEmotion | null }`
  - `spokenUnits(content: string): SpokenUnit[]`（原来回 `string[]`）
  - `splitSpoken(text): string[]` 不变形状，但带记号的段每一句的键前面都拼回规范形括注（`（笑）第一句。`）
  - `spokenText(key)` 现在先剥记号、再剥 Markdown、最后归一化

- [ ] **Step 1: 改既有断言 + 加新断言**

`tests/shared/voiceFeed.test.ts` 里所有 `toEqual([{ agentId: "a", text: "..." }])` 形状的 Utterance 断言都要加 `emotion: null`（文件里逐个找 `{ agentId:` 加上）。然后在 `describe("spokenText…")` 后面加：

```ts
describe("情绪括注（#1515）：段首记号进 emotion、键里留着、送合成的字节剥掉", () => {
  it("splitSpoken：带记号的段每一句的键都带规范形括注；不带的段键不变；半角写法也归到全角", () => {
    expect(splitSpoken("（笑）弄好了。你看一眼。\n\n第二段。")).toEqual(["（笑）弄好了。", "（笑）你看一眼。", "第二段。"]);
    expect(splitSpoken("(惊) 这么快？")).toEqual(["（惊）这么快？"]);
  });
  it("spokenText：剥记号、剥 Markdown、归一化 AI 与年份", () => {
    expect(spokenText("（笑）**Ai** 2026年就这样。")).toBe("AI 二零二六年就这样。");
  });
  it("spokenUnits：回 {text, emotion}，剥完为空的不要", () => {
    expect(spokenUnits("（叹）没赶上。\n\n```\nx\n```\n\n行。")).toEqual([
      { text: "没赶上。", emotion: "sad" },
      { text: "行。", emotion: null },
    ]);
  });
  it("feedDelta / feedEvent：Utterance 带 emotion；同一句带不带情绪是两个单位（已读判据是键）", () => {
    let s: VoiceFeedState = EMPTY_VOICE_FEED;
    let r = feedDelta(s, P, "a", "（笑）弄好了。\n\n没");
    expect(r.out).toEqual([{ agentId: "a", text: "弄好了。", emotion: "happy" }]);
    s = r.state;
    r = feedEvent(s, P, 0, chat("a", 7, "（笑）弄好了。\n\n弄好了。"));
    expect(r.out).toEqual([{ agentId: "a", text: "弄好了。", emotion: null }]);
  });
  it("词表外的括注当正文念出来", () => {
    expect(spokenUnits("（笑死）行。")).toEqual([{ text: "（笑死）行。", emotion: null }]);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/voiceFeed.test.ts`
Expected: 新加的全红（`emotion` 不存在 / 键里没括注）；改过的旧断言也红（Utterance 还没有 `emotion`）

- [ ] **Step 3: 改实现**

`src/shared/voiceFeed.ts`：

顶部 import 加：
```ts
import { emotionTagLiteral, normalizeSpoken, parseEmotionTag, type SpeechEmotion } from "./voiceProsody.js";
```

`spokenText` 开头（`let text = content;` 之后、围栏处理之前）加一行，末尾归一化：
```ts
export function spokenText(content: string): string {
  // 段首情绪括注（#1515）：它是给 TTS 的 emotion，不是话；键里留着它是为了已读判据与缓存键区分带不带情绪
  let text = parseEmotionTag(content).text;
  // 关上的围栏整段删；剩下一个没关上的，从它起全删
  text = text.replace(/(^|\n)\s*(```|~~~)[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "$1");
  …（原有各行不动）…
  return normalizeSpoken(lines.filter((l) => l !== "").join("\n"));
}
```

`Utterance` 加一格：
```ts
export interface Utterance {
  agentId: string;
  text: string;
  /** 这一句所在段的段首括注解出来的情绪；没写 = null（平读） */
  emotion: SpeechEmotion | null;
}

export interface SpokenUnit {
  text: string;
  emotion: SpeechEmotion | null;
}
```

`splitSpoken` 改成按段解记号再切句、把规范形括注拼回每一句的键：
```ts
/** 一条回复 → 要读的单位（键）：先按空行切段（同气泡），段内再按句。带情绪括注的段，每一句的键前面
    都拼回**规范形**括注（（笑）第一句。 / （笑）第二句。）——已读判据与手机缓存键都按键比，同一句
    带不带情绪是两个单位；送合成的字节由 spokenText 剥。围栏整段一个单位、不解记号 */
export function splitSpoken(text: string): string[] {
  return splitBubbles(text).flatMap((bubble) => {
    if (FENCE.test(bubble)) return [bubble];
    const { emotion, text: body } = parseEmotionTag(bubble);
    const tag = emotion === null ? "" : emotionTagLiteral(emotion);
    return splitSentences(body).map((s) => tag + s);
  });
}

export function spokenUnits(content: string): SpokenUnit[] {
  return splitSpoken(content)
    .map((key) => ({ text: spokenText(key), emotion: parseEmotionTag(key).emotion }))
    .filter((u) => u.text !== "");
}
```
（`FENCE` 常量目前定义在 `splitSpoken` 下面，把它挪到 `splitSpoken` 上面，否则 TDZ 不报错但读着别扭；它是 `const` 正则，挪动零风险。）

`take()` 里 `out.push`：
```ts
    for (const b of fresh) {
      const text = spokenText(b);
      if (text !== "") out.push({ agentId, text, emotion: parseEmotionTag(b).emotion });
    }
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/voiceFeed.test.ts`
Expected: PASS。再跑 `npx vitest run tests/shared` 看谁还引用 `spokenUnits` 的旧形状（手机 `voiceStore` 在 Task 6 改；`tsc` 到 Task 6 之前会红，预期内）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/voiceFeed.ts tests/shared/voiceFeed.test.ts
git commit -m "feat(shared): 出声单位带 emotion——段首括注解出来、键里留着、送合成的字节剥掉并归一化（#1515）

已读判据与缓存键按键比，所以同一句带不带情绪是两个单位；spokenText 多两步：剥记号在最前、
归一化在最后（AI 大写、年份逐位，播客听出来的两个发音坑）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `voicePlayer.ts` —— emotion 透传 + 句间停顿

**Files:**
- Modify: `src/shared/voicePlayer.ts`
- Test: `tests/shared/voicePlayer.test.ts`

**Interfaces:**
- Consumes: Task 1 `GAP_MS`、`SpeechEmotion`
- Produces:
  - `VoicePlayerDeps.speak: (text: string, voiceId: string, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>`
  - `VoicePlayerDeps.now?: () => number`、`VoicePlayerDeps.wait?: (ms: number) => Promise<void>`（测试注入；缺省 `Date.now` / `setTimeout`）
  - `enqueue(u: { agentId; text; voiceId; emotion: SpeechEmotion | null })`

- [ ] **Step 1: 改 harness + 加断言**

`tests/shared/voicePlayer.test.ts` 的 `harness`：`speak` 收第三参并记下；加 `now` / `wait` 注入；所有 `player.enqueue({ agentId, text, voiceId })` 调用加 `emotion: null`。

```ts
function harness(speakImpl?: (text: string) => VoiceSpeakResult) {
  const speakCalls: string[] = [];
  const emotions: (string | null)[] = [];
  const waits: number[] = [];
  let clock = 0;
  const audios: FakeAudio[] = [];
  const states: VoicePlayerState[] = [];
  const speak = vi.fn(async (text: string, _voiceId: string, emotion: SpeechEmotion | null): Promise<VoiceSpeakResult> => {
    speakCalls.push(text);
    emotions.push(emotion);
    await Promise.resolve();
    return speakImpl ? speakImpl(text) : { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
  });
  const player = new VoicePlayer({
    speak,
    createAudio: () => { /* 原样 */ },
    onChange: (s) => states.push(s),
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; },
  });
  return { player, speak, speakCalls, emotions, waits, audios, states, tick: (ms: number) => { clock += ms; } };
}
```
（import 加 `import type { SpeechEmotion } from "../../src/shared/voiceProsody.js";`）

新 describe：
```ts
describe("情绪与停顿（#1515）", () => {
  it("emotion 原样传给 speak", async () => {
    const { player, emotions } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: "happy" });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    expect(emotions).toEqual(["happy", null]);
  });
  it("第一句不等；同一只的下一句至少隔 230ms；换说话人至少隔 460ms", async () => {
    const { player, audios, waits } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "b", text: "三", voiceId: "v", emotion: null });
    await flush();
    expect(waits).toEqual([]);
    audios[0]!.ended();
    await flush();
    expect(waits).toEqual([230]);
    audios[1]!.ended();
    await flush();
    expect(waits).toEqual([230, 460]);
  });
  it("停顿扣掉已经等掉的：下一句合成晚回来 300ms，230 的档不再补", async () => {
    let release: (() => void) | null = null;
    const { player, audios, waits, tick } = harness();
    const slow = vi.fn(async (text: string): Promise<VoiceSpeakResult> => {
      if (text === "二") await new Promise<void>((r) => { release = r; });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
    });
    // 换掉 speak：第二句挂着不回
    (player as unknown as { deps: { speak: typeof slow } }).deps.speak = slow;
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    audios[0]!.ended();
    await flush();
    tick(300);
    release!();
    await flush();
    expect(waits).toEqual([]);
    expect(audios).toHaveLength(2);
  });
  it("stop() 之后等着的停顿不再起播", async () => {
    const { player, audios } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    audios[0]!.ended();
    player.stop();
    await flush();
    expect(audios).toHaveLength(1);
  });
});
```
（第三条用私有字段穿透是因为 harness 的 speak 在构造时就定了；若实现里 `deps` 是 `private readonly`，TS 上这种 cast 合法。也可以把 `speakImpl` 改成能返回 Promise——两种都行，选一种写到底。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/voicePlayer.test.ts`
Expected: 新四条红；旧的因 `enqueue` 多了一格仍绿（结构性多一格不影响）

- [ ] **Step 3: 改实现**

```ts
import { GAP_MS, type SpeechEmotion } from "./voiceProsody.js";

export interface VoicePlayerDeps {
  speak: (text: string, voiceId: string, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>;
  createAudio: (bytes: Uint8Array) => PlayerAudio;
  onChange: (s: VoicePlayerState) => void;
  /** 时钟与等待（#1515 句间停顿）：测试注入；缺省真时钟 */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

interface Item {
  agentId: string;
  text: string;
  voiceId: string;
  emotion: SpeechEmotion | null;
  fetch: Promise<VoiceSpeakResult> | null;
}
```

类里加两格 + 两个口：
```ts
  /** 上一句播完的时刻与说话人（#1515）：下一句起播前至少隔 GAP_MS（扣掉等合成已经等掉的）。stop() 清 */
  private lastEnded: { at: number; agentId: string } | null = null;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: VoicePlayerDeps) {
    this.createAudio = deps.createAudio;
    this.now = deps.now ?? (() => Date.now());
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
```

`enqueue` 签名：`enqueue(u: { agentId: string; text: string; voiceId: string; emotion: SpeechEmotion | null }): void`（函数体不变）。

`stop()` 里加 `this.lastEnded = null;`。

`ensureFetch`：`this.deps.speak(item.text, item.voiceId, item.emotion)`。

`pump()` 在 `const result = await fetch;` 的两道 epoch / 队头判据之后、`this.queue.shift()` 之前插入停顿：
```ts
    const result = await fetch;
    if (epoch !== this.epoch) return;
    if (this.queue[0] !== head) return;
    // 句间停顿（#1515）：真人句间中位 0.23s、换人 p90 0.55s；合成晚回来的那段时间已经是停顿，只补差额
    if (this.lastEnded !== null && result.ok) {
      const gap = head.agentId === this.lastEnded.agentId ? GAP_MS.sentence : GAP_MS.speaker;
      const due = gap - (this.now() - this.lastEnded.at);
      if (due > 0) {
        await this.wait(due);
        if (epoch !== this.epoch) return;
        if (this.queue[0] !== head) return;
      }
    }
    this.queue.shift();
```

`done()` 里记下播完时刻：
```ts
    const done = (): void => {
      if (epoch !== this.epoch || this.current?.audio !== audio) return;
      this.lastEnded = { at: this.now(), agentId: head.agentId };
      this.current = null;
      this.emit();
      void this.pump();
    };
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/voicePlayer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/voicePlayer.ts tests/shared/voicePlayer.test.ts
git commit -m "feat(shared): 播放队列带 emotion、句间补真人停顿档（#1515）

一句播完立刻接下一句听着像念稿；真人句间中位 230ms、换人 460ms。合成晚回来的那段时间本来
就是停顿，只补差额——不然首句那三秒之后还要再等。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ttsClient.ts` —— 请求体多 `emotion / speed / vol`

**Files:**
- Modify: `src/shared/ttsClient.ts`
- Test: `tests/shared/ttsClient.test.ts`

**Interfaces:**
- Consumes: Task 1 `prosodyFor`、`SpeechEmotion`
- Produces: `TtsSpeakOpts.emotion?: SpeechEmotion | null`；带 emotion 时 body `{ model, text, voice_id, emotion, speed, vol }`，不带时三格不变

- [ ] **Step 1: 加断言**

```ts
  it("带 emotion（#1515）：请求体多 emotion / speed / vol，数值按 prosodyFor；不带时三格逐字节同以前", async () => {
    const { voice, fetchImpl } = make(() => new Response(new Uint8Array([1]), { status: 200 }));
    await voice.speak("行。", "v", { emotion: "sad" });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ model: "speech-2.8-turbo", text: "行。", voice_id: "v", emotion: "sad", speed: 0.88, vol: 0.92 });
    await voice.speak("行。", "v", { emotion: null });
    const [, init2] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]!;
    expect(JSON.parse(String(init2.body))).toEqual({ model: "speech-2.8-turbo", text: "行。", voice_id: "v" });
  });
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/ttsClient.test.ts`
Expected: FAIL（body 里没有 emotion）

- [ ] **Step 3: 改实现**

```ts
import { prosodyFor, type SpeechEmotion } from "./voiceProsody.js";

export interface TtsSpeakOpts {
  speechTicket?: string;
  /** 这一句的情绪（#1515）：带上时请求体多 emotion / speed / vol；null / 缺席 = 平读，三格请求体同以前 */
  emotion?: SpeechEmotion | null;
}
```
`speak` 里 body：
```ts
      const emotion = opts?.emotion ?? null;
      const body = emotion === null
        ? { model: route.model, text, voice_id: voiceId }
        : { model: route.model, text, voice_id: voiceId, emotion, ...prosodyFor(emotion) };
      …
          body: JSON.stringify(body),
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/ttsClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ttsClient.ts tests/shared/ttsClient.test.ts
git commit -m "feat(shared): ttsClient 带 emotion 时请求体多 emotion/speed/vol（#1515）

speed/vol 在客户端算：「叹气要慢一点」是产品判断，网关只校验范围。不带 emotion 时三格请求体
逐字节同以前，老 edge 收到也照旧。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 桌面把 emotion 从队列传到网关

**Files:**
- Modify: `src/shared/voiceSession.ts:51,124,149`、`src/shared/shellBridge.ts:1289`、`src/preload/index.ts:277`、`src/main/index.ts:3627`、`src/renderer/src/store.ts:1533`
- Test: `tests/shared/voiceSession.test.ts`

**Interfaces:**
- Consumes: Task 3 `VoicePlayerDeps.speak` 三参；Task 4 `TtsSpeakOpts.emotion`
- Produces: `VoiceSessionDeps.speak(text, voiceId, emotion: SpeechEmotion | null)`；`ShellBridge.teamVoiceSpeak(text, voiceId, emotion?: SpeechEmotion | null)`

- [ ] **Step 1: 改测试**

`tests/shared/voiceSession.test.ts` 的 `deps.speak` 收第三参并记下：
```ts
  const spoke: { text: string; voiceId: string; emotion: SpeechEmotion | null }[] = [];
  …
    speak: async (text, voiceId, emotion): Promise<VoiceSpeakResult> => {
      spoke.push({ text, voiceId, emotion });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
    },
```
（import `type SpeechEmotion`）。找一条已有的「终态补读」用例，在它的 assistant_message 正文前加 `（笑）`，断言 `spoke[0]!.emotion` 为 `"happy"`、`spoke[0]!.text` 不含 `（笑）`。文件里现有 `spoke` 的 `toEqual` 断言要加 `emotion: null`。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/voiceSession.test.ts`
Expected: FAIL（`emotion` 是 undefined）

- [ ] **Step 3: 改五处**

`src/shared/voiceSession.ts`：
```ts
export interface VoiceSessionDeps {
  speak(text: string, voiceId: string, emotion: SpeechEmotion | null): Promise<VoiceSpeakResult>;
  …
}
  const player = new VoicePlayer({
    speak: (text, voiceId, emotion) => deps.speak(text, voiceId, emotion),
```
`enqueue` 那一行不用改（`{ ...u, voiceId }` 已经把 `emotion` 带过去了）。import `type SpeechEmotion` from `./voiceProsody.js`。

`src/shared/shellBridge.ts:1289`：
```ts
  teamVoiceSpeak(text: string, voiceId: string, emotion?: SpeechEmotion | null): Promise<VoiceSpeakResult>;
```
（文件顶部 import `type SpeechEmotion`）

`src/preload/index.ts:277`：
```ts
  teamVoiceSpeak: (text, voiceId, emotion) => ipcRenderer.invoke(CHANNELS.teamVoiceSpeak, text, voiceId, emotion ?? null),
```

`src/main/index.ts:3627`：
```ts
  ipcMain.handle(CHANNELS.teamVoiceSpeak, (_e, text: string, voiceId: string, emotion: SpeechEmotion | null = null) =>
    teamVoice.speak(text, voiceId, { emotion }));
```
（import `type SpeechEmotion`；`TtsSpeakOpts.emotion` 允许 `null`，所以直接传）

`src/renderer/src/store.ts:1533`：
```ts
      speak: (text, voiceId, emotion) => window.otter.teamVoiceSpeak(text, voiceId, emotion),
```

- [ ] **Step 4: 跑，确认绿 + tsc**

Run: `npx vitest run tests/shared/voiceSession.test.ts && npx tsc --noEmit`
Expected: vitest PASS；tsc 只剩手机 / speakCache 那几处（Task 6 修）

- [ ] **Step 5: Commit**

```bash
git add src/shared/voiceSession.ts src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/renderer/src/store.ts tests/shared/voiceSession.test.ts
git commit -m "feat(desktop): 通话里每一句的 emotion 从播放队列一路传到网关请求（#1515）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 手机同一条路；`speakCache` 键带 emotion

**Files:**
- Modify: `src/shared/speakCache.ts`、`mobile/src/voice/voiceStore.ts:140,345-347`
- Test: `tests/shared/speakCache.test.ts`

**Interfaces:**
- Consumes: Task 2 `SpokenUnit`、`spokenUnits`；Task 3 三参 `speak`
- Produces: `SpeakFn = (text, voiceId, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>`；`SpeakCache.prefetch(units: readonly SpokenUnit[], voiceId, untilTs)`

- [ ] **Step 1: 改测试**

`tests/shared/speakCache.test.ts`：`fake().inner` 收第三参、键里带它；所有 `c.prefetch(["你好。", …], "v1", 100)` 改成 `c.prefetch([{ text: "你好。", emotion: null }, …], "v1", 100)`；所有 `c.speak("你好。", "v1")` 改成 `c.speak("你好。", "v1", null)`。加一条：
```ts
  it("同一句不同情绪是两个键（#1515）：预取的平读那句，带 happy 来要时不命中", async () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch([{ text: "你好。", emotion: null }], "v1", 100);
    expect(tagOf(await c.speak("你好。", "v1", "happy"))).toBe("v1|happy|你好。#2");
    expect(tagOf(await c.speak("你好。", "v1", null))).toBe("v1||你好。#1");
  });
```
（`fake` 的 inner 改成 `calls.push(\`${voiceId}|${emotion ?? ""}|${text}\`)`，`ok` 标签同形，旧用例的期望串跟着从 `v1|你好。#1` 改成 `v1||你好。#1`。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/speakCache.test.ts`
Expected: FAIL

- [ ] **Step 3: 改实现**

`src/shared/speakCache.ts`：
```ts
import type { VoiceSpeakResult } from "./shellBridge.js";
import type { SpokenUnit } from "./voiceFeed.js";
import type { SpeechEmotion } from "./voiceProsody.js";

export type SpeakFn = (text: string, voiceId: string, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>;

export interface SpeakCache {
  speak: SpeakFn;
  prefetch(units: readonly SpokenUnit[], voiceId: string, untilTs: number): void;
}

/** 键带情绪（#1515）：同一句平读与带（笑）是两段不同的音频 */
const keyOf = (text: string, voiceId: string, emotion: SpeechEmotion | null): string => `${voiceId}\n${emotion ?? ""}\n${text}`;

export function createSpeakCache(inner: SpeakFn, now: () => number = Date.now): SpeakCache {
  const entries = new Map<string, { p: Promise<VoiceSpeakResult>; until: number }>();
  const safe = (text: string, voiceId: string, emotion: SpeechEmotion | null): Promise<VoiceSpeakResult> =>
    inner(text, voiceId, emotion).catch((err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  const sweep = (): void => { /* 不变 */ };
  return {
    speak(text, voiceId, emotion) {
      sweep();
      const k = keyOf(text, voiceId, emotion);
      const hit = entries.get(k);
      if (hit === undefined) return safe(text, voiceId, emotion);
      entries.delete(k);
      return hit.p.then((r) => (r.ok ? r : safe(text, voiceId, emotion)));
    },
    prefetch(units, voiceId, untilTs) {
      sweep();
      for (const u of units) {
        const k = keyOf(u.text, voiceId, u.emotion);
        if (entries.has(k)) continue;
        entries.set(k, { p: safe(u.text, voiceId, u.emotion), until: untilTs });
      }
    },
  };
}
```

`mobile/src/voice/voiceStore.ts:140`：
```ts
const speech = createSpeakCache((text, voiceId, emotion) => tts.speak(text, voiceId, { ...speechOpts(), emotion }));
```
`:345-347`（`prefetchOpening`）：
```ts
  const units = spokenUnits(opening);
  if (units.length === 0) return;
  speech.prefetch(units, agentVoiceId(agentId, voiceRoster()), untilTs);
```
`speakPreview`（`:311`）不动：试听不带情绪。

- [ ] **Step 4: 跑全门禁**

Run: `npm test`
Expected: 全绿（第一次完整 tsc：桌面 + 手机）

- [ ] **Step 5: Commit**

```bash
git add src/shared/speakCache.ts mobile/src/voice/voiceStore.ts tests/shared/speakCache.test.ts
git commit -m "feat(mobile): 通话放音带 emotion；预合成缓存键带情绪（#1515）

同一句平读与带（笑）是两段音频，键不分开会把平读那段交给带情绪的那次要。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: edge `ttsUpstream.ts` —— 收 emotion / vol，写 `emotion_intensity`，回包带 code

**Files:**
- Modify: `services/edge/src/ttsUpstream.ts`
- Test: `tests/edge/ttsUpstream.test.ts`

**Interfaces:**
- Consumes: Task 1 `SPEECH_EMOTIONS`、`SpeechEmotion`（edge 从 `../../../src/shared/voiceProsody.js` import，同 `tts.js` 的先例）
- Produces:
  - `TtsRequest { text; voiceId; speed; vol: number; emotion: SpeechEmotion | null }`
  - `TTS_EMOTION_INTENSITY = 1.0`
  - `TtsReply` 失败分支多 `code: number | null`

- [ ] **Step 1: 改既有断言 + 加新断言**

既有 `parseTtsRequest` 第一条的 `toEqual({ ok: true, req: { text: "你好", voiceId: "v", speed: 1 } })` 改成 `{ …, speed: 1, vol: 1, emotion: null }`；`ttsUpstreamBody` 用例传 `{ text: "hi", voiceId: "v", speed: 1.2, vol: 1, emotion: null }`，期望的 `voice_setting` 不变。加：

```ts
describe("情绪（#1515）", () => {
  it("parseTtsRequest：emotion 只认六档 + neutral（neutral 当成不带）；vol 0.5–2；缺省不带 / 1", () => {
    expect(parseTtsRequest({ text: "x", voice_id: "v", emotion: "happy", speed: 1.12, vol: 1.12 }))
      .toEqual({ ok: true, req: { text: "x", voiceId: "v", speed: 1.12, vol: 1.12, emotion: "happy" } });
    expect(parseTtsRequest({ text: "x", voice_id: "v", emotion: "neutral" })).toMatchObject({ ok: true, req: { emotion: null } });
    expect(parseTtsRequest({ text: "x", voice_id: "v", emotion: "ecstatic" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", vol: 3 })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", vol: "1" })).toMatchObject({ ok: false });
  });
  it("ttsUpstreamBody：带 emotion 写 emotion + emotion_intensity 常量；不带时 voice_setting 四格逐字节同以前", () => {
    const withE = JSON.parse(ttsUpstreamBody("m", { text: "hi", voiceId: "v", speed: 0.88, vol: 0.92, emotion: "sad" }));
    expect(withE.voice_setting).toEqual({ voice_id: "v", speed: 0.88, vol: 0.92, pitch: 0, emotion: "sad", emotion_intensity: TTS_EMOTION_INTENSITY });
    const plain = JSON.parse(ttsUpstreamBody("m", { text: "hi", voiceId: "v", speed: 1, vol: 1, emotion: null }));
    expect(Object.keys(plain.voice_setting)).toEqual(["voice_id", "speed", "vol", "pitch"]);
  });
  it("parseTtsReply：失败时带 code（降级判据要它）；非 JSON / 形状不对 code 为 null", () => {
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 2013, status_msg: "invalid params" } })))
      .toEqual({ ok: false, code: 2013, message: "MiniMax 2013：invalid params" });
    expect(parseTtsReply("nope")).toEqual({ ok: false, code: null, message: "MiniMax 回了非 JSON" });
  });
});
```
（import 加 `TTS_EMOTION_INTENSITY`。既有 `parseTtsReply` 失败用例若用 `toEqual` 比整个对象，要加 `code`：非零 status_code 的加对应数字，其余加 `null`。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/edge/ttsUpstream.test.ts`
Expected: FAIL

- [ ] **Step 3: 改实现**

```ts
import { TTS_MAX_UNITS, ttsUnits } from "../../../src/shared/tts.js";
import { SPEECH_EMOTIONS, type SpeechEmotion } from "../../../src/shared/voiceProsody.js";

export interface TtsRequest {
  text: string;
  voiceId: string;
  speed: number;
  vol: number;
  /** 情绪（#1515）；null = 不写 voice_setting.emotion，让上游走缺省 */
  emotion: SpeechEmotion | null;
}

/** 情绪强度（#1515）：这是「这个上游对这组音色的调法」，换上游 / 换音色跟着变，所以是 edge 常量不是
    客户端传的。播客在克隆声上听出 2.0 又活又像本人；系统预置音色没验过，先 1.0，真机听过再调——改这里、部署 edge，客户端不发版 */
export const TTS_EMOTION_INTENSITY = 1.0;

const numberIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
```
`parseTtsRequest` 里 speed 那段之后：
```ts
  let vol = 1;
  if (body.vol !== undefined) {
    const v = numberIn(body.vol, 0.5, 2);
    if (v === null) return { ok: false, message: "vol 要在 0.5–2 之间" };
    vol = v;
  }
  let emotion: SpeechEmotion | null = null;
  if (body.emotion !== undefined && body.emotion !== "neutral") {
    if (typeof body.emotion !== "string" || !(SPEECH_EMOTIONS as readonly string[]).includes(body.emotion)) {
      return { ok: false, message: `emotion 只认 ${SPEECH_EMOTIONS.join(" / ")} / neutral` };
    }
    emotion = body.emotion as SpeechEmotion;
  }
  return { ok: true, req: { text, voiceId, speed, vol, emotion } };
```
`ttsUpstreamBody`：
```ts
    voice_setting: {
      voice_id: req.voiceId, speed: req.speed, vol: req.vol, pitch: 0,
      ...(req.emotion !== null ? { emotion: req.emotion, emotion_intensity: TTS_EMOTION_INTENSITY } : {}),
    },
```
`TtsReply` 与 `parseTtsReply`：
```ts
export type TtsReply =
  | { ok: true; audio: Uint8Array; usageChars: number | null; audioMs: number | null }
  | { ok: false; code: number | null; message: string };
```
每个 `return { ok: false, message }` 补 `code: null`；`status_code ≠ 0` 那条回 `{ ok: false, code, message: \`MiniMax ${code}：${msg}\` }`。

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/edge/ttsUpstream.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/edge/src/ttsUpstream.ts tests/edge/ttsUpstream.test.ts
git commit -m "feat(edge): /speech 收 emotion / vol，带情绪时写 emotion_intensity 常量；回包解析带 code（#1515）

不带 emotion 的 voice_setting 四格逐字节同以前。强度是 edge 常量：换音色换上游它跟着变，
客户端不该知道；先 1.0，系统预置音色真机听过再调。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: edge `serveTts` —— emotion 被拒去掉重试一次

**Files:**
- Modify: `services/edge/src/llmGateway.ts:478-520`（`serveTts` 的 `work`）
- Test: `tests/edge/llmGateway.test.ts`（语音那个 describe）

**Interfaces:**
- Consumes: Task 7 `TtsReply.code`、`TtsRequest.emotion`
- Produces: 无新导出；`TTS_NO_RETRY_CODES = new Set([1002, 1008])` 文件内常量

- [ ] **Step 1: 加断言**

```ts
  it("带 emotion 被上游拒（200 + 参数类非零 code）：去掉 emotion 同一个 hold 内重试一次，第二发不带 emotion（#1515）", async () => {
    const { quota, calls } = quotaStub();
    let n = 0;
    const up = upstream(() => (++n === 1 ? Response.json({ base_resp: { status_code: 2013, status_msg: "invalid params" } }) : mmOk()()));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v", emotion: "happy", speed: 1.12, vol: 1.12 }), caller);
    expect(res.status).toBe(200);
    expect(up.seen).toHaveLength(2);
    expect((await up.seen[0]!.json()).voice_setting).toMatchObject({ emotion: "happy" });
    expect((await up.seen[1]!.json()).voice_setting).not.toHaveProperty("emotion");
    expect(calls.hold).toHaveLength(1);
    expect(calls.release).toHaveLength(0);
    expect(calls.settle).toHaveLength(1);
  });
  it("第二发也被拒：release + 502，不打第三发", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ base_resp: { status_code: 2013, status_msg: "invalid params" } }));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v", emotion: "happy" }), caller);
    expect(res.status).toBe(502);
    expect(up.seen).toHaveLength(2);
    expect(calls.release).toHaveLength(1);
  });
  it("限流 1002 / 欠费 1008 与 emotion 无关：不重试、直接 502；不带 emotion 的被拒也不重试", async () => {
    for (const [code, body] of [[1002, { emotion: "happy" }], [1008, { emotion: "happy" }], [2013, {}]] as const) {
      const { quota } = quotaStub();
      const up = upstream(() => Response.json({ base_resp: { status_code: code, status_msg: "x" } }));
      const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
      const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v", ...body }), caller);
      expect(res.status).toBe(502);
      expect(up.seen).toHaveLength(1);
    }
  });
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/edge/llmGateway.test.ts -t "emotion"`
Expected: 前两条 FAIL（只打了一发）；第三条绿（今天就不重试）

- [ ] **Step 3: 改实现**

`serveTts` 的 `work` 里，把「打上游 + 解回包」抽成一个本地函数并加一次降级：

```ts
      // emotion 被拒的降级（#1515，搬 ai-podcast MinimaxTts.synthesize）：上游 200 + 参数类非零 code、请求带
      // emotion → 去掉 emotion 同一个 hold 内再打一次，宁可这句平淡也别整句不出声。限流 / 欠费与 emotion 无关，
      // 重试救不了还白丢情绪；HTTP 非 200 / 连不上照旧 release + 502。第二发不带 emotion，不存在第三发
      const TTS_NO_RETRY_CODES = new Set([1002, 1008]);
      type Attempt = { kind: "unreachable" } | { kind: "http"; res: Response } | { kind: "reply"; reply: TtsReply };
      const attempt = async (req: TtsRequest): Promise<Attempt> => {
        let res: Response;
        try {
          res = await doFetch(`${route.baseUrl}${upstreamPathFor(route.kind)}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: ttsUpstreamBody(route.wireModel, req),
          });
        } catch {
          return { kind: "unreachable" };
        }
        if (!res.ok) return { kind: "http", res };
        return { kind: "reply", reply: parseTtsReply(await res.text()) };
      };
      const work = (async (): Promise<Response> => {
        try {
          let a = await attempt(parsed.req);
          if (a.kind === "reply" && !a.reply.ok && parsed.req.emotion !== null && a.reply.code !== null && !TTS_NO_RETRY_CODES.has(a.reply.code)) {
            a = await attempt({ ...parsed.req, emotion: null });
          }
          if (a.kind === "unreachable") {
            await deps.quota.release(caller.uid, requestId);
            return apiError(502, `上游连不上：${route.platform}`, "upstream");
          }
          if (a.kind === "http") {
            await deps.quota.release(caller.uid, requestId);
            const snippet = (await a.res.text().catch(() => "")).slice(0, 300);
            return apiError(502, `上游 ${a.res.status}：${snippet}`, "upstream", { upstreamStatus: a.res.status });
          }
          const reply = a.reply;
          if (!reply.ok) {
            await deps.quota.release(caller.uid, requestId);
            return apiError(502, reply.message, "upstream");
          }
          …（从 `const usage: UsageCounts = …` 起原样不动）…
```
（`TtsReply` / `TtsRequest` 从 `./ttsUpstream.js` import 类型。）

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/edge/llmGateway.test.ts`
Expected: PASS（语音那一组全部，含旧的）

- [ ] **Step 5: Commit**

```bash
git add services/edge/src/llmGateway.ts tests/edge/llmGateway.test.ts
git commit -m "feat(edge): /speech 带 emotion 被上游拒时去掉 emotion 同一个 hold 内重试一次（#1515）

turbo + 系统预置音色对 emotion 的接受度没验到（播客 key 欠费），这条降级路是必做项：宁可这句
平淡也别整句不出声。1002 / 1008 与 emotion 无关，不重试。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 显示剥记号（四处）

**Files:**
- Modify: `src/renderer/src/components/CloudSessionPage.tsx:1795-1805`（`AgentBubbles`）、`src/shared/mobileChat.ts:139,375`、`src/shared/sessionLast.ts:34`、`src/shared/cloudTimeline.ts:606`
- Test: `tests/renderer/CloudAssistantBubbles.test.tsx`、`tests/shared/mobileChat.test.ts`、`tests/shared/sessionLast.test.ts`、`tests/renderer/voiceCallCard.test.tsx`

**Interfaces:**
- Consumes: Task 1 `stripEmotionTag`、`stripEmotionTags`

- [ ] **Step 1: 四个测试文件各加一条**

`tests/renderer/CloudAssistantBubbles.test.tsx`（用文件里已有的 `ws` / `reply` / `bubbles` 夹具）：
```ts
  it("段首情绪括注不画出来（#1515）：记号是给 TTS 的，日志里留着、气泡里剥掉", () => {
    render(<AssistantMessageRow event={reply("（笑）弄好了。\n\n（叹）就是慢。")} ws={ws} />);
    const texts = bubbles().map((b) => b.textContent);
    expect(texts).toEqual(["弄好了。", "就是慢。"]);
  });
```
（`AssistantMessageRow` 的 props 名以文件里现有用例为准照抄。）

`tests/shared/mobileChat.test.ts`：在 `chatRows` 与 `liveRows` 各一条已有用例的正文前加 `（笑）`，断言 `paragraphs` 不含括注；或新加：
```ts
  it("段首情绪括注剥掉（#1515）：终态与流式都剥", () => {
    seq = 0;
    const rows = chatRows({ events: [e({ type: "assistant_message", agentId: "a_000000000001", content: "（笑）弄好了。\n\n（叹）就是慢。", model: "m" })], ws: WS, selfUid: "me", now: DAY });
    expect(rows.find((r) => r.kind === "agent")).toMatchObject({ paragraphs: ["弄好了。", "就是慢。"] });
    const live = liveRows({ streaming: { a_000000000001: "（惊）这么快？" }, ws: WS, now: DAY });
    expect(live[0]).toMatchObject({ paragraphs: ["这么快？"] });
  });
```
（`chatRows` 的参数形状照文件里第一条用例抄。）

`tests/shared/sessionLast.test.ts`：
```ts
  it("段首情绪括注不进「最后一句」（#1515）", () => {
    expect(excerptOf("（笑）弄好了。\n\n第二段")).toBe("弄好了。");
  });
```

`tests/renderer/voiceCallCard.test.tsx`：在「点开弹窗」那个 describe 里加（用 `answered` 夹具）：
```ts
  it("卡里的全文剥掉段首情绪括注（#1515）", () => {
    const el = renderCard([callChanged(1, 0, ["a_1"]), spoke(2, 2_000, "能听到吗"), answered(3, 4_000, "（笑）能，很清楚。"), callChanged(4, 9_000, [])]);
    fireEvent.click(el.querySelector("button")!);
    expect(screen.getByText("能，很清楚。")).toBeInTheDocument();
    expect(screen.queryByText(/（笑）/)).toBeNull();
  });
```
（点开弹窗的手法照文件里 ④ 那条用例抄。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/renderer/CloudAssistantBubbles.test.tsx tests/shared/mobileChat.test.ts tests/shared/sessionLast.test.ts tests/renderer/voiceCallCard.test.tsx`
Expected: 四条新用例 FAIL

- [ ] **Step 3: 改四处**

`CloudSessionPage.tsx` `AgentBubbles`：
```tsx
function AgentBubbles({ text }: { text: string }) {
  // 段首情绪括注（#1515）是给 TTS 的，不是话：日志留着，气泡剥掉
  const parts = splitBubbles(text).map(stripEmotionTag);
  const chunks = parts.length > 0 ? parts : [text];
```
（import `stripEmotionTag` from `../../../shared/voiceProsody.js`）

`mobileChat.ts:139` 与 `:375`：`splitBubbles(e.content).map(stripEmotionTag)` / `splitBubbles(text).map(stripEmotionTag)`。

`sessionLast.ts:34`：`const first = stripEmotionTag(splitBubbles(text)[0] ?? "");`

`cloudTimeline.ts:606`：`say(e, party.name, party.avatar, stripEmotionTags(e.content), false);`

- [ ] **Step 4: 跑，确认绿**

Run: 同 Step 2 的四个文件
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/CloudSessionPage.tsx src/shared/mobileChat.ts src/shared/sessionLast.ts src/shared/cloudTimeline.ts tests/renderer/CloudAssistantBubbles.test.tsx tests/shared/mobileChat.test.ts tests/shared/sessionLast.test.ts tests/renderer/voiceCallCard.test.tsx
git commit -m "feat(ui): 段首情绪括注在桌面气泡 / 手机气泡 / 名册最后一句 / 通话卡全文里都剥掉（#1515）

记号是给 TTS 的；每条开头一个括注像演戏（维护者拍板剥）。日志一字不动，剥是投影。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 通话提示词加三句

**Files:**
- Modify: `src/session/deriveMessages.ts:438`（`renderVoiceCallPrompt` 里「像打电话」那句之后）
- Test: `tests/session/deriveMessages.voiceCall.test.ts`

- [ ] **Step 1: 加断言**

在 `describe("通话里像打电话（#1183）")` 旁加：
```ts
describe("通话里像真人（#1515）", () => {
  it("通话块给六个情绪括注的词表、说平叙不写；要口头连接词与短接", () => {
    const text = renderVoiceCallPrompt([{ agentId: "admin", name: "管理员" }], "管理员", []);
    expect(text).toContain("（笑）（惊）（叹）（气）（怕）（嫌）");
    expect(text).toContain("平叙就不写");
    expect(text).toContain("口头连接");
  });
  it("没有通话时 system 里一个括注词表都没有", () => {
    expect(systemOf([created, brief, user])).not.toContain("（笑）");
  });
});
```
（`systemOf / created / brief / user` 是文件里已有的夹具。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/session/deriveMessages.voiceCall.test.ts`
Expected: 第一条 FAIL

- [ ] **Step 3: 改实现**

`renderVoiceCallPrompt` 里 `你的回复会被读出来，像打电话：…口语，代码只放围栏里。` 那一行之后插：
```ts
    // 活人感（#1515，搬 ai-podcast 的两条：情绪要起伏 / 受控低效 = 活）：括注词表只给六个，少给选项比多给准
    `每段开头可以写一个括注说这段的情绪：（笑）（惊）（叹）（气）（怕）（嫌），平叙就不写——真人大多数话是平的，起伏才显得出来。` +
    `说话带口头连接（然后、其实、就是、我看看），能一两个字接住的就接住（行、对、嗐、好），该问就问一句，不用句句都是完整的汇报。` +
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/session`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/deriveMessages.ts tests/session/deriveMessages.voiceCall.test.ts
git commit -m "feat(prompt): 通话块给情绪括注词表、要口头连接词与短接（#1515）

播客蒸馏的结论：真人句子短、满嘴连接词、48% 的段不到六个字；只说「短句口语」模型仍然念稿。
词表只给六个：少给选项比多给准。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 兼容矩阵脚本 + 文档骨架（维护者真机跑）

**Files:**
- Create: `scripts/tts-emotion-matrix.mjs`
- Create: `docs/voice-emotion-compat.md`

- [ ] **Step 1: 写脚本**

```js
// scripts/tts-emotion-matrix.mjs —— turbo × agentVoice.ts 的十三个音色 × 7 emotion 各念一个字，记 status_code（#1515）。
// ai-podcast 只验过 hd + 自家四音色；Otto 用的组合没人验过，而 emotion 被拒的降级路只兜「不出声」，
// 兜不住「哪几档从来没生效过」。跑法（key 只在 Worker secret 里，维护者在本机 export 一次）：
//   MINIMAX_API_KEY=… node scripts/tts-emotion-matrix.mjs > /tmp/matrix.txt
// 不打印 key；每发之间歇 300ms 避 RPM。
import { AGENT_VOICES, ADMIN_VOICE_ID } from "../src/shared/agentVoice.ts";

const key = process.env.MINIMAX_API_KEY;
if (!key) { console.error("要 MINIMAX_API_KEY"); process.exit(1); }
const base = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com";
const model = process.env.MODEL ?? "speech-2.8-turbo";
const emotions = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"];
const voices = [ADMIN_VOICE_ID, ...AGENT_VOICES.map((v) => v.id)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(voice, emotion) {
  const voice_setting = { voice_id: voice, speed: 1, vol: 1, pitch: 0, ...(emotion === "neutral" ? {} : { emotion, emotion_intensity: 1.0 }) };
  const res = await fetch(`${base}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, text: "测", stream: false, voice_setting, audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 64000, channel: 1 } }),
  });
  const body = await res.json().catch(() => ({}));
  return { code: body.base_resp?.status_code, msg: body.base_resp?.status_msg, audio: !!body.data?.audio };
}

console.log(`| voice_id | ${emotions.join(" | ")} |`);
console.log(`|---|${emotions.map(() => ":-:").join("|")}|`);
for (const v of voices) {
  const cells = [];
  for (const e of emotions) {
    const r = await call(v, e);
    cells.push(r.code === 0 && r.audio ? "✓" : `✗ ${r.code ?? "?"}`);
    await sleep(300);
  }
  console.log(`| \`${v}\` | ${cells.join(" | ")} |`);
}
```
（跑它要 `node --experimental-strip-types` 或 `npx tsx scripts/tts-emotion-matrix.mjs`——仓库里已有 `.mts + tsx` 的先例；在文件头注明用 `npx tsx`。）

- [ ] **Step 2: 写文档骨架**

```md
# MiniMax T2A v2：Otto 用的音色 × emotion 兼容矩阵

- 来源：#1515；方法与表的形状照 ai-podcast `docs/voice-emotion-compat.md`
- 型号：`speech-2.8-turbo`（国内站 `api.minimaxi.com`）
- 方法：`npx tsx scripts/tts-emotion-matrix.mjs`，每个 voice × emotion 各发一次 `text:"测"`，`status_code == 0` 且回了 `data.audio` = 接受

## 矩阵

**待真机**：2026-10-04 想用 ai-podcast 的 key 探，回 `1008 insufficient balance`；本机没有 Otto 的 key（只在 Worker secret）。
部署 edge 之后由维护者跑一遍，把脚本输出贴到这里。

## 怎么用这张表

- 「✗」的格子：运行时由 `serveTts` 的降级路兜（去掉 emotion 重试一次），那一句平读不出错；表上记下来是为了知道哪几档在哪个音色上从来没生效过。
- 全 ✓ 则 `TTS_EMOTION_INTENSITY` 可以考虑往播客的 2.0 拉（人耳决定）。
```

- [ ] **Step 3: Commit**

```bash
git add scripts/tts-emotion-matrix.mjs docs/voice-emotion-compat.md
git commit -m "chore(voice): 音色 × emotion 兼容矩阵脚本 + 文档骨架，等维护者带 key 真机跑（#1515）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: ADR + 代码地图 + 词汇 + 门禁

**Files:**
- Create: `docs/adr/0355-智能体语音活人感-段首括注情绪进TTS-投影剥掉-pitch恒0.md`（合并前 re-fetch 核号，撞了改 `max+1` 并加「原为」行，ADR-0074）
- Modify: `docs/where-to-find-things.md`（语音那一节 `:159` 之后加一条）、`CONTEXT.md`（产品 / 技术词那一节加「情绪括注」）
- Modify: `docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md` §2 的 `GAP_MS` 行改成 `{ sentence: 230, speaker: 460 }` 并注明原因（见 Global Constraints）

- [ ] **Step 1: 写 ADR**

```md
# ADR-0355：智能体语音的活人感——模型在段首写括注情绪，界面剥掉、日志留着，TTS 带 emotion 与韵律，pitch 恒 0

- 状态：已接受
- 日期：2026-10-04
- 关联：#1515；ADR-0271（TTS 走 edge——本篇在它的 `voice_setting` 上多三格）、ADR-0266（按空行拆气泡——情绪挂在段上）、ADR-0277（按句出声——句沿用段的情绪）、ADR-0288（通话卡——也剥记号）、ADR-0332（预合成缓存——键带情绪）；`~/Github/ai-podcast`（`data/refs/delivery_recipe.json` / `src/tts/prosody.ts` / `src/tts/minimax.ts` / `src/tts/normalize.ts`）
- 设计稿：`docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md`

## 背景

维护者原话：「现在 otto app 里的智能体语音太生硬了，没有活人感。我们之前做过 ai 播客的语音活人感调教，去借鉴过来。」

此刻（#1163）：`speech-2.8-turbo`，`voice_setting` 只有 `voice_id / speed 1 / vol 1 / pitch 0`，没有 emotion；一句播完立刻下一句；提示词只说「短句口语先说结论」。播客那边从 32 期真人节目蒸馏出的东西（每句 emotion、emotion→speed/vol、句间停顿档位、口头连接词密度、AI 大写 / 年份逐位）一条都没用上。

## 决策

1. **情绪由模型自己标**：通话提示词给六个段首括注 `（笑）（惊）（叹）（气）（怕）（嫌）`，对到 MiniMax 的 happy / surprised / sad / angry / fearful / disgusted；平叙不写。否决了分类器（每句多一次模型调用，#1400 量过 1.3–3 秒，电话里等不起）和只调声学（「！」既是惊也是气）。
2. **记号落日志、不落界面**：`assistant_message.content` 原文带括注落盘，显示路径四处（桌面气泡 / 手机气泡 / 名册最后一句 / 通话卡全文）各过一次 `stripEmotionTag`；出声路径解出来进 `voice_setting.emotion`。只认段首、只认白名单——词表外的括注是模型说的话。否决了加事件字段（正文里的东西再抄一份是两份事实；退化成平读 = 今天的行为，不值一个协议位）。
3. **韵律跟着情绪走、pitch 永远 0**：高唤起 speed 1.12 / vol 1.12，低唤起 0.88 / 0.92（播客 recipe）。客户端算、edge 只校验范围。移调 = 换共振峰 = 换一个人，连接口都不回 pitch。
4. **`emotion_intensity` 是 edge 常量**（先 1.0）：它是「这个上游对这组音色的调法」，换上游换音色跟着变；播客 2.0 是克隆声上听出来的，系统预置音色真机听过再调，客户端不发版。
5. **emotion 被拒去掉重试一次**（同一个 hold）：turbo + 系统预置音色对 emotion 的接受度没验到（播客 key 欠费、本机无 Otto key），宁可这句平淡也别整句不出声；1002 / 1008 不重试。
6. **句间补真人停顿**：同一只 230ms、换说话人 460ms，扣掉等合成已经等掉的。设计稿写的是「换段 460」，落地改成「换说话人」：播放器手上有 agentId、没有段边界，而真人 p90 那一档本来就是话轮切换。
7. **型号留 turbo、范围只通话**：hd 贵 + 慢，电话里延迟优先；试听与语音消息不碰。

## 代价

- 存量日志里的通话没有记号，重放还是平读。
- 模型在非通话会话里也可能写括注（历史会话里会出现）：显示路径都剥，人看不到，只是那几段当成正文落盘。
- 一段里句子沿用同一情绪，句级起伏做不到（播客也是按行标的）。
- `emotion_intensity` 的最终值、哪几档在哪个音色上生效，都要部署 edge 之后真机听（`scripts/tts-emotion-matrix.mjs` + `docs/voice-emotion-compat.md`）。
```

- [ ] **Step 2: 代码地图 + 词汇**

`docs/where-to-find-things.md` 在 `:159` 那条语音条目之后加一行：
```md
- `src/shared/voiceProsody.ts` / `services/edge/src/ttsUpstream.ts` 的 `TTS_EMOTION_INTENSITY` / `services/edge/src/llmGateway.ts` `serveTts` 的 `attempt` — **智能体语音的活人感**（#1515，ADR-0355）：模型在段首写括注情绪（（笑）（惊）（叹）（气）（怕）（嫌）），`voiceFeed` 解出来进 `voice_setting.emotion`、键里留着（同一句带不带情绪是两个单位，手机缓存键同），显示路径四处（`CloudSessionPage` 的 `AgentBubbles` / `mobileChat` / `sessionLast` / `cloudTimeline.voiceCallCards`）各剥一次；speed/vol 按情绪微映射（播客 recipe：1.12 / 0.88）、pitch 永远 0；句间 230 / 换人 460ms 由 `voicePlayer` 补、扣掉等合成已等掉的；edge 带 emotion 被拒（200 + 非 1002/1008 的非零 code）去掉重试一次、同一个 hold。**turbo + 系统预置音色对 emotion 的接受度没验到**（播客 key 欠费）：部署 edge 后维护者跑 `scripts/tts-emotion-matrix.mjs` 填 `docs/voice-emotion-compat.md`，再定 `TTS_EMOTION_INTENSITY` 从 1.0 拉不拉到播客的 2.0
```

`CONTEXT.md` 产品 / 技术词那一节加：
```md
- **情绪括注（emotion tag）**：通话里模型写在**段首**的括注 `（笑）（惊）（叹）（气）（怕）（嫌）`，对到 MiniMax 的 emotion（happy / surprised / sad / angry / fearful / disgusted）。落日志不落界面：显示剥、出声解；只认段首白名单，词表外的括注是正文。ADR-0355，`src/shared/voiceProsody.ts`
```

`docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md` §2：`GAP_MS = { sentence: 230, bubble: 460 }` 那一行改成 `{ sentence: 230, speaker: 460 }`，行尾加「（实施时改：播放器手上有 agentId 没有段边界，真人 p90 那一档本来就是话轮切换，ADR-0355 决策 6）」；§3 对应的「跨段补 GAP_MS.bubble」改成「换说话人补 GAP_MS.speaker」。

- [ ] **Step 3: 跑门禁**

Run: `npm test`
Expected: 全绿（含 `tests/docs/adrNumbers.test.ts` 不撞号、`tests/architecture.test.ts` 没越界 import）

- [ ] **Step 4: Commit + push**

```bash
git add docs/adr/0355-*.md docs/where-to-find-things.md CONTEXT.md docs/superpowers/specs/2026-10-04-agent-voice-liveliness-design.md
git commit -m "docs: ADR-0355 智能体语音活人感——情绪括注落日志不落界面、pitch 恒 0、被拒降级（#1515）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin claude/otto-agent-voice-naturalness-8a0d11
```

- [ ] **Step 5: 开 PR**

```bash
gh pr create --title "feat(voice): 智能体语音活人感——段首括注情绪进 TTS、投影剥掉、韵律与停顿、口头连接词（#1515）" --body-file /dev/stdin
```
PR body 写：Closes #1515；改了什么（七条，对 ADR 决策）；**没验的**：turbo + 系统预置音色 × emotion（要维护者部署 edge 后跑矩阵脚本）；`TTS_EMOTION_INTENSITY` 先 1.0；合并前 re-fetch 核 ADR 号。结尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

---

## Self-Review

**Spec coverage**：§1 提示词 → Task 10；§2 shared 纯逻辑 → Task 1、出声路 → Task 2、显示路五处 → Task 9（通话字幕是 `VoicePlayer.state().text`，Task 2 的 `spokenText` 已剥，Task 9 不另改——spec 说「加一条断言钉住」：Task 2 的 `spokenText` 用例就是那条）；§3 客户端请求体 → Task 4 / 5 / 6、停顿 → Task 3；§4 edge → Task 7 / 8；§6 测试 → 每个 Task 的 Step 1；§7 真机 → Task 11；ADR → Task 12。§2 的 `GAP_MS.bubble` 与实施偏差已在 Global Constraints 与 Task 12 Step 2 写明。

**Type consistency**：`SpeechEmotion | null` 贯穿 Utterance / SpokenUnit / Item / SpeakFn / TtsRequest；`TtsSpeakOpts.emotion?: SpeechEmotion | null`（Task 4）与 Task 5 的 `teamVoice.speak(text, voiceId, { emotion })`、Task 6 的 `{ ...speechOpts(), emotion }` 一致；`spokenUnits` 回 `SpokenUnit[]`（Task 2）与 Task 6 `prefetch(units)` 一致；`parseTtsReply` 失败分支 `code`（Task 7）与 Task 8 判据一致。

**Placeholders**：无 TBD；Task 9 Step 1 的「props 名 / 参数形状照文件里已有用例抄」是对既有夹具的引用，不是待填。
