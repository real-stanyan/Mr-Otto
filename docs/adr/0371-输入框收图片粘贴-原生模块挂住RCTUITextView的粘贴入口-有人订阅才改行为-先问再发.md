# 0371 输入框收图片粘贴：原生模块挂住 RCTUITextView 的粘贴入口，有人订阅才改行为，先问再发

原为 ADR-0370（与 #1640 的预览期 ADR 撞号，后合的改号）

日期：2026-10-05 · 状态：已采纳 · issue #1645

## 背景

维护者在 iOS 27 上点键盘建议栏的「Photo · Paste from Screenshots」，Otto 的输入框没反应；长按「粘贴」一张图也一样。
React Native 的输入框（新旧架构都落在 `RCTUITextView`）只认文字：`canPerformAction(paste:)` 只在剪贴板有字时给
「粘贴」，`pasteConfiguration` 不收图片，`paste:` / `pasteItemProviders:` 拿到图也不知道往哪放。RN 0.86 没有
`onPaste` 之类的口子，这件事只能在原生层做。

## 决定

1. **新建 Expo 本地模块 `mobile/modules/otto-paste`**，不换输入框组件。模块加载时用 runtime 在 `RCTUITextView`
   这个类自己身上加 / 换五个方法（`class_addMethod`，已有才 `method_setImplementation`；父类 `UITextView` 与别的
   文本框不动）：`pasteConfiguration` 多收 `public.image`；`canPerformAction(paste:)` 剪贴板有图也给；`paste:`
   剪贴板**只有图没有字**时把图拿走（图文都有时照旧粘字——网页上复制的一段，人要的多半是字）；
   `canPasteItemProviders:` / `pasteItemProviders:` 带图的那几份拿走（键盘建议走这一条，模拟器上实测）。
   拿走的图存成临时 PNG，经 `onPaste` 报给 JS。
2. **JS 没人订阅时一律走原实现**：`OnStartObserving` / `OnStopObserving` 开关一个 sink，聊天页只在自己在最上面、
   能发图时订阅（`usePastedImages`）。登录页的邮箱框之类不受影响。
3. **粘贴不等于发送**：先弹「发送这张图片？」（居中弹窗，带预览），点「发送」才走聊天页现成的 `sendPicked`——
   与相册挑的同一条路（`prepareImage` 把大 PNG 缩成 JPEG）。照微信。
4. 事件的验放 shared（`pastedImagesOf`：只收 `file://`、字段齐、数为正、一次最多 9 张），进 vitest。

## 代价与推翻条件

- 方法替换是对 RN 私有类名的依赖：RN 改名或改继承时挂钩静默失效（`NSClassFromString` 拿不到就整套不装），
  退回今天的「没反应」，不会崩。升级 RN 时要在真机上点一次粘贴图片。
- 动了 `mobile/modules/`，要出新的原生包（runtimeVersion +1），合进 main 之后在原生包上传之前 `publish-ota` 会拒绝。
- RN 哪天自带图片粘贴（`onPaste` 带文件），这个模块就该删掉。
