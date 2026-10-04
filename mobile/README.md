# mobile —— Mr Otto 的手机端（Expo / React Native）

手机端是微信式布局（#1386，ADR-0323）：底部三格「聊天 / 通讯录 / 我」，智能体、朋友、群排在同一列里。
每只智能体一条永久的私聊线，几只可以拉成一个群；它们跑在你账号的云端电脑上（个人主场），手机和桌面是同一个云会话的两个客户端。
朋友私聊走 `friendships` / `messages` 两张表；团队的每一条云会话在手机上就是一个有真人的群聊（界面上不分团队群与主场群）。
在它之前是「智能体」单栏（#1356，ADR-0317，A0–A5 与 A4b：名册、聊天、新建的那只先开口、群聊、语音通话、账号与那台电脑、挑说话的声音）——
那一版的判据（谁排前面、藏哪些事件、派活线、先开口、语音编排）原样留着，换的是外壳。设计见 spec `docs/superpowers/specs/2026-09-27-wechat-mobile-design.md`。

纯逻辑一律住 `src/shared/`、测试在 `tests/shared/`；手机端在自身之外只 import `src/shared/**`（`tests/architecture.test.ts` 有断言）。
`mobile/` 的类型检查在根门禁里（ADR-0294）：跑门禁前先 `npm --prefix mobile ci` 一次。

**规则不写在这里。** 全仓唯一的事实源是根目录的 `AGENTS.md`。（Expo 模板会往
子目录塞一份自己的 `AGENTS.md` + `CLAUDE.md`，已删掉——两份规则等于没有规则。
模板里那句提醒本身是对的，抄在下面。）

> Expo 变化很快。写代码前先读对应版本的文档：https://docs.expo.dev/versions/v57.0.0/

## 结构

- `App.tsx`：开屏 → 进门 → 底部三格；此刻画哪一屏由 `src/shared/mobileGate.ts` 的 `gateView` 说了算
- `src/nav/`：根栈——栈底是底部三格，推进来的页（聊天、聊天信息、智能体资料、朋友、新的朋友、群聊、个人信息、订阅与额度、那台电脑的几页、设置、开发构建里的形象陈列馆）盖住底栏
- `src/tabs/`：三个页签（聊天列表、通讯录、我）+ 自己画的底栏
- `src/gate/`：开屏、登录 / 注册卡、等确认信、忘记密码三步
- `src/chat/`：聊天页（气泡、隔 5 分钟一条的时间、审批卡、「此刻」那一行与「停」、输入栏的表情 / ⊕ 面板与按住说话、群里的「@ 谁」、新建的那只开口之后的六句现成话）+ 聊天信息
- `src/agent/`：智能体资料页、新建智能体（居中弹窗）、「换个形象」抽屉（共用 `FaceWall.tsx` 那面脸墙）、「说话的声音」那张表（`VoicePickerSheet.tsx`，A4b）
- `src/group/`：建群 / 拉人那张居中弹窗
- `src/friends/`：朋友私聊、朋友资料、新的朋友、添加朋友、群聊一览 + 查询层与数据（realtime 两条通道，哑了降级成轮询）
- `src/inbox/`：这台手机上的已读游标与草稿、团队清单、拼会话列表的那一个 hook
- `src/me/`：个人信息（头像 / 名字 / 改密码）、订阅与额度
- `src/home/`、`src/cloud/`：数据层——主场名册与订阅快照（直连 Supabase / edge）、云会话客户端与当前聊天（外部 store，`useSyncExternalStore`）
- `src/voice/`：通话整屏、通话全文抽屉、语音的装配
- `src/sheet/`：底部抽屉（reanimated + gesture-handler，ADR-0293 决定 3）
- `src/account/` —— 订阅页、设置、订阅快照
- `src/machine/` —— 它们的电脑：文件、应用、记忆、这周用量（A5）
- `src/wx/`：微信式的零件（头像、角标、页签页头、搜索条、可折叠的段、⊕ 菜单、底部动作单、轻提示、图标）；`iconNodes.ts` 是 `scripts/gen-icons.mjs` 的生成物
- `src/face/`、`src/dev/`：像素脸（react-native-svg + 共用的 25fps 钟）+ 只在开发构建里出现的形象陈列馆（入口在设置页底下）
- `src/ui.tsx`、`src/dialog.tsx`、`src/chrome/`：组件层（通栏的 `Group` / `Row`）与共享状态
- `modules/otto-speech/` —— 语音原生模块（识别 + 断句 + 回声消除 + 放音，Swift）。
- 能测的判断一律住 `src/shared/`（跟着根门禁跑），这里只放装配与画法

## 跑起来

```bash
npm --prefix mobile install
npm --prefix mobile start        # 扫码用 Expo Go 打开
```

**Expo Go 就能跑。** 用到的原生模块（react-native-svg / reanimated / gesture-handler / worklets / expo-blur……）Expo Go 57 里都自带，
版本逐字取 `node_modules/expo/bundledNativeModules.json`——与 Expo Go 自带的那一半不一致时，真机一打开就红屏。
配对那套 `@noble/*` 已经随 #1356 删了——加密只剩
supabase-js 的 PKCE 要的 `crypto.getRandomValues`，走 `expo-crypto`（Expo 模块，Expo Go 里
就有，ADR-0101，见 `src/polyfills.ts`）。

装到真机（或用 `mrotto://` 那条回跳）才需要 prebuild：

```bash
npm --prefix mobile run ios        # 走 mobile/ios/，需要 Apple 开发者账号签名
```

`mobile/ios/`、`mobile/android/` 是 prebuild 产物，进了 `.gitignore`。

### 打 TestFlight 包（EAS Build，Windows 上也行，#1528）

原生包以前是 Mac 上 Xcode 归档上传的；没有 Mac 时走 EAS 云端编译（`mobile/eas.json` 的 `production` profile：
store 分发、channel `production`、版本号读 app.json）。**凭据只能维护者在交互里给**：第一次会要 Apple 账号登录（2FA）
或 App Store Connect API key，EAS 替你生成分发证书与描述文件并存在 EAS 上，之后不再问。

    cd mobile
    npx eas-cli build --platform ios --profile production --auto-submit

`--auto-submit` 编完直接提交 TestFlight。EAS 上传的是**整个 git 仓库**（手机端 import 仓库根的 `src/shared/`），
云端只装 `mobile/` 的依赖——所以手机端用到的包都得在 `mobile/package.json` 里（`npx expo export --platform ios` 在没装仓库根
依赖的目录里打得出 bundle，就是这件事的检查）。

**Mac 上不想走云端**就照老路 Xcode 归档（版本号同样读 app.json，prebuild 会烤进去）：

    cd mobile
    npx expo prebuild --platform ios --clean   # 重新生成 ios/（动过 modules/otto-speech 必须 --clean）
    cd ios && pod install && cd ..
    open ios/MrOtto.xcworkspace                 # Xcode：选真机 / Any iOS Device → Product › Archive → Distribute App › TestFlight

包出来之后两件事，少一件热更新链路就不通：① app.json 的 `version` / `ios.buildNumber` 每次打包往上加（上一包 1.0.1 (4)）；
② 更新 `mobile/native-build.json`（`runtimeVersion`、打包那个 commit、`build`）——`publish-ota` 据它判「那之后动过原生没有」。

### 语音通话要开发版（A4）

语音识别不在 Expo Go 里，通话用的是本仓自己的原生模块 `modules/otto-speech/`（Swift，照搬桌面 `native/MrOttoSpeech`，ADR-0320）。
挑「说话的声音」（A4b）的试听也走这个原生模块：Expo Go 里照样能挑、能存，只是点了不念。
**Expo Go 里 app 照常跑，只是没有电话钮、输入栏左边也没有「按住说话」**（两样用的是同一个原生模块）；要用得装开发版：

    cd mobile
    npx expo run:ios            # 第一次：prebuild 出 ios/ + pod install + 编译，十几分钟

`ios/` 是生成的（`.gitignore` 里），不提交；改了 `modules/otto-speech/ios/` 下的 Swift 要重跑这一句。
真机要在 Xcode 里给 `ios/MrOtto.xcworkspace` 配上自己的签名。模拟器用 Mac 的麦克风（第一次会问 macOS 的麦克风权限），
模拟器上回声消除多半开不了，会退回半双工（它说话时闭麦）——插嘴只能在真机上验。

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
