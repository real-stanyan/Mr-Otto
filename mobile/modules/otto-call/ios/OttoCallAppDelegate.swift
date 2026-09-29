import ExpoModulesCore
import UIKit

/// App 一起来就登记 VoIP 推送、建好 CallKit（#1428，spec §2.1）。被 VoIP 推送从后台叫起来的那一次，推送回调
/// 紧跟在 didFinishLaunching 之后——放到 JS 那边初始化就来不及了。挂在 Expo 的 AppDelegate 订阅者上，
/// 不去改 AppDelegate 本身（那个文件已经被 withSceneLifecycle 插件改过一次，ADR-0329）
public class OttoCallAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    CallCenter.shared.start()
    return true
  }
}
