import AVFoundation
import CallKit
import Foundation
import PushKit

/// 进程里唯一的一份：PushKit 注册、CallKit provider、这几通来电的账（#1428，spec §2）。
/// 状态一律在主队列上动：PushKit 的 registry 建在主队列上，CXProvider 的 delegate 队列给 nil（= 主队列），
/// JS 调进来的 endCall 也 runOnQueue(.main)、挂 / 卸监听也 hop 到主队列。**唯一例外是 voipToken**：
/// 同步的 getVoipToken 在 JS 线程上读它，所以它有自己的锁。
final class CallCenter: NSObject {
  static let shared = CallCenter()

  private struct Call {
    let uuid: UUID
    var answered: Bool
    var timer: Timer?
  }

  private var registry: PKPushRegistry?
  private let provider: CXProvider
  private let tokenLock = NSLock()
  private var _voipToken: String?
  /// 主队列写、JS 线程读（getVoipToken 是同步函数），所以过锁
  var voipToken: String? {
    get { tokenLock.lock(); defer { tokenLock.unlock() }; return _voipToken }
    set { tokenLock.lock(); defer { tokenLock.unlock() }; _voipToken = newValue }
  }
  /// ringId → 这一通
  private var calls: [String: Call] = [:]
  /// 已经处理过的 ringId：推送不保证只到一次，同一通再来要报、但报完立刻结束
  private var seen = Set<String>()
  /// JS 还没挂上监听时攒着的事件（被 VoIP 推送从后台叫起来的那一次，JS 比推送回调晚）
  private var pending: [[String: Any]] = []
  /// JS 那一侧；nil = 没有监听。owner 是挂上它的那个模块实例：JS 重载后旧实例的 OnDestroy 只清自己挂的，
  /// 不会把新实例刚挂上的踩掉。closure 回 true = 送到了；回 false（模块已经没了）= 没送到，事件留着
  private var emitter: (owner: UUID, deliver: ([String: Any]) -> Bool)?

  /// 挂上监听（主队列）：把攒着的一次发完，发不出去的接着攒
  func attach(owner: UUID, deliver: @escaping ([String: Any]) -> Bool) {
    emitter = (owner, deliver)
    let queued = pending
    pending = []
    for (i, body) in queued.enumerated() {
      if !deliver(body) {
        pending = Array(queued[i...])
        break
      }
    }
  }

  /// 卸掉监听（主队列）：只认自己挂的
  func detach(owner: UUID) {
    guard emitter?.owner == owner else { return }
    emitter = nil
  }

  private override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallsPerCallGroup = 1
    config.maximumCallGroups = 1
    config.supportedHandleTypes = [.generic]
    // 通话记录在聊天里已经有了，不往「电话」App 的最近通话里塞
    config.includesCallsInRecents = false
    // expo-notifications 插件把它打进了包根目录（app.json 的 sounds）
    config.ringtoneSound = "ringtone.caf"
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// didFinishLaunching 里调（OttoCallAppDelegate）：越早越好，被推送叫起来时回调紧跟其后
  func start() {
    guard registry == nil else { return }
    let r = PKPushRegistry(queue: .main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
  }

  private func send(_ body: [String: Any]) {
    if let emitter, emitter.deliver(body) { return }
    pending.append(body)
  }

  private func ringIdOf(_ uuid: UUID) -> String? {
    calls.first(where: { $0.value.uuid == uuid })?.key
  }

  /// App 这边的通话结束了：收掉系统来电。走 reportCall 不走 CXEndCallAction——后者会回调 perform end、
  /// 再发一条 end 事件，JS 又去挂一次已经挂掉的电话
  func endCall(ringId: String) {
    guard let call = calls.removeValue(forKey: ringId) else { return }
    call.timer?.invalidate()
    provider.reportCall(with: call.uuid, endedAt: nil, reason: .remoteEnded)
  }

  private func finishUnanswered(_ ringId: String) {
    guard let call = calls[ringId], !call.answered else { return }
    calls.removeValue(forKey: ringId)
    provider.reportCall(with: call.uuid, endedAt: nil, reason: .unanswered)
    send(["type": "end", "ringId": ringId, "answered": false, "reason": "missed"])
  }

  /// 与 otto-speech 逐字同一组（spec §2.3）：回声消除由它的 VPIO 做。只设 category，激活交给 CallKit
  private func configureAudioSession() {
    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
  }
}

extension CallCenter: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = token
    send(["type": "token", "token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    voipToken = nil
  }

  /// iOS 13 起：每一条 VoIP 推送都必须在这里报一通来电，否则系统杀 App、屡犯就不再投递。
  /// 解析失败 / 已过期 / 重复的也报，报完立刻结束（spec §0.8）
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let ring = payload.dictionaryPayload["ring"] as? [String: Any]
    let ringId = ring?["ringId"] as? String
    let name = (ring?["agentName"] as? String) ?? "Mr Otto"
    let expiresMs = (ring?["expiresTs"] as? NSNumber)?.doubleValue ?? 0
    let nowMs = Date().timeIntervalSince1970 * 1000
    let live = ringId != nil && expiresMs > nowMs && !seen.contains(ringId!)
    // 同步登记，不等下面的异步完成回调：紧挨着到的同 ringId 第二条推送在这一行之后读 seen 就是重复的
    // （否则两条都当成有效、calls[ringId] 被后一条覆盖，前一条的系统来电永远响下去）
    if live, let ringId { seen.insert(ringId) }

    let uuid = UUID()
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: (ring?["agentId"] as? String) ?? "otto")
    update.localizedCallerName = name
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      // 完成回调在哪条队列上来 CallKit 没写：一律 hop 回主队列再碰 calls / Timer（Timer 挂在没有 runloop 的线程上永远不响）
      DispatchQueue.main.async {
        defer { completion() }
        guard let self else { return }
        // 系统拒了（勿扰挡掉、已经有一通在打……）：什么都不记，服务端到点记未接
        if error != nil {
          // 这条本来有效、却没响成：放开登记，服务端重发的同一通还能再试
          if live, let ringId { self.seen.remove(ringId) }
          return
        }
        // calls[ringId] != nil 是第二道：不管 seen 怎么漏的，同一 ringId 只留一通，多的这个 uuid 立刻结束
        guard live, let ringId, let ring, self.calls[ringId] == nil else {
          self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
          return
        }
        let timer = Timer.scheduledTimer(withTimeInterval: max(0, (expiresMs - nowMs) / 1000), repeats: false) { [weak self] _ in
          self?.finishUnanswered(ringId)
        }
        self.calls[ringId] = Call(uuid: uuid, answered: false, timer: timer)
        self.send(["type": "incoming", "ring": ring])
      }
    }
  }
}

extension CallCenter: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    for (ringId, call) in calls {
      call.timer?.invalidate()
      send(["type": "end", "ringId": ringId, "answered": call.answered, "reason": "reset"])
    }
    calls.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let ringId = ringIdOf(action.callUUID) else {
      action.fail()
      return
    }
    calls[ringId]?.timer?.invalidate()
    calls[ringId]?.timer = nil
    calls[ringId]?.answered = true
    configureAudioSession()
    action.fulfill()
    send(["type": "answer", "ringId": ringId])
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let ringId = ringIdOf(action.callUUID), let call = calls.removeValue(forKey: ringId) else {
      action.fulfill()
      return
    }
    call.timer?.invalidate()
    action.fulfill()
    send(["type": "end", "ringId": ringId, "answered": call.answered, "reason": "user"])
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let ringId = ringIdOf(action.callUUID) else {
      action.fail()
      return
    }
    action.fulfill()
    send(["type": "mute", "ringId": ringId, "muted": action.isMuted])
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    send(["type": "audio", "active": true])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    send(["type": "audio", "active": false])
  }
}
