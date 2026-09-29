// mobile/plugins/withSceneLifecycle.js 的可执行版（#1408，ADR-0329）。iOS 27 SDK 起没采用 UIScene 生命周期
// 的 App 一启动就被 UIKit 掐掉，而 Expo SDK 57 的模板没跟上。Swift 不进门禁（这里没有 iOS 工具链），
// 真机上验过的那一份由这里钉住：认得模板里自己建窗口那一段并换掉、认不出或已是 SDK 58 时大声失败、
// Info.plist 指向的类名就是追加进去的那个类。夹具是 expo-template-bare-minimum 原样的 AppDelegate
// （sdk-57 = 57.0.27，sdk-58 = 58.0.7），补完 sdk-57 那份与真跑 `expo prebuild` 的产物逐字节相同。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

interface SceneConfig {
  UISceneConfigurationName: string;
  UISceneDelegateClassName: string;
}
const plugin = createRequire(__filename)(join(ROOT, "mobile/plugins/withSceneLifecycle.js")) as {
  patchAppDelegate: (src: string, sceneDelegateSwift: string) => string;
  sceneManifest: () => {
    UIApplicationSupportsMultipleScenes: boolean;
    UISceneConfigurations: { UIWindowSceneSessionRoleApplication: SceneConfig[] };
  };
  SCENE_DELEGATE_SWIFT: string;
};

const SWIFT = readFileSync(plugin.SCENE_DELEGATE_SWIFT, "utf8");
const SDK57 = read("tests/fixtures/expo/sdk57-AppDelegate.swift");
const SDK58 = read("tests/fixtures/expo/sdk58-AppDelegate.swift");
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe("withSceneLifecycle：SDK 57 的 AppDelegate 改走场景生命周期", () => {
  it("didFinishLaunching 不再自己建窗口，React Native 一个进程只起一份", () => {
    expect(SDK57).toContain("UIWindow(frame: UIScreen.main.bounds)");
    const out = plugin.patchAppDelegate(SDK57, SWIFT);
    expect(out).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    // 两个启动点（#1428）：场景连上时，或被 VoIP 推送从后台叫起来、没有场景时（ottoStartReactNative）。
    // 两处都先置同一个记号、ottoStartReactNative 见它就走，场景那一侧有现成的就搬过去——一个进程只起一份
    expect(count(out, "startReactNative(")).toBe(2);
    expect(count(out, "reactNativeStarted = true")).toBe(2);
    expect(out).toContain("guard !reactNativeStarted");
    expect(out).toContain("if let root = headlessWindow?.rootViewController");
    expect(out).toContain("return super.application(application, didFinishLaunchingWithOptions: launchOptions)");
    expect(out).toContain("class SceneDelegate: UIResponder, UIWindowSceneDelegate");
  });

  it("在补过的文件上再跑一遍不变（prebuild 不带 --clean 时 mods 会再跑）", () => {
    const once = plugin.patchAppDelegate(SDK57, SWIFT);
    expect(plugin.patchAppDelegate(once, SWIFT)).toBe(once);
    expect(count(once, "class SceneDelegate")).toBe(1);
  });

  it("已经是 SDK 58 的模板：抛错叫人删插件，不叠第二个场景代理", () => {
    expect(() => plugin.patchAppDelegate(SDK58, SWIFT)).toThrow(/SDK 58/);
  });

  it("认不出建窗口那一段：抛错，不静默跳过（跳过 = 装上一启动就崩）", () => {
    const renamed = SDK57.replace('withModuleName: "main"', 'withModuleName: "other"');
    expect(renamed).not.toBe(SDK57);
    expect(() => plugin.patchAppDelegate(renamed, SWIFT)).toThrow(/认不出/);
  });

  it("追加的 Swift 缺了记号：抛错（否则重复 prebuild 会追加两遍）", () => {
    expect(() => plugin.patchAppDelegate(SDK57, SWIFT.replace("@otto-scene-lifecycle", ""))).toThrow(/记号/);
  });
});

describe("SceneDelegate.swift 与 Info.plist 说的是同一个类", () => {
  it("场景清单指向 @objc 声明的那个名字，单场景", () => {
    const objcName = /@objc\((\w+)\)/.exec(SWIFT)?.[1];
    const m = plugin.sceneManifest();
    expect(m.UIApplicationSupportsMultipleScenes).toBe(false);
    expect(m.UISceneConfigurations.UIWindowSceneSessionRoleApplication.map((c) => c.UISceneDelegateClassName)).toEqual([
      objcName,
    ]);
  });

  it("场景连上时建窗口并启动 React Native，模块名与模板一致，冷启动链接重建进 launchOptions", () => {
    expect(SWIFT).toContain("UIWindow(windowScene: windowScene)");
    expect(SWIFT).toContain('withModuleName: "main"');
    expect(SDK57).toContain('withModuleName: "main"');
    expect(SWIFT).toContain('"UIApplicationLaunchOptionsURLKey"');
  });

  it("场景事件转回 App 代理（ExpoAppDelegate 再转给各模块的订阅者）", () => {
    for (const forwarded of [
      "applicationDidBecomeActive(UIApplication.shared)",
      "applicationWillResignActive(UIApplication.shared)",
      "applicationWillEnterForeground(UIApplication.shared)",
      "applicationDidEnterBackground(UIApplication.shared)",
      "application(UIApplication.shared, open: context.url",
      "application(UIApplication.shared, continue: activity",
    ]) {
      expect(SWIFT).toContain(forwarded);
    }
  });

  it("app.json 挂上了这个插件", () => {
    const plugins = (JSON.parse(read("mobile/app.json")) as { expo: { plugins: unknown[] } }).expo.plugins;
    expect(plugins).toContain("./plugins/withSceneLifecycle");
  });
});
