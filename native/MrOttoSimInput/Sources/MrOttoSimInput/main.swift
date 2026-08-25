import AppKit
import ApplicationServices
import Foundation

// stdin 一行一条 Request，stdout 一行一条 Response。
// 不做并发：一次一条、按序回，主进程那边靠 id 认领。iOS 的输入本来就
// 是串行的（两只手指同时点两个地方不是这个 helper 该表达的东西）。

setbuf(stdout, nil)

let decoder = JSONDecoder()
let encoder = JSONEncoder()

func reply(_ r: Response) {
  guard let data = try? encoder.encode(r), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func fail(_ id: Int, _ msg: String) {
  reply(Response(id: id, ok: false, error: msg))
}

/// 需要发事件/读树的命令统一先过这道门：拿 pid，顺带把「没授权」翻成人话。
/// 授权状态每次现问——用户在系统设置里勾上之后不该要求重启 app
func requirePid(_ id: Int) -> pid_t? {
  guard let app = simulatorApp() else {
    fail(id, "Simulator.app 没在运行（先开机一台设备）")
    return nil
  }
  guard AXIsProcessTrusted() else {
    fail(
      id,
      "没有「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能，勾上 Mr Otto（开发时是 Electron），"
        + "然后重开这个面板。点击/打字/读屏都要它，画面不要")
    return nil
  }
  return app.processIdentifier
}

while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  if trimmed.isEmpty { continue }
  guard let data = trimmed.data(using: .utf8), let req = try? decoder.decode(Request.self, from: data)
  else {
    continue  // 解不开的行直接丢：回不了 id，主进程那边靠超时收场
  }

  switch req.type {
  case "probe":
    let app = simulatorApp()
    reply(
      Response(
        id: req.id, ok: true, trusted: AXIsProcessTrusted(), simulatorRunning: app != nil,
        pid: app.map { Int($0.processIdentifier) }))

  case "requestPermission":
    // 弹系统那颗「打开系统设置」对话框。已经授权时它什么都不做
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(opts)
    reply(Response(id: req.id, ok: true, trusted: trusted))

  case "windowRect":
    guard let box = simulatorWindowRect() else {
      fail(req.id, "找不到 Simulator 的设备窗口（Simulator.app 没开，或窗口被最小化了）")
      break
    }
    let shot = (width: req.shotWidth ?? 0, height: req.shotHeight ?? 0)
    // 有授权就问无障碍树要那块屏的真实矩形；没有就按截图比例内切窗口外框
    if let app = simulatorApp(), let exact = axScreenRect(pid: app.processIdentifier, shot: shot) {
      reply(Response(id: req.id, ok: true, rect: exact, rectSource: "screen"))
    } else {
      reply(
        Response(
          id: req.id, ok: true, rect: shot.width > 0 ? fitCentered(shot: shot, box: box) : box,
          rectSource: "window"))
    }

  case "describe":
    guard let pid = requirePid(req.id) else { break }
    let els = describeElements(pid: pid, within: simulatorWindowRect())
    reply(Response(id: req.id, ok: true, elements: els))

  case "tap":
    guard let pid = requirePid(req.id), let x = req.x, let y = req.y else {
      if req.x == nil || req.y == nil { fail(req.id, "tap 缺 x/y") }
      break
    }
    tap(pid: pid, x: x, y: y)
    reply(Response(id: req.id, ok: true))

  case "swipe":
    guard let pid = requirePid(req.id), let x = req.x, let y = req.y, let x2 = req.x2, let y2 = req.y2
    else {
      if req.x == nil || req.y == nil || req.x2 == nil || req.y2 == nil { fail(req.id, "swipe 缺坐标") }
      break
    }
    swipe(pid: pid, from: (x: x, y: y), to: (x: x2, y: y2), duration: (req.duration ?? 300) / 1000)
    reply(Response(id: req.id, ok: true))

  case "text":
    guard let pid = requirePid(req.id), let t = req.text else {
      if req.text == nil { fail(req.id, "text 缺 text") }
      break
    }
    typeText(pid: pid, text: t)
    reply(Response(id: req.id, ok: true))

  case "key":
    guard let pid = requirePid(req.id), let b = req.button else {
      if req.button == nil { fail(req.id, "key 缺 button") }
      break
    }
    guard let combo = comboFor(button: b) else {
      fail(req.id, "不认识的按钮：\(b)")
      break
    }
    pressCombo(pid: pid, combo: combo)
    reply(Response(id: req.id, ok: true))

  default:
    fail(req.id, "不认识的命令：\(req.type)")
  }
}
