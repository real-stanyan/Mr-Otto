import ExpoModulesCore

// 系统来电的原生模块（#1428）：JS 一侧只有两个函数与一路事件。来电本身不经过 JS——原生收到 VoIP 推送就当场
// 报给 CallKit（iOS 的硬规定），之后才把这一通交给 JS。
public class OttoCallModule: Module {
  /// 这个模块实例挂在 CallCenter 上的凭据：JS 重载后旧实例的 OnDestroy / OnStopObserving 只卸自己挂的
  private let owner = UUID()

  public func definition() -> ModuleDefinition {
    Name("OttoCall")

    Events("onCall")

    // JS 挂上第一个监听时接上：攒着的事件（被推送叫起来那一次，JS 还没起来时到的）一次发完。
    // 模块已经没了（重载后旧实例）时回 false，事件留在 CallCenter 里等新实例挂上
    OnStartObserving {
      let owner = self.owner
      DispatchQueue.main.async {
        CallCenter.shared.attach(owner: owner) { [weak self] body in
          guard let self, self.appContext != nil else { return false }
          self.sendEvent("onCall", body)
          return true
        }
      }
    }

    OnStopObserving {
      let owner = self.owner
      DispatchQueue.main.async { CallCenter.shared.detach(owner: owner) }
    }

    OnDestroy {
      let owner = self.owner
      DispatchQueue.main.async { CallCenter.shared.detach(owner: owner) }
    }

    Function("getVoipToken") { () -> String? in
      CallCenter.shared.voipToken
    }

    AsyncFunction("endCall") { (ringId: String) in
      CallCenter.shared.endCall(ringId: ringId)
    }.runOnQueue(.main)
  }
}
