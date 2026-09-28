# ADR-0329：手机端采用 UIScene 生命周期——Expo SDK 57 用本地配置插件补

- 日期：2026-09-28
- 状态：已采纳
- 关联：#1408。维护者 2026-09-28 第一次让手机端装到真机（iPhone 16 Pro Max，iOS 27.0，Xcode 27.0）
- 关系：手机端的原生形态（ADR-0320 的语音通话只在原生包里有）从这一条起才启动得了；升 Expo SDK 58 时本条作废

## 背景

- 用 iOS 27 SDK 链接、却没采用 UIScene 生命周期的 App，启动时被 UIKit 断言掐掉。设备上的崩溃报告：`EXC_BREAKPOINT (SIGTRAP)`，主线程停在 `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke` ← `-[UIApplication workspace:didCreateScene:…]`。
- `mobile/ios/` 是 prebuild 生成的（被 git 忽略）。Expo SDK 57 的最新模板（`expo-template-bare-minimum` 57.0.27）仍在 `AppDelegate` 的 `didFinishLaunching` 里自己建 `UIWindow`，`Info.plist` 没有场景清单；`expo` 57.0.25 的原生层也没有场景代理。SDK 58 的模板（58.0.7）才换成 `SceneDelegate: ExpoAppSceneDelegate` + 场景清单，而 `expo` 包的 58 此刻还是 preview（58.0.0-preview.7）。
- 之前在模拟器上看手机端，跑的都是 Expo Go（Expo 自己打的包），所以一直没暴露。也就是说，**手机端此前从没以原生包的形态启动成功过**。
- `xcrun devicectl device process launch --console` 对这次崩溃报的是「exit code 0」，这个结果是误导。判据要看设备上的 `.ips`（`devicectl device copy from --domain-type systemCrashLogs`）。

## 决定

1. 本地配置插件 `mobile/plugins/withSceneLifecycle.js`（挂在 `app.json` 的 plugins 末尾），prebuild 时补三处：
   - `Info.plist` 加场景清单；
   - `AppDelegate` 不再自己建窗口、启动 React Native；
   - 追加 `mobile/plugins/SceneDelegate.swift`。
2. `SceneDelegate` 照 SDK 58 的 `ExpoAppSceneDelegate` 写：
   - 场景连上时 `UIWindow(windowScene:)` + `startReactNative`。
   - 冷启动带来的链接从 `connectionOptions` 重建进 launchOptions，因为 `Linking.getInitialURL()` 只读 launchOptions。
   - 前后台四个事件、打开 URL、接续活动转回 `ExpoAppDelegate`，由它再转给各模块的订阅者。
   - 快捷方式（quick action）那一条没抄，本 App 没有快捷方式。
3. **追加进 `AppDelegate.swift`，不新建文件**：新建文件就要改 pbxproj，追加一段 Swift 不用。
4. **类名不带模块前缀**：`@objc(SceneDelegate)` 配清单里的 `SceneDelegate`。SDK 58 模板写的是 `$(PRODUCT_MODULE_NAME).SceneDelegate`，这里用的是真机验过的那种写法。
5. **对不上就抛错**：认不出模板里建窗口的那一段，或者已经是 SDK 58 模板时，prebuild 直接失败并说清怎么办。追加的 Swift 带记号，在补过的文件上再跑一遍结果不变。静默跳过的结局又是「装上一启动就崩」，而这种崩溃只在真机上看得见。

## 否决的

- **升 Expo SDK 58**：`expo` 包此刻还是 preview。为一个启动问题顶着 preview 做一次 SDK 大版本升级（RN 与各 expo-* 一起动）不划算。
- **把 `mobile/ios/` 提交进仓库、放弃生成**：以后每次升级都要手工合原生工程。为一个过渡问题换掉整条生成链，不值。

## 代价与推翻前提

- 升到 SDK 58 那天插件会抛错叫人删掉它。这是设计好的提醒，不是故障。
- Swift 不进门禁。`tests/mobile/sceneLifecycle.test.ts` 钉的是插件的文本变换，以及清单与 `@objc` 类名一致，钉不到「编得过、跑得起来」。真机验证只有 2026-09-28 这一次：Release 包，启动后进程常驻，没有新崩溃报告。插件产物与那次手改的工程代码逐字相同。
- 冷启动只重建了 URL，没重建 universal link 的 `userActivity`（SDK 58 两样都做）。本 App 没配 associated domains。
- Expo Go 不受影响，插件只在 prebuild 时生效。

## 附：打真机包撞到的三个环境坑

与本条无关，但下一次打真机包还会撞上：
- 这台机器的非交互 shell 没有 UTF-8 locale，`pod install` 会抛 `Unicode Normalization not appropriate for ASCII-8BIT`，要带 `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`。
- lane 里的 `mobile/node_modules` 不能是指向别处的软链。Metro 只认 watchFolders 以内的文件，会报 `Unable to resolve module expo`，要在 lane 里 `npm --prefix mobile ci` 真装一份。
- `expo prebuild` 要在 `mobile/` 里跑，图标路径按当前目录解析。
