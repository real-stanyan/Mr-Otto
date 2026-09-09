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
