# shadcn/ui 接入 + light/dark 主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 令牌体系全盘 shadcn 语义化 + light/dark 双主题(colorhunt 双板)+ 六个 shadcn 组件替换核心交互件。

**Architecture:** CSS 变量双主题(`:root` = light,`.dark` = dark)经 `@theme inline` 映射成 Tailwind utility;`theme.ts` 纯逻辑控制器(可注入环境,node 环境可测)管 `system|light|dark` 偏好;shadcn CLI 生成组件入库(可改),`@/` 别名指 renderer src。

**Tech Stack:** Tailwind v4.3(@theme inline / @custom-variant)、shadcn/ui CLI、Radix、vitest(node 环境,注入假环境测 theme 逻辑)。

**Spec:** `docs/superpowers/specs/2026-08-17-shadcn-theming-design.md`,issue #13。

## Global Constraints

- 分支 `feat/shadcn-theming`,一个 PR,body 带 `Closes #13`
- 门禁 `npm test` 必须绿;`npx tsc --noEmit` 干净;`npm run build` 绿
- 橙 `#FE7F2D`(dark)/蓝 `#4A70A9`(light)只做点缀(链接・光标・焦点环・活跃态),主面积禁用
- 状态色保留:ok `#2f9e44` err `#e8590c` deny `#e03131` warn `#f08c00`(light 微调见 Task 1 代码)
- 渲染进程不碰 Node API(theme 用 localStorage/matchMedia,纯浏览器 API,不走 IPC)
- 测试放 `tests/` 镜像 `src/`;theme 测试 = `tests/renderer/theme.test.ts`,node 环境 + 注入假环境,不装 jsdom
- CSP 禁内联 script(index.html `default-src 'self'`)——防闪初始化放 `main.tsx` 顶部,不改 CSP
- commit 中文、讲 why,结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 令牌层重写 + 全量类名迁移(新配色落地,双主题变量就位)

**Files:**
- Modify: `src/renderer/src/app.css`(整体重写变量层,保留区变量化)
- Modify: `src/renderer/src/App.tsx`(类名替换,约 120 处)
- Modify: `src/renderer/src/replay/Replay.tsx`(类名替换,约 25 处)
- Modify: `src/renderer/index.html`(`<html>` 加 `class="dark"` 防闪默认)

**Interfaces:**
- Produces: Tailwind 颜色类 `bg-background/text-foreground/bg-card/border-border/text-muted-foreground/bg-primary/text-primary-foreground/bg-secondary/bg-muted/bg-accent/text-brand/ring-ring/text-destructive` + 状态类 `text-ok/text-err/text-deny/text-warn`;CSS 变量 `--background/--foreground/--card/--card-foreground/--primary/--primary-foreground/--secondary/--secondary-foreground/--muted/--muted-foreground/--accent/--accent-foreground/--brand/--border/--input/--ring/--destructive/--destructive-foreground/--popover/--popover-foreground`(Task 3 shadcn 组件直接吃这套)
- 本任务结束 app 是**新 dark 配色**(黑底 `#000000`、面板 `#233D4D`、橙点缀),light 值已定义但无切换入口(Task 2 加)

- [ ] **Step 1: app.css 变量层重写**

`@theme` 块替换为「裸变量 + @theme inline」结构。文件头到 `@layer base` 前整段换成:

```css
/* Tailwind v4 入口(ADR-0010/0011)。布局/间距/颜色全部住进 JSX utility;
   这里只留 utility 够不着的:主题变量、生成 DOM 的排版(markdown/hljs)、
   动态 SVG 状态(replay 画布)、滚动条、keyframes、少量组件类(.btn,Task 3 删)。
   双主题:裸变量 :root = light,.dark 覆盖 = dark,@theme inline 映射成 utility。 */
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  color-scheme: light;
  --background: #efece3;
  --foreground: #000000;
  --card: #f7f5ef;
  --card-foreground: #000000;
  --popover: #f7f5ef;
  --popover-foreground: #000000;
  --primary: #4a70a9;
  --primary-foreground: #ffffff;
  --secondary: #8fabd4;
  --secondary-foreground: #000000;
  --muted: #e5e1d3;
  --muted-foreground: rgba(0, 0, 0, 0.55);
  --accent: #dce6f2;
  --accent-foreground: #000000;
  --brand: #4a70a9;
  --border: rgba(0, 0, 0, 0.12);
  --input: rgba(0, 0, 0, 0.12);
  --ring: #4a70a9;
  --destructive: #c92a2a;
  --destructive-foreground: #ffffff;
  /* 状态色(light 压深一档保对比) */
  --ok: #2b8a3e;
  --err: #d9480f;
  --deny: #c92a2a;
  --warn: #e67700;
  /* 保留区双主题变量 */
  --code-bg: rgba(0, 0, 0, 0.05);
  --code-border: rgba(0, 0, 0, 0.08);
  --pre-bg: rgba(0, 0, 0, 0.04);
  --md-strong: #000000;
  --md-em: #333333;
  --md-quote: #4a4a44;
  --scrollbar-thumb: rgba(0, 0, 0, 0.18);
  --hljs-keyword: #8250df;
  --hljs-string: #0a3069;
  --hljs-number: #953800;
  --hljs-comment: #6e7781;
  --hljs-title: #0550ae;
  --hljs-attr: #0550ae;
  --hljs-variable: #24292f;
  --hljs-type: #0f766e;
  --hljs-tag: #116329;
  --hljs-meta: #7d4e00;
  --hljs-addition: #116329;
  --hljs-deletion: #82071e;
  --hl-key: #0550ae;
  --hl-string: #0a3069;
  --hl-number: #953800;
  --hl-ident: #6f42c1;
  --hl-keyword: #cf222e;
  --hl-punct: #57606a;
  --hl-comment: #6e7781;
  --rp-node-fill: #f7f5ef;
  --rp-node-stroke: #8a8a80;
  --rp-node-text: #4b4b46;
  --rp-node-sub: #77776f;
  --rp-node-file: #6b7a88;
  --rp-edge: #b5b1a4;
  --rp-edge-text: #77776f;
}

.dark {
  color-scheme: dark;
  --background: #000000;
  --foreground: #eaecf0;
  --card: #233d4d;
  --card-foreground: #eaecf0;
  --popover: #233d4d;
  --popover-foreground: #eaecf0;
  --primary: #233d4d;
  --primary-foreground: #eaecf0;
  --secondary: #2e4a5c;
  --secondary-foreground: #eaecf0;
  --muted: #16262f;
  --muted-foreground: rgba(234, 236, 240, 0.6);
  --accent: #2e4a5c;
  --accent-foreground: #eaecf0;
  --brand: #fe7f2d;
  --border: rgba(234, 236, 240, 0.15);
  --input: rgba(234, 236, 240, 0.15);
  --ring: #fe7f2d;
  --destructive: #e03131;
  --destructive-foreground: #ffffff;
  --ok: #2f9e44;
  --err: #e8590c;
  --deny: #e03131;
  --warn: #f08c00;
  --code-bg: rgba(255, 255, 255, 0.08);
  --code-border: rgba(255, 255, 255, 0.09);
  --pre-bg: rgba(0, 0, 0, 0.32);
  --md-strong: #ffffff;
  --md-em: #d8d8dc;
  --md-quote: #b8b8bc;
  --scrollbar-thumb: rgba(255, 255, 255, 0.14);
  --hljs-keyword: #c792ea;
  --hljs-string: #a5d6a7;
  --hljs-number: #f7b26b;
  --hljs-comment: #6b6b73;
  --hljs-title: #74c0fc;
  --hljs-attr: #8ab4f8;
  --hljs-variable: #d8d8dc;
  --hljs-type: #7fd4c1;
  --hljs-tag: #e8a2a2;
  --hljs-meta: #b8a04a;
  --hljs-addition: #7fd48a;
  --hljs-deletion: #e08a8a;
  --hl-key: #74c0fc;
  --hl-string: #a5d8b0;
  --hl-number: #ffa94d;
  --hl-ident: #dcbdfb;
  --hl-keyword: #ff7b72;
  --hl-punct: #7a7f88;
  --hl-comment: #6a7a8a;
  --rp-node-fill: #182b36;
  --rp-node-stroke: #4a6172;
  --rp-node-text: #9aa7b0;
  --rp-node-sub: #6a7a86;
  --rp-node-file: #5b7181;
  --rp-edge: #35505f;
  --rp-edge-text: #6a7a86;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-brand: var(--brand);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-ok: var(--ok);
  --color-err: var(--err);
  --color-deny: var(--deny);
  --color-warn: var(--warn);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* 内置缓动太弱,UI 一律强 ease-out(快起步 = 响应感) */
  --ease-strong: cubic-bezier(0.23, 1, 0.32, 1);
}
```

- [ ] **Step 2: app.css 保留区改用变量**

`@layer base` 与 `@layer components` 内逐处替换(旧值 → 新写法):

| 位置 | 旧 | 新 |
|---|---|---|
| body | `background: var(--color-bg); color: var(--color-text)` | `background: var(--background); color: var(--foreground)` |
| focus-visible 环 | `box-shadow: 0 0 0 3px rgba(116,192,252,0.25)` | `box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 30%, transparent)` |
| `.btn` | `background: var(--color-panel); color: var(--color-text); border-color: var(--color-line)` | `background: var(--card); color: var(--card-foreground); border-color: var(--border)`;hover `border-color: var(--ring)` |
| `.md strong` | `color:#fff` | `color: var(--md-strong)` |
| `.md em` | `#d8d8dc` | `var(--md-em)` |
| `.md a` | `#74c0fc` | `var(--brand)` |
| `.md code` | `background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.09)` | `var(--code-bg)` / `var(--code-border)` |
| `.md pre` | `background: rgba(0,0,0,0.32); border-color: var(--color-line)` | `var(--pre-bg)` / `var(--border)` |
| `.md blockquote` | `border-left-color:#3a5a7a; color:#b8b8bc` | `var(--brand)` / `var(--md-quote)` |
| `.md hr`/`.md th,.md td` | `var(--color-line)` | `var(--border)` |
| `.md th` | `background: rgba(255,255,255,0.05)` | `background: var(--muted)` |
| `.md .hljs-*` 全组 | 硬编码 hex | 对应 `var(--hljs-*)`(keyword/literal/built_in→keyword,string/regexp→string,number→number,comment/quote→comment,title→title,attr/attribute/property→attr,variable/params→variable,type/class title→type,tag/name→tag,meta/doctag→meta,addition→addition,deletion→deletion) |
| `.hl .hk/.hs/.hd/.hv/.hw/.hp/.hn` | 硬编码 | `var(--hl-key/string/number/ident/keyword/punct/comment)` |
| `.streaming::after` | `background: var(--color-accent-hi)` | `background: var(--brand)` |
| `.replay` 局部变量 | `--hot: var(--color-ok)` 等 | `--hot: var(--ok); --hot-bg: color-mix(in srgb, var(--ok) 14%, transparent); --deny-bg: color-mix(in srgb, var(--deny) 14%, transparent)` |
| `.replay .node rect/ellipse` | `fill:#232325; stroke:#555` | `fill: var(--rp-node-fill); stroke: var(--rp-node-stroke)` |
| `.replay .node text` | `fill:#9a9a9a` | `var(--rp-node-text)` |
| `.replay .node .sub` | `#6a6a6e` | `var(--rp-node-sub)` |
| `.replay .node .file` | `#565b63`;hot `#74c0fc` | `var(--rp-node-file)`;hot `var(--brand)` |
| `.replay .node.hot filter` | `drop-shadow(... rgba(47,158,68,0.55))` | `drop-shadow(0 0 6px color-mix(in srgb, var(--ok) 55%, transparent))` |
| `.replay .node.deny` | `stroke: var(--color-deny)`,shadow rgba | `var(--deny)`,`color-mix(in srgb, var(--deny) 55%, transparent)` |
| `.replay .node.hot text` | `var(--color-text)` | `var(--foreground)` |
| `.replay .edge path` | `stroke:#3f3f42` | `var(--rp-edge)` |
| `.replay .edge text` | `#6a6a6e` | `var(--rp-edge-text)` |
| `.replay .edge.deny` | `var(--color-deny)` | `var(--deny)` |
| scrollbar-thin / thin-x thumb | `rgba(255,255,255,0.14)` | `var(--scrollbar-thumb)` |

- [ ] **Step 3: index.html 防闪默认 dark**

`<html lang="zh">` → `<html lang="zh" class="dark">`(Task 2 的 main.tsx 早期初始化会按偏好摘/留;静态默认 dark = 老用户观感连续,首帧不闪白)。

- [ ] **Step 4: App.tsx + Replay.tsx 类名全量替换**

机械映射(两文件全部出现处,含模板串常量):

| 旧类 | 新类 |
|---|---|
| `bg-bg` | `bg-background` |
| `text-text` | `text-foreground` |
| `bg-panel` | `bg-card` |
| `border-line` | `border-border` |
| `text-dim` | `text-muted-foreground` |
| `bg-accent`(用户气泡・发送钮) | `bg-primary text-primary-foreground`(原挂 text 白的地方去重) |
| `border-accent` | `border-primary` |
| `text-accent-hi` | `text-brand` |
| `text-ok/text-err/text-deny/text-warn/border-err` | 不变(令牌仍在) |

硬编码 hex/rgba 清扫(grep `#[0-9a-fA-F]\{3,6\}\|rgba(` 两文件,常量区为主):

| 旧 | 新 |
|---|---|
| `focus:border-[#3a5a7a]`(FOCUS_INPUT) | `focus:border-ring` |
| `focus:shadow-[0_0_0_3px_rgba(116,192,252,0.1)]` | `focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_15%,transparent)]` |
| `hover:bg-[#35587a]`(发送钮) | `hover:bg-primary/85` |
| `border-[#3a3a40]`(THINKING_DETAILS) | `border-border` |
| `hover:bg-white/5 active:bg-white/[0.09]`(SESSION_ITEM 等) | `hover:bg-foreground/5 active:bg-foreground/[0.09]` |
| `hover:text-text hover:border-text`(HEADER_GHOST 等) | `hover:text-foreground hover:border-foreground` |
| CtxRing `var(--color-deny)/var(--color-warn)` | 不变(@theme inline 仍生成 `--color-deny/--color-warn`) |
| 其余出现的暗色专用 hex(如 `#4a4a4e`) | 就近换语义 token(`border-border`/`border-ring`),逐个判断 |

rp-step 当前态 `bg-[rgba(47,158,68,0.14)] shadow-[inset_2px_0_0_#2f9e44]`(Replay)→ `bg-ok/15 shadow-[inset_2px_0_0_var(--color-ok)]`;deny 同理 `bg-deny/15` + `var(--color-deny)`。

- [ ] **Step 5: 验证**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 全绿。
再 grep 残留:`grep -rn "bg-panel\|border-line\|text-dim\b\|text-text\|accent-hi\|color-bg\|color-panel\|color-line\|--color-text\|--color-dim" src/renderer/` 应为空。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: 令牌层 shadcn 语义化 + 双主题变量就位——dark 换 colorhunt 新配色,light 值待切换入口"
```

---

### Task 2: theme.ts 控制器(TDD)+ 防闪初始化 + 设置页外观三选

**Files:**
- Create: `src/renderer/src/theme.ts`
- Test: `tests/renderer/theme.test.ts`
- Modify: `src/renderer/src/main.tsx`(顶部早期初始化)
- Modify: `src/renderer/src/App.tsx`(设置页加外观行,原生 select——Task 3 换 shadcn Select)

**Interfaces:**
- Produces:
  ```ts
  export type ThemePref = "system" | "light" | "dark";
  export interface ThemeEnv {
    getStored(): string | null;
    setStored(v: ThemePref): void;
    systemDark(): boolean;
    onSystemChange(cb: () => void): () => void; // 返回取消订阅
    applyDark(dark: boolean): void;             // <html> 挂/摘 dark 类
  }
  export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark";
  export function createThemeController(env: ThemeEnv): {
    pref(): ThemePref;
    setPref(p: ThemePref): void;
    dispose(): void;
  };
  export function browserThemeEnv(): ThemeEnv;   // localStorage key "otter-theme" + matchMedia + documentElement
  export function initTheme(): ReturnType<typeof createThemeController>; // main.tsx 用,单例
  export function themeController(): ReturnType<typeof createThemeController>; // App 取同一单例
  ```
- 语义:非法存储值当 `system`;创建即 `applyDark(resolveTheme(...))`;订阅常驻,回调里仅当 `pref()==="system"` 才重新 apply;`setPref` 先存后 apply。

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/theme.test.ts
import { describe, it, expect } from "vitest";
import { resolveTheme, createThemeController, type ThemeEnv, type ThemePref } from "../../src/renderer/src/theme.js";

function fakeEnv(init: { stored?: string | null; systemDark?: boolean } = {}) {
  let stored = init.stored ?? null;
  let sysDark = init.systemDark ?? false;
  const applied: boolean[] = [];
  let listener: (() => void) | null = null;
  const env: ThemeEnv = {
    getStored: () => stored,
    setStored: (v: ThemePref) => { stored = v; },
    systemDark: () => sysDark,
    onSystemChange: (cb) => { listener = cb; return () => { listener = null; }; },
    applyDark: (d) => { applied.push(d); },
  };
  return {
    env, applied,
    setSystemDark(v: boolean) { sysDark = v; listener?.(); },
    stored: () => stored,
    hasListener: () => listener !== null,
  };
}

describe("resolveTheme", () => {
  it("light/dark 直出,system 跟系统", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("createThemeController", () => {
  it("无存储默认 system,创建即按系统 apply", () => {
    const f = fakeEnv({ systemDark: true });
    const c = createThemeController(f.env);
    expect(c.pref()).toBe("system");
    expect(f.applied).toEqual([true]);
  });

  it("非法存储值当 system", () => {
    const f = fakeEnv({ stored: "banana" });
    const c = createThemeController(f.env);
    expect(c.pref()).toBe("system");
  });

  it("setPref 持久化并立即 apply", () => {
    const f = fakeEnv({ systemDark: true });
    const c = createThemeController(f.env);
    c.setPref("light");
    expect(f.stored()).toBe("light");
    expect(f.applied.at(-1)).toBe(false);
  });

  it("system 时系统切换跟着变;手动锁定后系统切换不生效", () => {
    const f = fakeEnv();
    const c = createThemeController(f.env);
    f.setSystemDark(true);
    expect(f.applied.at(-1)).toBe(true);
    c.setPref("light");
    const n = f.applied.length;
    f.setSystemDark(false);
    f.setSystemDark(true);
    expect(f.applied.length).toBe(n); // 锁定后不再 apply
  });

  it("dispose 退订", () => {
    const f = fakeEnv();
    const c = createThemeController(f.env);
    expect(f.hasListener()).toBe(true);
    c.dispose();
    expect(f.hasListener()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/theme.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 theme.ts**

```ts
// 主题偏好控制器。纯逻辑 + 注入环境(可测);浏览器胶水只在 browserThemeEnv。
// UI 偏好非会话事实:localStorage 即可,不走 IPC,不进事件日志。
export type ThemePref = "system" | "light" | "dark";

export interface ThemeEnv {
  getStored(): string | null;
  setStored(v: ThemePref): void;
  systemDark(): boolean;
  onSystemChange(cb: () => void): () => void;
  applyDark(dark: boolean): void;
}

const PREFS: readonly ThemePref[] = ["system", "light", "dark"];
const STORAGE_KEY = "otter-theme";

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export function createThemeController(env: ThemeEnv) {
  const raw = env.getStored();
  let pref: ThemePref = PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : "system";
  const apply = () => env.applyDark(resolveTheme(pref, env.systemDark()) === "dark");
  const unsub = env.onSystemChange(() => {
    if (pref === "system") apply();
  });
  apply();
  return {
    pref: () => pref,
    setPref(p: ThemePref) {
      pref = p;
      env.setStored(p);
      apply();
    },
    dispose: unsub,
  };
}

export function browserThemeEnv(): ThemeEnv {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    getStored: () => localStorage.getItem(STORAGE_KEY),
    setStored: (v) => localStorage.setItem(STORAGE_KEY, v),
    systemDark: () => mq.matches,
    onSystemChange(cb) {
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    applyDark: (dark) => document.documentElement.classList.toggle("dark", dark),
  };
}

let singleton: ReturnType<typeof createThemeController> | null = null;
export function initTheme() {
  singleton ??= createThemeController(browserThemeEnv());
  return singleton;
}
export function themeController() {
  return initTheme();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/theme.test.ts`
Expected: PASS。

- [ ] **Step 5: main.tsx 早期初始化(防闪)**

```ts
import React from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./theme.js";
import { App } from "./App.js";
import "./app.css";

// 首帧前按偏好定主题:CSP 禁内联 script,module 顶层执行同样先于首次 paint
initTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 6: 设置页外观行**

App.tsx 设置页(通用设置区,与模型/Keys 行同级)加:

```tsx
const [themePref, setThemePref] = useState<ThemePref>(() => themeController().pref());
// ...
<label className="flex items-center justify-between gap-3 text-[13px]">
  <span className="text-muted-foreground">外观</span>
  <select
    className={SETTINGS_SELECT}
    value={themePref}
    onChange={(e) => {
      const p = e.target.value as ThemePref;
      themeController().setPref(p);
      setThemePref(p);
    }}
  >
    <option value="system">跟随系统</option>
    <option value="light">浅色</option>
    <option value="dark">深色</option>
  </select>
</label>
```

`SETTINGS_SELECT` 用设置页现成 select 样式常量(没有就沿用页面里已有 select 的 className 字面量);import `themeController, type ThemePref` from `./theme.js`。放哪个设置页由实现者看现有结构定(通用/General 区优先,没有就放模型设置页顶部)。

- [ ] **Step 7: 验证 + Commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 全绿。手动:`npm run dev` 起 app(先杀旧 Electron 实例),设置页切三档,观感变;重启保持。

```bash
git add -A && git commit -m "feat: light/dark 主题切换——theme 控制器纯逻辑可测,防闪走 main.tsx 顶层,偏好 localStorage"
```

---

### Task 3: shadcn 基建 + 六组件引入替换

**Files:**
- Create: `components.json`、`src/renderer/src/lib/utils.ts`、`src/renderer/src/components/ui/*.tsx`(button/select/textarea/dropdown-menu/switch/tooltip)
- Modify: `tsconfig.json`(paths)、`electron.vite.config.ts`(renderer alias)、`package.json`(依赖)
- Modify: `src/renderer/src/App.tsx`(按钮/下拉/composer/菜单替换)
- Modify: `src/renderer/src/replay/Replay.tsx`(按钮替换)
- Modify: `src/renderer/src/app.css`(删 `.btn` 组件类)

**Interfaces:**
- Consumes: Task 1 的 CSS 变量(shadcn 组件 className 直接引用 `bg-primary/bg-popover/text-muted-foreground` 等)
- Produces: `@/components/ui/{button,select,textarea,dropdown-menu,switch,tooltip}`、`@/lib/utils` 的 `cn()`

- [ ] **Step 1: 别名接线**

tsconfig.json `compilerOptions` 加:

```json
"baseUrl": ".",
"paths": { "@/*": ["src/renderer/src/*"] }
```

electron.vite.config.ts renderer 段:

```ts
import { resolve } from "path";
// ...
renderer: {
  resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
  plugins: [react(), tailwindcss()],
},
```

- [ ] **Step 2: components.json + cn()**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/renderer/src/app.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

```ts
// src/renderer/src/lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

`npm i clsx tailwind-merge`(shadcn add 会补 Radix/cva/lucide 依赖)。

- [ ] **Step 3: CLI 拉组件**

Run: `npx shadcn@latest add button select textarea dropdown-menu switch tooltip --yes`
Expected: 六文件落 `src/renderer/src/components/ui/`。CLI 若因框架探测失败,退路:从 https://ui.shadcn.com/r 逐个取源码手放同路径(内容入库可改,权责一样)。
装完 `npx tsc --noEmit` 过——组件如用 `data-slot`/`size-*` 等 v4 写法应原生兼容。

- [ ] **Step 4: 替换——按钮**

- `.btn` 挂载点(HEADER_GHOST、SEND_BTN、审批 allow/deny、设置页各钮、replay 控件等)换 `<Button>`:
  - 主行动(发送)→ `variant="default"`(吃 `bg-primary`)
  - ghost(header 齿轮・返回・新会话)→ `variant="ghost"`
  - 危险(deny・停止)→ `variant="destructive"`(停止钮原为透明红边,可用 `variant="outline"` + `text-destructive border-destructive` 保观感,实现者按现观感就近选)
  - 描边次要 → `variant="outline"`
- 尺寸:紧凑处 `size="sm"`,图标钮 `size="icon"`
- 原 `.btn` 上叠的定制类(圆角/内边距差异)通过 `className` 传入,`cn()` 合并
- 全部替完后删 app.css 里 `.btn` 块;`grep -rn '"btn\|btn '` renderer 下应无残留(注意别误删 `.md` 内无关匹配)

- [ ] **Step 5: 替换——Select / Textarea / DropdownMenu**

- header 模型下拉 + 设置页原生 select + Task 2 外观三选 → shadcn `<Select>`(受控:`value` + `onValueChange`,选项文案不变)
- composer `<textarea>` → shadcn `<Textarea>`,叠回 `field-sizing-content max-h-*` 自增高类与现有 onKeyDown(Enter 发送/Shift+Enter 换行)逻辑,行为一字不动
- ＋ 附件菜单、slash 命令菜单(自制 popover)→ `<DropdownMenu>`:触发键盘导航/Escape 关闭交给 Radix;slash 菜单若与输入焦点耦合深(边打字边过滤),实现者可判定保留自制、只换令牌色——判定写进 commit message,不算跑偏
- Switch 本轮无布尔场景,组件入库备用即可,不硬造用例

- [ ] **Step 6: 验证 + Commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 全绿。`npm run dev` 手动过一遍:发消息・切模型・附件菜单・slash・审批・设置页,交互无回归。

```bash
git add -A && git commit -m "feat: shadcn 六组件落地替换核心交互件——Button/Select/Textarea/DropdownMenu 进场,.btn 退役"
```

---

### Task 4: Tooltip 收尾 + ADR-0011 + PR

**Files:**
- Modify: `src/renderer/src/App.tsx`(高频钮加 Tooltip)
- Create: `docs/adr/0011-theme-tokens.md`

**Interfaces:**
- Consumes: `@/components/ui/tooltip`

- [ ] **Step 1: Tooltip 四处**

发送・停止・附件(＋)・设置(齿轮)四钮:现有 `title=` 属性移除,换

```tsx
<TooltipProvider delayDuration={400}>
  {/* App 根包一次 Provider */}
</TooltipProvider>

<Tooltip>
  <TooltipTrigger asChild>{/* 原按钮 */}</TooltipTrigger>
  <TooltipContent>发送(Enter)</TooltipContent>
</Tooltip>
```

文案沿用原 title 文本。仅这四处,别处 title 留着(低频不值 DOM 包装成本)。

- [ ] **Step 2: ADR-0011**

`docs/adr/0011-theme-tokens.md`,内容要点(用现有 ADR 文件格式):

- 决定:令牌全盘 shadcn 语义命名;裸变量 `:root`(light)/`.dark` + `@theme inline`;`--brand` 单独于 `--accent`(shadcn 悬停面),点缀色(dark 橙 `#FE7F2D`/light 蓝 `#4A70A9`)只上链接・光标・焦点环・活跃态,主面积禁用
- 理由:shadcn 组件零对色成本;双主题变量一处切换;橙色大面积会盖过状态色语义(ok/deny 也是红绿)
- 后果:保留区(md/hljs/hl/replay)颜色全走变量,新增颜色必须双主题定义;`system|light|dark` 偏好在 localStorage(`otter-theme`),非会话事实不进事件日志
- 替代:方案 B(保留旧令牌名桥接)被否——两套词汇长期税

- [ ] **Step 3: 门禁 + PR**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 全绿。

```bash
git push -u origin feat/shadcn-theming
gh pr create --title "feat: shadcn/ui 接入 + light/dark 主题" --body "Closes #13

- 令牌 shadcn 语义化,:root/.dark 双主题(colorhunt 双板,橙/蓝只做点缀,--brand 与 --accent 分离)
- theme 控制器(system|light|dark,localStorage,防闪走 main.tsx 顶层),设置页外观三选
- shadcn 六组件:Button/Select/Textarea/DropdownMenu/Switch(备用)/Tooltip,.btn 退役
- 保留 CSS 区(md/hljs/hl/replay/滚动条)全变量化,双主题可读
- ADR-0011

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

PR 开出后停:用户视觉验收(双主题下聊天时间线・审批卡・回放・设置页・slash 菜单・附件 chips),用户说 merge 才合(merge commit,禁 squash)。
