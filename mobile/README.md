# mobile —— Mr Otto 的手机端（Expo / React Native）

手机端是「智能体」单栏（#1321 / #1356，ADR-0317）：第一层只回答「我有哪几只智能体」——一个原生栈，名册是栈底。
每只智能体一条永久的私聊线，几只可以拉成一个群；它们跑在你账号的云端电脑上（个人主场），手机和桌面是同一个云会话的两个客户端。
A0 只立了基座（名册是占位，真数据在 A1）；进度见 spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §8。

纯逻辑一律住 `src/shared/`、测试在 `tests/shared/`；手机端在自身之外只 import `src/shared/**`（`tests/architecture.test.ts` 有断言）。
`mobile/` 的类型检查在根门禁里（ADR-0294）：跑门禁前先 `npm --prefix mobile ci` 一次。

**规则不写在这里。** 全仓唯一的事实源是根目录的 `AGENTS.md`。（Expo 模板会往
子目录塞一份自己的 `AGENTS.md` + `CLAUDE.md`，已删掉——两份规则等于没有规则。
模板里那句提醒本身是对的，抄在下面。）

> Expo 变化很快。写代码前先读对应版本的文档：https://docs.expo.dev/versions/v57.0.0/

## 结构

- `App.tsx`：开屏 → 进门 → 名册（单栏，#1356）；此刻画哪一屏由 `src/shared/mobileGate.ts` 的 `gateView` 说了算
- `src/nav/`：根栈——名册（无头，自己画浮在内容上的圆钮）/ 账号 / 开发构建里的形象陈列馆；没有底栏、没有第二个根
- `src/gate/`：开屏、登录 / 注册卡、等确认信、忘记密码三步
- `src/roster/`：名册屏（栈底，A0 是占位，真数据在 A1）+ 左上账号入口
- `src/account/`：账号页（A0 精简版；额度 / 订阅 / 这周用了多少 / 设置在 A5）
- `src/face/`、`src/dev/`：像素脸（react-native-svg + 共用的 25fps 钟）+ 只在开发构建里出现的形象陈列馆
- `src/ui.tsx`、`src/dialog.tsx`、`src/chrome/`：组件层与共享状态
- 能测的判断一律住 `src/shared/`（跟着根门禁跑），这里只放装配与画法

## 跑起来

```bash
npm --prefix mobile install
npm --prefix mobile start        # 扫码用 Expo Go 打开
```

**Expo Go 就能跑，没有 native module。** 配对那套 `@noble/*` 已经随 #1356 删了——加密只剩
supabase-js 的 PKCE 要的 `crypto.getRandomValues`，走 `expo-crypto`（Expo 模块，Expo Go 里
就有，ADR-0101，见 `src/polyfills.ts`）。

装到真机（或用 `mrotto://` 那条回跳）才需要 prebuild：

```bash
npm --prefix mobile run ios        # 走 mobile/ios/，需要 Apple 开发者账号签名
```

`mobile/ios/`、`mobile/android/` 是 prebuild 产物，进了 `.gitignore`。

## 登录（Google / GitHub）

和桌面同一个 Supabase 项目、同一套 PKCE，代码在 `src/oauth.ts`。
登录卡自上而下三段：**邮箱密码在前、OAuth 在后**（`src/gate/SignInCard.tsx`，维护者定，#731）——
不是收进折叠里：**这个账号体系里注册走的是 OAuth**，用 Google 注册的账号根本没有密码，
只把密码登录收起来的话它永远登不进来。

回跳走**边缘服务的 landing 页**（`services/edge/src/authLanding.ts`），不是 app 自己的
deep link：那个地址早就在 Supabase 的 Redirect URLs 白名单里、桌面天天在用。
`mrotto://auth-callback` 只作 `ASWebAuthenticationSession` 的拦截 scheme
（`app.json` 的 `scheme` 注册进 Info.plist，拦截是确定的，不经过白名单）。

这样绕开了 GoTrue 的一个坑：`redirect_to` 不在白名单里时它**不报错**，
只是悄悄回落到 SITE_URL，表现为「授权页转完圈却没回到 app」。

## 和桌面共用的那一份代码

`src/shared/remote/` 里的东西手机端**直接 import 同一份文件**，不是抄一份：
帧的编解码、base64url，以及云会话客户端本体
`src/shared/remote/cloudSessionClient.ts`——手机是它的第二个客户端（ADR-0317 决定 5）；
会话列表那一行要 better-sqlite3 那层的 `SessionSummary`，留在桌面 `src/main/cloudSessionFleet.ts`。
`src/shared/supabaseWorkspacesApi.ts`、`src/shared/homeWorkspace.ts` 与时间线那批纯函数同理。
那一层不许碰 node builtin / electron，由 `tests/architecture.test.ts` 钉着。

metro 需要两处配置才吃得到它们（见 `metro.config.js`）：仓库根进 `watchFolders`，
以及把 `./x.js` 解析到 `./x.ts`（仓库按 ESM 风格写 `.js` 后缀，磁盘上是 `.ts`）。

## 类型检查

```bash
npm --prefix mobile run typecheck
```

**在根门禁里**（ADR-0294，#422）：`npm test` 会跑 `tsc --noEmit`（含 mobile）+ `vitest run`。
手机端有自己的 `package.json` 与 `node_modules`，跑门禁前先 `npm --prefix mobile ci`（一次即可）；
忘了装的话 `pretest` 的 `scripts/check-mobile-deps.mjs` 会当场说清去装哪一句。

## UI

设计令牌在 `src/theme.ts`，**逐个值抄自桌面的 `src/renderer/src/app.css`**：
同一套 Apple 四色底盘（`#000` 地面 / `#1d1d1f` 浮起的表面 / `#f5f5f7` 正文 /
`#0071e3` 点缀）、同一套语义色、同样跟随系统深浅色。

抄一份而不是 import 一份，是因为 app.css 是 CSS 自定义属性、RN 没有 CSS。
代价是两边可能漂，所以**令牌名和 CSS 变量名逐字对齐**（`background` / `card` /
`mutedForeground`…），漂了 grep 得出来。

组件层在 `src/ui.tsx`，只管三件事：按下就有反馈（不等抬手）、层级靠材质而不是
堆颜色（蓝色一屏只给一个主动作）、动效能被系统的「减弱动态效果」关掉。
