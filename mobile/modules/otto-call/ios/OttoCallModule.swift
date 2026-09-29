import ExpoModulesCore

// 系统来电的原生模块（#1428）：JS 一侧只有两个函数与一路事件。来电本身不经过 JS——原生收到 VoIP 推送就当场
// 报给 CallKit（iOS 的硬规定），之后才把这一通交给 JS。
public class OttoCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OttoCall")

    Events("onCall")

    // JS 挂上第一个监听时接上：攒着的事件（被推送叫起来那一次，JS 还没起来时到的）一次发完
    OnStartObserving {
      DispatchQueue.main.async {
        CallCenter.shared.emit = { [weak self] body in self?.sendEvent("onCall", body) }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async { CallCenter.shared.emit = nil }
    }

    Function("getVoipToken") { () -> String? in
      CallCenter.shared.voipToken
    }

    AsyncFunction("endCall") { (ringId: String) in
      CallCenter.shared.endCall(ringId: ringId)
    }.runOnQueue(.main)
  }
}
