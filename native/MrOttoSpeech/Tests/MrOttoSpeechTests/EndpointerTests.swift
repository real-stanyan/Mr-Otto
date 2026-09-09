import XCTest

@testable import MrOttoSpeech

// 只测纯逻辑：断句器与协议编解码。真麦克风、真授权进不了任何 CI。
final class EndpointerTests: XCTestCase {
  func testFeedReportsChangeOnly() {
    var e = Endpointer(silenceMs: 1500)
    XCTAssertTrue(e.feed("你好", now: 0))
    XCTAssertFalse(e.feed("你好", now: 100))
    XCTAssertFalse(e.feed(" 你好 ", now: 200))  // 首尾空白不算变
    XCTAssertTrue(e.feed("你好啊", now: 300))
    XCTAssertEqual(e.text, "你好啊")
  }

  func testTickFinalizesAfterSilence() {
    var e = Endpointer(silenceMs: 1500)
    _ = e.feed("帮我看下投放", now: 1000)
    XCTAssertNil(e.tick(now: 2000))  // 安静 1 秒：还没到
    XCTAssertNil(e.tick(now: 2499))
    XCTAssertEqual(e.tick(now: 2500), "帮我看下投放")
    XCTAssertEqual(e.text, "")  // 收口即清空
    XCTAssertNil(e.tick(now: 9999))  // 空的不再收口
  }

  func testChangeResetsSilenceClock() {
    var e = Endpointer(silenceMs: 1500)
    _ = e.feed("帮我", now: 0)
    _ = e.feed("帮我看下", now: 1400)  // 说到一半又说了
    XCTAssertNil(e.tick(now: 1600))  // 从 1400 起算
    XCTAssertEqual(e.tick(now: 2900), "帮我看下")
  }

  func testFlushReturnsPendingAndClears() {
    var e = Endpointer(silenceMs: 1500)
    XCTAssertNil(e.flush())
    _ = e.feed("在吗", now: 0)
    XCTAssertEqual(e.flush(), "在吗")
    XCTAssertNil(e.flush())
  }

  func testEmptySnapshotClearsWithoutFinal() {
    var e = Endpointer(silenceMs: 1500)
    _ = e.feed("在吗", now: 0)
    XCTAssertTrue(e.feed("", now: 100))  // 识别器把前面的字撤回了
    XCTAssertNil(e.tick(now: 5000))
  }

  func testDecodeCommand() throws {
    let c = try JSONDecoder().decode(
      Command.self, from: #"{"type":"start","locale":"zh-CN","silenceMs":1200}"#.data(using: .utf8)!)
    XCTAssertEqual(c.type, "start")
    XCTAssertEqual(c.locale, "zh-CN")
    XCTAssertEqual(c.silenceMs, 1200)
    let s = try JSONDecoder().decode(Command.self, from: #"{"type":"stop"}"#.data(using: .utf8)!)
    XCTAssertNil(s.locale)
  }

  func testEncodeEventOmitsNils() throws {
    let data = try JSONEncoder().encode(Event(type: "partial", text: "你好"))
    let s = String(data: data, encoding: .utf8)!
    XCTAssertTrue(s.contains(#""type":"partial""#))
    XCTAssertTrue(s.contains(#""text":"你好""#))
    XCTAssertFalse(s.contains("message"))
    XCTAssertFalse(s.contains("onDevice"))
  }
}

// 能量断句（#1184）：识别器的转写在人停嘴之后还会再变几百毫秒（重打分），只看「文本 1.5 秒没变」
// 等于在识别器滞后之上再加 1.5 秒。有了麦克风能量，「人停嘴」直接量得到：安静够久 + 转写稳住
// 就收口；像说完了（句末标点 / 很短）等得短，没说完（逗号 / 没标点）等得长。文本 1.5 秒没变
// 仍是天花板——背景噪音让能量一直「活着」时不能永远不收口。
final class EnergyEndpointerTests: XCTestCase {
  func testLooksFinished() {
    XCTAssertTrue(utteranceLooksFinished("我说话你能听到吗？"))
    XCTAssertTrue(utteranceLooksFinished("好的。"))
    XCTAssertTrue(utteranceLooksFinished("Sure!"))
    XCTAssertTrue(utteranceLooksFinished("在吗"))  // 很短 = 一句闭合的短答
    XCTAssertFalse(utteranceLooksFinished("我想问一下，"))
    XCTAssertFalse(utteranceLooksFinished("然后帮我把那个投放的数据"))
    XCTAssertFalse(utteranceLooksFinished(""))
  }

  func testQuietAfterFinishedUtteranceFinalizesFast() {
    var e = Endpointer(silenceMs: 1500, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("在吗", now: 0)
    e.feedLevel(active: true, now: 100)
    e.feedLevel(active: false, now: 300)  // 人停嘴
    XCTAssertNil(e.tick(now: 900))  // 安静 600 < 700
    XCTAssertEqual(e.tick(now: 1000), "在吗")
    XCTAssertEqual(e.text, "")
  }

  func testMidThoughtWaitsLonger() {
    var e = Endpointer(silenceMs: 3000, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("我想问一下，", now: 0)
    e.feedLevel(active: false, now: 300)
    XCTAssertNil(e.tick(now: 1100))  // 安静 800：没说完的要等 1500
    XCTAssertNil(e.tick(now: 1799))
    XCTAssertEqual(e.tick(now: 1800), "我想问一下，")
  }

  func testSpeechResumingResetsQuietClock() {
    var e = Endpointer(silenceMs: 3000, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("在吗", now: 0)
    e.feedLevel(active: false, now: 300)
    e.feedLevel(active: true, now: 800)  // 又开口了
    XCTAssertNil(e.tick(now: 1200))
    e.feedLevel(active: false, now: 1300)
    XCTAssertNil(e.tick(now: 1900))
    XCTAssertEqual(e.tick(now: 2000), "在吗")
  }

  func testTranscriptMustBeStableBeforeFinalizing() {
    var e = Endpointer(silenceMs: 3000, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("在吗", now: 0)
    e.feedLevel(active: false, now: 300)
    _ = e.feed("在吗？", now: 900)  // 停嘴之后识别器还在重打分
    XCTAssertNil(e.tick(now: 1000))  // 安静够了但转写刚变过 100ms
    XCTAssertEqual(e.tick(now: 1150), "在吗？")
  }

  func testTextSilenceRemainsTheCeilingWhenEnergyNeverGoesQuiet() {
    var e = Endpointer(silenceMs: 1500, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("帮我看下投放", now: 0)
    for t in stride(from: 100.0, through: 1400.0, by: 100.0) { e.feedLevel(active: true, now: t) }  // 背景一直响
    XCTAssertNil(e.tick(now: 1400))
    e.feedLevel(active: true, now: 1500)
    XCTAssertEqual(e.tick(now: 1500), "帮我看下投放")
  }

  func testWithoutLevelSamplesFallsBackToTextSilence() {
    var e = Endpointer(silenceMs: 1500, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("在吗", now: 0)
    XCTAssertNil(e.tick(now: 1000))
    XCTAssertEqual(e.tick(now: 1500), "在吗")
  }

  func testFlushClearsQuietClockToo() {
    var e = Endpointer(silenceMs: 1500, completeMs: 700, midMs: 1500, stableMs: 250)
    _ = e.feed("在吗", now: 0)
    e.feedLevel(active: false, now: 100)
    XCTAssertEqual(e.flush(), "在吗")
    _ = e.feed("再来", now: 2000)  // 新一句：安静的时钟不该从上一句的 100 起算
    XCTAssertNil(e.tick(now: 2100))
  }
}

// 能量门：RMS → 「人在说话吗」+ 给界面画的 0..1。噪声底自适应——不同麦克风、不同房间的底噪
// 差几十 dB，写死一个门槛要么在安静房间里被键盘声触发，要么在吵的房间里永远听不见人。
final class LevelGateTests: XCTestCase {
  private func db(_ d: Double) -> Float { Float(pow(10.0, d / 20.0)) }

  func testQuietRoomIsInactiveSpeechIsActive() {
    var g = LevelGate()
    var r = g.feed(rms: db(-60), now: 0)
    for t in 1...20 { r = g.feed(rms: db(-60), now: Double(t) * 21) }
    XCTAssertFalse(r.active)
    r = g.feed(rms: db(-30), now: 500)
    XCTAssertTrue(r.active)
    XCTAssertEqual(r.level, 0.6, accuracy: 0.05)  // -30 dB ≈ 0.6
    r = g.feed(rms: db(-60), now: 600)
    XCTAssertFalse(r.active)
    XCTAssertEqual(r.level, 0, accuracy: 0.05)
  }

  func testSustainedNoiseRaisesTheFloorUntilItIsInactive() {
    var g = LevelGate()
    for t in 0..<20 { _ = g.feed(rms: db(-60), now: Double(t) * 21) }
    var r = g.feed(rms: db(-48), now: 500)
    XCTAssertTrue(r.active)  // 刚变吵：比底噪高 12 dB，先当成有人说话
    for t in 0..<600 { r = g.feed(rms: db(-48), now: 500 + Double(t) * 21) }  // 响了十几秒
    XCTAssertFalse(r.active)  // 底噪爬上来了：持续的噪音不是人
    XCTAssertTrue(g.feed(rms: db(-30), now: 20000).active)  // 人说话仍然认得出
  }

  func testDigitalSilenceDoesNotPinTheFloorForever() {
    var g = LevelGate()
    _ = g.feed(rms: 0, now: 0)  // 一块全零（设备刚起）
    var r = g.feed(rms: db(-62), now: 21)
    for t in 0..<100 { r = g.feed(rms: db(-62), now: 42 + Double(t) * 21) }
    XCTAssertFalse(r.active)  // 普通底噪不该因为一块全零被判成说话
  }

  func testAbsoluteFloorKeepsVeryQuietSoundsInactive() {
    var g = LevelGate()
    for t in 0..<20 { _ = g.feed(rms: db(-80), now: Double(t) * 21) }
    XCTAssertFalse(g.feed(rms: db(-62), now: 500).active)  // 比底噪高 18 dB，但绝对值仍在门槛之下
  }
}
