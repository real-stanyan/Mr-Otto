// withSceneLifecycle —— 让 prebuild 生成的 iOS 工程采用 UIScene 生命周期（#1408，ADR-0329）。
//
// iOS 27 SDK 起，没采用场景生命周期的 App 一启动就被 UIKit 断言掐掉（设备上的崩溃报告停在
// `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`）。Expo SDK 57 的模板还在
// AppDelegate 里自己建窗口；SDK 58 的模板才换成 SceneDelegate + 场景清单。升 SDK 58 之前由这个
// 插件补上三处：
//   1. Info.plist 加 UIApplicationSceneManifest，指向 SceneDelegate；
//   2. AppDelegate 的 didFinishLaunching 不再自己建窗口、启动 React Native；
//   3. 把旁边那份 SceneDelegate.swift（照 SDK 58 的 ExpoAppSceneDelegate 写的）追加进
//      AppDelegate.swift —— 追加而不是新建文件，免得去改 pbxproj。
//
// **对不上就大声失败**：认不出 AppDelegate 里建窗口的那一段（模板变了、别的插件先动过），或者
// 已经是 SDK 58 的模板，都直接抛错、不静默跳过。静默跳过的结局是又一次「装上一启动就崩」，而那只
// 在真机上看得见（模拟器上看手机端一直是 Expo Go，那是 Expo 自己打的包）。

const fs = require("node:fs");
const path = require("node:path");

/** 追加进去的那段 Swift 带着这个记号：prebuild 不带 --clean 时会在已经补过的文件上再跑一遍 mods */
const MARKER = "@otto-scene-lifecycle";

const SCENE_DELEGATE_SWIFT = path.join(__dirname, "SceneDelegate.swift");

/** SDK 57 模板在 didFinishLaunching 里自己建窗口、启动 React Native 的那一段。模块名 "main" 也在
    判据里：SceneDelegate 里写死的是同一个名字，模板哪天换了名字这里先红 */
const WINDOW_BLOCK =
  /^#if os\(iOS\) \|\| os\(tvOS\)\n[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[ \t]*factory\.startReactNative\(\n[ \t]*withModuleName: "main",\n[ \t]*in: window,\n[ \t]*launchOptions: launchOptions\)\n#endif\n/m;

const REPLACEMENT =
  "    // 窗口与 React Native 由 SceneDelegate 在场景连上时建（iOS 27 SDK 起必须走场景生命周期，#1408）\n";

/** Info.plist 的场景清单。类名不带模块前缀：SceneDelegate 用 `@objc(SceneDelegate)` 定了 ObjC 名，
    UIKit 按这个名字找类（真机上验过） */
function sceneManifest() {
  return {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "SceneDelegate" },
      ],
    },
  };
}

function patchAppDelegate(src, sceneDelegateSwift) {
  if (src.includes(MARKER)) return src;
  if (/ExpoAppSceneDelegate|ExpoReactNativeFactoryProvider/.test(src)) {
    throw new Error(
      "[withSceneLifecycle] AppDelegate 已经是 Expo SDK 58+ 的模板（自带场景代理）：删掉 mobile/plugins/withSceneLifecycle.js 和 app.json 里那一项（#1408）",
    );
  }
  if (!WINDOW_BLOCK.test(src)) {
    throw new Error(
      "[withSceneLifecycle] 认不出 AppDelegate 里自己建窗口的那一段（模板变了，或别的插件先改过）；不补的话 iOS 27 上一启动就崩（#1408）",
    );
  }
  if (!sceneDelegateSwift.includes(MARKER)) {
    throw new Error("[withSceneLifecycle] SceneDelegate.swift 缺了记号，重复 prebuild 会追加两遍");
  }
  return `${src.replace(WINDOW_BLOCK, REPLACEMENT).trimEnd()}\n\n${sceneDelegateSwift.trimEnd()}\n`;
}

function withSceneLifecycle(config) {
  // 用到才 require：纯函数那几个要能在门禁里单独测，不必先装好 expo
  const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");
  const withManifest = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = sceneManifest();
    return c;
  });
  return withAppDelegate(withManifest, (c) => {
    if (c.modResults.language !== "swift") {
      throw new Error(`[withSceneLifecycle] 只认 Swift 的 AppDelegate，这里是 ${c.modResults.language}`);
    }
    c.modResults.contents = patchAppDelegate(c.modResults.contents, fs.readFileSync(SCENE_DELEGATE_SWIFT, "utf8"));
    return c;
  });
}

module.exports = withSceneLifecycle;
module.exports.patchAppDelegate = patchAppDelegate;
module.exports.sceneManifest = sceneManifest;
module.exports.SCENE_DELEGATE_SWIFT = SCENE_DELEGATE_SWIFT;
