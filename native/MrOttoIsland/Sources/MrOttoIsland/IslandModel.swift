import Foundation
import Combine

/// 岛 UI 的状态源:主进程推来的快照。hover 状态不在这里 —— 那是 DynamicNotch 自己的
/// `isHovering`(main.swift 直接订阅它,理由见 IslandView.swift 里 IslandCompactView 的注释)。
/// DynamicNotch 的 expand/compact/hide 都是 @MainActor,这个 model 也标 @MainActor,
/// 配合 Bridge 在 main.swift 里做的 DispatchQueue.main.async 跳转,保证发布只在主线程发生。
@MainActor
final class IslandModel: ObservableObject {
  @Published var snapshot = IslandSnapshot(
    sessionId: nil, model: nil, phase: .idle,
    currentTool: nil, turnStartedAt: nil, pendingApproval: nil
  )

  /// 输入态开关。true 时 main.swift 的 desiredState 强制 `.expanded` 并抢键盘焦点
  /// (见 main.swift 的 onComposeChange),phase 本身不受影响——退出输入态后
  /// 照常回到 idle/active/approval 该有的展示。
  @Published var composing = false

  var onOutbound: (Outbound) -> Void = { _ in }
  /// 焦点抢还的回调,main.swift 在这里做 NSApp.setActivationPolicy + activate 的实际操作。
  /// Model 自己不碰 AppKit——保持它是纯状态容器,AppKit 副作用留给 main.swift。
  var onComposeChange: (Bool) -> Void = { _ in }

  func enterCompose() {
    composing = true
    onComposeChange(true)
  }

  func exitCompose() {
    composing = false
    onComposeChange(false)
  }
}
