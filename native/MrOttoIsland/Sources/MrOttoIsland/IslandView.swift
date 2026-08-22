import SwiftUI

/// DynamicNotch 的 expanded 内容:active(工具 + 本地计时)/ approval(verb+target + 三按钮)。
/// idle 不会走到这里 —— idle 态由 main.swift 驱动到 compact,压根不 expand。
struct IslandExpandedView: View {
  @ObservedObject var model: IslandModel
  @State private var now = Date()
  private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    let s = model.snapshot
    Group {
      switch s.phase {
      case .approval:
        approvalRow(s.pendingApproval)
      case .active:
        activeRow(s)
      case .idle:
        // 防御性兜底:理论上 idle 不会被 expand,万一状态竞态漏进来也不要崩。
        Color.clear.frame(width: 1, height: 1)
      }
    }
    .onReceive(timer) { now = $0 }
  }

  private func activeRow(_ s: IslandSnapshot) -> some View {
    HStack(spacing: 8) {
      Image(systemName: s.currentTool == nil ? "circle.dashed" : "terminal")
      Text(s.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
        .lineLimit(1)
      if let start = s.turnStartedAt {
        Text("\(Int(now.timeIntervalSince1970 - start / 1000))s")
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .foregroundStyle(.white)
  }

  private func approvalRow(_ p: PendingApproval?) -> some View {
    HStack(spacing: 8) {
      Text("审批").foregroundStyle(.orange)
      Text(p.map { "\($0.verb) \($0.target)" } ?? "").lineLimit(1)
      if let p {
        Button {
          model.onOutbound(.approve(sessionId: model.snapshot.sessionId ?? "", callId: p.callId, grant: nil))
        } label: {
          Label("允许", systemImage: "checkmark")
        }
        Button {
          model.onOutbound(.approve(sessionId: model.snapshot.sessionId ?? "", callId: p.callId, grant: "session"))
        } label: {
          Text("会话").font(.caption)
        }
        Button {
          model.onOutbound(.deny(sessionId: model.snapshot.sessionId ?? "", callId: p.callId))
        } label: {
          Label("拒绝", systemImage: "xmark")
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .foregroundStyle(.white)
    .buttonStyle(.plain)
  }
}

/// DynamicNotch 的 compact leading 内容:idle 什么都不显;active 一个脉动小圆点提示"有事在发生"。
///
/// hover 检测特意不放在这里:DynamicNotchKit 的 NotchView 只在 state == .compact 时才把
/// compactLeading 挂进视图树,一旦因 hover 展开成 .expanded,这个 view 连同它的 .onHover
/// 就被卸载了 —— 鼠标移开也再收不到事件,会导致展开态卡死收不回去(手动冒烟实测踩到的坑)。
/// 真正跨 compact/expanded 都有效的 hover 信号是 DynamicNotch 自己的 `isHovering`
/// (框架把 .onHover 挂在包住 compact+expanded 两层内容的外层容器上),main.swift 直接订阅它。
struct IslandCompactView: View {
  @ObservedObject var model: IslandModel
  @State private var pulse = false

  var body: some View {
    Group {
      switch model.snapshot.phase {
      case .active:
        Circle()
          .fill(Color.accentColor)
          .frame(width: 5, height: 5)
          .opacity(pulse ? 1 : 0.35)
          .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
          .onAppear { pulse = true }
      case .idle, .approval:
        // idle:贴合刘海什么都不显。approval 不等 hover 直接 expand,compact 内容不会被看到。
        Color.clear.frame(width: 1, height: 1)
      }
    }
    .padding(.horizontal, 6)
  }
}
