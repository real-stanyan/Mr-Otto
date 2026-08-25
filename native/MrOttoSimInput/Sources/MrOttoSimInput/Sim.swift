import AppKit
import ApplicationServices

// 找窗口 / 读无障碍树 / 发事件。三件事都只用公开 API：
//   - 窗口矩形：CGWindowListCopyWindowInfo（**不需要任何授权**，所以「看画面」
//     这半边功能在没授权的机器上照样完整）
//   - 无障碍树：AXUIElement（Accessibility Inspector 走的同一条路——
//     Simulator.app 把 iOS 侧的无障碍元素桥到了 macOS AX 上）
//   - 点击/打字：CGEvent（postToPid，不抢前台）
// 后两件要「辅助功能」授权，没授权时 probe 会照实说。
//
// 坐标一律是 macOS 全局屏幕坐标、**左上角原点**：CGWindowList、AX 的
// kAXPosition、CGEvent 三者恰好都用这一套，中间不做翻转。

let simulatorBundleId = "com.apple.iphonesimulator"

func simulatorApp() -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == simulatorBundleId }
}

/// Simulator 最大的那扇窗（= 设备窗；「设备」菜单开出来的小面板一律更小）。
/// 用 CGWindowList 而不是 AX：这条路不要授权，画面功能因此不被授权卡住
func simulatorWindowRect() -> Rect? {
  guard let app = simulatorApp() else { return nil }
  let pid = app.processIdentifier
  guard
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]
  else { return nil }
  var best: Rect?
  for info in infos {
    guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid else { continue }
    guard let b = info[kCGWindowBounds as String] as? [String: Any],
      let x = b["X"] as? Double, let y = b["Y"] as? Double,
      let w = b["Width"] as? Double, let h = b["Height"] as? Double
    else { continue }
    // 阴影层/输入法候选窗之类的碎窗口滤掉
    if w < 100 || h < 100 { continue }
    if best == nil || w * h > best!.width * best!.height {
      best = Rect(x: x, y: y, width: w, height: h)
    }
  }
  return best
}

/// 在无障碍树里认出「设备屏」那块矩形：它是唯一一个和截图同宽高比的大元素。
/// 有它就不用猜窗口的边框和标题栏有多厚——这是点击坐标准不准的全部关键。
/// 没授权时返回 nil，调用方退回等比内切
func axScreenRect(pid: pid_t, shot: (width: Double, height: Double)) -> Rect? {
  guard AXIsProcessTrusted(), shot.width > 0, shot.height > 0 else { return nil }
  let want = shot.width / shot.height
  let app = AXUIElementCreateApplication(pid)
  var best: Rect?
  var bestArea = 0.0

  func visit(_ e: AXUIElement, depth: Int) {
    if depth > 12 { return }
    if let f = axFrame(e), f.width > 50, f.height > 50 {
      let ratio = Double(f.width / f.height)
      // 1% 容差:窗口尺寸是整数点,内切之后比例和截图不会分毫不差
      if abs(ratio - want) / want < 0.01 {
        let area = Double(f.width * f.height)
        if area > bestArea {
          bestArea = area
          best = Rect(
            x: Double(f.origin.x), y: Double(f.origin.y),
            width: Double(f.width), height: Double(f.height))
        }
      }
    }
    if let kids = axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement] {
      for k in kids { visit(k, depth: depth + 1) }
    }
  }
  if let windows = axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in windows { visit(w, depth: 0) }
  }
  return best
}

private func axAttr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}

private func axFrame(_ e: AXUIElement) -> CGRect? {
  guard let p = axAttr(e, kAXPositionAttribute as String),
    let s = axAttr(e, kAXSizeAttribute as String)
  else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt),
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
  else { return nil }
  return CGRect(origin: pt, size: sz)
}

private func axString(_ e: AXUIElement, _ a: String) -> String? {
  let v = axAttr(e, a)
  if let s = v as? String { return s.isEmpty ? nil : s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

/// 走一遍无障碍树，收「有名字且有框」的元素。
/// 刻意不只收叶子：iOS 的按钮在 AX 里常常是带子节点的容器，
/// 只收叶子会把按钮本身漏掉，只留下它里面那行字。
/// maxNodes 是护栏——一屏列表能有几千个节点，喂给模型没意义也贵。
func describeElements(pid: pid_t, within: Rect?, maxNodes: Int = 400) -> [Element] {
  let app = AXUIElementCreateApplication(pid)
  var out: [Element] = []
  var seen = 0

  func visit(_ e: AXUIElement, depth: Int) {
    if seen >= maxNodes || depth > 40 { return }
    seen += 1
    let role = axString(e, kAXRoleAttribute as String) ?? ""
    let label =
      axString(e, kAXTitleAttribute as String)
      ?? axString(e, kAXDescriptionAttribute as String)
      ?? ""
    let value = axString(e, kAXValueAttribute as String)
    if let f = axFrame(e), f.width > 0, f.height > 0, !label.isEmpty || value != nil {
      // 落在设备屏之外的（窗口标题栏、菜单）不要：模型拿到也点不着
      let inside =
        within == nil
        || (f.midX >= within!.x && f.midX <= within!.x + within!.width && f.midY >= within!.y
          && f.midY <= within!.y + within!.height)
      if inside {
        out.append(
          Element(
            role: role, label: label, value: value,
            x: Double(f.origin.x), y: Double(f.origin.y),
            width: Double(f.width), height: Double(f.height)))
      }
    }
    if let kids = axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement] {
      for k in kids { visit(k, depth: depth + 1) }
    }
  }

  if let windows = axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in windows { visit(w, depth: 0) }
  }
  return out
}

// MARK: - 发事件

private func flags(_ mods: Set<String>) -> CGEventFlags {
  var f: CGEventFlags = []
  if mods.contains("command") { f.insert(.maskCommand) }
  if mods.contains("shift") { f.insert(.maskShift) }
  if mods.contains("option") { f.insert(.maskAlternate) }
  if mods.contains("control") { f.insert(.maskControl) }
  return f
}

/// 事件一律 postToPid：不抢前台焦点，用户在别的窗口里打字不会被 agent 的点击打断。
/// 代价是 Simulator 必须活着（不能是「已退出但窗口还在」这种状态，不存在）
private func post(_ e: CGEvent?, pid: pid_t) {
  guard let e else { return }
  e.postToPid(pid)
}

func tap(pid: pid_t, x: Double, y: Double) {
  let p = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left), pid: pid)
  post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left), pid: pid)
  post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left), pid: pid)
}

func swipe(pid: pid_t, from: (x: Double, y: Double), to: (x: Double, y: Double), duration: Double) {
  let src = CGEventSource(stateID: .hidSystemState)
  let steps = max(8, Int(duration / 0.008))
  let pts = interpolate(from: from, to: to, steps: steps)
  post(
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
      mouseCursorPosition: CGPoint(x: from.x, y: from.y), mouseButton: .left), pid: pid)
  for p in pts {
    post(
      CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged,
        mouseCursorPosition: CGPoint(x: p.x, y: p.y), mouseButton: .left), pid: pid)
    Thread.sleep(forTimeInterval: duration / Double(steps))
  }
  post(
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
      mouseCursorPosition: CGPoint(x: to.x, y: to.y), mouseButton: .left), pid: pid)
}

/// 打字：不查键位表，直接把 unicode 串挂到一个空 keydown 上——
/// 中文/emoji/大写字母全都不用管布局
func typeText(pid: pid_t, text: String) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in text.unicodeScalars {
    var u = [UniChar](String(ch).utf16)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    else { continue }
    down.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    post(down, pid: pid)
    post(up, pid: pid)
    Thread.sleep(forTimeInterval: 0.004)
  }
}

func pressCombo(pid: pid_t, combo: KeyCombo) {
  let src = CGEventSource(stateID: .hidSystemState)
  let f = flags(combo.modifiers)
  if let down = CGEvent(keyboardEventSource: src, virtualKey: combo.keyCode, keyDown: true) {
    down.flags = f
    post(down, pid: pid)
  }
  if let up = CGEvent(keyboardEventSource: src, virtualKey: combo.keyCode, keyDown: false) {
    up.flags = f
    post(up, pid: pid)
  }
}
