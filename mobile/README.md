# mobile —— Mr Otto 的手机端（Expo / React Native）

三栏客户端：**任务 / 项目 / 团队**（ADR-0293；spec `docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md`，
可交互 demo `.demo/mobile-app-redesign.html`）。今天做到 M0 + M1：三栏导航壳与进门。
项目栏是到自己电脑的加密投影（ADR-0094 / 0096 原样），任务栏、团队栏在 M2 / M3 接上。

**规则不写在这里。** 全仓唯一的事实源是根目录的 `AGENTS.md`。（Expo 模板会往
子目录塞一份自己的 `AGENTS.md` + `CLAUDE.md`，已删掉——两份规则等于没有规则。
模板里那句提醒本身是对的，抄在下面。）

> Expo 变化很快。写代码前先读对应版本的文档：https://docs.expo.dev/versions/v57.0.0/

## 结构

- `App.tsx`：开屏 → 进门 → 三栏；此刻画哪一屏由 `src/shared/mobileGate.ts` 的 `gateView` 说了算
- `src/nav/`：根栈（三栏 + 账号 / 好友 / 配对）、毛玻璃页签栏、右上头像
- `src/gate/`：开屏、登录 / 注册卡、等确认信、忘记密码三步
- `src/tabs/`、`src/projects/`、`src/account/`、`src/pair/`、`src/friends/`：各屏
- `src/ui.tsx`、`src/dialog.tsx`、`src/icons.tsx`、`src/chrome.tsx`、`src/link.tsx`：组件层与共享状态
- 能测的判断一律住 `src/shared/`（跟着根门禁跑），这里只放装配与画法

## 跑起来

```bash
npm --prefix mobile install
npm --prefix mobile start        # 扫码用 Expo Go 打开
```

**Expo Go 就能跑。** 加密走纯 JS 的 `@noble/*`（ADR-0101），没有 native module。

装到真机（或用 `mrotto://` 那条回跳）才需要 prebuild：

```bash
npm --prefix mobile run ios        # 走 mobile/ios/，需要 Apple 开发者账号签名
```

`mobile/ios/`、`mobile/android/` 是 prebuild 产物，进了 `.gitignore`。

## 登录（Google / GitHub）

和桌面同一个 Supabase 项目、同一套 PKCE，代码在 `src/oauth.ts`。
邮箱密码那条路留着但收进折叠里：**这个账号体系里注册走的是 OAuth**，
用 Google 注册的账号根本没有密码，只留密码登录的话它永远登不进来。

回跳走**边缘服务的 landing 页**（`services/edge/src/authLanding.ts`），不是 app 自己的
deep link：那个地址早就在 Supabase 的 Redirect URLs 白名单里、桌面天天在用。
`mrotto://auth-callback` 只作 `ASWebAuthenticationSession` 的拦截 scheme
（`app.json` 的 `scheme` 注册进 Info.plist，拦截是确定的，不经过白名单）。

这样绕开了 GoTrue 的一个坑：`redirect_to` 不在白名单里时它**不报错**，
只是悄悄回落到 SITE_URL，表现为「授权页转完圈却没回到 app」。

## 和桌面共用的那一份代码

`src/shared/remote/` 里的东西手机端**直接 import 同一份文件**，不是抄一份：
帧的编解码、握手、密封流、base64url。那一层不许碰 node builtin / electron，
由 `tests/architecture.test.ts` 钉着。

metro 需要两处配置才吃得到它们（见 `metro.config.js`）：仓库根进 `watchFolders`，
以及把 `./x.js` 解析到 `./x.ts`（仓库按 ESM 风格写 `.js` 后缀，磁盘上是 `.ts`）。

## 类型检查

```bash
npm --prefix mobile run typecheck
```

**暂时不在根门禁里**——根 `tsconfig.json` 排除了 `mobile/`。这是临时状态，
原因和三条备选路都记在 issue #422（Protocol gap）。

## UI

设计令牌在 `src/theme.ts`，**逐个值抄自桌面的 `src/renderer/src/app.css`**：
同一套 Apple 四色底盘（`#000` 地面 / `#1d1d1f` 浮起的表面 / `#f5f5f7` 正文 /
`#0071e3` 点缀）、同一套语义色、同样跟随系统深浅色。

抄一份而不是 import 一份，是因为 app.css 是 CSS 自定义属性、RN 没有 CSS。
代价是两边可能漂，所以**令牌名和 CSS 变量名逐字对齐**（`background` / `card` /
`mutedForeground`…），漂了 grep 得出来。

组件层在 `src/ui.tsx`，只管三件事：按下就有反馈（不等抬手）、层级靠材质而不是
堆颜色（蓝色一屏只给一个主动作）、动效能被系统的「减弱动态效果」关掉。
