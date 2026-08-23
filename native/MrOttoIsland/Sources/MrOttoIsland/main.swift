import AppKit
import Combine
import DynamicNotchKit
import SwiftUI

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // LSUIElement:无 dock 无菜单栏

/// fleet(所有 session)+ compact 区 hover 状态 + 输入态 → 目标 DynamicNotchState。
/// 任一 session 在 approval 或正在输入:不等 hover,直接展开。
/// 任一 session active 且 hover 中:展开细节。否则贴合刘海(compact)。
/// 这是能编译的最小版——按 selectedAgent/多行列表精化展开条件留给下一个 task。
func desiredState(fleet: IslandFleet, hovering: Bool, composing: Bool) -> DynamicNotchState {
  if composing { return .expanded }
  if fleet.agents.contains(where: { $0.phase == .approval }) { return .expanded }
  if hovering && fleet.agents.contains(where: { $0.phase != .idle }) { return .expanded }
  return .compact
}

// main.swift 顶层代码本身不是 MainActor-isolated(与 async @main 入口不同),
// 但它确实同步跑在主线程上(app.run() 之前)——MainActor.assumeIsolated 把这个事实
// 告诉类型系统,才能在这里碰 @MainActor 的 IslandModel / DynamicNotch。
var cancellables = Set<AnyCancellable>()

MainActor.assumeIsolated {
  let model = IslandModel()
  let bridge = Bridge()
  model.onOutbound = { bridge.send($0) }

  // 焦点抢还的核心验收点(Task 6)。helper 常态是 .accessory(无 dock、不参与前台轮转),
  // 要打字就必须临时变身:
  //   进输入态 → 记住当前最前台是谁(退出时要还给它)→ .regular + activate,
  //   这样 app 才"有资格"拥有 key window;真正让 TextField 拿到键盘还差一步——
  //   DynamicNotchPanel 是 [.borderless, .nonactivatingPanel] 但覆写了
  //   canBecomeKey => true(见 DynamicNotchPanel.swift),nonactivatingPanel 只是不让
  //   "点击它"顺带激活 app,并不妨碍我们显式 makeKey——所以下面 CombineLatest3 的
  //   sink 里,expand 完成后还会显式 makeKeyAndOrderFront 一次。
  //   退出输入态 → .accessory + 把键盘显式还给进入前记下来的那个 app
  //   (不能只指望 activationPolicy 变化自动把焦点还回去——它不会;这正是
  //   #175 I3 描述的"常驻置顶窗口扣住键盘不放"的失败模式,必须显式 activate 回去)。
  var previousFrontmostApp: NSRunningApplication?
  model.onComposeChange = { composing in
    if composing {
      previousFrontmostApp = NSWorkspace.shared.frontmostApplication
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
    } else {
      NSApp.setActivationPolicy(.accessory)
      if let previousFrontmostApp, previousFrontmostApp != .current {
        previousFrontmostApp.activate(options: [.activateIgnoringOtherApps])
      }
    }
  }

  // 真实 DynamicNotchKit API(见 task-5-report.md 的映射说明):
  // DynamicNotch<Expanded, CompactLeading, CompactTrailing> 用三个 @ViewBuilder 闭包初始化,
  // 状态机是 .hidden/.compact/.expanded,切换靠 async 的 expand(on:)/compact(on:)/hide()。
  // 不是 brief 骨架里的单 view + expand()/hide() 二态。
  let notch = DynamicNotch(
    hoverBehavior: .all,
    style: .auto,
    expanded: { IslandExpandedView(model: model) },
    compactLeading: { IslandCompactView(model: model) },
    compactTrailing: { EmptyView() }
  )

  Publishers.CombineLatest3(model.$fleet, notch.$isHovering, model.$composing)
    .receive(on: DispatchQueue.main)
    .sink { fleet, hovering, composing in
      let target = desiredState(fleet: fleet, hovering: hovering, composing: composing)
      Task { @MainActor in
        switch target {
        case .compact: await notch.compact()
        case .expanded: await notch.expand()
        case .hidden: await notch.hide()
        }
        // expand() 只保证窗口在跑动画、ordered front——不保证它是 key window。
        // SwiftUI 的 @FocusState(IslandExpandedView.composeFieldFocused)只有在
        // 承载窗口是 key 时才能真的把键盘焦点移进 TextField,所以这里显式点一次。
        // DynamicNotchPanel.canBecomeKey 覆写成了 true,nonactivatingPanel 不阻止
        // 显式 makeKey(它只挡"点击自动激活 app" 那条默认行为)。
        if composing {
          notch.windowController?.window?.makeKeyAndOrderFront(nil)
        }
      }
    }
    .store(in: &cancellables)

  // Bridge 的 onSnapshot 回调在后台线程触发,必须先跳回主线程再碰 @Published/DynamicNotch。
  // DispatchQueue.main.async 保证物理上在主线程,但类型系统不知道这点,所以内层还要
  // 再 assumeIsolated 一次才能调 model.apply(_:)。
  bridge.start { fleet in
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        model.apply(fleet)
      }
    }
  }
  bridge.send(.ready) // 启动握手:请主进程回推当前快照
}

app.run()
