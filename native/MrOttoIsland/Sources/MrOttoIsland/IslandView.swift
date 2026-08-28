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

  /// 会话按**项目**分组(#206 起;分组键 workspace → projectRoot):flattenFleet 保证
  /// 同项目连续(侧栏同序),这里只做连续切段,不重排。id 用项目根全路径(收放状态的键)。
  private struct WorkspaceGroup: Identifiable {
    let id: String
    let label: String
    let agents: [IslandAgent]
  }

  private var workspaceGroups: [WorkspaceGroup] {
    var groups: [WorkspaceGroup] = []
    for agent in model.fleet.agents {
      let key = agent.groupKey
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
            // pinnedViews:组头吸顶。刘海面板一屏只放得下几行,滚起来之后
            // "现在看的是哪个项目"必须一直在场,否则组头等于没有
            LazyVStack(spacing: 2, pinnedViews: [.sectionHeaders]) {
              ForEach(workspaceGroups) { group in
                let collapsed = model.collapsedWorkspaces.contains(group.id)
                Section(header: workspaceHeader(group, collapsed: collapsed)) {
                  if !collapsed {
                    ForEach(group.agents) { agent in
                      AgentRow(agent: agent, isSelected: agent.id == effectiveSelectedId, now: now) {
                        model.selectedSessionId = agent.id
                        // 点行不只是选中详情(#210):把主窗也切过去——点击表达的
                        // 是"我要看这个会话",岛上的详情区只放得下一行状态
                        model.onOutbound(.focusSession(sessionId: agent.id))
                      }
                    }
                  }
                }
              }
            }
            .padding(.vertical, 6)
          }
          .frame(maxHeight: 240)
          // 纯黑面板上那条亮滚动条比它指示的信息更吵;列表本来就短,
          // 边缘渐隐已经在说"下面还有"。
          // `.never` 不是 `.hidden`:后者在系统「始终显示滚动条」下照样画出来
          // (真机验收抓到的),前者才是真的一条也不画
          .scrollIndicators(.never)
          // 列表与详情之间不用 Divider:一条硬线把两块切成"两个东西",而它们是
          // 同一件事的两个粒度。渐隐遮罩让内容在边缘消失,滚动的连续感留着
          // (Apple 的 scroll edge effect)
          .overlay(alignment: .bottom) {
            LinearGradient(
              colors: [Color.black.opacity(0), Color.black],
              startPoint: .top, endPoint: .bottom
            )
            .frame(height: 14)
            .allowsHitTesting(false)
          }

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

  /// 组头(#206):chevron + 项目名 + 会话数,整行可点收放。
  ///
  /// 字号从 13pt regular 降到 11pt semibold:组头和行标题原来几乎同权重,两条信息
  /// 在抢同一层。小字要**正** tracking 才不糊(Apple 的 tracking 随字号走,
  /// 大字负、小字正),所以 +0.04em ≈ 0.44pt。
  ///
  /// 会话数**常显**:原来状态点只在收起时出现,于是"收起"这个动作改变的不只是
  /// 占多少地方,还改变了看得见多少信息。收放只该改空间。
  /// 收起时才补状态点——组内有审批给橙点(要人动手的那种,绝不能被收起藏没)、
  /// 有 active 给蓝点。
  private func workspaceHeader(_ group: WorkspaceGroup, collapsed: Bool) -> some View {
    let hasApproval = group.agents.contains { $0.phase == .approval }
    let hasActive = group.agents.contains { $0.phase == .active }
    return HStack(spacing: 5) {
      Image(systemName: "chevron.down")
        .font(.system(size: 8, weight: .semibold))
        .foregroundStyle(.white.opacity(0.38))
        .frame(width: 9)
        .rotationEffect(.degrees(collapsed ? -90 : 0))
        .animation(.easeOut(duration: 0.22), value: collapsed)
      Text(group.label)
        .font(.system(size: 11, weight: .semibold))
        .tracking(0.44)
        .foregroundStyle(.white.opacity(0.46))
        .lineLimit(1)
      if collapsed && hasApproval {
        Circle().fill(Color.orange).frame(width: 5, height: 5)
      } else if collapsed && hasActive {
        Circle().fill(Color.accentColor).frame(width: 5, height: 5)
      }
      Text("\(group.agents.count)")
        .font(.system(size: 10, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(.white.opacity(0.30))
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.top, 9)
    .padding(.bottom, 4)
    .contentShape(Rectangle())
    // 吸顶时下方要有个收口,否则行会从组头底下"穿"出来
    .background(
      LinearGradient(
        colors: [Color.black, Color.black, Color.black.opacity(0)],
        startPoint: .top, endPoint: .bottom
      )
    )
    .onTapGesture { model.toggleWorkspace(group.id) }
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
  ///
  /// 三处层级修正:
  /// ① **今天是主数字**。原来三列同为 secondary、同字号,一整片同权重的数字,
  ///    不回答"我该先看哪个"。今天 13pt/白 94%,7天/14天 11.5pt/白 42%。
  /// ② 表头 10pt semibold + 正 tracking(小字要正 tracking 才不糊)。
  /// ③ 行底一条按 14 天占比的 2pt 细柱:不读数字也能看出谁在吃预算。用**细柱**
  ///    不用整行底色——满格的底色块会被读成"这一行选中了",而不是一个量。
  private var usageTable: some View {
    VStack(alignment: .leading, spacing: 2) {
      if model.fleet.usage.isEmpty {
        // 空态说的是出路,不只是事实:"还没有用量"讲完就没了,用户不知道该干什么
        Text("跑一轮对话后这里会有数")
          .font(.system(size: 12))
          .foregroundStyle(.white.opacity(0.42))
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.vertical, 12)
      } else {
        let peak = model.fleet.usage.map(\.d14).max() ?? 0
        HStack(spacing: 8) {
          Text("模型")
          Spacer(minLength: 0)
          Text("今天").frame(width: 64, alignment: .trailing)
          Text("7天").frame(width: 52, alignment: .trailing)
          Text("14天").frame(width: 52, alignment: .trailing)
        }
        .font(.system(size: 10, weight: .semibold))
        .tracking(0.6)
        .foregroundStyle(.white.opacity(0.38))
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 3)
        ForEach(model.fleet.usage) { row in
          HStack(spacing: 8) {
            if let logo = Self.providerLogo(row.provider) {
              Image(nsImage: logo)
                .resizable()
                .scaledToFit()
                .frame(width: 16, height: 16)
                // 深色 logo 压在纯黑上会糊掉边界,一圈内描边把它托住
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                )
            }
            Text(row.label)
              .font(.system(size: 12.5, weight: .medium))
              .lineLimit(1)
              .foregroundStyle(.white.opacity(0.92))
            Spacer(minLength: 0)
            Text(Self.fmtTokens(row.today))
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(.white.opacity(0.94))
              .monospacedDigit()
              .frame(width: 64, alignment: .trailing)
            Group {
              Text(Self.fmtTokens(row.d7)).frame(width: 52, alignment: .trailing)
              Text(Self.fmtTokens(row.d14)).frame(width: 52, alignment: .trailing)
            }
            .font(.system(size: 11.5))
            .foregroundStyle(.white.opacity(0.42))
            .monospacedDigit()
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 5)
          // 占比柱贴在行底,只铺"模型名"那段(总宽减去三列数字),不越到数字下面——
          // 越过去就分不清它是量还是高亮
          .overlay(alignment: .bottomLeading) {
            GeometryReader { geo in
              let usable = max(geo.size.width - 196, 0)
              let ratio = peak > 0 ? row.d14 / peak : 0
              Capsule()
                .fill(Color.white.opacity(0.20))
                .frame(width: usable * ratio, height: 2)
                .offset(x: 14, y: geo.size.height - 2)
            }
            .allowsHitTesting(false)
          }
        }
        // 表要收得了口:没有合计,四行数字读完不知道总共烧了多少
        let total = model.fleet.usage.reduce(into: (t: 0.0, d7: 0.0, d14: 0.0)) {
          $0.t += $1.today; $0.d7 += $1.d7; $0.d14 += $1.d14
        }
        HStack(spacing: 8) {
          Text("合计").tracking(0.4)
          Spacer(minLength: 0)
          Text(Self.fmtTokens(total.t))
            .font(.system(size: 12)).foregroundStyle(.white.opacity(0.72))
            .frame(width: 64, alignment: .trailing)
          Text(Self.fmtTokens(total.d7)).frame(width: 52, alignment: .trailing)
          Text(Self.fmtTokens(total.d14)).frame(width: 52, alignment: .trailing)
        }
        .font(.system(size: 11, weight: .semibold))
        .monospacedDigit()
        .foregroundStyle(.white.opacity(0.42))
        .padding(.horizontal, 14)
        .padding(.top, 7)
        .overlay(alignment: .top) {
          Rectangle().fill(Color.white.opacity(0.09)).frame(height: 1).padding(.horizontal, 14)
        }
      }
    }
    .padding(.bottom, 9)
  }

  /// 「跑了多久」的唯一算法与唯一写法。行上和详情区显示的是同一个数,不能一处
  /// `1024s` 一处 `1,024s` —— `Text("\(someInt)s")` 构造的是 LocalizedStringKey,
  /// 整数插值会按 locale 加千分位;先算成 String 再交给 `Text(_: String)` 就不会。
  /// (真机验收时抓到的:一个跑了 17 分钟的 turn 在两处长得不一样)
  static func elapsedText(sinceMs startedAt: Double, now: Date) -> String {
    "\(max(Int(now.timeIntervalSince1970 - startedAt / 1000), 0))s"
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

  /// 详情区左端那个"这是谁的状态"。只在有第二个会话时出现——一只水獭时它是废话,
  /// 而刘海这点宽度不该拿去说废话。`layoutPriority(-1)`:挤起来先截它,
  /// 绝不去挤审批那三个按钮。
  @ViewBuilder
  private func whoLabel(_ agent: IslandAgent) -> some View {
    if model.fleet.agents.count > 1 {
      Text(agent.title ?? "未命名会话")
        .foregroundStyle(.white.opacity(0.42))
        .lineLimit(1)
        .layoutPriority(-1)
      Text("·").foregroundStyle(.white.opacity(0.26))
    }
  }

  private func activeRow(_ agent: IslandAgent) -> some View {
    HStack(spacing: 7) {
      whoLabel(agent)
      Image(systemName: agent.currentTool == nil ? "circle.dashed" : "terminal")
        .font(.system(size: 11))
        .foregroundStyle(.white.opacity(0.55))
      Text(agent.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
        .lineLimit(1)
      // 本轮聚合改动(issue #345):有写盘才出现,与主窗「本轮改动」同一份统计
      if let d = agent.turnDiff {
        Text("\(d.files) 文件 +\(d.additions) −\(d.deletions)")
          .foregroundStyle(.white.opacity(0.42))
          .monospacedDigit()
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if let start = agent.turnStartedAt {
        Text(Self.elapsedText(sinceMs: start, now: now))
          .foregroundStyle(.white.opacity(0.42))
          .monospacedDigit()
      }
    }
    .font(.system(size: 12.5))
    .padding(.horizontal, 14)
    .padding(.top, 8)
    .padding(.bottom, 10)
    .foregroundStyle(.white.opacity(0.92))
  }

  private func approvalRow(_ agent: IslandAgent) -> some View {
    let p = agent.pendingApproval
    return HStack(spacing: 7) {
      Text("审批").foregroundStyle(.orange)
      whoLabel(agent)
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
    .font(.system(size: 12.5))
    .padding(.horizontal, 14)
    .padding(.top, 8)
    .padding(.bottom, 10)
    .foregroundStyle(.white.opacity(0.92))
    .buttonStyle(.plain)
  }
}

/// 一行状态的**形状**,不只是颜色:idle 空心环 / active 实心 + 一圈往外扩的环 /
/// approval 实心 + 一层光晕。原来三档都是 7pt 实心圆、只差颜色——只靠颜色编码状态,
/// 色觉差异的人拿到的是三个一模一样的点。
struct PhaseIndicator: View {
  let phase: Phase
  @State private var pulse = false

  var body: some View {
    ZStack {
      switch phase {
      case .idle:
        Circle()
          .strokeBorder(Color.white.opacity(0.34), lineWidth: 1.4)
          .frame(width: 8, height: 8)
      case .active:
        Circle()
          .strokeBorder(Color.accentColor.opacity(0.55), lineWidth: 1.2)
          .frame(width: 12, height: 12)
          .scaleEffect(pulse ? 1.3 : 0.7)
          .opacity(pulse ? 0 : 0.9)
          .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false), value: pulse)
        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
      case .approval:
        Circle().fill(Color.orange.opacity(0.30)).frame(width: 14, height: 14).blur(radius: 3)
        Circle().fill(Color.orange).frame(width: 7, height: 7)
      }
    }
    .frame(width: 13, height: 13)
    // repeatForever 的动画锚在 pulse 的**值变化**上(同 IslandCompactStatusView 那条):
    // 行被回收后 pulse 还是 true,下次再 active 时没有变化就没有动画——归零才有下一次
    .onAppear { if phase == .active { pulse = true } }
    .onDisappear { pulse = false }
  }
}

/// 副本分支 chip。折回项目分组(#690)之后,同一个组里躺着同项目的几只水獭,
/// "这一行在一份独立副本上、副本叫什么"就只剩这里能说了。
struct BranchChip: View {
  let branch: String

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: "arrow.triangle.branch").font(.system(size: 8, weight: .medium))
      Text(branch).lineLimit(1).truncationMode(.middle)
    }
    .font(.system(size: 10, weight: .medium))
    .foregroundStyle(.white.opacity(0.55))
    .padding(.horizontal, 5)
    .padding(.vertical, 1)
    .background(
      RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color.white.opacity(0.07))
    )
  }
}

/// 行的底:按下 / 悬停 / 选中三档,**按下那一刻**就变(不等抬手)。
/// SwiftUI 里唯一拿得到 isPressed 的地方是 ButtonStyle,所以列表行是 Button
/// 而不是 `.onTapGesture`。
/// 选中态从"通栏白 14% 的灰板"改成"左右内缩的圆角 + 2pt 主色前导条":
/// 选中该读作「这一条」,不是屏幕上多了一块灰。
struct RowPressStyle: ButtonStyle {
  let selected: Bool
  let hovering: Bool

  private var fill: Double {
    if selected { return 0.08 }
    if hovering { return 0.05 }
    return 0
  }

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.white.opacity(configuration.isPressed ? 0.10 : fill))
      )
      .overlay(alignment: .leading) {
        if selected {
          Capsule().fill(Color.accentColor).frame(width: 2).padding(.vertical, 7)
        }
      }
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
      .animation(.easeOut(duration: 0.16), value: hovering)
  }
}

/// 会话列表里的一行:状态指示 + 标题 + 计时,副行是分支 chip / 当前工具 / 本轮改动。
///
/// 计时和改动量原来只在**选中**那行的详情区出现,于是"哪只跑了多久、动了多少"
/// 要逐行点开才知道——列表是拿来扫的,不是拿来逐行查询的(#690)。
struct AgentRow: View {
  let agent: IslandAgent
  let isSelected: Bool
  /// 计时的时间锚点,由 IslandExpandedView 的 1s timer 推进(行自己不订阅时钟:
  /// 每行一个 Timer 等于 N 个定时器在跑)
  let now: Date
  let onTap: () -> Void
  @State private var hovering = false

  private var elapsed: String? {
    guard agent.phase == .active, let start = agent.turnStartedAt else { return nil }
    return IslandExpandedView.elapsedText(sinceMs: start, now: now)
  }

  /// 副行里跟在 chip 后面的那句话:在跑就是当前工具,等审批就是要批的动作
  private var toolText: String? {
    switch agent.phase {
    case .active: return agent.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…"
    case .approval: return agent.pendingApproval.map { "\($0.verb) \($0.target)" }
    case .idle: return nil
    }
  }

  private var hasMeta: Bool { agent.branch != nil || toolText != nil || agent.turnDiff != nil }

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .top, spacing: 8) {
        PhaseIndicator(phase: agent.phase).padding(.top, 3)
        VStack(alignment: .leading, spacing: 2) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(agent.title ?? "未命名会话")
              .font(.system(size: 13, weight: .medium))
              .tracking(-0.07)
              .lineLimit(1)
              .foregroundStyle(.white.opacity(0.95))
            Spacer(minLength: 0)
            if agent.phase == .approval {
              // 审批没有"跑了多久"可显示,但这一格空着就浪费了行右端那个
              // 眼睛本来就会扫的位置
              Text("等你")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.orange)
            } else if let elapsed {
              Text(elapsed)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.42))
            }
          }
          if hasMeta { metaLine }
        }
      }
      .padding(.leading, 12)
      .padding(.trailing, 10)
      .padding(.vertical, 5)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowPressStyle(selected: isSelected, hovering: hovering))
    .onHover { hovering = $0 }
    .padding(.horizontal, 8)
  }

  private var metaLine: some View {
    HStack(spacing: 6) {
      if let branch = agent.branch { BranchChip(branch: branch) }
      if let toolText {
        Text(toolText).lineLimit(1)
      }
      if let d = agent.turnDiff {
        Text("·").opacity(0.45)
        // 两个独立的 Text 而不是 Text 拼接:拼接要用 Text.foregroundStyle,
        // 那个重载是 macOS 14+,而部署目标是 13
        HStack(spacing: 3) {
          Text("+\(d.additions)").foregroundStyle(Color.green.opacity(0.85))
          Text("−\(d.deletions)").foregroundStyle(Color.red.opacity(0.80))
        }
      }
      Spacer(minLength: 0)
    }
    .font(.system(size: 10.5))
    .monospacedDigit()
    .foregroundStyle(.white.opacity(0.42))
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
