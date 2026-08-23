import SwiftUI

/// DynamicNotch 的 expanded 内容:上半区是会话列表(逐 session 一行,点选切换),
/// 下半区是选中会话的详情——active(工具 + 本地计时)/ approval(verb+target + 三按钮)/
/// compose(输入框)。idle 详情不会真的被看到——idle 态由 main.swift 驱动到 compact,
/// 压根不 expand(除非用户手动点了列表行里的 idle session,这时详情兜底渲染空)。
struct IslandExpandedView: View {
  @ObservedObject var model: IslandModel
  @State private var now = Date()
  @State private var text = ""
  /// composeRow 出现时靠 .onAppear 把这个设 true——SwiftUI 会据此把键盘焦点
  /// 移进 TextField。这只在承载窗口是 key window 时才生效,窗口 key 与否是
  /// main.swift 的 onComposeChange 负责的(activationPolicy + NSPanel.makeKey)。
  @FocusState private var composeFieldFocused: Bool
  private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  /// 列表行高亮用的"有效选中 id"。brief 定义为 selectedSessionId ?? focusedSessionId;
  /// 额外兜底到 agents.first——理由:model.selectedAgent 自己就有这层 first 兜底
  /// (两者都是 nil 时仍展示首行详情),高亮和详情如果不同步会出现"详情是 A,却没有
  /// 任何行被高亮"的观感错位,所以这里镜像同一条兜底链路。
  private var effectiveSelectedId: String? {
    model.selectedSessionId ?? model.fleet.focusedSessionId ?? model.fleet.agents.first?.id
  }

  var body: some View {
    Group {
      if model.fleet.agents.isEmpty {
        Text("主窗里先开会话")
          .foregroundStyle(.secondary)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
      } else {
        VStack(spacing: 0) {
          ScrollView {
            VStack(spacing: 2) {
              ForEach(model.fleet.agents) { agent in
                AgentRow(agent: agent, isSelected: agent.id == effectiveSelectedId)
                  .onTapGesture { model.selectedSessionId = agent.id }
              }
            }
            .padding(.vertical, 4)
          }
          .frame(maxHeight: 180)

          Divider()

          if let agent = model.selectedAgent {
            detail(agent)
          }
        }
      }
    }
    .onReceive(timer) { now = $0 }
    // 展开态根节点限宽:AgentRow 里的 Spacer(minLength: 0) 会贪婪吃满可用宽度,
    // 而 DynamicNotchKit 的展开面板窗口本身是 maxWidth: .infinity(库内 NotchContentView
    // 决定的全屏宽)。两者叠加,没有这行的话面板会被内容的 intrinsic width 撑成
    // 横贯全屏的黑条。380pt 落在 360–420pt 区间:够放下状态点 + 会话标题 + 简短
    // 工具 caption 单行不换行,也给审批三按钮(允许/会话/拒绝)和输入框留够地方,
    // 同时贴近刘海尺度,不再是一条横条。
    .frame(width: 380)
  }

  /// 选中会话的详情区:输入态优先(composing 是全局开关,不分会话),否则按
  /// 该 agent 当前 phase 分派——这部分视图体是从旧的"直接渲染 selectedAgent 详情"
  /// 版本原样搬过来的,入参从隐式 model.selectedAgent 改成显式传入的 agent,
  /// 内容(审批三按钮 / active 计时 / compose 输入框)未改。
  @ViewBuilder
  private func detail(_ agent: IslandAgent) -> some View {
    if model.composing {
      composeRow
    } else {
      switch agent.phase {
      case .approval:
        approvalRow(agent)
      case .active:
        activeRow(agent)
      case .idle:
        // 防御性兜底:idle 详情理论上不会被真的看到(compact 态就没 expand),
        // 用户手动点了一个 idle 行也不该崩,留空即可。
        Color.clear.frame(width: 1, height: 1)
      }
    }
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

/// 会话列表里的一行:状态点(idle 灰 / active 蓝 / approval 橙)+ 标题 +(active 才有的)
/// 当前工具 caption。选中行给一层浅底高亮。`.contentShape(Rectangle())` 让整行(包括
/// 间隙)都能接住点击——不加这行的话 HStack 里的 Spacer 区域是点不中的。
struct AgentRow: View {
  let agent: IslandAgent
  let isSelected: Bool

  private var dotColor: Color {
    switch agent.phase {
    case .idle: return .gray
    case .active: return .blue
    case .approval: return .orange
    }
  }

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(dotColor)
        .frame(width: 6, height: 6)
      VStack(alignment: .leading, spacing: 1) {
        Text(agent.title ?? "未命名会话")
          .lineLimit(1)
          .foregroundStyle(.white)
        if agent.phase == .active {
          // 无工具时(刚开跑/思考中)也给行内 caption,和详情区 activeRow 的兜底
          // 文案一致——不然列表行只有蓝点没字,看不出这行在干嘛(#194)。
          Text(agent.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
    .background(isSelected ? Color.white.opacity(0.14) : Color.clear)
    .cornerRadius(6)
    .contentShape(Rectangle())
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
      if model.fleet.agents.contains(where: { $0.phase == .approval }) {
        // approval 不等 hover 直接 expand(desiredState 是 fleet-wide 的 contains,
        // 见 main.swift),compact 内容不会被看到,不需要入口。这里的判断跟着
        // 改成 fleet-wide,和展开条件保持同一把键——原先按 selectedAgent 判,
        // 用户手动选中别的行时和展开条件错位(#194)。
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
