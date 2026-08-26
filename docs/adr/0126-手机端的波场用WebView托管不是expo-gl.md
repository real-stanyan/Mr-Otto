# ADR-0126：手机端的波场用 WebView 托管，shader 只留一份

- 状态：已接受
- 日期：2026-08-26
- 相关：`src/shared/dither.ts`、`mobile/src/dither.tsx`、
  `src/renderer/src/components/DitherBackground.tsx`、`src/renderer/src/components/Splash.tsx`

## 背景

桌面开屏用的是 reactbits 的 Dither（WebGL2 + Perlin fbm + 8×8 Bayer 有序抖动）。
手机端登录页原本铺的是一张**离线预渲染的 PNG**（`mobile/scripts/gen-dither.mjs`），
静止不动。要求是「一模一样的效果」——静态图达不到，抖动的点阵一动才是那个东西。

手机端的前提写在 `mobile/README.md`：跑在 Expo Go 里，不加原生模块。所以第一版走
`expo-gl`（文档标着 "Included in Expo Go"）。

## 决定

**手机端的波场跑在 WKWebView 里的一块 canvas 上，shader 源码提到 `src/shared/dither.ts`，
两端 import 同一份字符串。**

`DITHER_VERT` / `DITHER_FRAG` 是纯字符串常量，没有 import，满足共用层的边界约束
（`tests/architecture.test.ts`）。配色表 `DITHER_RAMP` 一起搬过去：桌面的
`app.css` 是这套令牌的事实来源，手机端抄一份就会漂。

原来的 `invert` 开关换成 `fromColor` / `toColor` 两个 uniform。**这不是新增能力**：
把两个颜色对调等价于取反，桌面的输出逐位不变；换过来是为了让「light 白→黑 /
dark 黑→白」这件事在配色表里直接读得出来，而不是藏在一个布尔里。

## 为什么不是 expo-gl

按顺序排除的，每条都有实测：

1. **ES 3.0 core 没有默认 VAO。** 不 `bindVertexArray` 就 `drawArrays`，`getError()`
   回 1282（GL_INVALID_OPERATION），画面全空、控制台干净。补上之后能画出纯色。
2. **单趟全分辨率 1.5 fps。** 改成两趟（低分辨率 cell 纹理 + NEAREST 放大）回到 60fps。
3. **iOS 模拟器只呈现第一帧。** 28 秒 1680 帧、零 GL 错误，而 `fract(time)` 的脉冲
   shader 截出来的图逐字节相同。模拟器的 legacy GLES 路径，不是代码问题。
4. **真机上 `Cannot find native module 'ExpoGL'`。** 文档说 "Included in Expo Go"
   只对 CLI 装的模拟器版成立；App Store 的 Expo Go 里没有这个模块。
   ——`node_modules/expo/bundledNativeModules.json` 列了 expo-gl，那是 SDK 的版本钉，
   **不是 Expo Go 的收录清单**，不能拿来判断。

WebView 一次绕开全部四条：WKWebView 的 WebGL2 是完整实现，`react-native-webview`
在 Expo Go 里就有，而且它按 CSS 像素、dpr=1 渲染——跟桌面 `dpr={1}` 的取舍撞在一起，
两趟渲染那套优化直接不需要了。

## 代价

- 多一层 WebView。启动多几十毫秒，内存多一块 —— 只在开屏和登录页挂着，进 app 就没了。
- **shader 通过字符串插值进 HTML。** 插的是本仓的常量，不是外部输入；真要改成动态的，
  这里就是注入点。
- WebView 不认 `StyleSheet.absoluteFill` 的自测量（实测量成 114pt 高），必须给它一个
  有尺寸的父级 + `flex: 1`。这条踩过，写在 `mobile/src/dither.tsx` 的注释里。

## 什么前提失效会推翻它

- Expo Go 之后带上 expo-gl（或项目彻底转 dev build，不再需要 Expo Go 兼容）——
  那时原生 GL 少一层壳，值得换回去。
- WKWebView 的 WebGL 被系统限制（低电量模式下已经会降帧）。
