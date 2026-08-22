import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // LSUIElement:无 dock 无菜单栏

let bridge = Bridge()
bridge.start { snapshot in
  DispatchQueue.main.async {
    // Task 5 会在这里驱动 DynamicNotch;现在只回显验证桥通
    FileHandle.standardError.write("岛 helper:收到 phase=\(snapshot.phase.rawValue)\n".data(using: .utf8)!)
  }
}
bridge.send(.ready) // 启动握手:请主进程回推当前快照

app.run()
