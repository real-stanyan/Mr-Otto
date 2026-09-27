---
name: Mr Otto
description: 一支会动手干活的 AI 智能体团队。像素脸是身份，其余界面退到系统级的安静里。
colors:
  background: "#efece3"
  background-dark: "#000000"
  card: "#f7f5ef"
  card-dark: "#1d1d1f"
  sidebar: "#e9e5d8"
  sidebar-dark: "#1d1d1f"
  muted: "#e5e1d3"
  muted-dark: "#2c2c2e"
  secondary: "#8fabd4"
  secondary-dark: "#2c2c2e"
  accent: "#dce6f2"
  accent-dark: "#2c2c2e"
  foreground: "#000000"
  foreground-dark: "#f5f5f7"
  muted-foreground: "rgba(0, 0, 0, 0.55)"
  muted-foreground-dark: "rgba(245, 245, 247, 0.56)"
  primary: "#4a70a9"
  primary-dark: "#0071e3"
  primary-foreground: "#ffffff"
  brand: "#4a70a9"
  brand-dark: "#0a84ff"
  border: "rgba(0, 0, 0, 0.12)"
  border-dark: "rgba(245, 245, 247, 0.12)"
  input: "rgba(0, 0, 0, 0.12)"
  input-dark: "rgba(245, 245, 247, 0.14)"
  self-bubble: "color-mix(in srgb, #4a70a9 18%, #f7f5ef)"
  self-bubble-dark: "color-mix(in srgb, #0a84ff 18%, #1d1d1f)"
  ok: "#2b8a3e"
  ok-dark: "#30d158"
  warn: "#e67700"
  warn-dark: "#ff9f0a"
  destructive: "#c92a2a"
  destructive-dark: "#ff453a"
  err: "#d9480f"
  err-dark: "#ff453a"
  face-disc: "#f2f2f3"
  voice: "#2F94A6"
typography:
  wordmark:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
  headline:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "1.25em"
    fontWeight: 650
    lineHeight: 1.3
  title:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "1.15em"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  control:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 500
  label:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.06em"
  caption:
    fontFamily: '-apple-system, "PingFang SC", sans-serif'
    fontSize: "11.5px"
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  settings: "10px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
  input:
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "24px"
  inset-group:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
  dialog:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
    padding: "24px"
  bubble-agent:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
  bubble-self:
    backgroundColor: "{colors.self-bubble}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
  section-label:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
---

# Design System: Mr Otto

> 这份文件记录的是**现有**实现（2026-09-27 由 `/impeccable document` 从代码提取，定调部分由维护者逐项确认）。令牌以上面的 YAML 为准；正文解释它们用在哪、为什么。令牌的源头是 `src/renderer/src/app.css`（桌面）与 `mobile/src/theme.ts`（手机，逐值照抄、名字对齐）。
>
> **读令牌的规矩**：带 `-dark` 后缀的是深色主题的值，不带后缀的是浅色主题的值；没有 `-dark` 兄弟的令牌两个主题同值。组件令牌按浅色名写，深色主题下每个引用换成它的 `-dark` 兄弟。YAML 的键名就是 `app.css` 里的 CSS 变量名（`card` 即 `--card`，Tailwind 里是 `bg-card`）。

## Overview

**Creative North Star: "像素同事"**

身份只有一种语言：黑白像素。app 图标是一张像素脸（`resources/icon.png`），每只智能体有一张会眨眼、会呼吸、说话时嘴会动的像素脸，进门页铺的是同一种 1-bit 的黑白抖动背景（dither）。脸让智能体读起来像一个同事，而不是一个功能入口。

其余一切都退到系统级的安静里：中性的底色、精确的对齐、设置式的分组卡。颜色只在出事的时候出现，界面不和活儿抢注意力。手感来自按下时那一下回弹、跟手的推入导航和快起步的缓动，而不是装饰。

两套主题都是品牌，跟随系统切换，改任何一套都按品牌改动来判：浅色是暖纸——燕麦色的地面、更亮一档的纸面、墨黑正文、低饱和的点缀蓝；深色是维护者 2026-08-19 指定的 Apple 四色底盘（地面 `#000000` / 浮起的表面 `#1d1d1f` / 正文 `#f5f5f7` / 点缀 `#0071e3`），中性档只从前两者往上抬一级得到，不另引入色相。

**Key Characteristics:**
- 像素脸是唯一带个性的视觉元素；其余界面中性、克制。
- 颜色只说「出事了」：正常和充足一律中性灰，红橙绿只报告状态。
- 扁平、靠色阶分层：静止的东西不投影，层级靠底色深浅。
- 设置式分组：圆角卡 + 内缩分隔线 + 组尾小字，不给每行各画一圈框。
- 动效快起步、强 ease-out，进场 150–200ms、离场 100–140ms；减动效时减弱，不取消。
- 中文优先的系统字体排版，14px 正文、11px 组头，密度中等偏紧。

## Colors

中性的底色撑起全部界面；点缀蓝是唯一的非状态色，只标主动作、焦点、选中和「正在发生」；红、橙、绿只用来报告状态。

### Primary
- **点缀蓝**（浅色 `primary` / 深色 `primary-dark`）：主按钮底色、焦点环（`--ring` 同值）。
- **点缀蓝·细线档**（`brand` / `brand-dark`）：小字、细线、角标、自己发出的气泡底色（以 18% 混进浮起的表面，即 `self-bubble`）、流式正文刚落下的那一瞬、Pro 徽章。深色下比 `primary-dark` 亮一档，因为 `#0071e3` 压在 `#1d1d1f` 上只有 3.58:1，13px 的字会发暗（桌面 issue #123）。浅色下与 `primary` 同值。

### Secondary
- **浅蓝实底**（`secondary` / `secondary-dark`）：次级实底按钮。深色下退成中性的 `#2c2c2e`。手机端浅色的 `secondary` 取的是 `#e5e1d3`（注释说要把蓝色让给真正的主动作），和桌面的 `#8fabd4` 不同——这是现存的一处两端分叉，待维护者定。

### Neutral
- **地面**（`background` / `background-dark`）：窗口本身的底。
- **浮起的表面**（`card` / `card-dark`）：卡片、分组卡、弹窗、浮层（`--popover` 同值）。
- **侧栏**（`sidebar` / `sidebar-dark`）：浅色下比地面深半档，深色下与浮起的表面同值。
- **抬一级的中性面**（`muted` / `muted-dark`）：智能体的气泡、分段控件的底、次级容器。
- **悬停底**（`accent` / `accent-dark`）：shadcn 语义里的悬停和选中底，不是点缀色；浅色下带一点蓝，深色下是中性灰。
- **正文**（`foreground` / `foreground-dark`）；**次要文字**（`muted-foreground`，55% / 56% 透明度）。
- **细线**（`border`，12%）与**输入框描边**（`input`，深色 14%）：一块板的边可以若隐若现，一个能往里打字的框必须先让人看见它在哪。
- **像素脸盘底**（`face-disc`）：两个主题同值。纯黑的头发压在纯黑底上会糊成一团，圆盘把脸托出来。

### Status
- **成功绿**（`ok` / `ok-dark`）、**警告橙**（`warn` / `warn-dark`）、**危险红**（`destructive` / `destructive-dark`，`--deny` 同值）、**错误橙红**（`err` / `err-dark`）。
- **通话青**（`voice`，仅手机端，两个主题同值）：通话那一格的声浪色。它是通话的记号，不跟深浅走。

### Named Rules
**The Color Means Trouble Rule.** 颜色只用来说「出事了」。充足、正常、空闲一律中性灰，不上品牌蓝——一根几乎满格的蓝条会把「一切正常」画得比「快没了」还响（ADR-0209 / 0239 / 0264）。

**The One Blue Rule.** 蓝色只给可以点的主动作、焦点、选中和正在发生的事。它是界面框架里唯一的非状态色（代码高亮、第三方 logo 这类内容不算），所以不拿它做装饰或区分分类。

**The Paired Theme Rule.** 新加一个颜色，必须同时给出浅色值和深色值，而且说得清它从哪一级抬出来；两端（桌面 `app.css`、手机 `theme.ts`）同名同值。

## Typography

**Display Font:** Poppins SemiBold Italic（只用于进门页那行「Mr Otto」字标，17px；随包分发 latin 子集，离线可用）
**Body Font:** 系统字体（`-apple-system, "PingFang SC", sans-serif`）
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace`（行内代码、代码块、需要按位对齐的数字）

**Character:** 系统字体承担全部界面，让它读起来像 macOS 自己的一部分；唯一的品牌字体只出现在字标上。

### Hierarchy
- **Headline**（650，1.25em，1.3）：模型输出正文里的一级标题。
- **Title**（650，1.15em / 1.05em，1.3）：二、三级标题。卡片和弹窗的标题用 semibold，行高收成 1。
- **Body**（400，14px，1.6）：全部正文，也是窗口的基准字号。
- **Control**（500，14px）：按钮、分段控件、菜单项。
- **Label**（600，11px，0.06em 字距，拉丁字母大写）：分组卡的组头、侧栏的分节标题。
- **Caption**（400，11.5px，1.5）：组尾解释、元信息。徽章另用 10–11.5px。
- **Mono**（12.5px）：代码。

### Named Rules
**The System Type Rule.** 界面文字一律走系统字体栈，不引入网络字体：这是桌面 app，离线也得能开，CSP 也不放行外域字体。要新字体就随包分发、按需子集化，像字标那样。

## Layout

- **窗口不滚动**：`html`、`body` 固定满高，滚动只发生在内部区域；内容会增长的区域（会话时间线）常驻滚动条槽位，免得内容跳。
- **桌面骨架**：左侧栏 16rem，顶部是三档分段控件（任务 / 项目 / 智能体），三档等宽；中间主区是时间线，头部钉顶、输入框钉底；右侧是一个槽位，Files、后台任务等面板同一时刻只开一个。
- **时间线**：占满主区宽度，两侧各留 16px，不设居中量尺；长会话只挂载最近一段，往上滚再补。
- **设置面**：推入式导航，目录一层、二级页一层；每一页是分组卡加组头、组尾。
- **间距**：Tailwind 的 4px 基准。组内 4–8px，组件内边距 12–16px，卡片和弹窗 24px。
- **弹窗**：居中，最大高度 `100dvh - 2rem`，超出时内部滚动，永不溢出屏幕。

## Elevation & Depth

扁平，靠色阶分层（维护者 2026-09-27 确认）。深色主题从 `#000000` 的地面到 `#1d1d1f` 的浮起表面再到 `#2c2c2e` 的中性面，一级一级抬高；浅色主题靠纸色的深浅（`#efece3` → `#f7f5ef`，`#e5e1d3`）。静止的东西不靠阴影表现层级；只有真正浮在内容之上的东西——弹窗、菜单、浮层、液态玻璃卡——才有阴影。输入框、描边按钮和 `Card` 身上 shadcn 默认带的 `shadow-xs` / `shadow-sm` 是存量，不算表达层级的手段，新东西不要再加。

### Shadow Vocabulary
- **焦点环**（`box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 30%, transparent)`）：只在 `:focus-visible` 时出现，鼠标点按不亮，键盘 Tab 才亮。
- **弹窗**（Tailwind `shadow-lg`）：居中弹窗，底下压一层 45% 的黑色遮罩。
- **液态玻璃**（`0 8px 24px color-mix(in srgb, var(--foreground) 10%, transparent)`，深色 `0 8px 24px rgb(0 0 0 / 0.35)`，外加三道内描边）：见 Components。

### Named Rules
**The Flat At Rest Rule.** 静止的表面不投影。要表现「这一块在上面」，先换底色，再考虑阴影；阴影只留给会盖住别的内容的浮层。

## Shapes

圆角由小到大各有归属：行内代码和小角标 4px；按钮、输入框、徽章 6px；套餐徽章 7px；代码块 8px；设置页里的卡片和图块 10px；卡片、分组卡、弹窗、聊天气泡 12px；登录卡这类更大的浮起块 16px；头像、状态点、药丸和分段控件的滑块全圆。线一律 1px 的细线（12% 透明度）；组内分隔线向右内缩到文字起点（有图标的组 51px、有头像的组 58px、没有前导的 13px），读作「同一份清单里的两条」，而不是两块东西的交界。

像素脸是方块像素画在一个圆盘上。它先画到一格一像素的离屏画布，再整张缩放：放大时关平滑（像素画的命脉），缩小时开平滑（一个像素装不下一格时，面积平均出来的小图才干净）。

## Components

### Buttons
- **Shape:** 微圆角矩形（6px）。
- **Primary:** 点缀蓝底、白字，14px / 500，高 36px，左右 16px；悬停时底色 90%。
- **Hover / Focus:** 颜色与阴影过渡 150ms，走 `--ease-strong`；按下缩到 0.97；键盘焦点是 3px 的焦点环。
- **Secondary / Outline / Ghost / Destructive / Link:** 次级实底 / 描边 / 透明（悬停上悬停底）/ 危险红 / 纯文字链接。尺寸 24 / 32 / 36 / 40px，外加同尺寸的方形图标钮。
- **Press feedback:** 其他可按的元素用 `press-scale`（0.97，120ms）；整张可按的卡片用 `press-card`（0.985），卡片面积大，缩多了会晃。

### Chips
- **Style:** 徽章是 6px 圆角，`px-1.5 py-0.5`，12px / 500。
- **套餐徽章:** Free 中性灰、Lite 成功绿、Pro 点缀蓝、Max 警告橙。字用那个颜色本身，底色是它的 18% 透明（Free 是次要文字色的 12%）。Max 对警告橙是借形不借义——调 `warn` 之前先想起它还挂着最贵的那一档。

### Cards / Containers
- **Corner Style:** 12px。
- **Background:** 浮起的表面（`card`）。
- **Shadow Strategy:** 静止不投影（见 Elevation & Depth）。
- **分组卡（InsetGroup）:** 设置面的主力容器。卡的边界说「这几行是一组」，内缩分隔线说「组内还分行」，组尾那段 11.5px 小字说「这一组是怎么回事」；组头是 11px 的 Label。
- **液态玻璃（LiquidGlass）:** 浮在繁忙背景上的卡片专用材质。先折射再模糊（6px），饱和压到 0.9；底色只留 34% 的表面色，对比度靠它不靠模糊；三道边：外轮廓、顶部高光、底部回光。用户开了「降低透明度」就整块换回实心卡片。

### Inputs / Fields
- **Style:** 高 36px，6px 圆角，1px 输入框描边，底色透明（深色下是 30% 的描边色），左右 12px。
- **Focus:** 描边换成焦点色，外加 3px 焦点环。
- **Error / Disabled:** 出错时描边和焦点环换成危险红；禁用时 50% 透明、不可点。

### Navigation
- **侧栏:** 16rem。顶部三档分段控件等宽排布，选中那档是一枚滑块；某一档里有未读 @ 时，右上角亮一枚不带数字的点。
- **推入式导航（NavStack）:** 设置面从目录推进二级页。动效是可以被半路打断的弹簧，左缘右划能拖回上一页；减动效时直接切换。
- **手机端:** 一个原生栈，名册在栈底（#1356）。

### 像素脸（AgentFace）
每只智能体一张，13 个坑位按 agent id 派生，坑位已落库，不能随手改（ADR-0316）。会动的只有眉眼嘴，脸型、头发、眼镜长在每个角色自己的像素矩阵里。只有「此刻正在看的那一只」会动（私聊头部、通话里的格子）；名册和选人列表里一律静止的一帧，因为查不到它此刻在干什么时，画一个状态等于说一句假话。名册里查不到的 id 不给脸，退回首字母。

### 聊天气泡
智能体的气泡用抬一级的中性面、靠左；自己发的用 `self-bubble`、靠右。12px 圆角，`px-3 py-2`，14px 正文，最宽 80%。群聊的标签行只写「名字 · 时间」。在云会话（智能体的私聊与群聊）里，一条回复按空行拆成几张气泡，像人在群里一句一句地发；智能体正在回复时，回复要落下的位置上是一枚输入指示器，答案到了就在同一张气泡里把点换成字。

### 正在发生的文字
- **流式正文:** 新落下的字先以点缀蓝淡入，再沉成它自己的颜色（正文是墨色，链接是链接色）。减动效时字照常出现，只是不逐个淡入。
- **Shimmer:** 状态文案表面有一道光带扫过（2.4s，线性），标示「正在发生」的直播态；减动效时退成静态的次要文字色。

### 进门页
黑白 1-bit 抖动背景（dither，WebGL2），桌面与手机共用同一份 shader 和配色表（`src/shared/dither.ts`）；字标用 Poppins SemiBold Italic。

## Do's and Don'ts

### Do:
- **Do** 用中性灰表达「正常 / 充足 / 空闲」，把颜色留给真正需要人注意的状态。
- **Do** 给每只智能体画它的像素脸；名册里查不到的不给脸，退回首字母。
- **Do** 用分组卡组织设置和清单：12px 圆角卡、内缩分隔线、组尾小字。
- **Do** 给可按的东西按下反馈：`press-scale`（0.97）或 `press-card`（0.985）。
- **Do** 动效走 `--ease-strong`（`cubic-bezier(0.23, 1, 0.32, 1)`）：进场 150–200ms，离场 100–140ms；弹窗从 0.96 放大，不从 0 长出来。
- **Do** 减动效时去掉位移和缩放、留下淡入淡出：减弱，不是取消。
- **Do** 数字按同一把尺子报：token 用 K（`865.5K`）；额度报「还剩百分之几」，一位小数向下取整。
- **Do** 手机端的表单、确认、多步小流程用居中弹窗，和桌面的 AlertDialog 一样，点遮罩不关；模型选单、@ 名册这类选择器保持底部抽屉（维护者 2026-09-11）。
- **Do** 过渡只列要动的属性。

### Don't:
- **Don't** 做成 SaaS 模板风：紫蓝渐变、卡片套卡片、每个标题上面一个彩色图标方块（维护者 2026-09-27）。
- **Don't** 给图标加彩色底座（Apple 设置那种每行一个彩色方块）；图标底座一律中性（ADR-0264，维护者 2026-09-27）。
- **Don't** 把智能体做成一个大聊天框：它们是有名字、有脸、有职责的同事，按人来排——花名册、私聊、群聊（维护者 2026-09-27）。
- **Don't** 拿红、橙、绿做装饰或区分分类；它们只报告状态（维护者 2026-09-27）。
- **Don't** 给静止的卡片加阴影表现层级。
- **Don't** 引入网络字体或外链资源。
- **Don't** 写 `transition: all`（`ui/tabs.tsx` 里 shadcn 默认的 `transition-all` 是存量）。
