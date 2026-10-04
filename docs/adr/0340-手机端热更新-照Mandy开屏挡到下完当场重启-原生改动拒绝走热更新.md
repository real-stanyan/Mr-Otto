# ADR-0340：手机端热更新——照 Mandy 开屏挡到下完、当场重启；动过原生就拒绝走热更新

日期：2026-10-04 · issue #1463 · 维护者：「OTA 做成像 Mandy App 一样，每次 OTA 完不需要退出两次 App 才能更新，开启软件自动检查是否有更新，自动更新」

## 决定

1. **expo-updates + EAS Update**（账号 `real_stanyan`，项目 `@real_stanyan/mr-otto`），与 Mandy 同一套，不自建更新服务器。
   `checkAutomatically: ON_LOAD`、`fallbackToCacheTimeout: 0`：原生那一侧每次冷启动都查，不管 JS 坏没坏，
   这是「一个修复总能送到一个坏掉的包」的唯一保证。这次构建不是 EAS Build（是本机 xcodebuild），所以频道写在
   `updates.requestHeaders`（`expo-channel-name: production`），由 prebuild 烤进 Expo.plist。
2. **不用退出两次**（Mandy 的 lib/launch-update.ts 移过来）：开屏进度条走完后，如果知道有更新正在下，就一直挡着；
   下完当场 `reloadAsync` 进新包，人打开一次就在新包上。还在查的时候最多再挡 5 秒（`CHECK_CAP_MS`），一个永远不回话的
   检查不能扣住每一次启动。原生那次下载失败时，App 自己再下两次；还不行就照常打开（Mandy 那里会让人选，这里直接开），
   下次冷启动会再查。上次重启进去却没成功的那个更新（重启失败，或新包崩了被回滚）不再重启进第二次。
3. **从后台回来**：在后台待够 30 分钟、没在打电话（语音通话 / 系统来电）、距上次自己重启超过 30 分钟，
   就查一次、有就下、下完重启。重启前再判一次是不是在打电话，因为下载那几秒里人可能接起了电话。
4. **动过原生就拒绝走热更新**（同 Mandy 的 fail closed）：`mobile/native-build.json` 记最近一次原生包
   （TestFlight）的提交与 `runtimeVersion`。`npm --prefix mobile run ota -- "说明"` 发现那之后动过
   `mobile/package.json` / `package-lock.json` / `app.json` / `modules/` / `plugins/` 中任一处就拒绝。
   往一个缺原生模块的包里推需要那个模块的 JS，一打开就崩。`runtimeVersion` 用固定字符串（现在是 `"1"`），
   每打一次带原生改动的包手动加一。
5. **这一包顺带装上图片 / 视频要用的原生件**（`expo-image-picker` 插件与相册、相机权限文案、`expo-video`），
   因为 #1443 的媒体功能需要它们，而热更新推不了原生。这样媒体那一半做完后，靠热更新就能发出去。

## 代价

- 发热更新目前在本机跑（`eas` 登录的是 real_stanyan），还没像 Mandy 那样在合并进 main 时自动发。要自动发，得把
  `EXPO_TOKEN` 放进 GitHub 仓库的 secrets（维护者动作），再加一个 workflow。
- 更新包没做代码签名（Mandy 也没做），只靠 EAS 托管加 TLS。
- 这套机制本身要靠这一次原生包送到用户手上。装了 1.0.1 (4) 之后的第一次热更新，才是它第一次真生效。
- 开发构建与 Expo Go 里整套旁路（`Updates.isEnabled && !__DEV__`）。
- **频道要先建**（2026-10-04 第一次真发时踩到）：`eas update --branch production` 只建分支、不建频道，也不报错；
  手机按 `production` 频道要更新，频道不在就谁也收不到。发布脚本现在发之前先查频道，不在就建（指向同名分支）。
