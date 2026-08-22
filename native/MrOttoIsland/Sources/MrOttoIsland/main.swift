import AppKit
import Combine
import DynamicNotchKit
import SwiftUI

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // LSUIElement:无 dock 无菜单栏

/// phase + compact 区 hover 状态 → 目标 DynamicNotchState。
/// idle:贴合刘海(compact,内容为空)。active:默认 compact(脉动点),hover 才展开细节。
/// approval:不等 hover,直接展开。
func desiredState(phase: Phase, hovering: Bool) -> DynamicNotchState {
  switch phase {
  case .idle: return .compact
  case .active: return hovering ? .expanded : .compact
  case .approval: return .expanded
  }
}

// main.swift 顶层代码本身不是 MainActor-isolated(与 async @main 入口不同),
// 但它确实同步跑在主线程上(app.run() 之前)——MainActor.assumeIsolated 把这个事实
// 告诉类型系统,才能在这里碰 @MainActor 的 IslandModel / DynamicNotch。
var cancellables = Set<AnyCancellable>()

MainActor.assumeIsolated {
  let model = IslandModel()
  let bridge = Bridge()
  model.onOutbound = { bridge.send($0) }

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

  Publishers.CombineLatest(model.$snapshot, notch.$isHovering)
    .receive(on: DispatchQueue.main)
    .sink { snapshot, hovering in
      let target = desiredState(phase: snapshot.phase, hovering: hovering)
      Task { @MainActor in
        switch target {
        case .compact: await notch.compact()
        case .expanded: await notch.expand()
        case .hidden: await notch.hide()
        }
      }
    }
    .store(in: &cancellables)

  // Bridge 的 onSnapshot 回调在后台线程触发,必须先跳回主线程再碰 @Published/DynamicNotch。
  // DispatchQueue.main.async 保证物理上在主线程,但类型系统不知道这点,所以内层还要
  // 再 assumeIsolated 一次才能写 model.snapshot。
  bridge.start { snapshot in
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        model.snapshot = snapshot
      }
    }
  }
  bridge.send(.ready) // 启动握手:请主进程回推当前快照
}

app.run()
