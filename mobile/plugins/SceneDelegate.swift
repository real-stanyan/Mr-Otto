// @otto-scene-lifecycle —— 由 mobile/plugins/withSceneLifecycle.js 追加进 AppDelegate.swift（#1408）。
// iOS 27 SDK 起 App 必须采用场景生命周期，否则启动即被 UIKit 断言掐掉。Expo SDK 57 的模板还没跟上
// （SDK 58 的 ExpoAppSceneDelegate 才有），这里照它的做法：场景连上时建窗口、启动 React Native，
// 并把场景事件转回 App 代理（ExpoAppDelegate 再转给各模块的订阅者）。升到 SDK 58 时连插件一起删。
/// 没有场景时先起来的那份 React Native（#1428）：App 被杀掉后，VoIP 推送从后台把进程叫起来，这时不连任何场景，
/// 上面那条「场景连上时启动 React Native」永远等不到——人在锁屏上接起来，系统通话在计时，JS 一行都没跑，
/// 没人把它拉进通话。otto-call 收到推送时发现 JS 不在就调 ottoStartReactNative：挂在一个不属于任何场景的窗口上
/// 先跑起来（后台照样渲染、聊天页照样挂载），场景后来连上时把那个根控制器搬进真窗口，不再启动第二份。
private var headlessWindow: UIWindow?
private var reactNativeStarted = false

extension AppDelegate {
  /// otto-call 按名字找它（performSelector），不 import 这个文件：模块不该知道 App 工程长什么样
  @objc func ottoStartReactNative() {
    guard !reactNativeStarted, let factory = reactNativeFactory else { return }
    reactNativeStarted = true
    let window = UIWindow(frame: .zero)
    headlessWindow = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: nil)
  }
}

@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate, let factory = appDelegate.reactNativeFactory else {
      fatalError("SceneDelegate：AppDelegate 没在 didFinishLaunching 里建好 RCTReactNativeFactory")
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    if let root = headlessWindow?.rootViewController {
      // 推送叫起来时已经在后台跑着一份（见上面 ottoStartReactNative）：搬过来，不启动第二份
      headlessWindow?.rootViewController = nil
      headlessWindow = nil
      window.rootViewController = root
      window.makeKeyAndVisible()
    } else {
      reactNativeStarted = true
      // 冷启动带来的链接在 connectionOptions 里，不在 launchOptions 里；Linking.getInitialURL()
      // 只读 launchOptions，所以按它认的键重建一份
      factory.startReactNative(
        withModuleName: "main",
        in: window,
        launchOptions: Self.launchOptions(url: connectionOptions.urlContexts.first?.url))
    }
    connectionOptions.urlContexts.forEach { open($0) }
    connectionOptions.userActivities.forEach { continueActivity($0) }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { open($0) }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueActivity(userActivity)
  }

  private func open(_ context: UIOpenURLContext) {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let source = context.options.sourceApplication { options[.sourceApplication] = source }
    if let annotation = context.options.annotation { options[.annotation] = annotation }
    options[.openInPlace] = context.options.openInPlace
    _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
  }

  private func continueActivity(_ activity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }

  private static func launchOptions(url: URL?) -> [UIApplication.LaunchOptionsKey: Any]? {
    guard let url else { return nil }
    return [UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey"): url]
  }
}
