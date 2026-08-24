import AppKit
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

  /// 列表行高亮用的"有效选中 id"。镜像 model.selectedAgent 的兜底链路
  /// (selected ?? focused ?? 审批行 ?? 首行)——高亮和详情不同步会出现
  /// "详情是 A,却没有任何行被高亮"的观感错位。
  private var effectiveSelectedId: String? {
    model.selectedSessionId
      ?? model.fleet.focusedSessionId
      ?? model.fleet.agents.first(where: { $0.phase == .approval })?.id
      ?? model.fleet.agents.first?.id
  }

  /// 会话按 workspace 分组(#206):flattenFleet 保证同 workspace 连续(侧栏同序),
  /// 这里只做连续切段,不重排。id 用 workspace 全路径(收放状态的键)。
  private struct WorkspaceGroup: Identifiable {
    let id: String
    let label: String
    let agents: [IslandAgent]
  }

  private var workspaceGroups: [WorkspaceGroup] {
    var groups: [WorkspaceGroup] = []
    for agent in model.fleet.agents {
      let key = agent.workspace ?? "其他"
      if let last = groups.indices.last, groups[last].id == key {
        groups[last] = WorkspaceGroup(id: key, label: groups[last].label, agents: groups[last].agents + [agent])
      } else {
        groups.append(WorkspaceGroup(id: key, label: agent.workspaceLabel, agents: [agent]))
      }
    }
    return groups
  }

  var body: some View {
    Group {
      // 用量模式(#199):上半区换成用量表,下半区详情(审批三按钮 / compose 输入)
      // 原样保留——审批 fleet-wide 强制展开的意义就是当场能按按钮,不能因为
      // 显示的是用量就把按钮藏了。fleet 为空但有历史用量也照常显示表。
      if model.fleet.display == .usage {
        VStack(spacing: 0) {
          usageTable
          if let agent = model.selectedAgent, model.composing || agent.phase != .idle {
            Divider()
            detail(agent)
          }
        }
      } else if model.fleet.agents.isEmpty {
        Text("主窗里先开会话")
          .foregroundStyle(.secondary)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
      } else {
        VStack(spacing: 0) {
          ScrollView {
            VStack(spacing: 2) {
              ForEach(workspaceGroups) { group in
                let collapsed = model.collapsedWorkspaces.contains(group.id)
                workspaceHeader(group, collapsed: collapsed)
                  .onTapGesture { model.toggleWorkspace(group.id) }
                if !collapsed {
                  ForEach(group.agents) { agent in
                    AgentRow(agent: agent, isSelected: agent.id == effectiveSelectedId)
                      .onTapGesture {
                        model.selectedSessionId = agent.id
                        // 点行不只是选中详情(#210):把主窗也切过去——点击表达的
                        // 是"我要看这个会话",岛上的详情区只放得下一行状态
                        model.onOutbound(.focusSession(sessionId: agent.id))
                      }
                  }
                }
              }
            }
            .padding(.vertical, 6)
          }
          .frame(maxHeight: 240)

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
    // 横贯全屏的黑条。420pt:#209 字号整体放大一档(13/14pt 正文)后 380 开始
    // 挤(用量三列 58pt + logo),420 仍贴刘海尺度,不是横条。
    .frame(width: 420)
  }

  /// 组头(#206):chevron + 文件夹名,整行可点收放。收起时组内状态不能凭空消失——
  /// 组内有审批给橙点(要人动手的那种,绝不能被收起藏没)、有 active 给蓝点。
  private func workspaceHeader(_ group: WorkspaceGroup, collapsed: Bool) -> some View {
    let hasApproval = group.agents.contains { $0.phase == .approval }
    let hasActive = group.agents.contains { $0.phase == .active }
    return HStack(spacing: 6) {
      Image(systemName: collapsed ? "chevron.right" : "chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.secondary)
        .frame(width: 11)
      Text(group.label)
        .font(.system(size: 13))
        .foregroundStyle(.secondary)
        .lineLimit(1)
      if collapsed && hasApproval {
        Circle().fill(Color.orange).frame(width: 6, height: 6)
      } else if collapsed && hasActive {
        Circle().fill(Color.accentColor).frame(width: 6, height: 6)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.top, 8)
    .padding(.bottom, 3)
    .contentShape(Rectangle())
  }

  /// 厂商 logo(#209):资源 bundle providers/<id>.png(lobehub dark 变体)。
  /// 查过一次就缓存——每帧重复解码 PNG 没意义。找不到返回 nil,行内只显文字。
  @MainActor private static var providerLogoCache: [String: NSImage?] = [:]
  @MainActor private static func providerLogo(_ id: String?) -> NSImage? {
    guard let id else { return nil }
    if let hit = providerLogoCache[id] { return hit }
    let img = Bundle.module
      .url(forResource: id, withExtension: "png", subdirectory: "providers")
      .flatMap { NSImage(contentsOf: $0) }
    providerLogoCache[id] = img
    return img
  }

  /// 用量表(#199):每模型一行,厂商 logo(#209)+ 今天/7天/14天 三列。数字
  /// monospacedDigit + 固定列宽右对齐——列不对齐的数字表读起来是灾难。
  /// 行数主进程已截到 6,高度可控,不套 ScrollView(表是扫一眼的东西)。
  private var usageTable: some View {
    VStack(alignment: .leading, spacing: 3) {
      if model.fleet.usage.isEmpty {
        Text("还没有用量")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.vertical, 10)
      } else {
        HStack(spacing: 8) {
          Text("模型")
          Spacer(minLength: 0)
          Text("今天").frame(width: 58, alignment: .trailing)
          Text("7天").frame(width: 58, alignment: .trailing)
          Text("14天").frame(width: 58, alignment: .trailing)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.top, 9)
        ForEach(model.fleet.usage) { row in
          HStack(spacing: 8) {
            if let logo = Self.providerLogo(row.provider) {
              Image(nsImage: logo)
                .resizable()
                .scaledToFit()
                .frame(width: 15, height: 15)
            }
            Text(row.label)
              .lineLimit(1)
              .foregroundStyle(.white)
            Spacer(minLength: 0)
            Group {
              Text(Self.fmtTokens(row.today)).frame(width: 58, alignment: .trailing)
              Text(Self.fmtTokens(row.d7)).frame(width: 58, alignment: .trailing)
              Text(Self.fmtTokens(row.d14)).frame(width: 58, alignment: .trailing)
            }
            .foregroundStyle(.secondary)
            .monospacedDigit()
          }
          .font(.system(size: 13))
          .padding(.horizontal, 14)
          .padding(.vertical, 4)
        }
      }
    }
    .padding(.bottom, 9)
  }

  /// K/M 缩写,同渲染层 fmtTokens 的口径(ProviderUsage.tsx)——两边显示同一个数,
  /// 写法也该长一个样。
  static func fmtTokens(_ n: Double) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", n / 1_000) }
    return String(Int(n))
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
      // 本轮聚合改动(issue #345):有写盘才出现,与主窗「本轮改动」同一份统计
      if let d = agent.turnDiff {
        Text("\(d.files) 文件 +\(d.additions) −\(d.deletions)")
          .foregroundStyle(.secondary)
          .monospacedDigit()
          .lineLimit(1)
      }
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
    HStack(spacing: 9) {
      Circle()
        .fill(dotColor)
        .frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 2) {
        Text(agent.title ?? "未命名会话")
          .font(.system(size: 14))
          .lineLimit(1)
          .foregroundStyle(.white)
        if agent.phase == .active {
          // 无工具时(刚开跑/思考中)也给行内 caption,和详情区 activeRow 的兜底
          // 文案一致——不然列表行只有蓝点没字,看不出这行在干嘛(#194)。
          Text(agent.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 6)
    .background(isSelected ? Color.white.opacity(0.14) : Color.clear)
    .cornerRadius(7)
    .contentShape(Rectangle())
  }
}

/// DynamicNotch 的 compact leading 内容:Otto logo 常显(#201/#203)——身份标识 +
/// 输入态入口(点了 enterCompose)。状态点在另一侧(IslandCompactStatusView)。
///
/// hover 检测特意不放在这里:DynamicNotchKit 的 NotchView 只在 state == .compact 时才把
/// compactLeading 挂进视图树,一旦因 hover 展开成 .expanded,这个 view 连同它的 .onHover
/// 就被卸载了 —— 鼠标移开也再收不到事件,会导致展开态卡死收不回去(手动冒烟实测踩到的坑)。
/// 真正跨 compact/expanded 都有效的 hover 信号是 DynamicNotch 自己的 `isHovering`
/// (框架把 .onHover 挂在包住 compact+expanded 两层内容的外层容器上),main.swift 直接订阅它。
struct IslandCompactView: View {
  @ObservedObject var model: IslandModel

  /// SPM 资源 bundle 里的 logo(透明背景版 otto.png,和渲染层同一张图,#201)。
  /// 找不到给 nil,下面兜底回键盘图标——资源缺失(打包漏拷 bundle)时岛不能瞎。
  private static let logo: NSImage? =
    Bundle.module.url(forResource: "otto", withExtension: "png")
      .flatMap { NSImage(contentsOf: $0) }

  var body: some View {
    Button {
      model.enterCompose()
    } label: {
      if let logo = Self.logo {
        Image(nsImage: logo)
          .resizable()
          .scaledToFit()
          .frame(height: 20)
      } else {
        Image(systemName: "keyboard")
          .font(.system(size: 8))
          .foregroundStyle(.white.opacity(0.55))
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 6)
  }
}

/// compact trailing(刘海右侧)的状态小圆球(#203):有任务在跑时蓝色脉动。
/// approval 也给一颗橙点——虽然 desiredState 会立刻 fleet-wide 展开,展开动画
/// 那几百毫秒里 compact 还在屏上,橙点让状态切换读起来连续而不是跳变。
struct IslandCompactStatusView: View {
  @ObservedObject var model: IslandModel
  @State private var pulse = false

  /// fleet-wide 条件(不局限当前选中):哪怕选中行是别的 session,
  /// 只要有 agent 在跑/在等审批就该有提示。
  private var anyActive: Bool {
    model.fleet.agents.contains { $0.phase == .active }
  }
  private var anyApproval: Bool {
    model.fleet.agents.contains { $0.phase == .approval }
  }

  var body: some View {
    Group {
      if anyApproval || anyActive {
        Circle()
          .fill(anyApproval ? Color.orange : Color.accentColor)
          .frame(width: 6, height: 6)
          .opacity(pulse ? 1 : 0.35)
          .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
          .onAppear { pulse = true }
          // repeatForever 的动画锚在 pulse 的**值变化**上:active 结束点被移除后
          // pulse 还是 true,下次再 active 时没有变化就没有动画——归零才有下一次
          .onDisappear { pulse = false }
      } else {
        // 空闲不显示——但 DynamicNotchKit 对空 trailing 会把区域收到 0,
        // 留一个 1pt 占位让左右视觉对称的问题交给框架的 padding,不在这里硬凑
        Color.clear.frame(width: 1, height: 1)
      }
    }
    .padding(.horizontal, 6)
  }
}
