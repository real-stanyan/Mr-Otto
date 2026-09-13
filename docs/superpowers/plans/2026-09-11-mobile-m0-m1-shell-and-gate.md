# 手机端 M0 + M1（三栏骨架与设计系统 + 进门）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端换成「任务 / 项目 / 团队」三栏原生导航壳（今天的功能原样搬进去），并照 demo 做完进门：冷启动、登录 / 注册、等确认信、忘记密码三步。

**Architecture:** react-navigation 原生栈——每个页签一个栈，根栈放账号 / 好友 / 配对——加一条自己画的毛玻璃页签栏；进门由 `App.tsx` 顶层一个纯函数 `gateView` 决定画冷启动、闸门还是主界面。所有能测的判断住 `src/shared/`、测试进 `tests/shared/`（`mobile/` 的类型检查不在门禁里，#422）。

**Tech Stack:** Expo SDK 57（Expo Go）、React Native 0.86、@react-navigation 7（native-stack / bottom-tabs）、react-native-screens、react-native-safe-area-context、expo-blur、expo-haptics、react-native-svg、expo-font + @expo-google-fonts/poppins、supabase-js；vitest（根门禁）。

**Spec:** `docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md`（§3 设计语言、§4.1 进门、§4.4 项目栏、§6 的 M0 / M1、§10 与 demo 的偏差）。Demo：`.demo/mobile-app-redesign.html`（本计划涉及的屏 id：splash / signin / signup / forgot / forgotCode / forgotSet / confirmMail / tasks / projects / teams / account）。Task issue：#1237。

## Global Constraints

- 全部依赖必须在 Expo Go（SDK 57）里就有：这份计划做完，`npx expo start` + Expo Go 仍然能跑，不许引入要 dev build 的原生模块。
- 颜色只从 `mobile/src/theme.ts` 的 `usePalette()` 取。弹窗遮罩：深色 `rgba(0,0,0,0.5)`、浅色 `rgba(0,0,0,0.28)`（demo 的 `--scrim`）。
- 弹簧一律 Apple 两参数口径，经 `spring(response, dampingRatio)` 换算，默认临界阻尼（ζ = 1）。
- 系统「减弱动态效果」开着时：位移 / 缩放退成只变透明度（`useReduceMotion()`）。
- 验证码 8 位（`OTP_LENGTH`）、4 + 4 两组；密码下限 6（`MIN_PASSWORD`）；用户名上限 24（`NAME_MAX`）；重发冷却 60 秒（`RESEND_COOLDOWN_S`）；等确认信的探测节奏 `pollDelayMs`（前 6 次 5 秒、之后 15 秒）；冷启动最短停留 1200 ms（`SPLASH_MIN_MS`）。
- 尺寸：页签栏 49pt + 底部安全区；弹窗宽 `min(320, 屏宽 − 48)`、圆角 22；按钮高 50（弹窗里 46、闸门上 42）；输入框高 46（闸门上 42）、圆角 14。
- 文案：不出现「水獭」；团队里的叫「智能体」；用「团队」不用「工作区」。
- 每个任务结束跑 `npm --prefix mobile run typecheck`；动了 `src/shared/` 或 `src/renderer/` 的任务再跑根门禁 `npm test`。PR 正文写上 `mobile` 类型检查的结果（#422 收口前的约定）。
- 相对路径：`mobile/src/<子目录>/` 到仓库根是 `../../../`；`mobile/src/` 到仓库根是 `../../`；`mobile/App.tsx` 到仓库根是 `../`。
- 正则里的 CJK 区间写 `\u4e00-\u9fff` 转义，不手抄字形。

## 与 spec 不同、写进这份计划的三处（Task 9 回写 spec §10）

1. **图标不引 `lucide-react-native`**：用 demo 同一份路径，经 `react-native-svg` 画。demo 的 `spark` 不是 lucide 原图，照 lucide 画会和过目的那版不一样；还少一个依赖。
2. **`react-native-reanimated` / `react-native-gesture-handler` / 底部抽屉挪到 M2**：M0 / M1 没有手势驱动的动效（抽屉的第一个消费方是 M2 的模型选单），RN 自带的 `Animated.spring` 吃同一套物理参数。
3. **找回密码第二步的说明去掉「邮件里那条链接点了也算」**：手机端没有接 `mrotto://auth-callback` 的深链（Expo Go 里 scheme 也不是它），这句话在手机上是假的。

## 文件结构

新建（共享纯逻辑，跟根门禁跑）：
- `src/shared/appleSpring.ts`：response / damping → stiffness / damping / mass（从 `mobile/src/theme.ts` 挪来）
- `src/shared/linkStatus.ts`：到自己电脑那条连接的一句话（原来在品牌栏上）
- `src/shared/forgotPassword.ts`（从 `src/renderer/src/lib/` 挪来 + 新 `otpCells`）
- `src/shared/signInForm.ts`（挪来）
- `src/shared/authError.ts`（规则表 + `authNoticeOf` + `localEmailProblem`；渲染层留一层剥 IPC 壳的包装）
- `src/shared/splashProgress.ts`（挪来）
- `src/shared/confirmEmailPoll.ts`（`pollDelayMs` 从 `ConfirmEmailDialog.tsx` 挪来）
- `src/shared/mobileGate.ts`：`gateView`（冷启动 / 闸门 / 按住 / 进 app）
- `tests/shared/` 下对应的八个测试文件

新建（手机端）：
- `mobile/src/chrome.tsx`：页签栏显隐 + 底部让位（`TabChromeProvider` / `useTabChrome` / `useTabInset`）
- `mobile/src/link.tsx`：到电脑那条连接的共享状态（`LinkProvider` / `useLink`）
- `mobile/src/icons.tsx`：demo 同一份路径的 `Icon`
- `mobile/src/haptics.ts`：触感（本计划只有「落定」「发送」两处）
- `mobile/src/dialog.tsx`：居中弹窗
- `mobile/src/nav/{types.ts,RootNavigator.tsx,TabBar.tsx,AvatarButton.tsx}`
- `mobile/src/tabs/{TasksRoot,TeamsRoot,ProjectsRoot}.tsx`
- `mobile/src/projects/{clock.ts,Fleet.tsx,SessionView.tsx}`（从 `App.tsx` 拆出）
- `mobile/src/account/AccountScreen.tsx`（`App.tsx` 的 `Settings` 拆出、改名）
- `mobile/src/pair/PairScreen.tsx`（`App.tsx` 的 `Pair` / `ScanPair` 拆出）
- `mobile/src/friends/FriendsScreen.tsx`：把 `Friends` 挂进根栈的外壳
- `mobile/src/gate/{GateScreen.tsx,SignInCard.tsx,Splash.tsx,Wordmark.tsx,ConfirmMailDialog.tsx,ForgotDialog.tsx,OtpInput.tsx,marks.tsx,authActions.ts,resetHold.ts}`
- `mobile/assets/otto.png`（桌面 `src/renderer/src/assets/otto.png` 的拷贝）
- `docs/adr/0293-手机端从投影窗口扩成三栏客户端.md`（编号合并时认领）

改：
- `mobile/App.tsx`（最后只剩：启动、进门、主界面三选一）
- `mobile/src/ui.tsx`（`Page` 给页签栏让位 + 自动内缩；`Button` 加 `secondary` 与两档尺寸；新 `Field`）
- `mobile/src/theme.ts`（`spring` 改成 re-export；加 `withAlpha`、`scrim`）
- `mobile/src/friends.tsx`（`embedded` 时不画自己的大标题）
- `mobile/package.json` / `mobile/package-lock.json`、`mobile/README.md`
- 渲染层 import 路径：`ForgotPasswordDialog.tsx`、`SignInCard.tsx`、`SetPasswordDialog.tsx`、`Splash.tsx`、`ConfirmEmailDialog.tsx`；`src/renderer/src/lib/authError.ts` 变成包装
- `AGENTS.md`「Where to find things」加一行（L2）；spec §6 / §10 / §11

## 模拟器验收的通用做法（带界面的任务末尾都用）

1. 起模拟器：`xcrun simctl boot "iPhone 17 Pro" 2>/dev/null; open -a Simulator`
2. 起 Metro 并装进 Expo Go：`cd mobile && npx expo start --ios`（第一次会给模拟器装 SDK 57 的 Expo Go，问升级就答 yes）。改完代码 Metro 会热更新；换了依赖要重启 Metro。
3. 截图：`xcrun simctl io booted screenshot --type=png /tmp/otto-<屏>.png`，和 demo 同一屏并排看。
4. 深浅色各看一遍：`xcrun simctl ui booted appearance dark` / `xcrun simctl ui booted appearance light`。
5. 减弱动态效果：模拟器「设置 → 辅助功能 → 动态效果 → 减弱动态效果」打开后再过一遍带动效的地方。

---

## M0 · 骨架与设计系统

### Task 1: 依赖与基线

**Files:**
- Modify: `mobile/package.json`、`mobile/package-lock.json`

**Interfaces:**
- Consumes: 无
- Produces: 可以 import 的 `@react-navigation/native`、`@react-navigation/native-stack`、`@react-navigation/bottom-tabs`、`react-native-screens`、`react-native-safe-area-context`、`expo-blur`、`expo-haptics`、`react-native-svg`

- [ ] **Step 1: 装现有依赖**（worktree 里没有 `mobile/node_modules`）

Run: `npm --prefix mobile ci`
Expected: 装完没有 `ERR!`。

- [ ] **Step 2: 基线类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。不是 0 就停下报告——不在红的基线上开工。

- [ ] **Step 3: 装 Expo 管版本的原生模块**（`expo install` 按 SDK 57 的 bundledNativeModules 选版本）

Run: `cd mobile && npx expo install react-native-screens react-native-safe-area-context expo-blur expo-haptics react-native-svg`
Expected: `mobile/package.json` 里出现 `react-native-screens`（~4.26）、`react-native-safe-area-context`（~5.7）、`expo-blur`（~57.0）、`expo-haptics`（~57.0）、`react-native-svg`（15.15）。

- [ ] **Step 4: 装导航**（纯 JS 包，不在 bundledNativeModules 里，钉 7.x）

Run: `npm --prefix mobile install @react-navigation/native@^7.3.18 @react-navigation/native-stack@^7.18.10 @react-navigation/bottom-tabs@^7.18.18`

- [ ] **Step 5: 版本自检**

Run: `cd mobile && npx expo install --check`
Expected: 没有不兼容提示；有的话照它说的跑 `npx expo install --fix`。

- [ ] **Step 6: 类型检查再跑一次**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。

- [ ] **Step 7: 冒烟**

照「模拟器验收的通用做法」起 app：登录页照旧出来（这一步没改任何界面）。截图 `/tmp/otto-t1-signin.png`。

- [ ] **Step 8: Commit**

```bash
git add mobile/package.json mobile/package-lock.json
git commit -m "build(mobile): 装导航与材质依赖（#1237 M0）

react-navigation 7 的原生栈与页签、react-native-screens、safe-area、expo-blur、
expo-haptics、react-native-svg。全部在 Expo Go（SDK 57）的 bundledNativeModules
里，手机端仍然不需要 dev build。reanimated / 手势库这次不装：M0/M1 没有手势驱动的
动效，跟 M2 的抽屉一起进。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 2: 共享纯逻辑——弹簧换算与连接状态

**Files:**
- Create: `src/shared/appleSpring.ts`、`src/shared/linkStatus.ts`
- Test: `tests/shared/appleSpring.test.ts`、`tests/shared/linkStatus.test.ts`
- Modify: `mobile/src/theme.ts`（`spring` 那一段）

**Interfaces:**
- Consumes: 无
- Produces:
  - `appleSpring(response: number, dampingRatio?: number): SpringPhysics`，`SpringPhysics = { stiffness: number; damping: number; mass: number }`
  - `type LinkTone = "ok" | "warn"`；`interface LinkStatus { tone: LinkTone; text: string }`；`linkStatus(ready: boolean, settled: boolean, hasSnapshot: boolean): LinkStatus`
  - `mobile/src/theme.ts` 照旧导出 `spring`（现在 = `appleSpring`）与 `PRESS_SPRING`

- [ ] **Step 1: 写失败的测试**

`tests/shared/appleSpring.test.ts`：

```ts
// Apple 两参数口径（response / damping ratio）→ RN Animated.spring 吃的物理三元组。
// 钉的是换算公式本身：ω₀ = 2π / response，stiffness = ω₀²，damping = 2ζω₀，质量取 1。

import { describe, expect, it } from "vitest";
import { appleSpring } from "../../src/shared/appleSpring.js";

describe("appleSpring", () => {
  it("按下的反馈（0.15s、临界阻尼）", () => {
    expect(appleSpring(0.15)).toEqual({ stiffness: 1755, damping: 84, mass: 1 });
  });

  it("挪位置（0.4s、临界阻尼）——Apple 那张表里 PiP 的档", () => {
    expect(appleSpring(0.4)).toEqual({ stiffness: 247, damping: 31, mass: 1 });
  });

  it("带动量的收尾（0.32s、ζ 0.82）：阻尼按比例变小，劲度只看 response", () => {
    expect(appleSpring(0.32, 0.82)).toEqual({ stiffness: 386, damping: 32, mass: 1 });
    expect(appleSpring(0.32, 0.82).stiffness).toBe(appleSpring(0.32).stiffness);
    expect(appleSpring(0.32, 0.82).damping).toBeLessThan(appleSpring(0.32).damping);
  });

  it("response 越小越快：劲度更大", () => {
    expect(appleSpring(0.2).stiffness).toBeGreaterThan(appleSpring(0.4).stiffness);
  });
});
```

`tests/shared/linkStatus.test.ts`：

```ts
// 项目栏大标题底下那一行：到自己那台电脑的加密连接此刻怎么样。
// 项目栏与账号页读同一份，判据只能有一份。

import { describe, expect, it } from "vitest";
import { linkStatus } from "../../src/shared/linkStatus.js";

describe("linkStatus", () => {
  it("握手完成：已连上", () => {
    expect(linkStatus(true, false, false)).toEqual({ tone: "ok", text: "已连上你的 Mac" });
    expect(linkStatus(true, true, true)).toEqual({ tone: "ok", text: "已连上你的 Mac" });
  });

  it("断了但还在宽限期里：当抖动看，说「重连中」，不说「断开了」", () => {
    expect(linkStatus(false, false, true)).toEqual({ tone: "warn", text: "重连中…" });
    expect(linkStatus(false, false, false)).toEqual({ tone: "warn", text: "重连中…" });
  });

  it("过了宽限期、手里还有断线前那份：说清下面的内容是旧的", () => {
    expect(linkStatus(false, true, true)).toEqual({ tone: "warn", text: "断开了 —— 下面是断线前的" });
  });

  it("过了宽限期、什么都没有：只说断开了", () => {
    expect(linkStatus(false, true, false)).toEqual({ tone: "warn", text: "断开了" });
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/shared/appleSpring.test.ts tests/shared/linkStatus.test.ts`
Expected: FAIL，找不到 `../../src/shared/appleSpring.js` / `linkStatus.js`。

- [ ] **Step 3: 写实现**

`src/shared/appleSpring.ts`：

```ts
// Apple 的弹簧口径 → 物理三元组。
//
// Apple 把「质量 / 劲度 / 阻尼」换成了两个给设计师用的量：
//   damping ratio ζ —— 1.0 是临界阻尼（不过冲），< 1 会回弹
//   response —— 到达目标的快慢（秒），不是时长（弹簧没有固定时长）
// RN 的 Animated.spring 只吃物理量，这里做换算（质量取 1）：
//   ω₀ = 2π / response，stiffness = ω₀²，damping = 2ζω₀
//
// 从 mobile/src/theme.ts 挪到 src/shared：手机端的类型检查不在门禁里（#422），
// 纯函数放这儿才有测试跟着根门禁跑。
export interface SpringPhysics {
  stiffness: number;
  damping: number;
  mass: number;
}

export function appleSpring(response: number, dampingRatio = 1): SpringPhysics {
  const w0 = (2 * Math.PI) / response;
  return { stiffness: Math.round(w0 * w0), damping: Math.round(2 * dampingRatio * w0), mass: 1 };
}
```

`src/shared/linkStatus.ts`：

```ts
// 手机到自己那台电脑的加密连接（ADR-0094 那条中继路），此刻用一句话怎么说。
//
// 原来挂在手机顶部的品牌栏上；三栏之后品牌栏没了，这句话挪到项目栏大标题底下
// （项目栏就是这条连接的消费方），账号页也读它。两处说的是同一件事，判据只能有一份。
//
// tone 只承担「哪一类」，话由 text 说全——不靠颜色单独传信息。
export type LinkTone = "ok" | "warn";

export interface LinkStatus {
  tone: LinkTone;
  text: string;
}

/**
 * @param ready 握手完成、密封流通着
 * @param settled 断开已经超过宽限期（6 秒）——在那之前一律当抖动看，不说「断开了」
 * @param hasSnapshot 手里还留着断线前那份舰队：要说清楚下面看到的是旧的
 */
export function linkStatus(ready: boolean, settled: boolean, hasSnapshot: boolean): LinkStatus {
  if (ready) return { tone: "ok", text: "已连上你的 Mac" };
  if (!settled) return { tone: "warn", text: "重连中…" };
  return { tone: "warn", text: hasSnapshot ? "断开了 —— 下面是断线前的" : "断开了" };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/shared/appleSpring.test.ts tests/shared/linkStatus.test.ts`
Expected: PASS（8 条）。

- [ ] **Step 5: `mobile/src/theme.ts` 改成 re-export**

在文件顶部 `import { Platform, useColorScheme } from "react-native";` 下面加一行：

```ts
import { appleSpring } from "../../src/shared/appleSpring.js";
```

把整段 `/** 弹簧参数。Apple 把物理三元组…` 注释连同 `export function spring(response: number, zeta = 1) { … }` 换成：

```ts
/**
 * 弹簧参数：Apple 的 response / damping ratio 换成 RN 吃的物理量。换算本身住在
 * src/shared/appleSpring.ts（有测试跟着根门禁跑），这里只是给手机端一个短名字。
 * 默认一律临界阻尼——回弹只留给"手上带着动量"的手势，而不是一个淡入的菜单。
 */
export const spring = appleSpring;
```

`PRESS_SPRING = spring(0.15)` 那一行不动。

- [ ] **Step 6: 两道检查**

Run: `npm --prefix mobile run typecheck && npm test`
Expected: 都是 0。

- [ ] **Step 7: Commit**

```bash
git add src/shared/appleSpring.ts src/shared/linkStatus.ts tests/shared/appleSpring.test.ts tests/shared/linkStatus.test.ts mobile/src/theme.ts
git commit -m "feat(shared): 弹簧换算与连接状态两个纯函数挪进 src/shared（#1237 M0）

手机端的类型检查不在门禁里（#422），能测的判断只有住在 src/shared 才有测试守着。
linkStatus 是原来品牌栏上那句话：三栏之后它挪到项目栏大标题底下，账号页也读它。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 3: 把 `App.tsx` 拆成三块（行为不变）

`App.tsx` 73 KB、一个文件装着全部界面。Task 4 要把这些屏挂进导航，先纯机械地拆开，**一个字的逻辑都不改**，好让审的人只看「搬得对不对」。

**Files:**
- Create: `mobile/src/projects/clock.ts`、`mobile/src/projects/Fleet.tsx`、`mobile/src/projects/SessionView.tsx`、`mobile/src/account/AccountScreen.tsx`、`mobile/src/pair/PairScreen.tsx`
- Modify: `mobile/App.tsx`

**Interfaces:**
- Consumes: 无（Task 1 的依赖这一步用不上）
- Produces（名字这一步都不改，Task 4 再改）：
  - `mobile/src/projects/Fleet.tsx`：`export function Fleet(props)`、`export interface ConnStatus { tone: "ok" | "warn"; text: string }`
  - `mobile/src/projects/SessionView.tsx`：`export function SessionView(props)`、`export function Approval(props)`
  - `mobile/src/projects/clock.ts`：`export function useTicker(active: boolean): number`、`export function elapsed(since: number, now: number): string`
  - `mobile/src/account/AccountScreen.tsx`：`export function Settings(props)`
  - `mobile/src/pair/PairScreen.tsx`：`export function Pair(props)`

- [ ] **Step 1: 把下面的脚本存成 `/tmp/split_app.py`，在仓库根跑 `python3 /tmp/split_app.py`**

每一处切口都断言「这个锚点在文件里恰好出现一次」，对不上就抛错、什么都不写。

```python
import pathlib

ROOT = pathlib.Path("mobile")
app = (ROOT / "App.tsx").read_text(encoding="utf-8")

def at(s, anchor):
    n = s.count(anchor)
    assert n == 1, f"锚点 {anchor!r} 出现了 {n} 次"
    return s.index(anchor)

i_pair = at(app, "/* ── 配对 ")
i_tabs = at(app, "/* ── 底栏与三个页签 ")
i_settings = at(app, "/* ── 设置 ")
i_fleet = at(app, "/* ── 舰队 ")
i_clock = at(app, "/** 一秒一跳的钟。")
i_wshead = at(app, "/** 工作区组头。")
i_session = at(app, "/* ── 会话详情 ")
assert i_pair < i_tabs < i_settings < i_fleet < i_clock < i_wshead < i_session

pair = app[i_pair:i_tabs]
tabs = app[i_tabs:i_settings]
settings = app[i_settings:i_fleet]
fleet = app[i_fleet:i_clock] + app[i_wshead:i_session]
clock = app[i_clock:i_wshead]
session = app[i_session:]

# ConnStatus 挪去 Fleet.tsx：Fleet 的 props 用它，App 里的 Shell / BrandBar 从那边 import
i_cs = at(tabs, "/** 顶栏右边那一句。")
cs_tail = 'interface ConnStatus { tone: "ok" | "warn"; text: string }\n'
i_cs_end = at(tabs, cs_tail) + len(cs_tail)
conn = tabs[i_cs:i_cs_end].replace("interface ConnStatus", "export interface ConnStatus")
tabs = tabs[:i_cs] + tabs[i_cs_end:]

def export(src, sig):
    assert src.count(sig) == 1, sig
    return src.replace(sig, "export " + sig)

pair = export(pair, "function Pair({")
settings = export(settings, "function Settings({")
fleet = export(fleet, "function Fleet({")
session = export(export(session, "function SessionView({"), "function Approval({")
clock = export(export(clock, "function useTicker("), "function elapsed(")

PAIR_HEAD = '''// 扫码配对 / 6 位安全码配对。从 App.tsx 原样拆出来（#1237 M0），逻辑一个字没动。

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { View } from "react-native";
import type { PinnedPeerStore, RemotePeer } from "../../../src/shared/remote/devices.js";
import { decodePairingOffer } from "../../../src/shared/remote/pairing.js";
import { armPairing, devices } from "../session.js";
import { myLabel } from "../deviceLabel.js";
import { usePalette, radius, space } from "../theme.js";
import { Button, Card, CodeTiles, Headline, Hint, Note, Page, Spinner, Title, Warn } from "../ui.js";

'''

ACCOUNT_HEAD = '''// 账号页（原来底栏上的「设置」）。从 App.tsx 原样拆出来（#1237 M0），逻辑一个字没动；
// Task 4 把它挂进根栈、改名 AccountScreen。

import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View, type ViewStyle } from "react-native";
import type { PinnedPeerStore } from "../../../src/shared/remote/devices.js";
import { fmtTokens, type RemoteStats } from "../../../src/shared/remote/stats.js";
import { activityWindow, heatLevel, heatWeeks } from "../../../src/shared/sessionActivity.js";
import { fmtUsd } from "../../../src/shared/modelPricing.js";
import { RELAY_BASE } from "../session.js";
import { supabase } from "../supabase.js";
import { usePalette, type as t, space } from "../theme.js";
import { Card, Dot, Group, Headline, Meta, Page, Row, Title } from "../ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

'''

CLOCK_HEAD = '''// 会话列表与详情共用的两个小钟。从 App.tsx 拆出来（#1237 M0）：
// Fleet 与 SessionView 都要，放在任何一边都会让两者互相 import。

import { useEffect, useState } from "react";

'''

FLEET_HEAD = '''// 舰队：到自己那台电脑的加密连接 + 会话列表 + 审批。从 App.tsx 原样拆出来（#1237 M0），
// 逻辑一个字没动；Task 4 把它挂到项目栏的根上。

import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { IslandAgent, IslandFleet } from "../../../src/shared/shellBridge.js";
import type { MobileMessage, UpFrame } from "../../../src/shared/remote/frames.js";
import type { RemoteStats } from "../../../src/shared/remote/stats.js";
import { chunkUpload } from "../../../src/shared/remote/uploads.js";
import { groupByWorkspace, groupTone, type WorkspaceGroup } from "../../../src/shared/remote/groups.js";
import type { PinnedPeerStore } from "../../../src/shared/remote/devices.js";
import type { MobileBridge } from "../../../src/shared/remote/mobileBridge.js";
import { connect } from "../session.js";
import { prepareForUpload, type Picked } from "../attach.js";
import { usePalette, type as t, MONO, space } from "../theme.js";
import {
  Button, Card, Dot, FolderIcon, Headline, Hint, Meta, Page, Spinner, StatusLine, Tile, Title,
} from "../ui.js";
import { Approval, SessionView } from "./SessionView.js";
import { elapsed, useTicker } from "./clock.js";

'''

SESSION_HEAD = '''// 会话详情：时间线 + 就地审批 + 回一条话。从 App.tsx 原样拆出来（#1237 M0），逻辑一个字没动。

import { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { IslandAgent } from "../../../src/shared/shellBridge.js";
import type { MobileMessage } from "../../../src/shared/remote/frames.js";
import { UPLOAD_LIMITS } from "../../../src/shared/remote/uploads.js";
import { parseMarkdown, type Span as MdSpan } from "../../../src/shared/remote/markdown.js";
import { groupTimeline, splitTool } from "../../../src/shared/remote/timeline.js";
import {
  MAX_MB, NeedsRebuild, pickFiles, pickPhotos, takePhoto, tooBig, type Picked,
} from "../attach.js";
import { usePalette, type as t, MONO, radius, space } from "../theme.js";
import {
  Button, Card, DetailBar, Dot, Headline, Hint, Meta, Note, Spinner, StatusLine, Tile, useKeyboardInset,
} from "../ui.js";
import { elapsed } from "./clock.js";

'''

APP_IMPORTS = '''import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View,
  type ViewStyle,
} from "react-native";
import type { RemoteStats } from "../src/shared/remote/stats.js";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { Friends } from "./src/friends.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, radius, space } from "./src/theme.js";
import { Button, Divider, Dot, Note, Page, Spinner, TabIcon, useKeyboardInset } from "./src/ui.js";
import { Pair } from "./src/pair/PairScreen.js";
import { Settings } from "./src/account/AccountScreen.js";
import { Fleet, type ConnStatus } from "./src/projects/Fleet.js";
'''

new_app = app[:i_pair] + tabs
imp_start = at(new_app, 'import { useCallback, useEffect, useRef, useState } from "react";')
imp_tail = 'import appJson from "./app.json";\n'
imp_end = at(new_app, imp_tail) + len(imp_tail)
new_app = new_app[:imp_start] + APP_IMPORTS + new_app[imp_end:]

out = {
    "pair/PairScreen.tsx": PAIR_HEAD + pair,
    "account/AccountScreen.tsx": ACCOUNT_HEAD + settings,
    "projects/clock.ts": CLOCK_HEAD + clock,
    "projects/Fleet.tsx": FLEET_HEAD + conn + "\n" + fleet,
    "projects/SessionView.tsx": SESSION_HEAD + session,
}
for rel, text in out.items():
    p = ROOT / "src" / rel
    assert not p.exists(), f"{p} 已经存在"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
(ROOT / "App.tsx").write_text(new_app, encoding="utf-8")
print("拆完：", ", ".join(out))
```

- [ ] **Step 2: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。报「找不到名字 X」就补一行 import——**从 App.tsx 原来引它的那个模块引**，不改任何逻辑。

- [ ] **Step 3: 模拟器冒烟（行为必须一模一样）**

登录 → 配对页或舰队 → 点进一个会话看时间线 → 返回 → 底栏切到好友、设置，各看一眼。和 Task 1 那张截图对比，没有任何可见差别。

- [ ] **Step 4: Commit**

```bash
git add mobile/App.tsx mobile/src/projects mobile/src/account mobile/src/pair
git commit -m "refactor(mobile): App.tsx 拆出舰队 / 会话详情 / 账号 / 配对四块（行为不变，#1237 M0）

下一步要把这些屏挂进导航，先纯机械地拆开，审的人只需要看「搬得对不对」。
useTicker / elapsed 单独一个 clock.ts：舰队和会话详情都用，放哪边都会互相 import。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 4: 三栏导航壳

把 Task 3 拆出来的屏挂进导航：底下「任务 / 项目 / 团队」三栏（毛玻璃页签栏），每栏一个原生栈、根上是 iOS 原生大标题 + 右上头像；账号 / 好友 / 配对进根栈（推进来时盖住页签栏）。配对不再是进门的一步：没配过的人在项目栏里看到一张「还没配对电脑」的卡。品牌栏、旧底栏删掉，连接状态挪到项目栏大标题底下（`linkStatus`）。

**Files:**
- Create: `mobile/src/chrome.tsx`、`mobile/src/link.tsx`、`mobile/src/icons.tsx`、`mobile/src/haptics.ts`、`mobile/src/nav/types.ts`、`mobile/src/nav/TabBar.tsx`、`mobile/src/nav/AvatarButton.tsx`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/tabs/TasksRoot.tsx`、`mobile/src/tabs/TeamsRoot.tsx`、`mobile/src/tabs/ProjectsRoot.tsx`、`mobile/src/friends/FriendsScreen.tsx`
- Modify: `mobile/src/ui.tsx`（`Page`）、`mobile/src/projects/Fleet.tsx`、`mobile/src/projects/SessionView.tsx`、`mobile/src/account/AccountScreen.tsx`、`mobile/src/pair/PairScreen.tsx`、`mobile/src/friends.tsx`、`mobile/App.tsx`

**Interfaces:**
- Consumes: Task 2 的 `linkStatus` / `LinkStatus`；Task 3 的 `Fleet`、`SessionView`、`Settings`、`Pair`
- Produces:
  - `chrome.tsx`：`TAB_BAR_HEIGHT = 49`、`TabChromeProvider`、`useTabChrome(): { hidden: boolean; setHidden(h: boolean): void; inset: number }`、`useTabInset(): number`
  - `link.tsx`：`LinkProvider({ store, children })`、`useLink(): { store; status: LinkStatus | null; setStatus; stats: RemoteStats | null; setStats; askStats: RefObject<(() => void) | null>; pairEpoch: number; bumpPair(): void }`
  - `icons.tsx`：`Icon({ name, size?, stroke?, color })`、`type IconName = "spark" | "folder" | "people"`
  - `haptics.ts`：`hapticDecided()`、`hapticSent()`
  - `nav/types.ts`：`RootStackParams`（`Main` / `Account` / `Friends` / `Pair`）、`TabParams`、三个栈的参数表；全局 `ReactNavigation.RootParamList`
  - `nav/RootNavigator.tsx`：`RootNavigator()`
  - `account/AccountScreen.tsx`：`AccountScreen()`（原 `Settings` 改名、改成读 `useLink`）
  - `pair/PairScreen.tsx`：`PairScreen()`（外壳；`Pair` 本体不动）

- [ ] **Step 1: 页签栏的显隐与让位——`mobile/src/chrome.tsx`**

```tsx
// 页签栏的两件共享状态：此刻收着没有、屏幕底下要给它让出多少。
//
// 页签栏是浮在内容上的毛玻璃（demo 的 .tabbar），内容从它底下滚过去——所以滚动容器
// 要自己让出这么高（ui.tsx 的 Page 读 useTabInset()）。根栈里的屏（账号、好友、配对）
// 在 Provider 外面，拿到的是默认值 0。
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** 页签栏高度，不含底部安全区。49pt 是 iOS 底栏的标准高度 */
export const TAB_BAR_HEIGHT = 49;

interface TabChrome {
  /** 翻进会话详情这种「推进一层」的屏时收起来 */
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** 收起时为 0 */
  inset: number;
}

const Ctx = createContext<TabChrome>({ hidden: false, setHidden: () => {}, inset: 0 });

export function TabChromeProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [hidden, setHidden] = useState(false);
  const value = useMemo(
    () => ({ hidden, setHidden, inset: hidden ? 0 : TAB_BAR_HEIGHT + insets.bottom }),
    [hidden, insets.bottom],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabChrome(): TabChrome {
  return useContext(Ctx);
}

export function useTabInset(): number {
  return useContext(Ctx).inset;
}
```

- [ ] **Step 2: 到电脑那条连接的共享状态——`mobile/src/link.tsx`**

```tsx
// 到自己那台电脑那条加密连接的共享状态（ADR-0094 那条中继路）。
//
// 桥的生命周期归项目栏里的 Fleet（它握着连接）；这里只放**别的屏也要读**的：
// 一句话的状态（项目栏大标题底下、账号页）、桌面答回来的统计（账号页）、
// 「问一次统计」这个动作——只交动作，不交桥，别的屏能做的只有开口问。
// pairEpoch：每配对成功一次加一，项目栏拿它当 key 重建连接（新握手要带上刚扫到的 secret）。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LinkStatus } from "../../src/shared/linkStatus.js";
import type { RemoteStats } from "../../src/shared/remote/stats.js";
import type { PinnedPeerStore } from "../../src/shared/remote/devices.js";

interface LinkValue {
  store: PinnedPeerStore;
  status: LinkStatus | null;
  setStatus: (s: LinkStatus) => void;
  stats: RemoteStats | null;
  setStats: (s: RemoteStats) => void;
  askStats: RefObject<(() => void) | null>;
  pairEpoch: number;
  bumpPair: () => void;
}

const Ctx = createContext<LinkValue | null>(null);

export function LinkProvider({ store, children }: { store: PinnedPeerStore; children: ReactNode }) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [stats, setStats] = useState<RemoteStats | null>(null);
  const askStats = useRef<(() => void) | null>(null);
  const [pairEpoch, setPairEpoch] = useState(0);
  const bumpPair = useCallback(() => setPairEpoch((n) => n + 1), []);
  return (
    <Ctx.Provider value={{ store, status, setStatus, stats, setStats, askStats, pairEpoch, bumpPair }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLink(): LinkValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLink 只能在 LinkProvider 里面用");
  return v;
}
```

- [ ] **Step 3: 图标——`mobile/src/icons.tsx`**

```tsx
// 图标。路径逐字取自 demo 的图标表（.demo/mobile-app-redesign.html 里 `const P=` 那张），
// 24×24 视框、描边、圆头圆角——和过目的那版是同一份图形。用到哪个才抄哪个进来。
// 不引 lucide-react-native（spec §10）：demo 的 spark 不是 lucide 原图。
import Svg, { Path } from "react-native-svg";

const PATHS = {
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, stroke = 1.7, color }: {
  name: IconName;
  size?: number;
  stroke?: number;
  color: string;
}) {
  return (
    <Svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    >
      <Path d={PATHS[name]} />
    </Svg>
  );
}
```

- [ ] **Step 4: 触感——`mobile/src/haptics.ts`**

```ts
// 触感只在四处（spec §3.3）：批准 / 拒绝落定、发送、通话接通 / 挂断、抽屉吸附。多了就没人注意了。
// 这里只放已经有消费方的两处；通话跟 M7、抽屉跟 M2 一起进来。
// 失败一律吞掉：没有触感马达的设备（模拟器、部分安卓）不该因为这个抛错。
import * as Haptics from "expo-haptics";

/** 批准 / 拒绝发出去了 */
export function hapticDecided(): void {
  void Haptics.impactAsync(Haptics.ImpactStyle.Medium).catch(() => {});
}

/** 一条话发出去了 */
export function hapticSent(): void {
  void Haptics.impactAsync(Haptics.ImpactStyle.Light).catch(() => {});
}
```

- [ ] **Step 5: 路由表——`mobile/src/nav/types.ts`**

```ts
// 导航的路由表。根栈放「推进一层、盖住页签栏」的屏（账号、好友、配对）；
// 每个页签自己一个栈，M2 起各栏的会话页推在各自的栈里。
export type RootStackParams = {
  Main: undefined;
  Account: undefined;
  Friends: undefined;
  Pair: undefined;
};

export type TabParams = {
  TasksTab: undefined;
  ProjectsTab: undefined;
  TeamsTab: undefined;
};

export type TasksStackParams = { TasksRoot: undefined };
export type ProjectsStackParams = { ProjectsRoot: undefined };
export type TeamsStackParams = { TeamsRoot: undefined };

// 让不带泛型的 useNavigation() 也认得根栈里的屏：页签里的屏要跳到根栈（账号、配对），
// navigate 会沿着嵌套往上冒泡到认得这个名字的那一层
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParams {}
  }
}
```

- [ ] **Step 6: 页签栏——`mobile/src/nav/TabBar.tsx`**

```tsx
// 三栏的页签栏。浮在内容上的一层毛玻璃（demo 的 .tabbar：blur + 半透明 + 顶上一道细线），
// 内容从它底下滚过去——滚动容器自己让出 useTabInset() 那么高（ui.tsx 的 Page 已经让了）。
// 选中只靠颜色和线宽，不加下划线 / 底色；按下时图标缩到 .88（demo 同值）。
import { useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Icon, type IconName } from "../icons.js";
import { PRESS_SPRING, usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { TAB_BAR_HEIGHT, useTabChrome } from "../chrome.js";

const META: Record<string, { label: string; icon: IconName }> = {
  TasksTab: { label: "任务", icon: "spark" },
  ProjectsTab: { label: "项目", icon: "folder" },
  TeamsTab: { label: "团队", icon: "people" },
};

export function OttoTabBar({ state, navigation }: BottomTabBarProps) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const { hidden } = useTabChrome();
  if (hidden) return null;
  return (
    <View style={{
      position: "absolute", left: 0, right: 0, bottom: 0,
      height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom,
      flexDirection: "row",
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
    }}>
      <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />
      {state.routes.map((route, i) => {
        const meta = META[route.name];
        if (!meta) return null;
        const focused = state.index === i;
        return (
          <TabButton
            key={route.key} label={meta.label} icon={meta.icon} focused={focused}
            onPress={() => {
              const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
            }}
          />
        );
      })}
    </View>
  );
}

function TabButton({ label, icon, focused, onPress }: {
  label: string;
  icon: IconName;
  focused: boolean;
  onPress: () => void;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  // 反馈挂在按下上，不是抬手；关了动效就不缩（颜色变化本身还在）
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const color = focused ? c.foreground : c.mutedForeground;
  return (
    <Pressable
      accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label}
      onPressIn={() => to(0.88)} onPressOut={() => to(1)} onPress={onPress}
      style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 3 }}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Icon name={icon} size={24} stroke={focused ? 2 : 1.7} color={color} />
      </Animated.View>
      <Text style={{ fontSize: 10.5, lineHeight: 13, letterSpacing: 0.1, fontWeight: focused ? "600" : "500", color }}>
        {label}
      </Text>
    </Pressable>
  );
}
```

- [ ] **Step 7: 右上角的头像——`mobile/src/nav/AvatarButton.tsx`**

```tsx
// 页签根导航栏右边那颗头像：点进账号。按下缩到 .93（demo 的 .navbtn:active）。
// 名字 / 头像先取 OAuth 带来的 user_metadata；profiles 那份（桌面 lib/identity.ts 的裁决）等 M5 账号页一起接。
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { supabase } from "../supabase.js";
import { PRESS_SPRING } from "../theme.js";
import { Avatar, useReduceMotion } from "../ui.js";

export function AvatarButton() {
  const navigation = useNavigation();
  const reduce = useReduceMotion();
  const [me, setMe] = useState<{ name: string; url?: string }>({ name: "" });
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = (u?.user_metadata ?? {}) as { name?: string; full_name?: string; avatar_url?: string };
      setMe({
        name: meta.name ?? meta.full_name ?? u?.email ?? "",
        ...(meta.avatar_url ? { url: meta.avatar_url } : {}),
      });
    });
  }, []);
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel="账号" hitSlop={8}
      onPressIn={() => to(0.93)} onPressOut={() => to(1)}
      onPress={() => navigation.navigate("Account")}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Avatar name={me.name} url={me.url} size={31} />
      </Animated.View>
    </Pressable>
  );
}
```

- [ ] **Step 8: 三栏的根——`mobile/src/tabs/TasksRoot.tsx`、`TeamsRoot.tsx`、`ProjectsRoot.tsx`**

`mobile/src/tabs/TasksRoot.tsx`：

```tsx
// 任务栏的根。M2（#1254）接上任务会话之前，这里是一句实话的空态——不画假数据。
import { Card, Headline, Hint, Page } from "../ui.js";

export function TasksRoot() {
  return (
    <Page>
      <Card>
        <Headline>任务栏下一步接上</Headline>
        <Hint>电脑上聊过的任务会话、手机上新开的，都会出现在这里。</Hint>
      </Card>
    </Page>
  );
}
```

`mobile/src/tabs/TeamsRoot.tsx`：

```tsx
// 团队栏的根。M3 接上团队云会话之前，这里是一句实话的空态——不画假数据。
import { Card, Headline, Hint, Page } from "../ui.js";

export function TeamsRoot() {
  return (
    <Page>
      <Card>
        <Headline>团队栏下一步接上</Headline>
        <Hint>团队的群聊、@ 和通话都会在这里。</Hint>
      </Card>
    </Page>
  );
}
```

`mobile/src/tabs/ProjectsRoot.tsx`：

```tsx
// 项目栏的根：到自己那台电脑的投影（ADR-0094），M4 之前就是原来那一页舰队。
// 配对不再是进门的一步（spec §4.1）：没配过的人在这里看到一张卡，点了去扫码。
import { useCallback, useLayoutEffect, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Button, Card, Headline, Hint, Page } from "../ui.js";
import { useLink } from "../link.js";
import { useTabChrome } from "../chrome.js";
import { Fleet } from "../projects/Fleet.js";

export function ProjectsRoot() {
  const navigation = useNavigation();
  const { store, pairEpoch } = useLink();
  const { setHidden } = useTabChrome();
  const [paired, setPaired] = useState(() => store.peerIdentities().length > 0);
  // PinnedPeerStore 没有订阅口：从配对页回来、或者重新配过一台，都重新数一遍
  useFocusEffect(useCallback(() => {
    setPaired(store.peerIdentities().length > 0);
  }, [store, pairEpoch]));

  // 点进一个会话 = 推进一层：大标题那条导航栏和页签栏一起让位（会话页自己有返回栏）
  const [inDetail, setInDetail] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !inDetail });
    setHidden(inDetail);
  }, [navigation, inDetail, setHidden]);

  const toPair = (): void => navigation.navigate("Pair");

  if (!paired) {
    return (
      <Page>
        <Card>
          <Headline>还没配对电脑</Headline>
          <Hint>项目住在你的电脑上。扫一下电脑「设置 → 手机」里那张码，这里就能看、能批、能接着说。</Hint>
          <Button label="扫码配一台电脑" onPress={toPair} />
        </Card>
      </Page>
    );
  }
  // key = 配对次数：重新配过一台就整条连接重建（原来是「重新配对」把整个壳卸掉，效果相同）
  return <Fleet key={pairEpoch} store={store} onRepair={toPair} onDetailChange={setInDetail} />;
}
```

- [ ] **Step 9: 好友挂进根栈——`mobile/src/friends/FriendsScreen.tsx`**

```tsx
// 好友从页签降到账号栈里（spec §4.6，M6 再换皮）。它自己有「加好友 / 聊天」两个内层屏，
// 各带一条自己的返回栏；翻进去时把根栈那条原生导航栏收起来，两条栏不叠。
// 页签上的角标（待处理请求 + 未读）三栏之后暂时没有地方画——M6 接回，ADR 里记着。
import { useCallback, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Friends } from "../friends.js";

export function FriendsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [inDetail, setInDetail] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !inDetail });
  }, [navigation, inDetail]);
  const ignoreBadge = useCallback((_n: number) => {}, []);
  return (
    // 导航栏收起时内层那条返回栏要自己躲开刘海和 home 条
    <View style={{ flex: 1, paddingTop: inDetail ? insets.top : 0, paddingBottom: inDetail ? insets.bottom : 0 }}>
      <Friends embedded onDetailChange={setInDetail} onBadge={ignoreBadge} />
    </View>
  );
}
```

- [ ] **Step 10: 根导航——`mobile/src/nav/RootNavigator.tsx`**

```tsx
// 导航的根。根栈：Main（三栏）+ 推进来盖住页签栏的屏（账号、好友、配对）。
// 每一栏自己一个原生栈（react-native-screens = UINavigationController）：推入 / 返回 / 左缘右划
// 都是系统的，天然可打断——spec §3.2。
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { usePalette } from "../theme.js";
import { TabChromeProvider } from "../chrome.js";
import { OttoTabBar } from "./TabBar.js";
import { AvatarButton } from "./AvatarButton.js";
import { TasksRoot } from "../tabs/TasksRoot.js";
import { ProjectsRoot } from "../tabs/ProjectsRoot.js";
import { TeamsRoot } from "../tabs/TeamsRoot.js";
import { AccountScreen } from "../account/AccountScreen.js";
import { FriendsScreen } from "../friends/FriendsScreen.js";
import { PairScreen } from "../pair/PairScreen.js";
import type {
  ProjectsStackParams, RootStackParams, TabParams, TasksStackParams, TeamsStackParams,
} from "./types.js";

const Root = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<TabParams>();
const TasksStack = createNativeStackNavigator<TasksStackParams>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParams>();
const TeamsStack = createNativeStackNavigator<TeamsStackParams>();

/** 导航的配色从 theme.ts 取：返回键是点缀色、导航栏底色就是地面 */
function useNavTheme(): Theme {
  const { c, isDark } = usePalette();
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.brand, background: c.background, card: c.background,
      text: c.foreground, border: c.border, notification: c.brand,
    },
  };
}

/**
 * 页签根的导航栏：iOS 原生大标题，往上滚时原地缩进导航条、材质出现（demo 的 .nav 就是在模仿它）。
 * 透明 + 模糊：内容从导航栏底下滚过去；滚动容器带 contentInsetAdjustmentBehavior="automatic"
 * （ui.tsx 的 Page 已经带了），大标题的收放才跟手。右边一颗头像进账号。
 */
function rootTab(title: string): NativeStackNavigationOptions {
  return {
    title,
    headerLargeTitle: true,
    headerTransparent: true,
    headerBlurEffect: "systemChromeMaterial",
    headerLargeStyle: { backgroundColor: "transparent" },
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerRight: () => <AvatarButton />,
  };
}

function TasksTab() {
  return (
    <TasksStack.Navigator>
      <TasksStack.Screen name="TasksRoot" component={TasksRoot} options={rootTab("任务")} />
    </TasksStack.Navigator>
  );
}

function ProjectsTab() {
  return (
    <ProjectsStack.Navigator>
      <ProjectsStack.Screen name="ProjectsRoot" component={ProjectsRoot} options={rootTab("项目")} />
    </ProjectsStack.Navigator>
  );
}

function TeamsTab() {
  return (
    <TeamsStack.Navigator>
      <TeamsStack.Screen name="TeamsRoot" component={TeamsRoot} options={rootTab("团队")} />
    </TeamsStack.Navigator>
  );
}

function Main() {
  return (
    <TabChromeProvider>
      {/* lazy:false：三栏一开 app 就都挂上。项目栏里握着到电脑的连接（握手 + 密封流），
          不能等人第一次点过去才开始连（原来三个页签「常驻挂载、靠 display 切」是同一个理由）。
          先落在项目栏：M0 里任务 / 团队两栏还是空态，M2 接上任务栏后改回 TasksTab（demo 登录后落在任务） */}
      <Tabs.Navigator
        initialRouteName="ProjectsTab"
        screenOptions={{ headerShown: false, lazy: false }}
        tabBar={(p) => <OttoTabBar {...p} />}
      >
        <Tabs.Screen name="TasksTab" component={TasksTab} />
        <Tabs.Screen name="ProjectsTab" component={ProjectsTab} />
        <Tabs.Screen name="TeamsTab" component={TeamsTab} />
      </Tabs.Navigator>
    </TabChromeProvider>
  );
}

export function RootNavigator() {
  const theme = useNavTheme();
  return (
    <NavigationContainer theme={theme}>
      <Root.Navigator>
        <Root.Screen name="Main" component={Main} options={{ headerShown: false }} />
        <Root.Screen name="Account" component={AccountScreen} options={{ title: "账号", headerBackTitle: "返回" }} />
        <Root.Screen name="Friends" component={FriendsScreen} options={{ title: "好友" }} />
        <Root.Screen name="Pair" component={PairScreen} options={{ title: "配对电脑", headerBackTitle: "返回" }} />
      </Root.Navigator>
    </NavigationContainer>
  );
}
```

- [ ] **Step 11: `mobile/src/ui.tsx` 的 `Page` 给页签栏让位**

import 区加一行：

```ts
import { useTabInset } from "./chrome.js";
```

把 `export function Page(...)` 整个换成：

```tsx
export function Page({ children, grow }: { children: React.ReactNode; grow?: boolean }) {
  // 页签栏是浮在内容上的毛玻璃:最后一行要让出它那么高,否则压在它底下(根栈里的屏拿到 0)
  const tabInset = useTabInset();
  return (
    <ScrollView
      // 原生导航栏(尤其页签根那条透明的大标题栏)靠这一格把内容推到栏下面,
      // 大标题往上滚时的收放也靠它跟手;不在导航里的屏(进门)这一格什么都不做
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        { padding: space.lg, paddingBottom: space.xl + tabInset, gap: space.md },
        grow && { flexGrow: 1 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
```

- [ ] **Step 12: `mobile/src/projects/Fleet.tsx` 接上 `useLink` / `linkStatus`**

import 区（`FLEET_HEAD` 那一段）末尾加：

```ts
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { linkStatus } from "../../../src/shared/linkStatus.js";
import { useLink } from "../link.js";
import { hapticDecided } from "../haptics.js";
```

删掉文件头部 Task 3 挪进来的那段 `/** 顶栏右边那一句。… */` 注释连同 `export interface ConnStatus { … }`（`LinkStatus` 取代它）。

然后逐处替换（用 Edit，旧文本必须原样匹配）。

① 函数签名。旧：

```ts
export function Fleet({ store, onRepair, onDetailChange, onStatus, onStats, askStats }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  /** 翻进详情屏时底栏要收起来 */
  onDetailChange: (inDetail: boolean) => void;
  /** 连接状态报给品牌栏 —— 桥在这儿,栏在上面 */
  onStatus: (s: ConnStatus) => void;
  /** 桌面答回来的统计。设置页要,而桥在这儿 */
  onStats: (s: RemoteStats) => void;
  /** 把"问一次"这个动作交出去。**只交动作,不交桥** ——
      桥的生命周期归这一屏,别的屏能做的只有开口问 */
  askStats: React.RefObject<(() => void) | null>;
}) {
```

新：

```ts
export function Fleet({ store, onRepair, onDetailChange }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  /** 翻进详情屏时,项目栏的大标题与页签栏都要让位 */
  onDetailChange: (inDetail: boolean) => void;
}) {
  // 连接状态、统计、「问一次」这个动作交给 LinkProvider:项目栏大标题底下那行与账号页都读它。
  // **只交数据和动作,不交桥** —— 桥的生命周期仍然归这一屏
  const { setStatus, setStats, askStats } = useLink();
  /** 会话详情要自己躲开刘海和 home 条:那时原生导航栏收着 */
  const insets = useSafeAreaInsets();
```

② `else if (f.type === "stats") onStats(f.stats);` → `else if (f.type === "stats") setStats(f.stats);`

③ 连接那个 effect 末尾的两行注释：

```ts
    // onStats 每次 render 都是新的(Shell 的 setState 其实是稳的,但类型上不保证),
    // 而这条连接一辈子只建一次 —— 让它进依赖等于每次渲染都重连
```

换成：

```ts
    // 这条连接一辈子只建一次 —— 让 setStats / askStats 进依赖,等于冒着每次渲染都重连的险
```

④ 报状态的 effect。旧：

```ts
  useEffect(() => {
    onStatus(ready
      ? { tone: "ok", text: "已连上你的 Mac" }
      : { tone: "warn", text: settled ? "断开了" : "重连中…" });
  }, [ready, settled, onStatus]);
```

新：

```ts
  // 判据在 shared/linkStatus.ts:项目栏大标题底下那行与账号页读的是同一句话
  const link = linkStatus(ready, settled, fleet !== null);
  useEffect(() => {
    setStatus(link);
    // link 每次渲染都是新对象,按它的两格字段比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.tone, link.text, setStatus]);
```

⑤ `decide` 里发审批那几行。旧：

```ts
    // send 回 false = 会话没建立。不乐观更新:审批这种动作显示成"批了"
    // 而其实没发出去,比显示"没连上"糟糕得多
    bridge.current?.send({
      type: ok ? "approve" : "deny", sessionId: a.sessionId, callId,
    });
```

新：

```ts
    // send 回 false = 会话没建立。不乐观更新:审批这种动作显示成"批了"
    // 而其实没发出去,比显示"没连上"糟糕得多;触感也只在真发出去时给
    const sent = bridge.current?.send({
      type: ok ? "approve" : "deny", sessionId: a.sessionId, callId,
    }) ?? false;
    if (sent) hapticDecided();
```

⑥ 电脑不在线那一屏。旧：

```tsx
      <Page>
        <View style={{ gap: space.sm, paddingTop: space.xl }}>
          <Title>你的 Mac 不在线</Title>
          <Hint>它上线之后这里会自动出现。中继不落盘,期间发生的事不会补播。</Hint>
        </View>
        <Button label="重新配对" variant="plain" onPress={onRepair} />
      </Page>
```

新（大标题「项目」由导航栏画，这里不再有第二个大标题）：

```tsx
      <Page>
        <StatusLine tone={link.tone}>{link.text}</StatusLine>
        <Card>
          <Headline>你的 Mac 不在线</Headline>
          <Hint>它上线之后这里会自动出现。中继不落盘,期间发生的事不会补播。</Hint>
        </Card>
        <Button label="重新配对" variant="plain" onPress={onRepair} />
      </Page>
```

⑦ 会话详情套一层安全区。旧：

```tsx
  if (opened) {
    return (
      <SessionView
        agent={opened} now={now} messages={timeline} diag={diag} online={ready}
        notice={notice} onDismissNotice={() => setNotice(null)}
        onBack={closeSession} onDecide={decide}
        onSubmit={(text, files, p) => submitMessage(opened.sessionId, text, files, p)}
        onRetry={() => bridge.current?.send({ type: "watch", sessionId: opened.sessionId })}
      />
    );
  }
```

新（`SessionView` 的属性一个不改）：

```tsx
  if (opened) {
    return (
      // 这时项目栏的原生导航栏收着:自己躲开刘海和 home 条
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <SessionView
          agent={opened} now={now} messages={timeline} diag={diag} online={ready}
          notice={notice} onDismissNotice={() => setNotice(null)}
          onBack={closeSession} onDecide={decide}
          onSubmit={(text, files, p) => submitMessage(opened.sessionId, text, files, p)}
          onRetry={() => bridge.current?.send({ type: "watch", sessionId: opened.sessionId })}
        />
      </View>
    );
  }
```

⑧ 列表页的抬头。旧：

```tsx
    <Page>
      <View style={{ paddingTop: space.sm }}><Title>会话</Title></View>
      {/* 品牌栏上那个点只说"断了",说不出"你正在看的是旧的"。这一句只在
          真断线、而且手里确实还留着上一份快照时出现 */}
      {ready || !settled ? null : (
        <StatusLine tone="warn">断开了 —— 下面是断线前的</StatusLine>
      )}
```

新：

```tsx
    <Page>
      {/* 大标题「项目」是原生导航栏画的;它底下这一行说到电脑那条连接此刻怎么样
          (原来挂在品牌栏上)。断线时它会说「下面是断线前的」 */}
      <StatusLine tone={link.tone}>{link.text}</StatusLine>
```

- [ ] **Step 13: `mobile/src/projects/SessionView.tsx` 两处**

import 区加 `import { hapticSent } from "../haptics.js";`。

① 返回栏的字：`back="会话" title={a.title ?? a.sessionId} onBack={onBack}` → `back="项目" title={a.title ?? a.sessionId} onBack={onBack}`

② `Composer` 的 `submit` 里，发成功之后给触感。旧：

```ts
        if (why) return setErr(why);
        // 发出去了才清空:失败时把人打的字和选的文件一起吞掉是不可接受的
```

新：

```ts
        if (why) return setErr(why);
        hapticSent();
        // 发出去了才清空:失败时把人打的字和选的文件一起吞掉是不可接受的
```

- [ ] **Step 14: `mobile/src/account/AccountScreen.tsx`（原 `Settings`）改成根栈里的一屏**

import 区：`import { useEffect, useRef, useState } from "react";` → `import { useCallback, useEffect, useRef, useState } from "react";`，再加：

```ts
import { useNavigation } from "@react-navigation/native";
import { useLink } from "../link.js";
```

① 签名。旧：

```ts
export function Settings({
  store, onRepair, onSignedOut, stats, online, active, onRefreshStats,
}: {
  store: PinnedPeerStore;
  onRepair: () => void;
  onSignedOut: () => void;
  /** 桌面答回来的统计。null = 还没问到(没连上,或刚翻进来) */
  stats: RemoteStats | null;
  online: boolean;
  /** 这一屏此刻是不是当前页签。三个页签都常驻挂载,不看这个就不知道人翻过来了 */
  active: boolean;
  onRefreshStats: () => void;
}) {
```

新：

```ts
export function AccountScreen() {
  const navigation = useNavigation();
  // 到电脑那条连接归项目栏的 Fleet;这一屏只读它报上来的状态与统计,要统计时开口问一次
  const { store, status, stats, askStats } = useLink();
  const online = status?.tone === "ok";
  const onRefreshStats = useCallback(() => { askStats.current?.(); }, [askStats]);
```

② 问统计的 effect。旧：

```ts
  useEffect(() => {
    if (active && online) onRefreshStats();
  }, [active, online, onRefreshStats]);
```

新（推进这一屏就是「翻过来了」，不再需要 `active`）：

```ts
  useEffect(() => {
    if (online) onRefreshStats();
  }, [online, onRefreshStats]);
```

③ 退出登录：删掉 `signOut` 里的 `onSignedOut();` 那一行，并在 `const signOut` 上面加一行注释 `// 登出之后回登录页由 App 那层的 onAuthStateChange 接住,这一屏不用管`。

④ 大标题。旧：

```tsx
      <View style={{ paddingTop: space.sm }}><Title>设置</Title></View>

      {/* 组与组之间比组内的行远一档,眼睛才会先分组再读行 */}
```

新：

```tsx
      {/* 标题「账号」是原生导航栏画的。组与组之间比组内的行远一档,眼睛才会先分组再读行 */}
```

⑤ 在「账号」那组（邮箱那一行所在的 `<Group header="账号" …>`）后面加一组：

```tsx
        {/* 好友从页签降到这里(spec §4.6);M6 设置页换皮时连同角标一起接回 */}
        <Group>
          <Row label="好友" chevron onPress={() => navigation.navigate("Friends")} />
        </Group>
```

⑥ `<Row label="重新配对" chevron onPress={onRepair} />` → `<Row label="重新配对" chevron onPress={() => navigation.navigate("Pair")} />`

- [ ] **Step 15: `mobile/src/pair/PairScreen.tsx`：去掉三处大标题 + 加外壳**

import 区加：

```ts
import { useNavigation } from "@react-navigation/native";
import { useLink } from "../link.js";
```

① 相机权限那一支，旧：

```tsx
        <View style={{ gap: space.xs, paddingTop: space.sm }}>
          <Title>扫码配对</Title>
        </View>
        <Card>
```

新：

```tsx
        <Card>
```

② 扫码那一支，旧：

```tsx
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>扫码配对</Title>
        <Hint>对准电脑「设置 → 手机」里那张二维码。</Hint>
      </View>
```

新：

```tsx
      <Hint>对准电脑「设置 → 手机」里那张二维码。</Hint>
```

③ 6 位码那一支，旧：

```tsx
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>配对电脑</Title>
```

新：

```tsx
      <View style={{ gap: space.xs }}>
```

④ 文件末尾加外壳：

```tsx
/** 根栈里的配对页。标题「配对电脑」是原生导航栏画的;配成之后回到来的地方,
    项目栏按 pairEpoch 重建连接(新握手要带上刚扫到的那把 secret) */
export function PairScreen() {
  const navigation = useNavigation();
  const { store, bumpPair } = useLink();
  return (
    <Pair
      store={store}
      onPaired={() => {
        bumpPair();
        navigation.goBack();
      }}
    />
  );
}
```

- [ ] **Step 16: `mobile/src/friends.tsx` 加 `embedded`**

① 签名。旧：

```ts
export function Friends({ onDetailChange, onBadge }: {
  /** 翻进「加好友」或某条聊天 = 推进一层,底栏要收起来 */
  onDetailChange: (inDetail: boolean) => void;
  /** 页签上那个红点该显示多少:待我处理的请求 + 没看过的消息 */
  onBadge: (n: number) => void;
}) {
```

新：

```ts
export function Friends({ onDetailChange, onBadge, embedded = false }: {
  /** 翻进「加好友」或某条聊天 = 推进一层,外壳要把自己那条原生导航栏收起来 */
  onDetailChange: (inDetail: boolean) => void;
  /** 待我处理的请求 + 没看过的消息。好友不再是页签之后这个数暂时没有地方画(M6 接回) */
  onBadge: (n: number) => void;
  /** 挂在根栈里、头上已经有一条写着「好友」的原生导航栏:不再画自己的大标题 */
  embedded?: boolean;
}) {
```

② 列表页抬头。旧：

```tsx
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>好友</Title>
        {live ? null : <Hint>实时推送没通，正在每隔几秒对一次表。</Hint>}
      </View>
```

新：

```tsx
      {embedded && live ? null : (
        <View style={{ gap: space.xs, paddingTop: embedded ? 0 : space.sm }}>
          {embedded ? null : <Title>好友</Title>}
          {live ? null : <Hint>实时推送没通，正在每隔几秒对一次表。</Hint>}
        </View>
      )}
```

- [ ] **Step 17: `mobile/App.tsx` 换成「开屏 → 登录 → 三栏」**

把下面的脚本存成 `/tmp/app_m0.py`，在仓库根跑 `python3 /tmp/app_m0.py`。它删掉旧的 `Shell` / 品牌栏 / 底栏（`/* ── 底栏与三个页签` 到文件末尾）与配对那一步，保留 `BootSpinner` / `Screen` / `SignIn` / `GitHubMark` / `PasswordForm` 原样。

```python
import pathlib

p = pathlib.Path("mobile/App.tsx")
s = p.read_text(encoding="utf-8")

def at(a):
    n = s.count(a)
    assert n == 1, f"锚点 {a!r} 出现了 {n} 次"
    return s.index(a)

i_imports = at('import { useCallback, useEffect, useRef, useState } from "react";')
i_phase = at('type Phase = "loading" | "signIn" | "pair" | "fleet";')
i_boot = at("/** 开屏那个转圈。")
i_tabs = at("/* ── 底栏与三个页签 ")
assert i_imports < i_phase < i_boot < i_tabs

HEADER = '''// 手机端的入口：开屏 → 登录 → 三栏（任务 / 项目 / 团队）。
//
// 三栏的导航在 src/nav/（ADR-0293）：每一栏一个原生栈，账号 / 好友 / 配对在根栈里。
// 配对不再是进门的一步——项目栏里没配过就给一张卡（spec §4.1）。
// 视觉语言全部来自 src/theme.ts（逐值抄自桌面的 app.css），组件在 src/ui.tsx。

'''

IMPORTS = '''import { useEffect, useState } from "react";
import { Image, SafeAreaView, StatusBar, Text, TextInput, View } from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, radius, space } from "./src/theme.js";
import { Button, Divider, Note, Page, Spinner, useKeyboardInset } from "./src/ui.js";
import { LinkProvider } from "./src/link.js";
import { RootNavigator } from "./src/nav/RootNavigator.js";
'''

APP_FN = '''type Phase = "loading" | "signIn" | "main";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [store, setStore] = useState<PinnedPeerStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await openStore();
      setStore(s);
      const { data } = await supabase.auth.getSession();
      setPhase(data.session ? "main" : "signIn");
    })().catch((e: unknown) => setError(String(e)));
    // 退出登录（账号页）/ session 过期 → 回登录页。登录成功那条路由 SignIn 的 onDone 走。
    // 订阅时会先来一发 INITIAL_SESSION：开屏还没读完 session 时不抢着改 phase
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) setPhase((p) => (p === "loading" ? p : "signIn"));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (error) {
    return (
      <SafeAreaProvider>
        <Screen center><Note tone="error">{error}</Note></Screen>
      </SafeAreaProvider>
    );
  }

  if (phase === "main" && store) {
    return (
      <SafeAreaProvider>
        <ExpoStatusBar style="auto" />
        <LinkProvider store={store}>
          <RootNavigator />
        </LinkProvider>
      </SafeAreaProvider>
    );
  }

  const booting = !store || phase === "loading";
  return (
    <SafeAreaProvider>
      {/* 开屏与登录页共用**同一个** <Screen>：拆成两次 return 的话中间那块 WebView
          会卸载再挂载，拿到 session 那一刻波场从头重启一次 */}
      <Screen dither center={booting}>
        {booting ? <BootSpinner /> : <SignIn onDone={() => setPhase("main")} />}
      </Screen>
    </SafeAreaProvider>
  );
}

'''

p.write_text(HEADER + IMPORTS + "\n" + APP_FN + s[i_boot:i_tabs].rstrip() + "\n", encoding="utf-8")
print("App.tsx 换好了")
```

- [ ] **Step 18: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。

- [ ] **Step 19: 模拟器验收**（深浅色各一遍）

1. 已登录冷启动：落在「项目」栏，原生大标题「项目」、右上一颗头像，大标题底下一行连接状态（「重连中…」→「已连上你的 Mac」）。截图 `/tmp/otto-t4-projects.png`，对照 demo 的 projects 屏（数据不同，只看版式：大标题、头像、毛玻璃页签栏）。
2. 列表往上滚：大标题原地缩进导航条、材质出现；松手回弹跟手。
3. 页签栏：毛玻璃、三格（任务 / 项目 / 团队）、图标与 demo 同形；切到任务、团队是两张实话空态卡。
4. 头像 → 「账号」（左上「返回」），没有第二个大标题；「好友」→ 好友列表（左上「账号」），点一个好友进聊天时原生导航栏收起、聊天自己的返回栏在刘海下面；「重新配对」→「配对电脑」。
5. 项目栏点进一个会话：导航栏与页签栏一起收起，会话页的返回栏写「项目」、不压刘海，输入框不压 home 条；返回后两者回来。
6. 批准 / 发送时手上有一下触感（真机才有，模拟器跳过）。
7. 账号 → 退出登录：回到登录页。
8. 系统设置里打开「减弱动态效果」：页签按下不缩放，其余照常。

- [ ] **Step 20: Commit**

```bash
git add mobile/App.tsx mobile/src
git commit -m "feat(mobile): 三栏导航壳——任务 / 项目 / 团队 + 根栈里的账号、好友、配对（#1237 M0）

每一栏一个原生栈（react-native-screens），根上是 iOS 原生大标题 + 右上头像，
页签栏是浮在内容上的毛玻璃，图标用 demo 同一份路径。今天的功能原样搬进来：
舰队挂在项目栏根上、设置改名账号推进根栈、好友从页签降到账号里。
配对不再是进门的一步：没配过的人在项目栏里看到一张卡。
品牌栏删了，连接状态挪到项目栏大标题底下（shared/linkStatus.ts）。

已知：好友的角标（待处理请求 + 未读）三栏之后暂时没有地方画，M6 接回。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

## M1 · 进门

### Task 5: 进门的判据挪进 `src/shared`（两端共用）

手机的进门要和桌面说同一套话（登录报错怎么翻、验证码几位、等确认信多久探一次、冷启动停多久）。这些判据今天住在桌面渲染层；挪进 `src/shared/`，桌面改 import 路径，手机直接用同一份。顺带新增两个手机要的纯函数：验证码格子怎么画（`otpCells`）、进门此刻画哪一屏（`gateView`）。

**Files:**
- Move（`git mv`）：`src/renderer/src/lib/forgotPassword.ts` → `src/shared/forgotPassword.ts`；`src/renderer/src/lib/signInForm.ts` → `src/shared/signInForm.ts`；`src/renderer/src/lib/splashProgress.ts` → `src/shared/splashProgress.ts`；`src/renderer/src/lib/authError.ts` → `src/shared/authError.ts`
- Move tests：`tests/renderer/forgotPassword.test.ts` → `tests/shared/`；`tests/renderer/signInForm.test.ts` → `tests/shared/`；`tests/renderer/lib/splashProgress.test.ts` → `tests/shared/`；`tests/renderer/confirmEmailPoll.test.ts` → `tests/shared/`
- Create：`src/shared/confirmEmailPoll.ts`、`src/shared/mobileGate.ts`、`src/renderer/src/lib/authError.ts`（新的一层包装）、`tests/shared/authError.test.ts`、`tests/shared/mobileGate.test.ts`
- Modify：`src/renderer/src/components/{ForgotPasswordDialog,SignInCard,SetPasswordDialog,Splash,ConfirmEmailDialog}.tsx`（import 路径）、`src/renderer/src/store.ts`（一处注释里的路径）

**Interfaces:**
- Consumes: 无
- Produces:
  - `src/shared/forgotPassword.ts`：原有导出（`OTP_LENGTH`、`RESEND_COOLDOWN_S`、`ForgotStep`、`normalizeOtp`、`canSubmitOtp`、`resendLabel`）+ 新 `interface OtpCell { ch: string; cursor: boolean }`、`otpCells(code: string): OtpCell[]`
  - `src/shared/signInForm.ts`：原有导出（`SignInMode`、`SignInFormState`、`MIN_PASSWORD`、`NAME_MAX`、`canSubmitSignIn`、`confirmHint`）
  - `src/shared/authError.ts`：`interface AuthNotice { title: string; hint?: string; raw?: string }`、`authNoticeOf(raw: string): AuthNotice`、`localEmailProblem(email: string): string | null`
  - `src/renderer/src/lib/authError.ts`：导出与之前**完全相同**（`authNotice(e: unknown)`、`localEmailProblem`、`AuthNotice`），桌面其余代码不用改
  - `src/shared/splashProgress.ts`：`SPLASH_MIN_MS`、`splashProgress({ done, total, elapsedMs })`
  - `src/shared/confirmEmailPoll.ts`：`pollDelayMs(attempt: number): number`
  - `src/shared/mobileGate.ts`：`type GateView = "splash" | "signIn" | "resetHold" | "app"`、`interface GateInput { booted; splashDone; hasSession; resetHold }`、`gateView(s: GateInput): GateView`

- [ ] **Step 1: 搬文件**

```bash
git mv src/renderer/src/lib/forgotPassword.ts src/shared/forgotPassword.ts
git mv src/renderer/src/lib/signInForm.ts src/shared/signInForm.ts
git mv src/renderer/src/lib/splashProgress.ts src/shared/splashProgress.ts
git mv src/renderer/src/lib/authError.ts src/shared/authError.ts
git mv tests/renderer/forgotPassword.test.ts tests/shared/forgotPassword.test.ts
git mv tests/renderer/signInForm.test.ts tests/shared/signInForm.test.ts
git mv tests/renderer/lib/splashProgress.test.ts tests/shared/splashProgress.test.ts
git mv tests/renderer/confirmEmailPoll.test.ts tests/shared/confirmEmailPoll.test.ts
```

- [ ] **Step 2: 改路径**

- `src/shared/signInForm.ts`：`import { NAME_MAX } from "../../../shared/profile.js";` → `import { NAME_MAX } from "./profile.js";`
- `tests/shared/forgotPassword.test.ts`：`"../../src/renderer/src/lib/forgotPassword.js"` → `"../../src/shared/forgotPassword.js"`
- `tests/shared/signInForm.test.ts`：`"../../src/renderer/src/lib/signInForm.js"` → `"../../src/shared/signInForm.js"`
- `tests/shared/splashProgress.test.ts`：`"../../../src/renderer/src/lib/splashProgress.js"` → `"../../src/shared/splashProgress.js"`
- `tests/shared/confirmEmailPoll.test.ts`：`"../../src/renderer/src/components/ConfirmEmailDialog.js"` → `"../../src/shared/confirmEmailPoll.js"`
- `src/renderer/src/components/ForgotPasswordDialog.tsx`：`"../lib/forgotPassword.js"` → `"../../../shared/forgotPassword.js"`
- `src/renderer/src/components/SignInCard.tsx`、`SetPasswordDialog.tsx`：`"../lib/signInForm.js"` → `"../../../shared/signInForm.js"`
- `src/renderer/src/components/Splash.tsx`：`"../lib/splashProgress.js"` → `"../../../shared/splashProgress.js"`
- `src/renderer/src/store.ts`：注释里的 `（见 lib/splashProgress.ts）` → `（见 src/shared/splashProgress.ts）`

- [ ] **Step 3: `pollDelayMs` 从组件里剪出来**

新建 `src/shared/confirmEmailPoll.ts`，第一行写：

```ts
// 等确认邮件那张弹窗的探测节奏（issue #737）。两端共用：#1237 M1 从 ConfirmEmailDialog.tsx 挪来。
```

然后把 `src/renderer/src/components/ConfirmEmailDialog.tsx` 里 `export function pollDelayMs(attempt: number): number { … }` **连同它上面那段 `/** 第 n 次探测该等多久…*/` 注释**原样剪下来，贴到这一行下面。`ConfirmEmailDialog.tsx` 的 import 区加：

```ts
import { pollDelayMs } from "../../../shared/confirmEmailPoll.js";
```

- [ ] **Step 4: `authError` 拆成「两端共用的规则」+「桌面剥壳的包装」**

在搬过去的 `src/shared/authError.ts` 里做五处小改：

① 删掉 `import { bridgeErrorMessage } from "./bridgeError.js";` 这一行。

② 文件头那段分工说明，旧：

```ts
// 与 `bridgeError.ts` 的分工：那边剥的是**所有** IPC 调用共有的那层壳（通道名、
// `Error: ` 前缀、主进程版本错配），是通用的；这边翻的是**登录这件事**特有的
// 那批 supabase GoTrue 报文。所以这里先调它、再往下认。
```

新：

```ts
// 与 `bridgeError.ts` 的分工：那边剥的是**所有** IPC 调用共有的那层壳（通道名、
// `Error: ` 前缀、主进程版本错配），只有桌面有；这边翻的是**登录这件事**特有的
// 那批 supabase GoTrue 报文，桌面和手机共用这一份（#1237 M1）。桌面渲染层的
// `lib/authError.ts` 先剥壳再交给 `authNoticeOf`；手机端没有那层壳，直接交原文。
```

③ 「密码不对」那条规则，旧：

```ts
    re: /Invalid login credentials|invalid_credentials/i,
    of: () => ({ title: "邮箱或密码不对", hint: "再试一次，注意密码的大小写" }),
```

新（把手机端原来那句挪进来，两端都受益）：

```ts
    // 「密码不对」和「这个账号压根没有密码」（用 Google / GitHub 注册的）在 GoTrue 这里是同一句话，
    // 而后者在这个产品里更常见——两种都说出来，别让人在一个不存在的密码上试三遍
    // （手机端原有的那句，#1237 挪进来两端共用）
    re: /Invalid login credentials|invalid_credentials/i,
    of: () => ({
      title: "邮箱或密码不对",
      hint: "再试一次，注意大小写；用 Google / GitHub 注册的账号没有密码，走那两个按钮",
    }),
```

④ 入口函数，旧：

```ts
/**
 * 报错 → 给人看的那张卡的内容。
 *
 * 入参给什么都行：Error、字符串、store.error 里那份已经被 `bridgeErrorMessage`
 * 剥过壳的文本。剥壳是幂等的，重复调一次无害。
 */
export function authNotice(e: unknown): AuthNotice {
  const message = bridgeErrorMessage(e).trim();
```

新：

```ts
/**
 * 报错原文 → 给人看的那张卡的内容。入参是**已经剥过壳**的一句话
 * （桌面由渲染层 `lib/authError.ts` 剥 IPC 壳；手机端直接传 supabase 的 error.message）。
 */
export function authNoticeOf(raw: string): AuthNotice {
  const message = raw.trim();
```

⑤ 认中文那一行（原文里是字面的 CJK 区间）换成 `\u` 转义写法——手抄字形容易抄错码点，转义不会：

```ts
  if (/[\u4e00-\u9fff]/.test(message)) return { title: message };
```

然后在原位置新建 `src/renderer/src/lib/authError.ts`（桌面其余代码一行不用改）：

```ts
// 桌面渲染层那一层包装：先剥 Electron IPC 的壳（bridgeError.ts），再交给两端共用的规则表
// （src/shared/authError.ts，#1237 M1 挪过去的——手机端要同一份翻译）。
// 入参给什么都行：Error、字符串、store.error 里那份已经剥过壳的文本；剥壳是幂等的。
import { bridgeErrorMessage } from "./bridgeError.js";
import { authNoticeOf, type AuthNotice } from "../../../shared/authError.js";

export type { AuthNotice };
export { localEmailProblem } from "../../../shared/authError.js";

export function authNotice(e: unknown): AuthNotice {
  return authNoticeOf(bridgeErrorMessage(e));
}
```

`tests/renderer/authError.test.ts` 不动——它测的就是这层包装（含剥 IPC 壳那条），必须照旧全绿。

- [ ] **Step 5: 写新测试（先红）**

`tests/shared/authError.test.ts`：

```ts
// 登录报错翻译里两端共用的那一半（src/shared/authError.ts）。
// 桌面剥 IPC 壳的那层包装由 tests/renderer/authError.test.ts 守着；这里钉手机端直接用的那几条。

import { describe, expect, it } from "vitest";
import { authNoticeOf, localEmailProblem } from "../../src/shared/authError.js";

describe("authNoticeOf", () => {
  it("手机端直接交 supabase 原文：密码不对时两种可能都说出来", () => {
    const n = authNoticeOf("Invalid login credentials");
    expect(n.title).toBe("邮箱或密码不对");
    expect(n.hint).toContain("Google / GitHub");
  });

  it("空白原文不装成翻译过", () => {
    expect(authNoticeOf("   ").title).toBe("没成功，但没说原因");
  });

  it("本地预检那句与服务端同文，翻出来是同一条", () => {
    const bad = localEmailProblem("a@qq");
    expect(bad).not.toBeNull();
    expect(authNoticeOf(bad ?? "").title).toBe("这个邮箱地址填得不太对");
  });

  it("已经是中文的（我们自己写的话）原样当标题", () => {
    expect(authNoticeOf("主进程还是旧的一版").title).toBe("主进程还是旧的一版");
  });
});
```

`tests/shared/mobileGate.test.ts`：

```ts
// 手机端进门那道闸：此刻画冷启动、登录、「设新密码」还是主界面。

import { describe, expect, it } from "vitest";
import { gateView, type GateInput } from "../../src/shared/mobileGate.js";

const base: GateInput = { booted: true, splashDone: true, hasSession: true, resetHold: false };

describe("gateView", () => {
  it("冷启动没做完、或进度条没到头：都还是冷启动", () => {
    expect(gateView({ ...base, booted: false })).toBe("splash");
    expect(gateView({ ...base, splashDone: false })).toBe("splash");
  });

  it("没有 session：登录", () => {
    expect(gateView({ ...base, hasSession: false })).toBe("signIn");
  });

  it("没有 session 时「按住」不起作用——那是上一次没走完的残留", () => {
    expect(gateView({ ...base, hasSession: false, resetHold: true })).toBe("signIn");
  });

  it("有 session 但新密码还没设：按住闸门，不进 app", () => {
    expect(gateView({ ...base, resetHold: true })).toBe("resetHold");
  });

  it("其余：进 app", () => {
    expect(gateView(base)).toBe("app");
  });
});
```

`tests/shared/forgotPassword.test.ts`：import 那一段加上 `otpCells,`（和 `OTP_LENGTH` 等并排），文件末尾追加：

```ts
describe("otpCells", () => {
  it(`永远画 ${OTP_LENGTH} 格；光标停在第一个空格上`, () => {
    const cells = otpCells("123");
    expect(cells).toHaveLength(OTP_LENGTH);
    expect(cells.map((c) => c.ch).join("")).toBe("123");
    expect(cells.findIndex((c) => c.cursor)).toBe(3);
  });

  it("填满之后没有光标（交出去了）", () => {
    expect(otpCells("12345678").some((c) => c.cursor)).toBe(false);
  });

  it("画的是擦过的码：粘进来的整句只剩数字", () => {
    expect(otpCells("验证码：1234").slice(0, 4).map((c) => c.ch).join("")).toBe("1234");
  });
});
```

Run: `npx vitest run tests/shared/authError.test.ts tests/shared/mobileGate.test.ts tests/shared/forgotPassword.test.ts`
Expected: FAIL——`mobileGate.js` 不存在、`otpCells` 不是函数。

- [ ] **Step 6: 写实现**

`src/shared/mobileGate.ts`：

```ts
// 手机端进门那道闸：此刻该画冷启动、登录、「设新密码」还是主界面（#1237 M1）。
//
// 纯函数、四个输入，顺序就是优先级：
//   1. 冷启动没做完（身份库 + 读 session），或进度条没到头 → 冷启动。进度条是
//      「真实完成数 × 最短停留」两半合成（splashProgress），两边都满才放行
//   2. 没有 session → 登录
//   3. 有 session，但忘记密码那条路验完验证码、新密码还没设（也没明说跳过）→ 按住闸门。
//      同桌面 lib/identity.ts 的 showsSignInScreen（ADR-0194）：recovery OTP 换到的是
//      真 session，不按住的话一个旧密码原封不动的人就这么进去了
//   4. 其余 → 主界面
export type GateView = "splash" | "signIn" | "resetHold" | "app";

export interface GateInput {
  /** 冷启动那几步做完没有 */
  booted: boolean;
  /** 冷启动进度条到头没有（splashProgress === 1） */
  splashDone: boolean;
  hasSession: boolean;
  /** 找回密码验完验证码、新密码还没设完 */
  resetHold: boolean;
}

export function gateView(s: GateInput): GateView {
  if (!s.booted || !s.splashDone) return "splash";
  if (!s.hasSession) return "signIn";
  if (s.resetHold) return "resetHold";
  return "app";
}
```

`src/shared/forgotPassword.ts` 末尾追加：

```ts
/** 手机上那排验证码格子（4 + 4）的一格：有没有字、光标在不在这格 */
export interface OtpCell {
  ch: string;
  cursor: boolean;
}

/**
 * 手机端验证码那排格子怎么画（#1237 M1）。底下只有**一个**真输入框——粘贴、系统从邮件里
 * 递上来的码、退格全走它——格子只是它的画法：画擦过的码（normalizeOtp），光标停在第一个
 * 空格上；填满了就没有光标（demo 的 .otp：填满就交）。
 */
export function otpCells(code: string): OtpCell[] {
  const v = normalizeOtp(code);
  return Array.from({ length: OTP_LENGTH }, (_, i) => ({ ch: v[i] ?? "", cursor: i === v.length }));
}
```

- [ ] **Step 7: 全门禁**

Run: `npm test`
Expected: tsc 与 vitest 全绿；搬过去的四份旧测试一条不少地过。

再确认渲染层没有漏改的旧路径：

Run: `grep -rnE "lib/(forgotPassword|signInForm|splashProgress)|components/ConfirmEmailDialog\.js" src tests`
Expected: 没有输出。

- [ ] **Step 8: Commit**

```bash
git add -A src/shared src/renderer tests/shared tests/renderer
git commit -m "refactor(shared): 进门的判据挪进 src/shared，两端共用（#1237 M1）

验证码、登录表单、报错翻译、冷启动进度、等确认信的探测节奏原来住在桌面渲染层；
手机的进门要说同一套话，挪到 src/shared 后桌面只改 import 路径。authError 拆成
两半：规则表两端共用，剥 Electron IPC 壳的那层包装留在渲染层，导出不变。
「密码不对」的提示并进手机端原有的那句（OAuth 注册的账号没有密码），两端都说。
新增 otpCells（验证码格子怎么画）与 gateView（进门此刻画哪一屏）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```


### Task 6: 冷启动 + 进门闸（登录）

照 demo 的 splash / signin：开屏是一张脸 + 一条细进度条压在波场上（真实启动步数 × 最短停留 1200 ms，两边都满才放行）；闸门是脸 + 「Mr Otto」字标 + 一张玻璃卡（邮箱密码 → Google / GitHub）。报错贴在卡的上面，走 `authNoticeOf` 翻成人话。App 顶层改由 `gateView` 决定画哪一屏，登录 / 登出一律跟着 `onAuthStateChange` 走。

**Files:**
- Create: `mobile/src/gate/authActions.ts`、`mobile/src/gate/marks.tsx`、`mobile/src/gate/Wordmark.tsx`、`mobile/src/gate/Splash.tsx`、`mobile/src/gate/SignInCard.tsx`、`mobile/src/gate/GateScreen.tsx`、`mobile/assets/otto.png`
- Modify: `mobile/src/theme.ts`（`withAlpha`）、`mobile/src/ui.tsx`（`Button` 的 `secondary` 与两档尺寸、新 `Field`）、`mobile/App.tsx`（整份重写）、`mobile/package.json` / `package-lock.json`
- Delete: `mobile/assets/otto-head.png`、`mobile/assets/otto-mark.png`（Step 9 确认没人引用之后）

**Interfaces:**
- Consumes: Task 5 的 `gateView`、`splashProgress`、`canSubmitSignIn`、`authNoticeOf`、`localEmailProblem`、`AuthNotice`；Task 4 的 `RootNavigator`、`LinkProvider`
- Produces:
  - `theme.ts`：`withAlpha(hex: string, alpha: number): string`
  - `ui.tsx`：`ButtonVariant` 多一个 `"secondary"`；`Button` 的 `size` 多 `"dialog"`（46 高）、`"compact"`（42 高）；`Field(props)`，`props.variant?: "plain" | "gate" | "dialog"`
  - `gate/authActions.ts`：`errorText(e: unknown): string`、`signInWithPassword(email, password): Promise<void>`
  - `gate/GateScreen.tsx`：`GateScreen()`（Task 7 / 8 会给它加东西）
  - `gate/SignInCard.tsx`：`SignInCard({ onNotice })`，`onNotice: (n: AuthNotice | null) => void`
  - `gate/Splash.tsx`：`Splash({ progress })`；`gate/Wordmark.tsx`：`Wordmark()`；`gate/marks.tsx`：`GoogleMark({ size? })`、`GitHubMark({ size? })`

- [ ] **Step 1: 依赖与资源**

```bash
cd mobile && npx expo install expo-font @expo-google-fonts/poppins && cd ..
cp src/renderer/src/assets/otto.png mobile/assets/otto.png
```

Expected: `mobile/package.json` 多 `expo-font`（~57.0）与 `@expo-google-fonts/poppins`。`otto.png` 是桌面进门闸与开屏用的同一张脸（spec §3.4：logo 用桌面同一张）。

- [ ] **Step 2: `mobile/src/theme.ts` 加 `withAlpha`**（文件末尾追加）

```ts
/** 十六进制实色（#rrggbb）加透明度 → rgba。palette 里的实色都是 #rrggbb；
    本来就带透明度的那几格（mutedForeground / border / input）别往这里传——原样退回 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
```

- [ ] **Step 3: `mobile/src/ui.tsx` 的 `Button`：`secondary` 变体 + 两档尺寸**

① 类型：`export type ButtonVariant = "primary" | "outline" | "plain" | "quiet" | "destructive";` → `export type ButtonVariant = "primary" | "secondary" | "outline" | "plain" | "quiet" | "destructive";`，并在它上面那段变体说明里加一行 ` *   secondary 次级实底——弹窗里「不做这件事」那一颗（demo 的 .btn.sec），和主按钮等宽并排`。

② props 里的 `size?: "full" | "auto";` → `size?: "full" | "auto" | "dialog" | "compact";`，注释补一句：`dialog = 弹窗底下那排（46 高）；compact = 进门闸那张卡上（42 高）`。

③ 在 `export function Button` 上面加尺寸表：

```ts
/** 四档尺寸。高度照 demo：通栏 50、弹窗 46、进门闸 42、小胶囊 44 */
const BUTTON_SIZE = {
  full: { box: { borderRadius: radius.control, paddingVertical: 15, paddingHorizontal: space.md, minHeight: 50 }, font: 17 },
  dialog: { box: { borderRadius: radius.control, paddingVertical: 12, paddingHorizontal: space.md, minHeight: 46 }, font: 16 },
  compact: { box: { borderRadius: radius.control, paddingVertical: 10, paddingHorizontal: space.md, minHeight: 42 }, font: 15 },
  auto: { box: { borderRadius: radius.pill, paddingVertical: 11, paddingHorizontal: space.lg, minHeight: 44 }, font: 17 },
} as const;
```

④ 在 `const face: ViewStyle =` 那一串里，`v === "primary" ? { backgroundColor: c.primary }` 下面加一支 `: v === "secondary" ? { backgroundColor: c.secondary }`；`const fg =` 那一串里 `v === "primary" ? c.primaryForeground` 下面加 `: v === "secondary" ? c.secondaryForeground`。

⑤ 样式里那段尺寸三元，旧：

```tsx
          props.size === "auto"
            ? { borderRadius: radius.pill, paddingVertical: 11, paddingHorizontal: space.lg, minHeight: 44 }
            : { borderRadius: radius.control, paddingVertical: 15, paddingHorizontal: space.md, minHeight: 50 },
```

新：

```tsx
          BUTTON_SIZE[props.size ?? "full"].box,
```

⑥ 文字，旧：`<Text style={{ ...type.headline, color: fg }}>{props.label}</Text>`，新：

```tsx
        <Text style={{
          ...type.headline,
          fontSize: BUTTON_SIZE[props.size ?? "full"].font,
          lineHeight: BUTTON_SIZE[props.size ?? "full"].font + 5,
          color: fg,
        }}>
          {props.label}
        </Text>
```

- [ ] **Step 4: `mobile/src/ui.tsx` 加 `Field`**

react-native 那行 import 加上 `TextInput, type TextInputProps`；theme 那行 import 加上 `withAlpha`。文件末尾追加：

```tsx
/**
 * 能往里打字的框（demo 的 .input）。边框 1pt：平时 c.input（比 c.border 亮半档——一个能往里
 * 打字的框必须先让人看见它在哪）、聚焦时换点缀色、invalid 时换红（同桌面 Input 的 aria-invalid）。
 * 三档底色：
 *   plain  实底 card，46 高
 *   gate   进门闸上：card 的 60%，42 高——坐在会动的波场上，不透一点就是「贴」上去的
 *   dialog 弹窗里：前景色 5% 叠在弹窗那张 card 上（demo 的 color-mix(fg 5%, card)），46 高
 */
export function Field(props: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  variant?: "plain" | "gate" | "dialog";
  secure?: boolean;
  invalid?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  keyboardType?: TextInputProps["keyboardType"];
  autoComplete?: TextInputProps["autoComplete"];
  textContentType?: TextInputProps["textContentType"];
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: () => void;
}) {
  const { c } = usePalette();
  const [focused, setFocused] = useState(false);
  const v = props.variant ?? "plain";
  const bg = v === "gate" ? withAlpha(c.card, 0.6) : v === "dialog" ? withAlpha(c.foreground, 0.05) : c.card;
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={c.mutedForeground}
      secureTextEntry={props.secure}
      maxLength={props.maxLength}
      autoFocus={props.autoFocus}
      keyboardType={props.keyboardType ?? "default"}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete={props.autoComplete}
      textContentType={props.textContentType}
      returnKeyType={props.returnKeyType}
      onSubmitEditing={props.onSubmitEditing}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        height: v === "gate" ? 42 : 46,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: props.invalid ? c.destructive : focused ? c.brand : c.input,
        backgroundColor: bg,
        color: c.foreground,
        paddingHorizontal: 14,
        fontSize: 16,
      }}
    />
  );
}
```

- [ ] **Step 5: 进门的动作——`mobile/src/gate/authActions.ts`**

```ts
// 进门的动作，逐个对照桌面 src/main/account.ts 的 AccountManager：同一个 Supabase 项目、
// 同一个 redirectTo（边缘服务的落地页）。报错一律把 supabase 的原文抛出去，
// 由界面交给 shared/authError.ts 的 authNoticeOf 翻成人话。
// 这一份先放登录；注册（Task 7）与找回密码（Task 8）接着往下加。
import { supabase } from "../supabase.js";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 6: 标记与字标——`mobile/src/gate/marks.tsx`、`Wordmark.tsx`**

`mobile/src/gate/marks.tsx`（`GitHubMark` 从 `App.tsx` 搬来，注释照抄）：

```tsx
// 两颗第三方登录的标记。一律 20pt：两个标记的视觉重量差不多，给同一个尺寸就够齐。
import { Image } from "react-native";
import { usePalette } from "../theme.js";

export function GoogleMark({ size = 20 }: { size?: number }) {
  return <Image source={require("../../assets/google-mark.png")} style={{ width: size, height: size }} />;
}

/** GitHub 那个标记是**反白猫**:黑底挖出猫。深色下黑底就看不见了,
    换成白底那版 —— 挖出来的猫这时露的是页面底色,和浅色下同一个读法 */
export function GitHubMark({ size = 20 }: { size?: number }) {
  const { isDark } = usePalette();
  return (
    <Image
      source={isDark ? require("../../assets/github-mark-light.png") : require("../../assets/github-mark.png")}
      style={{ width: size, height: size }}
    />
  );
}
```

`mobile/src/gate/Wordmark.tsx`：

```tsx
// 「Mr Otto」字标：Poppins SemiBold Italic，同桌面进门闸那一行（SignInScreen.tsx，app.css 的 @font-face）。
// 字体没加载出来之前退成系统的斜体半粗——这一行照样读得出是同一个字标，不闪一个空位。
import { Text } from "react-native";
import { Poppins_600SemiBold_Italic, useFonts } from "@expo-google-fonts/poppins";
import { usePalette } from "../theme.js";

export function Wordmark() {
  const { c } = usePalette();
  const [loaded] = useFonts({ Poppins_600SemiBold_Italic });
  return (
    <Text style={[
      { fontSize: 17, lineHeight: 22, letterSpacing: -0.1, color: c.foreground },
      loaded ? { fontFamily: "Poppins_600SemiBold_Italic" } : { fontStyle: "italic", fontWeight: "600" },
    ]}>
      Mr Otto
    </Text>
  );
}
```

- [ ] **Step 7: 开屏——`mobile/src/gate/Splash.tsx`**

```tsx
// 冷启动那一屏：一张脸 + 一条细进度条，压在波场上（demo 的 splash，同桌面 Splash.tsx）。
// 进度是真实启动步数与最短停留两半合成（shared/splashProgress.ts），两边都满才放行——
// 启动其实只要一两百毫秒，不掺停留那半，这一屏就是一闪而过。
import { Image, View } from "react-native";
import { usePalette, withAlpha } from "../theme.js";

const TRACK = 160;

export function Splash({ progress }: { progress: number }) {
  const { c } = usePalette();
  return (
    <View style={{ alignItems: "center", gap: 24 }}>
      {/* 阴影在外层：Image 的圆角会把它自己的阴影一起裁掉 */}
      <View style={{
        borderRadius: 24, shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25,
        shadowOffset: { width: 0, height: 25 },
      }}>
        <Image source={require("../../assets/otto.png")} style={{ width: 96, height: 96, borderRadius: 24 }} />
      </View>
      <View style={{
        width: TRACK, height: 3, borderRadius: 2, overflow: "hidden",
        backgroundColor: withAlpha(c.foreground, 0.15),
      }}>
        <View style={{
          width: TRACK * Math.min(1, Math.max(0, progress)), height: 3, borderRadius: 2,
          backgroundColor: withAlpha(c.foreground, 0.8),
        }} />
      </View>
    </View>
  );
}
```

- [ ] **Step 8: 玻璃卡与闸门——`mobile/src/gate/SignInCard.tsx`、`GateScreen.tsx`**

`mobile/src/gate/SignInCard.tsx`：

```tsx
// 登录那张玻璃卡（demo 的 .glasscard，同桌面 SignInCard 的 glass 档）。自上而下三段：
// 邮箱密码 → OAuth → 离开这张表单的两条路（Task 7 / 8 加上）。三段共用一圈边，
// 段间 16、段内 8——分组全靠这个比值读出来。邮箱在前、OAuth 在后是维护者定的（#731）。
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { canSubmitSignIn } from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "../oauth.js";
import { radius, usePalette, withAlpha } from "../theme.js";
import { Button, Field } from "../ui.js";
import { GitHubMark, GoogleMark } from "./marks.js";
import { errorText, signInWithPassword } from "./authActions.js";

export function SignInCard({ onNotice }: { onNotice: (n: AuthNotice | null) => void }) {
  const { c } = usePalette();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | OAuthProvider | null>(null);
  const canSubmit = canSubmitSignIn({
    mode: "sign-in", name: "", email, password, confirm: "", busy: busy !== null,
  });

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    // 本地预检：形状一眼不对就别跑这趟网络；报文与 supabase 那句同文，翻出来是同一条
    const bad = localEmailProblem(email.trim());
    if (bad) return onNotice(authNoticeOf(bad));
    onNotice(null);
    setBusy("password");
    try {
      await signInWithPassword(email.trim(), password);
      // 成功不用做别的：App 那层的 onAuthStateChange 会把闸门抬起来，这张卡跟着卸载
    } catch (e: unknown) {
      onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const oauth = async (provider: OAuthProvider): Promise<void> => {
    onNotice(null);
    setBusy(provider);
    try {
      await signInWithProvider(provider);
    } catch (e: unknown) {
      // 取消不是故障，不报红
      if (!(e instanceof AuthCancelled)) onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    // 阴影在外层、裁切在内层：iOS 上 overflow:hidden 会连阴影一起裁掉
    <View style={{
      width: "100%", borderRadius: radius.card,
      shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
    }}>
      <View style={{
        borderRadius: radius.card, overflow: "hidden", borderWidth: 1, borderColor: c.border,
        backgroundColor: withAlpha(c.card, 0.85), padding: 12, gap: 16,
      }}>
        {/* 不透一点、不糊一层的话，卡是「贴」在波场上而不是「坐」在里面 */}
        <BlurView tint="systemMaterial" intensity={60} style={StyleSheet.absoluteFill} />
        <View style={{ gap: 8 }}>
          <Field
            variant="gate" value={email} onChangeText={setEmail} placeholder="邮箱"
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next"
          />
          <Field
            variant="gate" value={password} onChangeText={setPassword} placeholder="密码" secure
            autoComplete="current-password" textContentType="password" returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />
          <Button
            size="compact" label={busy === "password" ? "…" : "用邮箱登录"}
            disabled={!canSubmit} onPress={() => void submit()}
          />
        </View>
        <View style={{ gap: 8 }}>
          <Button
            size="compact" variant="outline" icon={<GoogleMark />}
            label={busy === "google" ? "登录中…" : "用 Google 登录"}
            disabled={busy !== null} onPress={() => void oauth("google")}
          />
          <Button
            size="compact" variant="outline" icon={<GitHubMark />}
            label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
            disabled={busy !== null} onPress={() => void oauth("github")}
          />
        </View>
      </View>
    </View>
  );
}
```

`mobile/src/gate/GateScreen.tsx`：

```tsx
// 进门闸（demo 的 signin / signup，同桌面 SignInScreen）：一张脸 + 字标，底下一张玻璃卡。
// 波场背景在 App 那层（开屏与闸门共用同一块，不重启）。进场 260ms：透明度 + 上移 10 +
// 从 .98 放到 1（同桌面 ENTER_MS），不从 0 起；关了动效就只淡入。
// 报错贴在卡的上面：一句人话 + 一步能做的事；认不出来的原文降级成等宽小字（shared/authError.ts）。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, View } from "react-native";
import type { AuthNotice } from "../../../src/shared/authError.js";
import { Meta, Note, Page, useKeyboardInset, useReduceMotion } from "../ui.js";
import { SignInCard } from "./SignInCard.js";
import { Wordmark } from "./Wordmark.js";

export function GateScreen() {
  const reduce = useReduceMotion();
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  // 键盘要让位：卡在屏幕正中，「用邮箱登录」就贴在密码框下面
  const { root, keyboard } = useKeyboardInset(() => {});
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1, duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true,
    }).start();
  }, [enter]);
  const motion = reduce ? null : {
    transform: [
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
    ],
  };

  return (
    <View ref={root.ref} onLayout={root.onLayout} style={{ flex: 1, paddingBottom: keyboard }}>
      <Page grow>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Animated.View style={[
            { width: "100%", maxWidth: 320, alignItems: "center", gap: 16, opacity: enter },
            motion,
          ]}>
            {/* 身份就是这两行：一张脸 + 一个名字。它们属于这一屏，不属于登录控件 */}
            <View style={{ alignItems: "center", gap: 8 }}>
              <View style={{
                borderRadius: 16, shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25,
                shadowOffset: { width: 0, height: 25 },
              }}>
                <Image source={require("../../assets/otto.png")} style={{ width: 80, height: 80, borderRadius: 16 }} />
              </View>
              <Wordmark />
            </View>
            {notice ? (
              <View style={{ width: "100%", gap: 4 }}>
                <Note tone="error">{notice.hint ? `${notice.title} —— ${notice.hint}` : notice.title}</Note>
                {notice.raw ? <Meta>{notice.raw}</Meta> : null}
              </View>
            ) : null}
            <SignInCard onNotice={setNotice} />
          </Animated.View>
        </View>
      </Page>
    </View>
  );
}
```

- [ ] **Step 9: `mobile/App.tsx` 整份换成下面这样**（旧的 `BootSpinner` / `SignIn` / `PasswordForm` / `GitHubMark` 一并删掉，`Screen` 原样保留）

```tsx
// 手机端的入口：开屏 → 进门 → 三栏（任务 / 项目 / 团队）。
//
// 此刻画哪一屏由 shared/mobileGate.ts 的 gateView 说了算：冷启动没做完画开屏，没有 session 画闸门，
// 其余进三栏。登录 / 登出 / session 过期一律跟着 onAuthStateChange 走，不在各个按钮里分别切屏。
// 三栏的导航在 src/nav/（ADR-0293）；视觉语言全部来自 src/theme.ts（逐值抄自桌面 app.css）。

import { useEffect, useState } from "react";
import { SafeAreaView, StatusBar, View } from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { gateView } from "../src/shared/mobileGate.js";
import { splashProgress } from "../src/shared/splashProgress.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, space } from "./src/theme.js";
import { Note } from "./src/ui.js";
import { LinkProvider } from "./src/link.js";
import { RootNavigator } from "./src/nav/RootNavigator.js";
import { GateScreen } from "./src/gate/GateScreen.js";
import { Splash } from "./src/gate/Splash.js";

/** 冷启动的步数：身份库、读 session。进度条的「真实」那一半按它数 */
const BOOT_STEPS = 2;

export default function App() {
  const [store, setStore] = useState<PinnedPeerStore | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [done, setDone] = useState(0);
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setStore(await openStore());
      setDone((n) => n + 1);
      const { data } = await supabase.auth.getSession();
      setHasSession(data.session !== null);
      setDone((n) => n + 1);
    })().catch((e: unknown) => setError(String(e)));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => setHasSession(session !== null));
    return () => sub.subscription.unsubscribe();
  }, []);

  const progress = splashProgress({ done, total: BOOT_STEPS, elapsedMs: now - t0 });
  // 开屏那只钟：进度条到头就停，进了 app 之后不再每 100ms 醒一次
  useEffect(() => {
    if (progress >= 1) return;
    const id = setTimeout(() => setNow(Date.now()), 100);
    return () => clearTimeout(id);
  }, [progress, now]);

  const view = gateView({
    booted: store !== null && done >= BOOT_STEPS,
    splashDone: progress >= 1,
    hasSession,
    resetHold: false,
  });

  if (error) {
    return (
      <SafeAreaProvider>
        <Screen center><Note tone="error">{error}</Note></Screen>
      </SafeAreaProvider>
    );
  }

  if (view === "app" && store) {
    return (
      <SafeAreaProvider>
        <ExpoStatusBar style="auto" />
        <LinkProvider store={store}>
          <RootNavigator />
        </LinkProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      {/* 开屏与闸门共用**同一个** <Screen>：拆成两次 return 的话中间那块 WebView 会卸载再挂载，
          开屏刚起好的浪在进闸门那一刻回到第 0 帧 */}
      <Screen dither center={view === "splash"}>
        {view === "splash" ? <Splash progress={progress} /> : <GateScreen />}
      </Screen>
    </SafeAreaProvider>
  );
}

/**
 * 地面。状态栏跟着主题走 —— 深色底配浅色状态栏,反过来读不出来。
 *
 * `dither` 打开时那块波场铺在 **SafeAreaView 外面**:背景就该顶到屏幕边,
 * 缩在安全区里会在刘海和 home 条那儿各留一条底色,看着像没加载完。
 * 内容仍然在安全区内 —— 通栏的是背景,不是表单。
 */
function Screen({ children, center, dither }: {
  children: React.ReactNode; center?: boolean; dither?: boolean;
}) {
  const { c, isDark } = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {dither ? <DitherBackground isDark={isDark} /> : null}
      <SafeAreaView style={[
        { flex: 1 },
        center && { alignItems: "center", justifyContent: "center", padding: space.lg },
      ]}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        {children}
      </SafeAreaView>
    </View>
  );
}
```

然后确认两张旧头像图没人再引用，删掉：

Run: `grep -rn "otto-head\|otto-mark" mobile --include=*.ts --include=*.tsx --include=app.json`
Expected: 没有输出；有输出就先别删，改成引用 `otto.png`。

```bash
git rm mobile/assets/otto-head.png mobile/assets/otto-mark.png
```

- [ ] **Step 10: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。

- [ ] **Step 11: 模拟器验收**（深浅色各一遍）

1. 冷启动（先在账号里退出登录）：波场 + 96pt 的脸 + 细进度条，至少停 1.2 秒，然后同一块波场上换成闸门（浪不重启）。截图 `/tmp/otto-t6-splash.png`，对照 demo 的 splash。
2. 闸门：80pt 的脸 + Poppins 斜体「Mr Otto」+ 玻璃卡（邮箱、密码、「用邮箱登录」、Google、GitHub），整组淡入并上浮一点点。截图 `/tmp/otto-t6-signin.png`，对照 demo 的 signin；深色下波场也是深色。
3. 邮箱填 `a@qq`、密码 6 位以上 → 卡上面冒出「这个邮箱地址填得不太对 —— 检查一下有没有写全…」，没发网络请求。
4. 真账号填错密码 → 「邮箱或密码不对 —— 再试一次，注意大小写；用 Google / GitHub 注册的账号没有密码，走那两个按钮」。
5. 填对 → 进三栏（落在项目栏）。账号 → 退出登录 → 回到闸门。
6. 点输入框时键盘把卡顶上去，「用邮箱登录」不被遮住。
7. 打开「减弱动态效果」：闸门只淡入、不上浮。

- [ ] **Step 12: Commit**

```bash
git add mobile/App.tsx mobile/src mobile/assets mobile/package.json mobile/package-lock.json
git commit -m "feat(mobile): 冷启动与进门闸照 demo 重做（#1237 M1）

开屏：一张脸 + 细进度条压在波场上，真实启动步数 × 最短停留（shared/splashProgress）。
闸门：脸 + Poppins 斜体字标 + 一张玻璃卡，报错走两端共用的 authNoticeOf。
App 顶层改由 gateView 决定画哪一屏，登录 / 登出一律跟着 onAuthStateChange。
logo 换成桌面同一张 otto.png，两张旧头像图删掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```


### Task 7: 注册 + 等确认信（居中弹窗第一次上场）

登录与注册是同一张卡的两个状态（demo 的 signin / signup）：点「没有账号？注册」原地长出「用户名」「再输一遍」两格。注册成功而项目要求邮箱确认时，弹出一张**居中弹窗**「去邮箱点一下确认链接」，我们自己轮询，确认了就自己进 app（demo 的 confirmMail，同桌面 `ConfirmEmailDialog`）。居中弹窗是第一次有消费方，`Dialog` 在这一步立起来。

**Files:**
- Create: `mobile/src/dialog.tsx`、`mobile/src/gate/ConfirmMailDialog.tsx`
- Modify: `mobile/src/theme.ts`（`scrim` 令牌）、`mobile/src/gate/authActions.ts`（`trySignIn`、`signUp`）、`mobile/src/gate/SignInCard.tsx`（整份替换）

**Interfaces:**
- Consumes: Task 5 的 `canSubmitSignIn`、`confirmHint`、`MIN_PASSWORD`、`NAME_MAX`、`SignInMode`、`pollDelayMs`；Task 6 的 `Field`、`Button`（`size="dialog"`、`variant="secondary"`）、`authActions`、`withAlpha`
- Produces:
  - `theme.ts`：`Palette.scrim: string`（浅色 `rgba(0, 0, 0, 0.28)`、深色 `rgba(0, 0, 0, 0.5)`）
  - `dialog.tsx`：`Dialog({ visible, children })`、`DialogTitle`、`DialogLead`、`DialogBody`、`DialogFooter({ left, right })`，`left` / `right` 是 `{ label: string; onPress: () => void; disabled?: boolean }`
  - `authActions.ts`：`trySignIn(email, password): Promise<boolean>`、`signUp(email, password, name): Promise<"signed-in" | "confirm-email">`
  - `gate/ConfirmMailDialog.tsx`：`ConfirmMailDialog({ email, password, onLater })`
  - `gate/SignInCard.tsx`：签名不变（`SignInCard({ onNotice })`）；内部多一个 `GateLink({ label, onPress, hidden? })`，Task 8 用它加「忘记密码？」

- [ ] **Step 1: `mobile/src/theme.ts` 加 `scrim`**

`interface Palette` 里 `warn: string;` 后面加：

```ts
  /** 弹窗底下那层暗幕（demo 的 --scrim）。深色压得更重——底本来就暗，压轻了分不出层 */
  scrim: string;
```

浅色那张表 `warn: "#e67700",` 后面加 `scrim: "rgba(0, 0, 0, 0.28)",`；深色那张表 `warn: "#ff9f0a",` 后面加 `scrim: "rgba(0, 0, 0, 0.5)",`。

- [ ] **Step 2: 居中弹窗——`mobile/src/dialog.tsx`**

```tsx
// 居中弹窗（demo 的 .dlg，同桌面 AlertDialog）：表单与确认一律用它，不用底部抽屉（spec §3.2）。
//
// 只受控：没有「点遮罩关」，出口只有里面的按钮——一个正在收信的人手一抖就得从头再来。
// 进场从 .96 放到 1 + 淡入（不从 0 起：现实里没有东西从「没有」里长出来），退场更快：
// .98 + 淡出 140ms。关了动效就只淡入淡出。
// 键盘弹起时居中的是键盘上面那块：Modal 里的 KeyboardAvoidingView 量的是整屏坐标，
// 没有 ui.tsx 里 useKeyboardInset 说的那个「相对父级」的坑。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { spring, type as t, usePalette } from "./theme.js";
import { Button, useReduceMotion } from "./ui.js";

const WIDTH = 320;
const RADIUS = 22;

export function Dialog({ visible, children }: { visible: boolean; children: ReactNode }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const { width } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  /** 0 = 收着，1 = 摊开。暗幕的透明度、卡的透明度与缩放都挂在它上面 */
  const k = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.spring(k, { toValue: 1, useNativeDriver: true, ...spring(0.28) }).start();
      return;
    }
    Animated.timing(k, { toValue: 0, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true })
      .start(({ finished }) => {
        if (finished) setMounted(false);
      });
  }, [visible, k]);

  if (!mounted) return null;
  const scale = reduce ? 1 : k.interpolate({ inputRange: [0, 1], outputRange: [visible ? 0.96 : 0.98, 1] });
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={() => {}}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: k }]} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        <Animated.View
          accessibilityViewIsModal
          style={{
            width: Math.min(WIDTH, width - 48), borderRadius: RADIUS, backgroundColor: c.card,
            borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingTop: 24, paddingBottom: 20,
            shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
            opacity: k, transform: [{ scale }],
          }}
        >
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** 标题：22/28 粗体、居中（demo 的 .gdlg h2） */
export function DialogTitle({ children }: { children: ReactNode }) {
  const { c } = usePalette();
  return (
    <Text style={{ ...t.title, textAlign: "center", color: c.foreground, marginBottom: 8, paddingHorizontal: 20 }}>
      {children}
    </Text>
  );
}

/** 说明：15/21、暗色、居中。里面要压重音的那几个字（邮箱）用 ui.tsx 的 Strong */
export function DialogLead({ children }: { children: ReactNode }) {
  const { c } = usePalette();
  return (
    <Text style={{ ...t.callout, textAlign: "center", color: c.mutedForeground, marginBottom: 18, paddingHorizontal: 20 }}>
      {children}
    </Text>
  );
}

/** 正文（输入框、验证码格子）：左右各 20 */
export function DialogBody({ children }: { children: ReactNode }) {
  return <View style={{ paddingHorizontal: 20, gap: 8 }}>{children}</View>;
}

interface DialogAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * 底下那排（同桌面 AlertDialogFooter）：左边「不做这件事」、右边「做」，两颗等宽。
 * 换步只换字不换位置——手指停在原地就能接着按。
 */
export function DialogFooter({ left, right }: { left: DialogAction; right: DialogAction }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 20 }}>
      <Button grow size="dialog" variant="secondary" label={left.label} onPress={left.onPress} disabled={left.disabled} />
      <Button grow size="dialog" label={right.label} onPress={right.onPress} disabled={right.disabled} />
    </View>
  );
}
```

- [ ] **Step 3: `mobile/src/gate/authActions.ts` 加注册与探测**

文件头 import 区加：

```ts
import { authLandingUrl } from "../../../src/shared/edgeConfig.js";
import { NAME_MAX } from "../../../src/shared/profile.js";
```

`import { supabase } …` 下面加：

```ts
/** 和桌面同一个 redirectTo（边缘服务的落地页），天然在 Supabase 的 Redirect URLs 白名单里（见 oauth.ts 顶部） */
const LANDING = authLandingUrl({} as never);
```

文件末尾追加：

```ts
/** 等确认信那张弹窗的探测：邮箱还没点时失败是预期，不抛、只回布尔 */
export async function trySignIn(email: string, password: string): Promise<boolean> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return !error;
}

/**
 * 注册。两种正常结局（同桌面 signUpWithPassword）："signed-in" = 项目免邮箱确认、注册即登录；
 * "confirm-email" = 有 user 没 session，要去邮箱点确认链接。名字走 options.data，
 * profiles 那一行由 migration 0007 的触发器取它填；空名字不传（触发器退回邮箱前缀）
 */
export async function signUp(
  email: string, password: string, name: string,
): Promise<"signed-in" | "confirm-email"> {
  const trimmed = name.trim().slice(0, NAME_MAX);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: LANDING, ...(trimmed === "" ? {} : { data: { name: trimmed } }) },
  });
  if (error) throw new Error(error.message);
  return data.session ? "signed-in" : "confirm-email";
}
```

- [ ] **Step 4: 等确认信——`mobile/src/gate/ConfirmMailDialog.tsx`**

```tsx
// 注册完、等他去邮箱点确认链接（demo 的 confirmMail，同桌面 ConfirmEmailDialog）。
//
// 我们自己盯着：轮询重试登录——邮箱没确认时 GoTrue 一律回 Email not confirmed，确认之后同一把
// 邮箱密码立刻换得到 session。成功那一刻 App 那层的 onAuthStateChange 把闸门抬起来，这张弹窗
// 跟着卸载，不用他回来按什么。「我已确认」= 立刻探一次。节奏前快后慢（shared/confirmEmailPoll.ts），
// 否则「等确认」自己把账号打进 /token 的限流。密码只活在内存里，不落盘。
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { pollDelayMs } from "../../../src/shared/confirmEmailPoll.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { type as t, usePalette } from "../theme.js";
import { Dot, Strong } from "../ui.js";
import { trySignIn } from "./authActions.js";

export function ConfirmMailDialog({ email, password, onLater }: {
  email: string;
  password: string;
  /** 「稍后再说」。确认成功那条路不走这里——闸门一抬，整张卡连同这张弹窗一起卸载 */
  onLater: () => void;
}) {
  const { c } = usePalette();
  const [checking, setChecking] = useState(false);
  /** 手动按过「我已确认」但还没生效。只用来说一句话，不拦他再按——邮件到得慢是常事 */
  const [notYet, setNotYet] = useState(false);

  // 一次一约的 setTimeout 而不是 setInterval：间隔会变，上一轮还在飞时也不该叠下一轮
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const tick = async (): Promise<void> => {
      if (stop) return;
      await trySignIn(email, password);
      if (stop) return;
      timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    };
    timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [email, password]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setNotYet(false);
    const ok = await trySignIn(email, password);
    setChecking(false);
    if (!ok) setNotYet(true);
  };

  return (
    <Dialog visible>
      <DialogTitle>去邮箱点一下确认链接</DialogTitle>
      <DialogLead>
        确认信已经发给 <Strong>{email}</Strong>。点开里面的链接，这里会自己继续，不用回来按什么。
      </DialogLead>
      <View style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        marginTop: -4, paddingHorizontal: 20,
      }}>
        {notYet ? null : <Dot tone="busy" />}
        <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>
          {notYet ? "还没生效——邮件可能慢了一点，也看看垃圾箱。" : "正在等你确认…"}
        </Text>
      </View>
      <DialogFooter
        left={{ label: "稍后再说", onPress: onLater }}
        right={{ label: checking ? "查一下…" : "我已确认", onPress: () => void checkNow(), disabled: checking }}
      />
    </Dialog>
  );
}
```

- [ ] **Step 5: `mobile/src/gate/SignInCard.tsx` 整份替换成两态**

```tsx
// 登录 / 注册那张玻璃卡（demo 的 .glasscard，同桌面 SignInCard）。登录与注册是**同一张卡的两个
// 状态**，不是两页：注册态原地长出「用户名」「再输一遍」两格，按钮与底下那行换说法——两者除了
// 多两格一模一样，换一页等于让人把整张表重读一遍。
//
// 自上而下三段：邮箱密码 → OAuth → 离开这张表单的两条路。三段共用一圈边，段间 16、段内 8，
// 分组全靠这个比值读出来。邮箱在前、OAuth 在后是维护者定的（#731）。
import { useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import {
  MIN_PASSWORD, NAME_MAX, canSubmitSignIn, confirmHint, type SignInMode,
} from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "../oauth.js";
import { radius, usePalette, withAlpha } from "../theme.js";
import { Button, Field, useReduceMotion } from "../ui.js";
import { GitHubMark, GoogleMark } from "./marks.js";
import { errorText, signInWithPassword, signUp } from "./authActions.js";
import { ConfirmMailDialog } from "./ConfirmMailDialog.js";

export function SignInCard({ onNotice }: { onNotice: (n: AuthNotice | null) => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const [mode, setMode] = useState<SignInMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | OAuthProvider | null>(null);
  /** 注册成功、正在等确认信。存的是那一刻的邮箱密码——弹窗要拿它轮询；只活在内存里 */
  const [pending, setPending] = useState<{ email: string; password: string } | null>(null);

  const form = { mode, name, email, password, confirm, busy: busy !== null };
  const canSubmit = canSubmitSignIn(form);
  const mismatch = confirmHint(form);
  const up = mode === "sign-up";

  /** 换态：清掉只有注册才有的两格（同桌面切换那三行）。两格原地长出来 / 收回去，
      高度的变化交给 LayoutAnimation；关了动效就瞬切 */
  const switchMode = (next: SignInMode): void => {
    if (!reduce) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(280, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
      );
    }
    setMode(next);
    setName("");
    setConfirm("");
    onNotice(null);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    // 本地预检：形状一眼不对就别跑这趟网络；报文与 supabase 那句同文，翻出来是同一条
    const addr = email.trim();
    const bad = localEmailProblem(addr);
    if (bad) return onNotice(authNoticeOf(bad));
    onNotice(null);
    setBusy("password");
    try {
      if (!up) {
        await signInWithPassword(addr, password);
      } else if ((await signUp(addr, password, name)) === "confirm-email") {
        setPending({ email: addr, password });
      }
      // 登录成功 / 注册即登录：App 那层的 onAuthStateChange 会把闸门抬起来，这张卡跟着卸载
    } catch (e: unknown) {
      onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const oauth = async (provider: OAuthProvider): Promise<void> => {
    onNotice(null);
    setBusy(provider);
    try {
      await signInWithProvider(provider);
    } catch (e: unknown) {
      // 取消不是故障，不报红
      if (!(e instanceof AuthCancelled)) onNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    // 阴影在外层、裁切在内层：iOS 上 overflow:hidden 会连阴影一起裁掉
    <View style={{
      width: "100%", borderRadius: radius.card,
      shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
    }}>
      <View style={{
        borderRadius: radius.card, overflow: "hidden", borderWidth: 1, borderColor: c.border,
        backgroundColor: withAlpha(c.card, 0.85), padding: 12, gap: 16,
      }}>
        {/* 不透一点、不糊一层的话，卡是「贴」在波场上而不是「坐」在里面 */}
        <BlurView tint="systemMaterial" intensity={60} style={StyleSheet.absoluteFill} />

        {/* 一：邮箱密码。用户名排在邮箱上面——它问的是「你叫什么」，邮箱密码是「怎么进来」 */}
        <View style={{ gap: 8 }}>
          {up ? (
            <Field
              variant="gate" value={name} onChangeText={setName} placeholder="用户名"
              maxLength={NAME_MAX} autoComplete="nickname" textContentType="nickname" returnKeyType="next"
            />
          ) : null}
          <Field
            variant="gate" value={email} onChangeText={setEmail} placeholder="邮箱"
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next"
          />
          <Field
            variant="gate" value={password} onChangeText={setPassword}
            placeholder={up ? `密码（至少 ${MIN_PASSWORD} 位）` : "密码"} secure
            autoComplete={up ? "new-password" : "current-password"}
            textContentType={up ? "newPassword" : "password"}
            returnKeyType={up ? "next" : "go"}
            onSubmitEditing={up ? undefined : () => void submit()}
          />
          {up ? (
            <View>
              <Field
                variant="gate" value={confirm} onChangeText={setConfirm} placeholder="再输一遍密码" secure
                invalid={mismatch !== null} autoComplete="new-password" textContentType="newPassword"
                returnKeyType="go" onSubmitEditing={() => void submit()}
              />
              {/* 贴着那一格念：这是边打字边改的问题，提示要待在他正在看的地方；
                  空着不念（confirmHint 只在打了字之后才说）——空着就红，那是催促不是提示 */}
              {mismatch ? (
                <Text style={{ fontSize: 12, lineHeight: 16, color: c.destructive, paddingTop: 6, paddingHorizontal: 2 }}>
                  {mismatch}
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* 对不上就按不动，而不是按了报错：密码看不见，按之前就该知道 */}
          <Button
            size="compact" label={busy === "password" ? "…" : up ? "注册" : "用邮箱登录"}
            disabled={!canSubmit} onPress={() => void submit()}
          />
        </View>

        {/* 二：OAuth。注册态照样在：拿 Google 头一次进来就是注册 */}
        <View style={{ gap: 8 }}>
          <Button
            size="compact" variant="outline" icon={<GoogleMark />}
            label={busy === "google" ? "登录中…" : "用 Google 登录"}
            disabled={busy !== null} onPress={() => void oauth("google")}
          />
          <Button
            size="compact" variant="outline" icon={<GitHubMark />}
            label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
            disabled={busy !== null} onPress={() => void oauth("github")}
          />
        </View>

        {/* 三：两条离开这张表单的路，一行两端分开摆。左边「我进不去了」（Task 8 加上），
            右边「我还没有账号」——右边照样靠右，左边先留一个空位撑住 */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View />
          <GateLink
            label={up ? "已有账号？登录" : "没有账号？注册"}
            onPress={() => switchMode(up ? "sign-in" : "sign-up")}
          />
        </View>
      </View>

      {pending ? (
        <ConfirmMailDialog
          email={pending.email}
          password={pending.password}
          onLater={() => {
            setPending(null);
            switchMode("sign-in");
          }}
        />
      ) : null}
    </View>
  );
}

/** 卡底下那两条小字路（demo 的 .gatelink：12pt、暗色、无边框）。hidden = 占着位置但看不见、点不动 */
export function GateLink({ label, onPress, hidden }: { label: string; onPress: () => void; hidden?: boolean }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button" accessibilityElementsHidden={hidden} disabled={hidden}
      onPress={onPress} hitSlop={10}
      style={({ pressed }) => ({ opacity: hidden ? 0 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, color: c.mutedForeground }}>{label}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 6: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。

- [ ] **Step 7: 模拟器验收**

> 注意发信配额：本项目 Supabase 内置邮件通道**每小时两封**（`src/shared/authError.ts` 里「发信配额到顶」那条注释）。注册与找回密码（Task 8）的真实发信各走一次就够，别反复点。

1. 点「没有账号？注册」：「用户名」「再输一遍密码」两格原地长出来、密码框的占位换成「密码（至少 6 位）」、按钮换成「注册」、底下那行换成「已有账号？登录」。截图 `/tmp/otto-t7-signup.png`，对照 demo 的 signup。
2. 「注册」在用户名为空、邮箱没有 @、密码不到 6 位、两次不一样时都按不动；第二格打了字且不一样时，它下面出一行红字「两次输入不一样」、边框变红，空着不念。
3. 用一个真的新邮箱注册 → 居中弹出「去邮箱点一下确认链接」：暗幕淡入、卡从 .96 放到 1。截图 `/tmp/otto-t7-confirm.png`，对照 demo 的 confirmMail。
4. 还没去点邮件就按「我已确认」→ 那一行变成「还没生效——邮件可能慢了一点，也看看垃圾箱。」
5. 去邮箱点确认链接 → 15 秒内自己进 app，不用回来按任何东西。
6. 另起一次：注册后按「稍后再说」→ 弹窗快速淡出，卡回到登录态。
7. 打开「减弱动态效果」：弹窗只淡入淡出、不缩放；两格长出来 / 收回去是瞬切。

- [ ] **Step 8: Commit**

```bash
git add mobile/src
git commit -m "feat(mobile): 注册与等确认信——居中弹窗第一次上场（#1237 M1）

登录与注册是同一张卡的两个状态，注册态原地长出用户名与再输一遍两格；提交判据与
「两次不一样」那句走两端共用的 shared/signInForm。注册后要确认邮箱时弹出居中弹窗，
自己按 shared/confirmEmailPoll 的节奏轮询，确认了就自己进 app。
dialog.tsx 是表单与确认类的共用弹窗：只受控、.96 放到 1、退场更快（spec §3.2）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```


### Task 8: 忘记密码——一张弹窗里原地换三步

demo 的 forgot / forgotCode / forgotSet（同桌面 `ForgotPasswordDialog` + `SetPasswordDialog`）：填邮箱 → 收 8 位验证码（4 + 4 两组，填满就交）→ 设新密码，**同一张居中弹窗里原地换三步**。验过验证码那一刻人就是登录态了（recovery OTP 换到真 session），所以验之前先让 App 按住闸门（落 kv-store，冷启动也记得），设完新密码或明说「以后再说」才放开（ADR-0194 同一条理由）。

**Files:**
- Create: `mobile/src/gate/resetHold.ts`、`mobile/src/gate/OtpInput.tsx`、`mobile/src/gate/ForgotDialog.tsx`
- Modify: `mobile/src/gate/authActions.ts`（三个动作）、`mobile/src/gate/SignInCard.tsx`（「忘记密码？」）、`mobile/src/gate/GateScreen.tsx`（挂弹窗 + 三个 props）、`mobile/App.tsx`（按住 / 放开）

**Interfaces:**
- Consumes: Task 5 的 `OTP_LENGTH`、`RESEND_COOLDOWN_S`、`canSubmitOtp`、`normalizeOtp`、`resendLabel`、`otpCells`、`MIN_PASSWORD`、`gateView` 的 `resetHold`；Task 7 的 `Dialog*`、`GateLink`；Task 6 的 `Field`
- Produces:
  - `gate/resetHold.ts`：`readResetHold(): Promise<boolean>`、`writeResetHold(on: boolean): Promise<void>`
  - `authActions.ts`：`sendReset(email): Promise<void>`、`verifyReset(email, token): Promise<void>`、`setNewPassword(password): Promise<void>`
  - `gate/OtpInput.tsx`：`OtpInput({ value, onChange, busy, autoFocus? })`
  - `gate/ForgotDialog.tsx`：`type ForgotStage = "email" | "code" | "set"`、`ForgotDialog({ initialEmail, initialStage?, onClose, onHold, onRelease })`
  - `gate/GateScreen.tsx`：`GateScreen({ resetHold, onHold, onRelease })`
  - `gate/SignInCard.tsx`：`SignInCard({ onNotice, onForgot })`，`onForgot: (email: string) => void`

- [ ] **Step 1: 按住的记号——`mobile/src/gate/resetHold.ts`**

```ts
// 「找回密码验完验证码、新密码还没设」这笔记号（同桌面 store 的 RESET_PENDING_KEY，ADR-0194）。
//
// 落 kv-store 不落内存：验完码到设完新密码之间 app 可能被杀掉——冷启动回来时 session 在、
// 旧密码一个字没变，没有这笔记号闸门就抬了。和 supabase 的 session 存在同一个 kv-store 里
// （见 supabase.ts），同样 Expo Go 就有。
import AsyncStorage from "expo-sqlite/kv-store";

const KEY = "otto.gate.resetHold";

export async function readResetHold(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY)) === "1";
}

export async function writeResetHold(on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem(KEY, "1");
  else await AsyncStorage.removeItem(KEY);
}
```

- [ ] **Step 2: `mobile/src/gate/authActions.ts` 末尾追加三个动作**

```ts
/** 发重置邮件。「查无此人」不报错是故意的（同桌面 resetPassword 的注释）：
    不然等于把「这个邮箱注册过没有」做成一个人人可查的接口 */
export async function sendReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: LANDING });
  if (error) throw new Error(error.message);
}

/** 验重置邮件里那串码。验过就是登录态（recovery OTP 换到真 session）——所以调用方要先按住闸门 */
export async function verifyReset(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
  if (error) throw new Error(error.message);
}

/** 设新密码。调用方保证此刻有 session（验码换来的那个就算） */
export async function setNewPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 3: 验证码那排格子——`mobile/src/gate/OtpInput.tsx`**

```tsx
// 8 位验证码（Supabase 的 mailer_otp_length = 8，见 shared/forgotPassword.ts），4 + 4 两组：
// 从邮件里读 8 个数字再敲进来，中间断一下比一口气数 8 格好认（demo 的 .otp）。
//
// 底下是**一个**真输入框（数字键盘 + oneTimeCode：iOS 会把邮件里那串数字直接递上来），
// 铺满整排；格子只是它的画法（shared/forgotPassword.ts 的 otpCells）——粘贴、系统递码、
// 退格全走那一个框。光标停在第一个空格上，那一格的边换点缀色。
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { OTP_LENGTH, normalizeOtp, otpCells } from "../../../src/shared/forgotPassword.js";
import { MONO, radius, usePalette, withAlpha } from "../theme.js";

export function OtpInput({ value, onChange, busy, autoFocus }: {
  value: string;
  onChange: (code: string) => void;
  busy: boolean;
  autoFocus?: boolean;
}) {
  const { c } = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <View style={{ flexDirection: "row", gap: 5 }}>
        {otpCells(value).map((cell, i) => (
          <View
            key={i}
            style={{
              flex: 1, height: 42, borderRadius: radius.tile, borderWidth: 1,
              borderColor: focused && cell.cursor ? c.brand : c.input,
              backgroundColor: withAlpha(c.foreground, 0.05),
              alignItems: "center", justifyContent: "center",
              // 4 + 4 之间多一口气
              marginLeft: i === OTP_LENGTH / 2 ? 7 : 0,
              opacity: busy ? 0.45 : 1,
            }}
          >
            <Text style={{ fontFamily: MONO, fontSize: 20, fontWeight: "600", color: c.foreground }}>{cell.ch}</Text>
          </View>
        ))}
      </View>
      <TextInput
        value={value}
        // 粘进来的整句在这里就擦干净（只留数字、截到 8 位），而不是等到提交那一刻报「码不对」。
        // **不设 maxLength**：它在擦之前先截，「验证码：12345678」整句粘进来只剩「验证码：1234」
        onChangeText={(text) => onChange(normalizeOtp(text))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        editable={!busy}
        caretHidden
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={`${OTP_LENGTH} 位验证码`}
        // 铺满整排、几乎全透明。不写 0：UIKit 不把触摸派给 alpha < 0.01 的视图，
        // 那样点格子就对不上这个框了
        style={[StyleSheet.absoluteFill, { opacity: 0.02, color: "transparent" }]}
      />
    </View>
  );
}
```

- [ ] **Step 4: 三步弹窗——`mobile/src/gate/ForgotDialog.tsx`**

```tsx
// 找回密码（demo 的 forgot / forgotCode / forgotSet，同桌面 ForgotPasswordDialog + SetPasswordDialog）：
// 填邮箱 → 收验证码 → 设新密码，**同一张居中弹窗里原地换三步**（桌面的第三步是另一张弹窗
// 「换在同一位置」，这里就真是同一张）。
//
// 验过验证码那一刻人就是登录态了（recovery OTP 换到真 session），所以验之前先让 App 按住闸门
// （onHold，落 kv-store）；设完新密码或明说「以后再说」才放开（onRelease）——ADR-0194：一个
// 旧密码原封不动的人不该就这么进去。「查无此人也不报错」由服务端守着，所以发完一律进第二步。
//
// 与 demo 的一处不同（spec §10）：第二步的说明去掉「邮件里那条链接点了也算」——手机端没有接
// 那条深链，这句话在手机上是假的。
import { useEffect, useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import {
  OTP_LENGTH, RESEND_COOLDOWN_S, canSubmitOtp, resendLabel,
} from "../../../src/shared/forgotPassword.js";
import { MIN_PASSWORD } from "../../../src/shared/signInForm.js";
import { authNoticeOf, localEmailProblem, type AuthNotice } from "../../../src/shared/authError.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Field, Meta, Note, Strong, useReduceMotion } from "../ui.js";
import { OtpInput } from "./OtpInput.js";
import { errorText, sendReset, setNewPassword, verifyReset } from "./authActions.js";

export type ForgotStage = "email" | "code" | "set";

const TITLE: Record<ForgotStage, string> = { email: "找回密码", code: "填验证码", set: "设一个新密码" };

export function ForgotDialog({ initialEmail, initialStage = "email", onClose, onHold, onRelease }: {
  /** 登录卡里已经填了的那个邮箱。人已经在那一格上打过字了，不该让他再打一遍 */
  initialEmail: string;
  /** 冷启动回来时闸门还按着：直接从「设新密码」那一步开始 */
  initialStage?: ForgotStage;
  onClose: () => void;
  /** 验码之前按住闸门（App 那层落盘）；验码失败由 onRelease 放开 */
  onHold: () => Promise<void>;
  /** 设完新密码、或明说「以后再说」：放开闸门，App 自己进 */
  onRelease: () => Promise<void>;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const [stage, setStage] = useState<ForgotStage>(initialStage);
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  /** 重发冷却剩几秒，0 = 解冻。对齐 GoTrue 对同一邮箱的 60 秒限制——点了才被服务端骂一句是坏的 */
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<AuthNotice | null>(null);

  // 一秒一跳的倒数：setTimeout 链而不是常驻 setInterval——弹窗随时会整棵卸载
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** 换步：弹窗不动、里面换；高度的变化交给 LayoutAnimation，关了动效就瞬切 */
  const go = (next: ForgotStage): void => {
    if (!reduce) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(240, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
      );
    }
    setNotice(null);
    setStage(next);
  };

  const send = async (again: boolean): Promise<void> => {
    const addr = email.trim();
    const bad = localEmailProblem(addr);
    if (bad) return setNotice(authNoticeOf(bad));
    setBusy(true);
    try {
      await sendReset(addr);
      setCode("");
      setCooldown(RESEND_COOLDOWN_S);
      if (!again) go("code");
    } catch (e: unknown) {
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (token: string): Promise<void> => {
    if (busy || token.length !== OTP_LENGTH) return;
    setBusy(true);
    setNotice(null);
    // 先按住再验：验过那一刻 session 就来了，晚一步闸门已经抬起来了
    await onHold();
    try {
      await verifyReset(email.trim(), token);
      go("set");
    } catch (e: unknown) {
      await onRelease();
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  // 同注册那张表单的规矩：够长 + 两次一致，且**空着不念**
  const mismatch = pw2 !== "" && pw !== pw2 ? "两次输入不一样" : null;
  const canSave = !busy && pw.length >= MIN_PASSWORD && pw === pw2;

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await setNewPassword(pw);
      await onRelease();
    } catch (e: unknown) {
      setNotice(authNoticeOf(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const right =
    stage === "email"
      ? { label: busy ? "稍等…" : "发送验证码", onPress: () => void send(false), disabled: busy || email.trim() === "" }
      : stage === "code"
        ? { label: busy ? "稍等…" : "提交", onPress: () => void verify(code), disabled: !canSubmitOtp(code, busy) }
        : { label: busy ? "保存中…" : "保存", onPress: () => void save(), disabled: !canSave };
  // 第三步左边从「取消」变成「以后再说」：验过之后已经没有东西可取消了——人已经进来了，
  // 逼着设只是又一道收费站（同桌面 SetPasswordDialog）
  const left =
    stage === "set"
      ? { label: "以后再说", onPress: () => void onRelease(), disabled: busy }
      : { label: "取消", onPress: onClose, disabled: busy };

  return (
    <Dialog visible>
      <DialogTitle>{TITLE[stage]}</DialogTitle>
      <DialogLead>
        {stage === "email" ? (
          "填注册时用的邮箱，我们发一个验证码过去。"
        ) : stage === "code" ? (
          <>验证码发到 <Strong>{email.trim()}</Strong> 了，填回来就能设新密码。</>
        ) : (
          "你已经进来了，但旧密码还没变 —— 现在设一个，下次在别的设备上才用得上。"
        )}
      </DialogLead>
      <DialogBody>
        {notice ? (
          <View style={{ gap: 4 }}>
            <Note tone="error">{notice.hint ? `${notice.title} —— ${notice.hint}` : notice.title}</Note>
            {notice.raw ? <Meta>{notice.raw}</Meta> : null}
          </View>
        ) : null}

        {stage === "email" ? (
          <Field
            variant="dialog" value={email} onChangeText={setEmail} placeholder="邮箱" autoFocus
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="send"
            onSubmitEditing={() => { if (!right.disabled) right.onPress(); }}
          />
        ) : stage === "code" ? (
          <>
            <OtpInput
              value={code} busy={busy} autoFocus
              // 手机上填满就交：少按一下（Apple 账户的验证码也是这样）
              onChange={(v) => {
                setCode(v);
                if (v.length === OTP_LENGTH) void verify(v);
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
              {/* 倒数写出来：没有理由的灰按钮会被反复去点 */}
              <SmallLink label={resendLabel(cooldown)} disabled={cooldown > 0 || busy} onPress={() => void send(true)} />
              <SmallLink label="换个邮箱" disabled={busy} onPress={() => { setCode(""); go("email"); }} />
            </View>
          </>
        ) : (
          <>
            <Field
              variant="dialog" value={pw} onChangeText={setPw} placeholder={`新密码（至少 ${MIN_PASSWORD} 位）`}
              secure autoFocus autoComplete="new-password" textContentType="newPassword" returnKeyType="next"
            />
            <View>
              <Field
                variant="dialog" value={pw2} onChangeText={setPw2} placeholder="再输一遍" secure
                invalid={mismatch !== null} autoComplete="new-password" textContentType="newPassword"
                returnKeyType="done" onSubmitEditing={() => { if (canSave) void save(); }}
              />
              {mismatch ? (
                <Text style={{ fontSize: 12, lineHeight: 16, color: c.destructive, paddingTop: 6, paddingHorizontal: 2 }}>
                  {mismatch}
                </Text>
              ) : null}
            </View>
          </>
        )}
      </DialogBody>
      <DialogFooter left={left} right={right} />
    </Dialog>
  );
}

/** 验证码底下那两条小字路（demo 的 .gdlg .links：13pt、暗色；冻着时 .6） */
function SmallLink({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ paddingVertical: 4, opacity: disabled ? 0.6 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>{label}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 5: `mobile/src/gate/SignInCard.tsx` 加「忘记密码？」**

① 签名，旧：`export function SignInCard({ onNotice }: { onNotice: (n: AuthNotice | null) => void }) {`

新：

```tsx
export function SignInCard({ onNotice, onForgot }: {
  onNotice: (n: AuthNotice | null) => void;
  /** 点「忘记密码？」：带上已经填了的邮箱——人已经在那一格上打过字了 */
  onForgot: (email: string) => void;
}) {
```

② 第三段左边那个空位，旧：

```tsx
          <View />
          <GateLink
```

新：

```tsx
          {/* 注册态没有这条（那一屏还不存在「旧密码」这回事），但它占着位置，右边那条照样靠右 */}
          <GateLink label="忘记密码？" hidden={up} onPress={() => onForgot(email.trim())} />
          <GateLink
```

并把那段注释里的「左边「我进不去了」（Task 8 加上）」改成「左边「我进不去了」」。

- [ ] **Step 6: `mobile/src/gate/GateScreen.tsx` 挂上弹窗**

① import 区加：

```ts
import { ForgotDialog } from "./ForgotDialog.js";
```

② 签名，旧：`export function GateScreen() {`

新：

```tsx
export function GateScreen({ resetHold, onHold, onRelease }: {
  /** 闸门此刻被找回密码那条路按着（有 session、新密码还没设）——弹窗要开在「设新密码」那一步 */
  resetHold: boolean;
  onHold: () => Promise<void>;
  onRelease: () => Promise<void>;
}) {
  /** 找回密码那张弹窗开着时带的邮箱；null = 没开 */
  const [forgotEmail, setForgotEmail] = useState<string | null>(null);
```

③ `<SignInCard onNotice={setNotice} />` → `<SignInCard onNotice={setNotice} onForgot={setForgotEmail} />`

④ 最外层 `<View ref={root.ref} …>` 收尾的 `</View>` 前面加：

```tsx
      {/* 两条路打开它：点了「忘记密码？」；或者闸门被按着（冷启动回来、上一次停在「设新密码」）。
          验码成功那一刻两个条件都成立，还是同一个实例——这一步不会被换掉重来 */}
      {forgotEmail !== null || resetHold ? (
        <ForgotDialog
          initialEmail={forgotEmail ?? ""}
          initialStage={forgotEmail === null ? "set" : "email"}
          onClose={() => setForgotEmail(null)}
          onHold={onHold}
          onRelease={onRelease}
        />
      ) : null}
```

- [ ] **Step 7: `mobile/App.tsx` 接上按住 / 放开**

① `import { useEffect, useState } from "react";` → `import { useCallback, useEffect, useState } from "react";`，并加 `import { readResetHold, writeResetHold } from "./src/gate/resetHold.js";`

② `const [hasSession, setHasSession] = useState(false);` 下面加 `const [resetHold, setResetHold] = useState(false);`

③ 冷启动那段，旧：

```tsx
      const { data } = await supabase.auth.getSession();
      setHasSession(data.session !== null);
      setDone((n) => n + 1);
```

新：

```tsx
      const { data } = await supabase.auth.getSession();
      setHasSession(data.session !== null);
      // 上一次停在「设新密码」那一步就被杀掉了：session 还在就接着按住；session 没了就是残留，清掉
      const held = await readResetHold();
      if (held && data.session === null) await writeResetHold(false);
      setResetHold(held && data.session !== null);
      setDone((n) => n + 1);
```

④ 开屏那只钟的 effect 后面加：

```tsx
  // 找回密码那条路的「按住 / 放开」：先落盘再改状态——验码换来 session 的那一刻，闸门看到的已经是按住
  const hold = useCallback(async () => {
    await writeResetHold(true);
    setResetHold(true);
  }, []);
  const release = useCallback(async () => {
    await writeResetHold(false);
    setResetHold(false);
  }, []);
```

⑤ `gateView({ … resetHold: false, })` → `resetHold,`

⑥ `{view === "splash" ? <Splash progress={progress} /> : <GateScreen />}` →

```tsx
        {view === "splash"
          ? <Splash progress={progress} />
          : <GateScreen resetHold={view === "resetHold"} onHold={hold} onRelease={release} />}
```

- [ ] **Step 8: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 退出码 0。

- [ ] **Step 9: 模拟器验收**（发信配额：每小时两封，这一整条只发一次信）

1. 登录态点「忘记密码？」→ 居中弹窗「找回密码」，邮箱已经带上卡里填的那个；「取消」关掉。截图 `/tmp/otto-t8-forgot.png`，对照 demo 的 forgot。
2. 「发送验证码」→ 原地换成「填验证码」：说明里邮箱加粗、**没有**「邮件里那条链接点了也算」；8 格 4 + 4、数字键盘；「重新发送（59s）」在倒数；「换个邮箱」回到第一步。截图 `/tmp/otto-t8-code.png`，对照 demo 的 forgotCode。
3. 粘贴「验证码：12345678」→ 格子里只剩 8 位数字、立刻自己交；码不对时弹窗里冒出一句人话，闸门没被按住（取消后还在登录页）。
4. 填对的码 → 原地换成「设一个新密码」，左边那颗变成「以后再说」；两次不一样时第二格下面出红字。截图 `/tmp/otto-t8-set.png`，对照 demo 的 forgotSet。
5. **停在这一步把 app 从多任务里划掉**，再打开：开屏之后回到的是「设一个新密码」，不是三栏。
6. 「保存」→ 进三栏；退出登录，用新密码能登进来。（另起一次可验「以后再说」→ 直接进三栏。）
7. 打开「减弱动态效果」：三步之间瞬切，弹窗只淡入淡出。

- [ ] **Step 10: Commit**

```bash
git add mobile/App.tsx mobile/src
git commit -m "feat(mobile): 忘记密码——一张弹窗里原地换三步，验完码先按住闸门（#1237 M1）

填邮箱 → 8 位验证码（4 + 4，填满就交，一个真输入框 + otpCells 画格子）→ 设新密码。
recovery OTP 换到的是真 session：验之前先把「按住」落进 kv-store，冷启动回来也还按着，
设完或明说「以后再说」才放开（同桌面 ADR-0194）。第二步的说明去掉了「邮件里那条链接
点了也算」——手机端没有接那条深链（spec §10）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```


### Task 9: ADR、README、索引，收尾开 PR

**Files:**
- Create: `docs/adr/0293-手机端从投影窗口扩成三栏客户端.md`
- Modify: `mobile/README.md`、`AGENTS.md`（「Where to find things」加一行，L2）；实施中出现的偏差追加进 spec §10

**Interfaces:**
- Consumes: Task 1–8 的全部产出
- Produces: 一个开着的 PR（`Refs #1237`，不关 issue——M2 起还挂在它下面）

- [ ] **Step 1: 认领 ADR 编号**（项目 ADR-0074：合并时认领，不是开分支时）

Run: `git fetch origin && git ls-tree --name-only origin/main docs/adr/ | tail -3`
Expected: 最大号还是 0292 → 用 0293。已经被占了就用「最大号 + 1」，ADR 文件头第一行加 `> 原为 ADR-0293`，并把代码注释里的 `ADR-0293` 一并改掉（`grep -rn "ADR-0293" mobile docs AGENTS.md`）。

- [ ] **Step 2: 写 ADR——`docs/adr/0293-手机端从投影窗口扩成三栏客户端.md`**

```markdown
# ADR-0293：手机端从投影窗口扩成三栏客户端

- 日期：2026-09-11
- 状态：已接受
- Task issue：#1237
- 关系：扩展 ADR-0094「手机端是隔着公网的第三个投影窗口」——它背景里「看 + 审批」那句范围作废，决定 1–6 在项目栏原样成立。spec `docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md`；plan `docs/superpowers/plans/2026-09-11-mobile-m0-m1-shell-and-gate.md`；demo `.demo/mobile-app-redesign.html`

## 背景

维护者原话（#1237）：「在 App 上要获得和桌面端几乎一致的体验，包括语音通话等……App 是作为一个脱离了桌面端，也可以完全独立运行，帮用户完成项目或需求的一个端口。」手机端此前只做「看时间线 + 审批 + 回一条话」（ADR-0094），一个 phase 字段推着三屏走，没有导航库。

## 决定

1. **手机端是三栏客户端：任务 / 项目 / 团队。** 三栏三种写法各有出处、不混：项目栏是到自己电脑的加密投影，手机永不产生事实（ADR-0094 决定 5 原样）；任务栏的 human 类事件经 RPC 直写（ADR-0291 已放宽）；团队栏写事实的是 runtime（cs 协议）。
2. **导航用 react-navigation 7 的原生栈 + bottom-tabs 自定义页签栏。** 每栏一个原生栈（react-native-screens = UINavigationController）：推入 / 返回 / 左缘右划由系统做，天然可打断。否决 Expo Router（入口与目录要重排，metro 的 `watchFolders` 与 `.js → .ts` 解析要一起重配，而它底下就是 react-navigation）与手写栈（桌面 ADR-0264 自写弹簧是 web 上没有原生栈）。
3. **依赖只取 Expo Go（SDK 57）自带的原生模块**：react-native-screens、react-native-safe-area-context、expo-blur、expo-haptics、react-native-svg、expo-font；其余是纯 JS（@react-navigation/*、@expo-google-fonts/poppins）。`react-native-reanimated` / `react-native-gesture-handler` 跟 M2 的底部抽屉一起进——M0/M1 没有手势驱动的动效，RN 自带的 `Animated.spring` 吃同一套物理参数（`src/shared/appleSpring.ts`）。
4. **图标用 demo 同一份路径经 react-native-svg 画**，不引 lucide-react-native：demo 的 `spark` 不是 lucide 原图，照 lucide 画会和过目的那版不一样。
5. **配对不再是进门的一步。** 登录后直接进三栏；项目栏没配过就给一张卡，配对页在根栈里。
6. **进门的判据两端共用。** 验证码、登录表单、报错翻译、冷启动进度、等确认信的节奏从桌面渲染层挪进 `src/shared/`；进门此刻画哪一屏由 `src/shared/mobileGate.ts` 的 `gateView` 说了算。找回密码验完验证码先按住闸门（落 kv-store，冷启动也记得），设完新密码或明说「以后再说」才放开——同 ADR-0194 的理由。
7. **表单与确认类用居中弹窗（`mobile/src/dialog.tsx`），选择器类用底部抽屉（M2 起）。** 维护者在订阅页说「采取弹窗显示，不要下拉框」。

## 后果

- 好友的角标（待处理请求 + 未读）三栏之后暂时没有地方画，M6 接回。
- 任务 / 团队两栏在 M2 / M3 之前是实话空态（手机端没有发布渠道，中间态只有维护者看得到）。
- 账号页的热力图与模型占比仍然要电脑在线（ADR-0115 的 `stats` 帧）。
- 「密码不对」的提示两端都带上「用 Google / GitHub 注册的账号没有密码」那一句。
- `mobile/` 的类型检查仍不在门禁（#422 已定方向 B，另走 L1 PR），这之前靠手跑 + PR 正文。
- 三栏壳与进门只在 iOS 模拟器上验过，真机一次没跑过（毛玻璃、弹簧手感、键盘、触感）。
```

- [ ] **Step 3: `mobile/README.md`**

① 开头那两行（`范围只有两件事：…` 与 `不建会话、不改设置、不切模型、不管 MCP。`）换成：

```markdown
三栏客户端：**任务 / 项目 / 团队**（ADR-0293；spec `docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md`，
可交互 demo `.demo/mobile-app-redesign.html`）。今天做到 M0 + M1：三栏导航壳与进门。
项目栏是到自己电脑的加密投影（ADR-0094 / 0096 原样），任务栏、团队栏在 M2 / M3 接上。
```

② 在「## 跑起来」之前加一节：

```markdown
## 结构

- `App.tsx`：开屏 → 进门 → 三栏；此刻画哪一屏由 `src/shared/mobileGate.ts` 的 `gateView` 说了算
- `src/nav/`：根栈（三栏 + 账号 / 好友 / 配对）、毛玻璃页签栏、右上头像
- `src/gate/`：开屏、登录 / 注册卡、等确认信、忘记密码三步
- `src/tabs/`、`src/projects/`、`src/account/`、`src/pair/`、`src/friends/`：各屏
- `src/ui.tsx`、`src/dialog.tsx`、`src/icons.tsx`、`src/chrome.tsx`、`src/link.tsx`：组件层与共享状态
- 能测的判断一律住 `src/shared/`（跟着根门禁跑），这里只放装配与画法
```

- [ ] **Step 4: `AGENTS.md` 索引加一行**（L2：只动「Where to find things」）

在 `- \`mobile/src/friends.tsx\` / \`mobile/src/friendsApi.ts\` …` 那一行后面插入：

```markdown
- `mobile/src/nav/` / `mobile/src/gate/` / `src/shared/mobileGate.ts` — 手机端三栏壳与进门（ADR-0293，#1237）：每一栏一个原生栈，账号 / 好友 / 配对在根栈；配对不再是进门的一步；进门此刻画哪一屏由 `gateView` 说了算，找回密码验完码先按住闸门（落 kv-store，同 ADR-0194）。进门的判据（验证码 / 登录表单 / 报错翻译 / 冷启动进度 / 等确认信的节奏）住 `src/shared/`，桌面渲染层只剩 import
```

- [ ] **Step 5: 全门禁 + 手机类型检查**

Run: `npm test && npm --prefix mobile run typecheck`
Expected: 都是 0（`tests/docs/adrNumbers.test.ts` 会查 ADR 编号唯一、不跳号）。

- [ ] **Step 6: Commit**

```bash
git add docs/adr mobile/README.md AGENTS.md docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md
git commit -m "docs: ADR-0293 手机端扩成三栏客户端 + README 与索引（#1237）

ADR-0094 的「看 + 审批」范围作废、决定 1–6 在项目栏原样成立；导航、依赖、图标、
配对、进门判据、弹窗与抽屉的分工各一条。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: 推送并开 PR**

```bash
git push -u origin claude/otto-app-redesign-aedb3e
gh pr create --title "feat(mobile): 三栏导航壳与进门（#1237 M0 + M1）" --body-file /tmp/pr-body.md
```

`/tmp/pr-body.md`：

```markdown
## 做了什么

- **M0 三栏壳**：任务 / 项目 / 团队三栏，每栏一个原生栈、原生大标题、右上头像；毛玻璃页签栏；账号 / 好友 / 配对在根栈。今天的功能原样搬进来（舰队 → 项目栏根，设置 → 账号，好友降到账号里），配对不再是进门的一步。
- **M1 进门**：开屏（脸 + 进度条，真实启动 × 最短停留）、登录 / 注册同一张玻璃卡、等确认信（居中弹窗，自己轮询）、忘记密码三步（一张弹窗原地换，8 位验证码，验完先按住闸门）。
- 进门的判据挪进 `src/shared/` 两端共用；新 `gateView` / `otpCells` / `appleSpring` / `linkStatus` 带测试。
- ADR-0293。

## 检查

- `npm test`：（贴结果）
- `npm --prefix mobile run typecheck`：（贴结果——#422 收口前手机端的类型检查不在门禁里）
- iOS 模拟器（iPhone 17 Pro，深浅色）：（逐条列 Task 4 / 6 / 7 / 8 验收里的截图与结论）

## 已知

- 好友的角标暂时没有地方画（M6 接回）；任务 / 团队两栏是实话空态（M2 / M3）。
- 真机一次没跑过。
- 与 demo 的不同见 spec §10。

Refs #1237

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

CI 绿了之后由作者自己合并（merge commit，不 squash）；#1237 不关，M2 起还挂在它下面。
