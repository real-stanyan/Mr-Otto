import SwiftUI

/// DynamicNotch 的 expanded 内容:active(工具 + 本地计时)/ approval(verb+target + 三按钮)。
/// idle 不会走到这里 —— idle 态由 main.swift 驱动到 compact,压根不 expand。
struct IslandExpandedView: View {
  @ObservedObject var model: IslandModel
  @State private var now = Date()
  @State private var text = ""
  /// composeRow 出现时靠 .onAppear 把这个设 true——SwiftUI 会据此把键盘焦点
  /// 移进 TextField。这只在承载窗口是 key window 时才生效,窗口 key 与否是
  /// main.swift 的 onComposeChange 负责的(activationPolicy + NSPanel.makeKey)。
  @FocusState private var composeFieldFocused: Bool
  private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    Group {
      if model.composing {
        composeRow
      } else if let agent = model.selectedAgent {
        switch agent.phase {
        case .approval:
          approvalRow(agent)
        case .active:
          activeRow(agent)
        case .idle:
          // 防御性兜底:理论上 idle 不会被 expand,万一状态竞态漏进来也不要崩。
          Color.clear.frame(width: 1, height: 1)
        }
      } else {
        // fleet 为空(还没有任何 session):没有可展示的详情,贴合刘海。
        Color.clear.frame(width: 1, height: 1)
      }
    }
    .onReceive(timer) { now = $0 }
  }

  /// 输入态整行:TextField + 发送按钮。composing 由外部(点"说话"入口)置真,
  /// main.swift 的 desiredState 据此强制 .expanded 并让承载窗口成为 key window,
  /// 这里 .onAppear 把 SwiftUI 焦点也移过去——两边都到位,TextField 才真正能打字。
  private var composeRow: some View {
    HStack(spacing: 8) {
      TextField(
        model.selectedAgent == nil ? "主窗里先开会话" : "对 Otto 说…",
        text: $text
      )
      .textFieldStyle(.plain)
      .foregroundStyle(.white)
      .focused($composeFieldFocused)
      .onSubmit { submit() }
      Button {
        submit()
      } label: {
        Image(systemName: "paperplane.fill")
      }
      .buttonStyle(.plain)
      .foregroundStyle(.white)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .onAppear { composeFieldFocused = true }
    .onExitCommand { cancelCompose() } // Esc:取消输入态,清空文本
    // 单参数版 onChange(of:perform:)——部署目标 macOS 13,双参数版是 14+ 才有的 API。
    .onChange(of: composeFieldFocused) { focused in
      // 失焦(比如用户点回了别的 app,承载窗口 resign key)也要退出输入态,
      // 不然 composing 卡在 true、main.swift 不会把 activationPolicy 放回
      // .accessory——这正是 #175 I3 那种"窗口一直扣着键盘"的失败模式。
      //
      // 只退出输入态,不清 text——Send 按钮点击时,鼠标点下去可能先让
      // TextField resign first responder(触发这条 blur 分支),再轮到按钮的
      // action 触发 submit()。这两条事件流谁先谁后不是我们能控的时序保证。
      // 如果这里清了 text,submit() 里 guard 文本非空的检查就会先失败,
      // 用户刚打完的字被静默丢掉——这是本 fix round 要堵的竞态。
      // text = "" 只留给明确的退出路径:Esc(cancelCompose)和提交成功(submit)。
      if !focused && model.composing {
        model.exitCompose()
      }
    }
  }

  private func submit() {
    guard let sid = model.selectedAgent?.sessionId,
          !text.trimmingCharacters(in: .whitespaces).isEmpty
    else { return }
    model.onOutbound(.send(sessionId: sid, text: text))
    text = ""
    model.exitCompose()
  }

  private func cancelCompose() {
    text = ""
    model.exitCompose()
  }

  private func activeRow(_ agent: IslandAgent) -> some View {
    HStack(spacing: 8) {
      Image(systemName: agent.currentTool == nil ? "circle.dashed" : "terminal")
      Text(agent.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
        .lineLimit(1)
      if let start = agent.turnStartedAt {
        Text("\(Int(now.timeIntervalSince1970 - start / 1000))s")
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .foregroundStyle(.white)
  }

  private func approvalRow(_ agent: IslandAgent) -> some View {
    let p = agent.pendingApproval
    return HStack(spacing: 8) {
      Text("审批").foregroundStyle(.orange)
      Text(p.map { "\($0.verb) \($0.target)" } ?? "").lineLimit(1)
      if let p {
        Button {
          model.onOutbound(.approve(sessionId: agent.sessionId, callId: p.callId, grant: nil))
        } label: {
          Label("允许", systemImage: "checkmark")
        }
        Button {
          model.onOutbound(.approve(sessionId: agent.sessionId, callId: p.callId, grant: "session"))
        } label: {
          Text("会话").font(.caption)
        }
        Button {
          model.onOutbound(.deny(sessionId: agent.sessionId, callId: p.callId))
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

  /// 折叠态脉动条件:fleet 里任一 session 在 active(不局限于当前选中的那个)——
  /// 哪怕选中行是别的 session,只要有 agent 在跑就该有提示。按 selectedAgent 切换的
  /// 单会话逻辑(点击进输入态等)留到列表 UI 落地的下一个 task。
  private var anyActive: Bool {
    model.fleet.agents.contains { $0.phase == .active }
  }

  var body: some View {
    Group {
      if model.selectedAgent?.phase == .approval {
        // approval 不等 hover 直接 expand,compact 内容不会被看到,不需要入口。
        Color.clear.frame(width: 1, height: 1)
      } else if anyActive {
        // 脉动点本身就是入口:点一下进输入态(Task 6)。视觉不变,只是加了可点性,
        // 跟 task-5 报告里"active 默认折叠只露一个提示点"的设计没冲突。
        Button {
          model.enterCompose()
        } label: {
          Circle()
            .fill(Color.accentColor)
            .frame(width: 5, height: 5)
            .opacity(pulse ? 1 : 0.35)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
        }
        .buttonStyle(.plain)
        .onAppear { pulse = true }
      } else {
        // Task 6 之前这里是纯 Color.clear(贴合刘海什么都不显)。要让 idle 也能进输入态,
        // 必须有个可点的东西——用一个很小的键盘图标当"点一下说话"入口,尽量不抢视觉。
        Button {
          model.enterCompose()
        } label: {
          Image(systemName: "keyboard")
            .font(.system(size: 8))
            .foregroundStyle(.white.opacity(0.55))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 6)
  }
}
