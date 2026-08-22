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

  var onOutbound: (Outbound) -> Void = { _ in }
}
