# shadcn/ui 接入 + light/dark 主题 设计

日期:2026-08-17
状态:已批准(维护者会话确认)
前置:PR #12(Tailwind v4 迁移)已合入 main(afbaa26)

## 目标

1. 全 app 支持 light/dark 双主题:dark 用 colorhunt `000000/233D4D/FE7F2D/EAECF0`,light 用 `EFECE3/8FABD4/4A70A9/000000`
2. 令牌体系改用 shadcn 语义命名(执行 ADR-0010 的 shadcn 路线)
3. 核心交互件换 shadcn 组件:Button / Select / Textarea / DropdownMenu / Switch / Tooltip

## 非目标

- 审批卡、会话列表、思考折叠(details/summary)不换 shadcn——定制度高,保留自制,只换令牌色
- 不引入 Card/Collapsible/ScrollArea/Tabs(用户选"核心交互件"范围)
- 不做吉祥物/视觉设计(harness 前约束不变,本任务是主题基建)

## 1. 令牌层(app.css)

采用方案 A:全盘 shadcn 令牌语义。CSS 变量定义在 `:root`(light)与 `.dark`,`@theme inline` 映射成 Tailwind 颜色类。现有 `bg/panel/line/text/dim/accent/accent-hi` 类名全部改写为 shadcn 语义类。

### 角色映射

| 令牌 | light | dark | 用途 |
|---|---|---|---|
| `--background` | `#EFECE3` | `#000000` | 窗口背景 |
| `--foreground` | `#000000` | `#EAECF0` | 正文文字 |
| `--card` | `#F7F5EF`(米提亮) | `#233D4D` | 面板・卡片・composer |
| `--card-foreground` | `#000000` | `#EAECF0` | 卡上文字 |
| `--primary` | `#4A70A9` | `#233D4D` | 按钮・用户气泡主面积 |
| `--primary-foreground` | `#FFFFFF` | `#EAECF0` | 主色上文字 |
| `--secondary` | `#8FABD4` | `#2E4A5C`(233D4D 提亮) | 次要按钮・悬停面 |
| `--muted` | `#E5E1D3`(米压暗) | `#16262F`(233D4D 压暗) | 弱底(chips・代码块底) |
| `--muted-foreground` | 黑 55% | `#EAECF0` 60% | dim 文字 |
| `--accent` | `#4A70A9` | `#FE7F2D` 橙 | 点缀:链接・流式光标・焦点环・活跃态高亮 |
| `--border` | 黑 12% | `#EAECF0` 15% | 描边 |
| `--input` | 同 border | 同 border | 表单描边 |
| `--ring` | `#4A70A9` | `#FE7F2D` | focus-visible 环 |
| `--destructive` | `#E03131` 微调深 | `#E03131` | 危险操作 |

**橙色只做点缀**(用户明确):dark 下按钮/气泡主面积用 `#233D4D`,`#FE7F2D` 只给链接、光标、焦点环、活跃指示。light 同理以 `#4A70A9` 为点缀主角、`#8FABD4` 为面。

### 状态色

`ok/err/deny/warn` 不在 colorhunt 板内,保留现值(`#2f9e44/#e8590c/#e03131/#f08c00`),自定义令牌继续存在;light 下如对比度不足则微调深一档(实现时以 4.5:1 文字对比为准)。

### 技术写法

- v4 shadcn 约定:裸 CSS 变量放 `:root`/`.dark`,`@theme inline { --color-background: var(--background); … }` 生成 utility
- `color-scheme: light`/`dark` 跟主题走,原生滚动条・表单控件同步
- `--font-mono`、`--ease-strong`、keyframes、滚动条 utility 保持不变

## 2. 主题切换

- `useTheme` hook(新文件 `src/renderer/src/theme.ts`):偏好 ∈ `system | light | dark`,localStorage key `otter-theme`;`system` 时监听 `matchMedia("(prefers-color-scheme: dark)")`;解析结果在 `<html>` 上挂/摘 `dark` 类
- `index.html` 内联脚本:React 挂载前读 localStorage 并设类,防启动闪白/闪黑
- 设置页(通用设置区)加"外观"一行:shadcn Select 三选(跟随系统/浅色/深色)
- 纯渲染进程状态,不走 IPC,不进事件日志(UI 偏好非会话事实)

## 3. shadcn 接入

- `components.json` + 路径别名 `@/` → `src/renderer/src`(tsconfig.web.json paths + electron.vite renderer resolve.alias)
- `cn()` util(clsx + tailwind-merge),放 `src/renderer/src/lib/utils.ts`
- 引入组件(shadcn CLI 生成,入库可改):**Button / Select / Textarea / DropdownMenu / Switch / Tooltip**
- 替换点:
  - `.btn` 及各按钮常量 → `<Button>` variants(default/ghost/destructive/outline);`.btn` 组件类最终删除
  - 模型下拉(header 原生 select)、设置页各原生 select → shadcn Select
  - composer textarea → shadcn Textarea(保留 `field-sizing-content` 自增高与 Enter 发送逻辑)
  - ＋ 附件菜单、slash 菜单(自制 popover)→ DropdownMenu(保留现有键盘导航语义)
  - 主题三选 → Select;如有布尔开关场景 → Switch
  - 现有 `title=` 提示逐步换 Tooltip(仅高频按钮:发送・停止・附件・设置)
- Radix 依赖随组件进 package.json;不装未用组件

## 4. 保留 CSS 区连带(躲不掉的暗色硬编码)

现值全按暗底调的 hex,light 下不可读,需抽成分主题变量:

- `.md` 排版:strong/em/blockquote/code 底色・边等 `#fff`/`rgba(255,255,255,…)` → 语义变量
- `.md .hljs-*` 代码高亮:整组换成 `--hljs-*` 变量,`:root` 一套浅色值(参考 GitHub light 风格自配),`.dark` 保留现值
- `.hl` 自研高亮 token(hk/hs/hd/hv/hw/hp/hn):同上双套
- `.replay` SVG 节点/边(`#232325/#555/#9a9a9a` 等):抽 `--rp-*` 变量双套
- `.streaming` 光标色 → `var(--accent)`
- 滚动条 thumb `rgba(255,255,255,.14)` → 分主题变量

## 5. 测试与验收

- vitest:`useTheme` 逻辑(localStorage 读写・matchMedia 切换・`dark` 类挂摘・system 监听增删)——jsdom 环境
- 门禁 `npm test` 绿(CI 同款)
- tsc 干净、生产 build 绿
- 视觉验收:用户手动测(双主题下聊天时间线・审批卡・回放・设置页・slash 菜单・附件 chips)
- ADR-0011:主题令牌架构(shadcn 语义令牌 + 双主题 + 橙色点缀原则)

## 实施顺序(供 plan 拆解)

1. 令牌层重写 + 全量类名改写(bg-bg → bg-background 等)+ 保留区变量化——先在纯 dark 下等价
2. light 值填入 + useTheme + 防闪脚本 + 设置页三选
3. shadcn 基建(alias/cn/components.json)+ 六组件引入替换
4. Tooltip 收尾 + ADR-0011 + 收尾
